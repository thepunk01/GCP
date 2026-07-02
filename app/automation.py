from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any

from app.gcp_compute import GcpApiError, GcpCompute
from app.probes import probe_server
from app.schemas import CreateInstanceRequest
from app import store

_task: asyncio.Task | None = None
_stop: asyncio.Event | None = None


def _parse_time(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _now_ts() -> float:
    return datetime.now(timezone.utc).timestamp()


def server_due(server: dict[str, Any], global_interval: int) -> bool:
    check = server.get("check") or {}
    if not check.get("enabled", False):
        return False
    interval = int(check.get("interval_seconds") or global_interval or 300)
    state = server.get("state") or {}
    return _now_ts() - _parse_time(state.get("last_checked_at")) >= max(interval, 10)


async def check_server_once(server: dict[str, Any], *, allow_actions: bool = False) -> dict[str, Any]:
    result = await asyncio.to_thread(probe_server, server)
    state = server.get("state") or {}
    failures = 0 if result.get("ok") else int(state.get("consecutive_failures") or 0) + 1
    patch = {
        "last_status": "ok" if result.get("ok") else "failed",
        "last_checked_at": store.utc_now(),
        "last_latency_ms": result.get("latency_ms"),
        "last_error": result.get("error"),
        "last_target": result.get("target"),
        "last_status_code": result.get("status_code"),
        "consecutive_failures": failures,
    }
    updated = store.update_server_state(server["id"], patch) or server
    merged = {**server, "state": {**state, **patch}}

    if result.get("ok"):
        return {"server": updated, "probe": result, "action": None}

    if allow_actions:
        action = await maybe_repair_server(merged, failures)
        return {"server": store.get_item("servers", server["id"]) or updated, "probe": result, "action": action}
    return {"server": updated, "probe": result, "action": None}


async def maybe_repair_server(server: dict[str, Any], failures: int) -> dict[str, Any] | None:
    check = server.get("check") or {}
    threshold = int(check.get("failure_threshold") or 3)
    if failures < threshold:
        return None

    cooldown = int(check.get("action_cooldown_seconds") or 900)
    state = server.get("state") or {}
    if _now_ts() - _parse_time(state.get("last_action_at")) < cooldown:
        return {"skipped": True, "reason": "cooldown"}

    if check.get("rotate_ip_on_blocked"):
        return await asyncio.to_thread(rotate_server_ip, server)
    if check.get("replace_on_unavailable"):
        return await asyncio.to_thread(replace_server_instance, server)
    return None


def rotate_server_ip(server: dict[str, Any]) -> dict[str, Any]:
    if server.get("provider") != "gcp":
        msg = "只有绑定 GCP 实例的服务器才能自动换 IP。"
        store.add_event("warn", msg, {"server_id": server.get("id"), "server": server.get("name")})
        return {"ok": False, "message": msg}
    project = server.get("project")
    zone = server.get("zone")
    name = server.get("instance_name") or server.get("name")
    if not project or not zone or not name:
        msg = "自动换 IP 缺少 project / zone / instance_name。"
        store.add_event("warn", msg, {"server_id": server.get("id")})
        return {"ok": False, "message": msg}
    try:
        data = GcpCompute().rotate_external_ip(
            project=project,
            zone=zone,
            name=name,
            network_interface=server.get("network_interface") or "nic0",
            access_config_name=server.get("access_config_name") or "External NAT",
            network_tier=server.get("network_tier") or "PREMIUM",
        )
        new_ip = data.get("new_ip")
        patch = {"last_action_at": store.utc_now(), "last_action": "rotate_ip", "last_action_result": data}
        if new_ip:
            patch["current_ip"] = new_ip
            # host 默认同步为新外部 IP，便于下一轮检测和 SSH。
            server["host"] = new_ip
            server["updated_at"] = store.utc_now()
            store.upsert_item("servers", {**server, "host": new_ip})
        store.update_server_state(server["id"], patch)
        store.add_event("info", f"自动换 IP 完成：{server.get('name')} {data.get('old_ip')} -> {new_ip}", {"server_id": server.get("id"), **data})
        return {"ok": True, "type": "rotate_ip", **data}
    except (GcpApiError, Exception) as exc:
        store.update_server_state(server["id"], {"last_action_at": store.utc_now(), "last_action": "rotate_ip", "last_action_error": str(exc)})
        store.add_event("error", f"自动换 IP 失败：{server.get('name')}：{exc}", {"server_id": server.get("id")})
        return {"ok": False, "type": "rotate_ip", "message": str(exc)}


def _replacement_payload(server: dict[str, Any]) -> dict[str, Any]:
    tpl = dict((server.get("replacement") or {}).get("template") or {})
    project = tpl.get("project") or server.get("project")
    zone = tpl.get("zone") or server.get("zone")
    base_name = server.get("instance_name") or server.get("name") or "instance"
    ts = datetime.now(timezone.utc).strftime("%m%d%H%M")
    name = tpl.get("name") or f"{base_name}-r-{ts}"
    tpl.update({"project": project, "zone": zone, "name": name})
    tpl.setdefault("machine_type", "e2-micro")
    tpl.setdefault("source_image", "projects/debian-cloud/global/images/family/debian-12")
    tpl.setdefault("disk_gb", 10)
    tpl.setdefault("network", "global/networks/default")
    tpl.setdefault("external_ip", True)
    tpl.setdefault("network_tier", "PREMIUM")
    tpl.setdefault("tags", [])
    return tpl


def replace_server_instance(server: dict[str, Any]) -> dict[str, Any]:
    if server.get("provider") != "gcp":
        msg = "只有绑定 GCP 实例的服务器才能自动替换实例。"
        store.add_event("warn", msg, {"server_id": server.get("id")})
        return {"ok": False, "message": msg}
    try:
        payload = _replacement_payload(server)
        request = CreateInstanceRequest(**payload)
        op = GcpCompute().create_instance(request)
        data = {"operation": op.raw, "replacement": payload}
        store.update_server_state(server["id"], {"last_action_at": store.utc_now(), "last_action": "replace_instance", "last_action_result": data})
        store.add_event("info", f"替换实例已创建：{server.get('name')} -> {payload.get('name')}", {"server_id": server.get("id"), **data})
        if (server.get("replacement") or {}).get("delete_old_after_replace"):
            try:
                old_name = server.get("instance_name") or server.get("name")
                GcpCompute().action(server["project"], server["zone"], old_name, "delete")
                store.add_event("info", f"旧实例已删除：{old_name}", {"server_id": server.get("id")})
            except Exception as exc:
                store.add_event("error", f"旧实例删除失败：{exc}", {"server_id": server.get("id")})
        return {"ok": True, "type": "replace_instance", **data}
    except Exception as exc:
        store.update_server_state(server["id"], {"last_action_at": store.utc_now(), "last_action": "replace_instance", "last_action_error": str(exc)})
        store.add_event("error", f"替换实例失败：{server.get('name')}：{exc}", {"server_id": server.get("id")})
        return {"ok": False, "type": "replace_instance", "message": str(exc)}


async def monitor_loop() -> None:
    while not (_stop and _stop.is_set()):
        try:
            state = store.load_state()
            config = state.get("monitor_config") or {}
            if config.get("enabled"):
                interval = int(config.get("interval_seconds") or 300)
                servers = [srv for srv in state.get("servers", []) if server_due(srv, interval)]
                max_parallel = max(1, min(int(config.get("max_parallel_checks") or 5), 20))
                sem = asyncio.Semaphore(max_parallel)

                async def guarded(srv: dict[str, Any]) -> None:
                    async with sem:
                        await check_server_once(srv, allow_actions=True)

                if servers:
                    await asyncio.gather(*(guarded(s) for s in servers), return_exceptions=True)
            await asyncio.sleep(5)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            store.add_event("error", f"监控循环异常：{exc}")
            await asyncio.sleep(10)


def start_monitor() -> None:
    global _task, _stop
    if _task and not _task.done():
        return
    _stop = asyncio.Event()
    _task = asyncio.create_task(monitor_loop())


async def stop_monitor() -> None:
    global _task
    if _stop:
        _stop.set()
    if _task:
        _task.cancel()
        try:
            await _task
        except BaseException:
            pass
        _task = None
