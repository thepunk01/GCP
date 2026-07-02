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
from app.ssh_runner import SshRunError, run_ssh_command
from app import automation, store
from app.schemas import (
    ApiResult,
    CommandPresetRequest,
    CreateInstanceRequest,
    InstanceActionRequest,
    ManagedServerRequest,
    MonitorConfigRequest,
    RotateIpRequest,
    RunCommandRequest,
    StartupScriptPresetRequest,
)

load_dotenv()

APP_ENV = os.getenv("APP_ENV", "dev").lower()
PANEL_TOKEN = os.getenv("PANEL_TOKEN", "").strip()
DEFAULT_PROJECT = os.getenv("GCP_PROJECT_ID", "").strip()
DEFAULT_ZONE = os.getenv("GCP_DEFAULT_ZONE", "us-central1-a").strip()
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
SERVICE_ACCOUNT_PATH = DATA_DIR / "gcp-service-account.json"

if SERVICE_ACCOUNT_PATH.exists() and not os.getenv("GOOGLE_APPLICATION_CREDENTIALS"):
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(SERVICE_ACCOUNT_PATH)

app = FastAPI(title="GCP Compute Engine 工作台", version="0.3.0")
app.mount("/static", StaticFiles(directory="app/static"), name="static")


@app.on_event("startup")
async def startup_event() -> None:
    automation.start_monitor()


@app.on_event("shutdown")
async def shutdown_event() -> None:
    await automation.stop_monitor()


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


@app.get("/api/ops/servers", dependencies=[Depends(require_token)])
async def list_managed_servers() -> ApiResult:
    return ApiResult(ok=True, message="ok", data=store.list_items("servers"))


@app.post("/api/ops/servers", dependencies=[Depends(require_token)])
async def save_managed_server(payload: ManagedServerRequest) -> ApiResult:
    item = payload.model_dump()
    saved = store.upsert_item("servers", item)
    return ApiResult(ok=True, message="服务器资产已保存。", data=saved)


@app.put("/api/ops/servers/{server_id}", dependencies=[Depends(require_token)])
async def update_managed_server(server_id: str, payload: ManagedServerRequest) -> ApiResult:
    item = payload.model_dump()
    item["id"] = server_id
    saved = store.upsert_item("servers", item)
    return ApiResult(ok=True, message="服务器资产已更新。", data=saved)


@app.delete("/api/ops/servers/{server_id}", dependencies=[Depends(require_token)])
async def delete_managed_server(server_id: str) -> ApiResult:
    if not store.delete_item("servers", server_id):
        raise HTTPException(status_code=404, detail="服务器不存在。")
    return ApiResult(ok=True, message="服务器资产已删除。", data={"id": server_id})


@app.post("/api/ops/servers/{server_id}/check", dependencies=[Depends(require_token)])
async def check_managed_server(server_id: str) -> ApiResult:
    server = store.get_item("servers", server_id)
    if not server:
        raise HTTPException(status_code=404, detail="服务器不存在。")
    result = await automation.check_server_once(server, allow_actions=False)
    return ApiResult(ok=True, message="检测完成。", data=result)


@app.post("/api/ops/servers/{server_id}/rotate-ip", dependencies=[Depends(require_token)])
async def rotate_managed_server_ip(server_id: str) -> ApiResult:
    server = store.get_item("servers", server_id)
    if not server:
        raise HTTPException(status_code=404, detail="服务器不存在。")
    result = automation.rotate_server_ip(server)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("message") or "换 IP 失败。")
    return ApiResult(ok=True, message="换 IP 完成。", data=result)


@app.post("/api/ops/servers/{server_id}/replace", dependencies=[Depends(require_token)])
async def replace_managed_server(server_id: str) -> ApiResult:
    server = store.get_item("servers", server_id)
    if not server:
        raise HTTPException(status_code=404, detail="服务器不存在。")
    result = automation.replace_server_instance(server)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("message") or "替换实例失败。")
    return ApiResult(ok=True, message="替换实例已发起。", data=result)


