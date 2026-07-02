from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.cloudflare import CloudflareClient
from app.gcp_compute import GcpApiError, GcpCompute
from app.gcp_monitoring import GcpMonitoring
from app.schemas import ApiResult, CreateInstanceRequest, InstanceActionRequest, RotateIpRequest

load_dotenv()

APP_ENV = os.getenv("APP_ENV", "dev").lower()
PANEL_TOKEN = os.getenv("PANEL_TOKEN", "").strip()
DEFAULT_PROJECT = os.getenv("GCP_PROJECT_ID", "").strip()
DEFAULT_ZONE = os.getenv("GCP_DEFAULT_ZONE", "us-central1-a").strip()
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
SERVICE_ACCOUNT_PATH = DATA_DIR / "gcp-service-account.json"

if SERVICE_ACCOUNT_PATH.exists() and not os.getenv("GOOGLE_APPLICATION_CREDENTIALS"):
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(SERVICE_ACCOUNT_PATH)

app = FastAPI(title="GCP Compute Engine 工作台", version="0.2.0")
app.mount("/static", StaticFiles(directory="app/static"), name="static")


@app.exception_handler(GcpApiError)
async def gcp_api_exception_handler(_: Request, exc: GcpApiError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"ok": False, "message": str(exc), "data": None})


@app.exception_handler(Exception)
async def generic_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=500, content={"ok": False, "message": str(exc), "data": None})


def require_token(
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
    x_panel_token: Annotated[str | None, Header(alias="X-Panel-Token")] = None,
) -> None:
    if not PANEL_TOKEN and APP_ENV == "dev":
        return
    if not PANEL_TOKEN:
        raise HTTPException(status_code=500, detail="服务端未设置 PANEL_TOKEN，已拒绝管理类请求。")
    token = x_panel_token or ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    if token != PANEL_TOKEN:
        raise HTTPException(status_code=401, detail="Token 错误或缺失。")


@lru_cache(maxsize=1)
def compute_client() -> GcpCompute:
    return GcpCompute()


@lru_cache(maxsize=1)
def monitoring_client() -> GcpMonitoring:
    return GcpMonitoring()


def clear_clients() -> None:
    compute_client.cache_clear()
    monitoring_client.cache_clear()


def credential_status() -> dict:
    path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    service_account_project = None
    if path and Path(path).exists():
        try:
            with open(path, "r", encoding="utf-8") as fh:
                service_account_project = json.load(fh).get("project_id")
        except Exception:
            service_account_project = None
    return {
        "google_application_credentials": path or None,
        "uploaded_service_account_exists": SERVICE_ACCOUNT_PATH.exists(),
        "service_account_project_id": service_account_project,
    }


@app.get("/")
async def index() -> FileResponse:
    return FileResponse("app/static/index.html")


@app.get("/api/config")
async def config() -> dict:
    return {
        "ok": True,
        "data": {
            "default_project": DEFAULT_PROJECT,
            "default_zone": DEFAULT_ZONE,
            "token_required": bool(PANEL_TOKEN) or APP_ENV != "dev",
            "app_env": APP_ENV,
            "cloudflare_token_configured": bool(os.getenv("CF_API_TOKEN", "").strip()),
            "credential_status": credential_status(),
        },
    }


@app.get("/api/health", dependencies=[Depends(require_token)])
async def health(project: str = Query(default=DEFAULT_PROJECT)) -> ApiResult:
    data = {"compute": "unknown", "monitoring": "unknown", "project": project, "credential_status": credential_status()}
    try:
        if project:
            compute_client().overview(project)
        data["compute"] = "ok"
    except Exception as exc:
        data["compute"] = f"error: {exc}"
    try:
        monitoring_client()
        data["monitoring"] = "ok"
    except Exception as exc:
        data["monitoring"] = f"error: {exc}"
    return ApiResult(ok=True, message="ok", data=data)


