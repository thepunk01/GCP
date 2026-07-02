from __future__ import annotations

import socket
import time
from typing import Any
from urllib.parse import urlparse

import requests


def probe_server(server: dict[str, Any]) -> dict[str, Any]:
    check = server.get("check") or {}
    host = (server.get("host") or "").strip()
    timeout = float(check.get("timeout_seconds") or 5)
    check_type = (check.get("type") or "tcp").lower()
    started = time.perf_counter()

    if not host:
        return {"ok": False, "latency_ms": None, "error": "服务器 host 为空"}

    try:
        if check_type in {"http", "https"}:
            url = (check.get("url") or "").strip()
            if not url:
                scheme = "https" if check_type == "https" else "http"
                port = check.get("port")
                path = check.get("path") or "/"
                netloc = host if not port else f"{host}:{int(port)}"
                url = f"{scheme}://{netloc}{path if str(path).startswith('/') else '/' + str(path)}"
            parsed = urlparse(url)
            if parsed.scheme not in {"http", "https"}:
                raise ValueError("HTTP 检测 URL 必须以 http:// 或 https:// 开头")
            response = requests.get(url, timeout=timeout, allow_redirects=bool(check.get("follow_redirects", True)))
            expected = int(check.get("expected_status") or 0)
            ok = response.status_code == expected if expected else response.status_code < 500
            return {
                "ok": ok,
                "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                "status_code": response.status_code,
                "error": None if ok else f"HTTP 状态码 {response.status_code}",
                "target": url,
            }

        port = int(check.get("port") or server.get("port") or 22)
        with socket.create_connection((host, port), timeout=timeout):
            return {
                "ok": True,
                "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                "error": None,
                "target": f"tcp://{host}:{port}",
            }
    except Exception as exc:
        return {
            "ok": False,
            "latency_ms": round((time.perf_counter() - started) * 1000, 2),
            "error": str(exc),
        }
