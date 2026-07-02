from __future__ import annotations

import os
from typing import Any

import requests

from app.gcp_compute import GcpApiError


CF_BASE = "https://api.cloudflare.com/client/v4"


class CloudflareClient:
    def __init__(self, token: str | None = None) -> None:
        self.token = (token or os.getenv("CF_API_TOKEN", "")).strip()
        if not self.token:
            raise GcpApiError("服务端未配置 CF_API_TOKEN，无法自动更新 Cloudflare DNS。")
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})

    def _request(self, method: str, path: str, *, json: dict[str, Any] | None = None) -> dict[str, Any]:
        response = self.session.request(method, f"{CF_BASE}/{path.lstrip('/')}", json=json, timeout=30)
        try:
            payload = response.json()
        except Exception:
            payload = {"success": False, "errors": [response.text]}
        if response.status_code >= 400 or payload.get("success") is False:
            errors = payload.get("errors") or payload
            raise GcpApiError(f"Cloudflare API 错误 {response.status_code}: {errors}")
        return payload

    def get_record(self, zone_id: str, record_id: str) -> dict[str, Any]:
        payload = self._request("GET", f"zones/{zone_id}/dns_records/{record_id}")
        return payload.get("result") or {}

    def update_record_content(
        self,
        *,
        zone_id: str,
        record_id: str,
        content: str,
        name: str | None = None,
        record_type: str | None = None,
        proxied: bool | None = None,
    ) -> dict[str, Any]:
        current = self.get_record(zone_id, record_id)
        if not current:
            raise GcpApiError("Cloudflare DNS 记录不存在或无权访问。")
        body = {
            "type": record_type or current.get("type") or "A",
            "name": name or current.get("name"),
            "content": content,
            "ttl": current.get("ttl", 1),
            "proxied": current.get("proxied", False) if proxied is None else proxied,
        }
        # Preserve optional fields Cloudflare may already have.
        for key in ("comment", "tags"):
            if key in current and current[key] is not None:
                body[key] = current[key]
        payload = self._request("PUT", f"zones/{zone_id}/dns_records/{record_id}", json=body)
        return payload.get("result") or {}
