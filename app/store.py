from __future__ import annotations

import json
import os
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
STATE_PATH = DATA_DIR / "panel-state.json"

_DEFAULT_STATE: dict[str, Any] = {
    "version": 1,
    "servers": [],
    "command_presets": [],
    "startup_scripts": [],
    "monitor_config": {
        "enabled": False,
        "interval_seconds": 300,
        "max_parallel_checks": 5,
    },
    "events": [],
}

_lock = threading.RLock()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _merge_defaults(state: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(_DEFAULT_STATE)
    for key, value in state.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key].update(value)
        else:
            merged[key] = value
    return merged


def load_state() -> dict[str, Any]:
    with _lock:
        _ensure_dir()
        if not STATE_PATH.exists():
            save_state(deepcopy(_DEFAULT_STATE))
            return deepcopy(_DEFAULT_STATE)
        try:
            state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            return _merge_defaults(state)
        except Exception:
            backup = STATE_PATH.with_suffix(f".broken.{datetime.now().strftime('%Y%m%d%H%M%S')}.json")
            STATE_PATH.rename(backup)
            save_state(deepcopy(_DEFAULT_STATE))
            return deepcopy(_DEFAULT_STATE)


def save_state(state: dict[str, Any]) -> None:
    with _lock:
        _ensure_dir()
        tmp = STATE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(_merge_defaults(state), ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, STATE_PATH)
        try:
            os.chmod(STATE_PATH, 0o600)
        except Exception:
            pass


def list_items(key: str) -> list[dict[str, Any]]:
    return load_state().get(key, []) or []


def get_item(key: str, item_id: str) -> dict[str, Any] | None:
    for item in list_items(key):
        if item.get("id") == item_id:
            return item
    return None


def upsert_item(key: str, item: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        state = load_state()
        items = state.setdefault(key, [])
        now = utc_now()
        if not item.get("id"):
            prefix = {"servers": "srv", "command_presets": "cmd", "startup_scripts": "script"}.get(key, "item")
            item["id"] = new_id(prefix)
            item["created_at"] = now
        item["updated_at"] = now
        for idx, old in enumerate(items):
            if old.get("id") == item["id"]:
                merged = {**old, **item, "updated_at": now}
                items[idx] = merged
                save_state(state)
                return merged
        items.insert(0, item)
        save_state(state)
        return item


def delete_item(key: str, item_id: str) -> bool:
    with _lock:
        state = load_state()
        items = state.setdefault(key, [])
        new_items = [item for item in items if item.get("id") != item_id]
        if len(new_items) == len(items):
            return False
        state[key] = new_items
        save_state(state)
        return True


def update_monitor_config(config: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        state = load_state()
        current = state.setdefault("monitor_config", deepcopy(_DEFAULT_STATE["monitor_config"]))
        current.update(config)
        current["updated_at"] = utc_now()
        save_state(state)
        return current


def add_event(level: str, message: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    with _lock:
        state = load_state()
        event = {"id": new_id("evt"), "time": utc_now(), "level": level, "message": message, "data": data or {}}
        events = state.setdefault("events", [])
        events.insert(0, event)
        state["events"] = events[:300]
        save_state(state)
        return event


def update_server_state(server_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    with _lock:
        state = load_state()
        servers = state.setdefault("servers", [])
        for idx, server in enumerate(servers):
            if server.get("id") == server_id:
                state_block = {**(server.get("state") or {}), **patch}
                server["state"] = state_block
                server["updated_at"] = utc_now()
                servers[idx] = server
                save_state(state)
                return server
        return None
