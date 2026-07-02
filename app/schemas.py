from __future__ import annotations

from typing import Literal, Any
from pydantic import BaseModel, Field, field_validator


class CreateInstanceRequest(BaseModel):
    project: str = Field(..., min_length=3)
    zone: str = Field(..., min_length=3)
    name: str = Field(..., min_length=1, pattern=r"^[a-z]([-a-z0-9]*[a-z0-9])?$")
    machine_type: str = Field(default="e2-micro")
    source_image: str = Field(default="projects/debian-cloud/global/images/family/debian-12")
    disk_gb: int = Field(default=10, ge=10, le=65536)
    network: str = Field(default="global/networks/default")
    subnetwork: str | None = None
    external_ip: bool = True
    network_tier: Literal["PREMIUM", "STANDARD"] = "PREMIUM"
    tags: list[str] = Field(default_factory=list)
    startup_script: str | None = None
    service_account_email: str | None = None
    service_account_scopes: list[str] = Field(default_factory=lambda: ["https://www.googleapis.com/auth/cloud-platform"])

    @field_validator("machine_type")
    @classmethod
    def normalize_machine_type(cls, value: str) -> str:
        return value.strip()


class InstanceActionRequest(BaseModel):
    project: str = Field(..., min_length=3)
    zone: str = Field(..., min_length=3)
    name: str = Field(..., min_length=1)
    action: Literal["start", "stop", "reset", "delete"]


class RotateIpRequest(BaseModel):
    project: str = Field(..., min_length=3)
    zone: str = Field(..., min_length=3)
    name: str = Field(..., min_length=1)
    network_interface: str = "nic0"
    access_config_name: str = "External NAT"
    network_tier: Literal["PREMIUM", "STANDARD"] = "PREMIUM"
    update_cloudflare_dns: bool = False
    cloudflare_zone_id: str | None = None
    cloudflare_record_id: str | None = None
    cloudflare_record_name: str | None = None
    cloudflare_record_type: Literal["A", "AAAA"] = "A"
    cloudflare_proxied: bool | None = None


class ServerCheckConfig(BaseModel):
    enabled: bool = True
    type: Literal["tcp", "http", "https"] = "tcp"
    port: int | None = Field(default=22, ge=1, le=65535)
    path: str = "/"
    url: str | None = None
    expected_status: int | None = Field(default=None, ge=100, le=599)
    follow_redirects: bool = True
    timeout_seconds: int = Field(default=5, ge=1, le=60)
    interval_seconds: int | None = Field(default=None, ge=10, le=86400)
    failure_threshold: int = Field(default=3, ge=1, le=20)
    action_cooldown_seconds: int = Field(default=900, ge=60, le=86400)
    rotate_ip_on_blocked: bool = False
    replace_on_unavailable: bool = False


class ServerSshConfig(BaseModel):
    username: str | None = None
    port: int = Field(default=22, ge=1, le=65535)
    private_key: str | None = None
    password: str | None = None


class ReplacementConfig(BaseModel):
    delete_old_after_replace: bool = False
    template: dict[str, Any] = Field(default_factory=dict)


class ManagedServerRequest(BaseModel):
    id: str | None = None
    name: str = Field(..., min_length=1, max_length=80)
    host: str = Field(..., min_length=1, max_length=255)
    port: int | None = Field(default=None, ge=1, le=65535)
    provider: Literal["manual", "gcp"] = "manual"
    project: str | None = None
    zone: str | None = None
    instance_name: str | None = None
    network_interface: str = "nic0"
    access_config_name: str = "External NAT"
    network_tier: Literal["PREMIUM", "STANDARD"] = "PREMIUM"
    tags: list[str] = Field(default_factory=list)
    check: ServerCheckConfig = Field(default_factory=ServerCheckConfig)
    ssh: ServerSshConfig = Field(default_factory=ServerSshConfig)
    replacement: ReplacementConfig = Field(default_factory=ReplacementConfig)


class MonitorConfigRequest(BaseModel):
    enabled: bool = False
    interval_seconds: int = Field(default=300, ge=10, le=86400)
    max_parallel_checks: int = Field(default=5, ge=1, le=20)


class CommandPresetRequest(BaseModel):
    id: str | None = None
    name: str = Field(..., min_length=1, max_length=80)
    command: str = Field(..., min_length=1, max_length=20000)
    description: str | None = None


class RunCommandRequest(BaseModel):
    server_ids: list[str] = Field(..., min_length=1)
    preset_id: str | None = None
    command: str | None = Field(default=None, max_length=20000)
    timeout_seconds: int = Field(default=60, ge=3, le=3600)


class StartupScriptPresetRequest(BaseModel):
    id: str | None = None
    name: str = Field(..., min_length=1, max_length=80)
    script: str = Field(..., min_length=1, max_length=50000)
    description: str | None = None


class ApiResult(BaseModel):
    ok: bool
    message: str
    data: dict | list | None = None