@app.get("/api/ops/monitor", dependencies=[Depends(require_token)])
async def get_monitor_config() -> ApiResult:
    state = store.load_state()
    return ApiResult(ok=True, message="ok", data=state.get("monitor_config") or {})


@app.put("/api/ops/monitor", dependencies=[Depends(require_token)])
async def save_monitor_config(payload: MonitorConfigRequest) -> ApiResult:
    config = store.update_monitor_config(payload.model_dump())
    return ApiResult(ok=True, message="监控配置已保存。", data=config)


@app.get("/api/ops/events", dependencies=[Depends(require_token)])
async def list_ops_events(limit: int = Query(default=80, ge=1, le=300)) -> ApiResult:
    events = (store.load_state().get("events") or [])[:limit]
    return ApiResult(ok=True, message="ok", data=events)


@app.get("/api/ops/command-presets", dependencies=[Depends(require_token)])
async def list_command_presets() -> ApiResult:
    return ApiResult(ok=True, message="ok", data=store.list_items("command_presets"))


@app.post("/api/ops/command-presets", dependencies=[Depends(require_token)])
async def save_command_preset(payload: CommandPresetRequest) -> ApiResult:
    saved = store.upsert_item("command_presets", payload.model_dump())
    return ApiResult(ok=True, message="命令预设已保存。", data=saved)


@app.delete("/api/ops/command-presets/{preset_id}", dependencies=[Depends(require_token)])
async def delete_command_preset(preset_id: str) -> ApiResult:
    if not store.delete_item("command_presets", preset_id):
        raise HTTPException(status_code=404, detail="命令预设不存在。")
    return ApiResult(ok=True, message="命令预设已删除。", data={"id": preset_id})


@app.post("/api/ops/commands/run", dependencies=[Depends(require_token)])
async def run_command(payload: RunCommandRequest) -> ApiResult:
    command = payload.command
    if payload.preset_id:
        preset = store.get_item("command_presets", payload.preset_id)
        if not preset:
            raise HTTPException(status_code=404, detail="命令预设不存在。")
        command = preset.get("command")
    if not command:
        raise HTTPException(status_code=400, detail="缺少命令内容。")

    results = []
    for server_id in payload.server_ids:
        server = store.get_item("servers", server_id)
        if not server:
            results.append({"server_id": server_id, "ok": False, "error": "服务器不存在"})
            continue
        try:
            output = run_ssh_command(server, command, timeout=payload.timeout_seconds)
            ok = output.get("exit_code") == 0
            results.append({"server_id": server_id, "server_name": server.get("name"), "ok": ok, **output})
            store.add_event("info" if ok else "warn", f"命令下发完成：{server.get('name')} exit={output.get('exit_code')}", {"server_id": server_id})
        except (SshRunError, Exception) as exc:
            results.append({"server_id": server_id, "server_name": server.get("name"), "ok": False, "error": str(exc)})
            store.add_event("error", f"命令下发失败：{server.get('name')}：{exc}", {"server_id": server_id})
    return ApiResult(ok=True, message="命令下发已完成。", data=results)


@app.get("/api/ops/startup-scripts", dependencies=[Depends(require_token)])
async def list_startup_scripts() -> ApiResult:
    return ApiResult(ok=True, message="ok", data=store.list_items("startup_scripts"))


@app.post("/api/ops/startup-scripts", dependencies=[Depends(require_token)])
async def save_startup_script(payload: StartupScriptPresetRequest) -> ApiResult:
    saved = store.upsert_item("startup_scripts", payload.model_dump())
    return ApiResult(ok=True, message="开机脚本预设已保存。", data=saved)


@app.delete("/api/ops/startup-scripts/{script_id}", dependencies=[Depends(require_token)])
async def delete_startup_script(script_id: str) -> ApiResult:
    if not store.delete_item("startup_scripts", script_id):
        raise HTTPException(status_code=404, detail="开机脚本预设不存在。")
    return ApiResult(ok=True, message="开机脚本预设已删除。", data={"id": script_id})