@app.post("/api/credentials/gcp-service-account", dependencies=[Depends(require_token)])
async def upload_service_account(file: UploadFile = File(...)) -> ApiResult:
    content = await file.read()
    try:
        payload = json.loads(content.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="上传文件不是有效的 JSON。") from exc
    if payload.get("type") != "service_account" or not payload.get("client_email") or not payload.get("private_key"):
        raise HTTPException(status_code=400, detail="这不是有效的 GCP Service Account JSON 密钥。")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SERVICE_ACCOUNT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(SERVICE_ACCOUNT_PATH, 0o600)
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(SERVICE_ACCOUNT_PATH)
    clear_clients()
    return ApiResult(
        ok=True,
        message="Service Account JSON 已保存并热加载。",
        data={"project_id": payload.get("project_id"), "client_email": payload.get("client_email")},
    )


@app.post("/api/cache/reload", dependencies=[Depends(require_token)])
async def reload_clients() -> ApiResult:
    clear_clients()
    return ApiResult(ok=True, message="GCP 客户端缓存已刷新。", data=credential_status())


@app.get("/api/instances", dependencies=[Depends(require_token)])
async def list_instances(project: str = Query(default=DEFAULT_PROJECT)) -> ApiResult:
    if not project:
        raise HTTPException(status_code=400, detail="缺少 project。")
    instances = compute_client().aggregated_instances(project)
    return ApiResult(ok=True, message="ok", data=instances)


@app.get("/api/overview", dependencies=[Depends(require_token)])
async def overview(project: str = Query(default=DEFAULT_PROJECT)) -> ApiResult:
    if not project:
        raise HTTPException(status_code=400, detail="缺少 project。")
    data = compute_client().overview(project)
    return ApiResult(ok=True, message="ok", data=data)


@app.post("/api/instances", dependencies=[Depends(require_token)])
async def create_instance(payload: CreateInstanceRequest) -> ApiResult:
    op = compute_client().create_instance(payload)
    return ApiResult(ok=True, message=f"创建请求完成，操作状态：{op.status}", data=op.raw)


@app.post("/api/instances/action", dependencies=[Depends(require_token)])
async def instance_action(payload: InstanceActionRequest) -> ApiResult:
    op = compute_client().action(payload.project, payload.zone, payload.name, payload.action)
    return ApiResult(ok=True, message=f"{payload.action} 完成，操作状态：{op.status}", data=op.raw)


@app.post("/api/instances/rotate-ip", dependencies=[Depends(require_token)])
async def rotate_ip(payload: RotateIpRequest) -> ApiResult:
    data = compute_client().rotate_external_ip(
        payload.project,
        payload.zone,
        payload.name,
        payload.network_interface,
        payload.access_config_name,
        payload.network_tier,
    )
    dns_result = None
    if payload.update_cloudflare_dns:
        if not payload.cloudflare_zone_id or not payload.cloudflare_record_id:
            raise HTTPException(status_code=400, detail="启用 Cloudflare DNS 更新时必须填写 Zone ID 和 Record ID。")
        new_ip = data.get("new_ip")
        if not new_ip:
            raise HTTPException(status_code=400, detail="换 IP 后未获取到新的外部 IP，无法更新 DNS。")
        dns_result = CloudflareClient().update_record_content(
            zone_id=payload.cloudflare_zone_id,
            record_id=payload.cloudflare_record_id,
            content=new_ip,
            name=payload.cloudflare_record_name or None,
            record_type=payload.cloudflare_record_type,
            proxied=payload.cloudflare_proxied,
        )
        data["cloudflare_dns"] = dns_result
    suffix = "，Cloudflare DNS 已更新" if dns_result else ""
    return ApiResult(ok=True, message=f"换 IP 完成：{data.get('old_ip')} -> {data.get('new_ip')}{suffix}", data=data)


@app.get("/api/traffic", dependencies=[Depends(require_token)])
async def traffic(
    project: str = Query(default=DEFAULT_PROJECT),
    hours: int = Query(default=24, ge=1, le=24 * 92),
    zone: str | None = Query(default=None),
    instance: str | None = Query(default=None),
    instance_id: str | None = Query(default=None),
) -> ApiResult:
    if not project:
        raise HTTPException(status_code=400, detail="缺少 project。")
    resolved_instance_id = instance_id
    if instance and zone:
        resolved_instance_id = compute_client().get_instance(project, zone, instance).get("id")
    data = monitoring_client().query_network_bytes(project, hours=hours, instance_id=resolved_instance_id)
    return ApiResult(ok=True, message="ok", data=data)
