from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any

import google.auth
from google.auth.transport.requests import AuthorizedSession
from google.auth.exceptions import DefaultCredentialsError
from requests import Response


COMPUTE_BASE = "https://compute.googleapis.com/compute/v1"
SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


class GcpApiError(RuntimeError):
    pass


@dataclass
class OperationResult:
    name: str
    status: str | None
    target_link: str | None = None
    raw: dict[str, Any] | None = None


def _last(url_or_name: str | None) -> str | None:
    if not url_or_name:
        return None
    return url_or_name.rstrip("/").split("/")[-1]


def zone_from_scope(scope: str) -> str:
    # aggregatedList returns keys such as "zones/us-central1-a".
    return scope.split("/", 1)[-1]


class GcpCompute:
    def __init__(self) -> None:
        try:
            credentials, _ = google.auth.default(scopes=SCOPES)
        except DefaultCredentialsError as exc:
            raise GcpApiError(
                "未找到 Google Application Default Credentials。请先运行 `gcloud auth application-default login` "
                "或设置 GOOGLE_APPLICATION_CREDENTIALS。"
            ) from exc
        self.session = AuthorizedSession(credentials)

    def _url(self, path: str) -> str:
        return f"{COMPUTE_BASE}/{path.lstrip('/')}"

    def _request(self, method: str, path: str, *, params: dict | None = None, json: dict | None = None) -> dict[str, Any]:
        response: Response = self.session.request(method, self._url(path), params=params, json=json, timeout=60)
        if response.status_code >= 400:
            try:
                payload = response.json()
                message = payload.get("error", {}).get("message") or payload
            except Exception:
                message = response.text
            raise GcpApiError(f"GCP API 错误 {response.status_code}: {message}")
        if not response.text:
            return {}
        return response.json()

    def wait_zone_operation(self, project: str, zone: str, operation: dict[str, Any], wait: bool = True) -> OperationResult:
        op_name = operation.get("name")
        if not op_name or not wait:
            return OperationResult(name=op_name or "", status=operation.get("status"), target_link=operation.get("targetLink"), raw=operation)
        waited = self._request("POST", f"projects/{project}/zones/{zone}/operations/{op_name}/wait")
        if waited.get("error"):
            raise GcpApiError(f"操作失败: {waited['error']}")
        return OperationResult(name=op_name, status=waited.get("status"), target_link=waited.get("targetLink"), raw=waited)

    def aggregated_instances(self, project: str) -> list[dict[str, Any]]:
        data = self._request(
            "GET",
            f"projects/{project}/aggregated/instances",
            params={"returnPartialSuccess": "true"},
        )
        instances: list[dict[str, Any]] = []
        for scope, scoped_list in data.get("items", {}).items():
            for instance in scoped_list.get("instances", []) or []:
                instances.append(self._normalize_instance(instance, zone_from_scope(scope)))
        instances.sort(key=lambda x: (x.get("zone") or "", x.get("name") or ""))
        return instances

    def get_instance_raw(self, project: str, zone: str, name: str) -> dict[str, Any]:
        return self._request("GET", f"projects/{project}/zones/{zone}/instances/{name}")

    def get_instance(self, project: str, zone: str, name: str) -> dict[str, Any]:
        return self._normalize_instance(self.get_instance_raw(project, zone, name), zone)

    def create_instance(self, request: Any) -> OperationResult:
        body = self._build_instance_body(request)
        operation = self._request("POST", f"projects/{request.project}/zones/{request.zone}/instances", json=body)
        return self.wait_zone_operation(request.project, request.zone, operation)

    def action(self, project: str, zone: str, name: str, action: str) -> OperationResult:
        if action == "delete":
            operation = self._request("DELETE", f"projects/{project}/zones/{zone}/instances/{name}")
        elif action in {"start", "stop", "reset"}:
            operation = self._request("POST", f"projects/{project}/zones/{zone}/instances/{name}/{action}")
        else:
            raise GcpApiError(f"不支持的操作: {action}")
        return self.wait_zone_operation(project, zone, operation)

    def rotate_external_ip(
        self,
        project: str,
        zone: str,
        name: str,
        network_interface: str = "nic0",
        access_config_name: str = "External NAT",
        network_tier: str = "PREMIUM",
    ) -> dict[str, Any]:
        raw = self.get_instance_raw(project, zone, name)
        nic = None
        for candidate in raw.get("networkInterfaces", []) or []:
            if candidate.get("name") == network_interface:
                nic = candidate
                break
        if not nic:
            raise GcpApiError(f"实例 {name} 不存在网卡 {network_interface}")

        access_configs = nic.get("accessConfigs", []) or []
        existing = None
        for config in access_configs:
            if config.get("name") == access_config_name or not existing:
                existing = config
        old_ip = existing.get("natIP") if existing else None

        if existing:
            delete_op = self._request(
                "POST",
                f"projects/{project}/zones/{zone}/instances/{name}/deleteAccessConfig",
                params={"accessConfig": existing.get("name", access_config_name), "networkInterface": network_interface},
            )
            self.wait_zone_operation(project, zone, delete_op)

        add_body = {
            "name": access_config_name,
            "type": "ONE_TO_ONE_NAT",
            "networkTier": network_tier,
        }
        add_op = self._request(
            "POST",
            f"projects/{project}/zones/{zone}/instances/{name}/addAccessConfig",
            params={"networkInterface": network_interface},
            json=add_body,
        )
        self.wait_zone_operation(project, zone, add_op)
        refreshed = self.get_instance(project, zone, name)
        return {"old_ip": old_ip, "new_ip": refreshed.get("external_ip"), "instance": refreshed}

    def overview(self, project: str) -> dict[str, Any]:
        instances = self.aggregated_instances(project)
        by_status = Counter(i.get("status") or "UNKNOWN" for i in instances)
        by_zone = Counter(i.get("zone") or "UNKNOWN" for i in instances)
        by_machine = Counter(i.get("machine_type") or "UNKNOWN" for i in instances)
        disk_gb = sum(sum(d.get("disk_gb") or 0 for d in i.get("disks", [])) for i in instances)
        external_ip_count = sum(1 for i in instances if i.get("external_ip"))
        e2_micro_count = sum(1 for i in instances if i.get("machine_type") == "e2-micro")
        return {
            "total": len(instances),
            "running": by_status.get("RUNNING", 0),
            "stopped": by_status.get("TERMINATED", 0),
            "external_ip_count": external_ip_count,
            "disk_gb": disk_gb,
            "zone_count": len(by_zone),
            "e2_micro_count": e2_micro_count,
            "by_status": dict(by_status),
            "by_zone": dict(by_zone),
            "by_machine": dict(by_machine),
        }

    def _build_instance_body(self, req: Any) -> dict[str, Any]:
        machine_type = req.machine_type
        if "/" not in machine_type:
            machine_type = f"zones/{req.zone}/machineTypes/{machine_type}"

        disk = {
            "boot": True,
            "autoDelete": True,
            "type": "PERSISTENT",
            "initializeParams": {
                "sourceImage": req.source_image,
                "diskSizeGb": str(req.disk_gb),
            },
        }

        nic: dict[str, Any] = {"network": req.network}
        if req.subnetwork:
            nic["subnetwork"] = req.subnetwork
        if req.external_ip:
            nic["accessConfigs"] = [{"name": "External NAT", "type": "ONE_TO_ONE_NAT", "networkTier": req.network_tier}]

        body: dict[str, Any] = {
            "name": req.name,
            "machineType": machine_type,
            "disks": [disk],
            "networkInterfaces": [nic],
        }
        if req.tags:
            body["tags"] = {"items": req.tags}
        if req.startup_script:
            body["metadata"] = {"items": [{"key": "startup-script", "value": req.startup_script}]}
        if req.service_account_email:
            body["serviceAccounts"] = [{"email": req.service_account_email, "scopes": req.service_account_scopes}]
        return body

    def _normalize_instance(self, instance: dict[str, Any], zone: str | None = None) -> dict[str, Any]:
        nics = instance.get("networkInterfaces", []) or []
        primary_nic = nics[0] if nics else {}
        access_configs = primary_nic.get("accessConfigs", []) or []
        primary_access = access_configs[0] if access_configs else {}
        disks = []
        for disk in instance.get("disks", []) or []:
            disks.append(
                {
                    "device_name": disk.get("deviceName"),
                    "boot": disk.get("boot", False),
                    "auto_delete": disk.get("autoDelete", False),
                    "disk_gb": int(disk.get("diskSizeGb") or 0),
                    "type": _last(disk.get("type")),
                    "source": _last(disk.get("source")),
                }
            )
        return {
            "id": str(instance.get("id", "")),
            "name": instance.get("name"),
            "status": instance.get("status"),
            "zone": zone or _last(instance.get("zone")),
            "machine_type": _last(instance.get("machineType")),
            "creation_timestamp": instance.get("creationTimestamp"),
            "internal_ip": primary_nic.get("networkIP"),
            "external_ip": primary_access.get("natIP"),
            "network": _last(primary_nic.get("network")),
            "network_interface": primary_nic.get("name"),
            "tags": (instance.get("tags") or {}).get("items", []),
            "disks": disks,
            "self_link": instance.get("selfLink"),
        }
