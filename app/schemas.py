from __future__ import annotations

from typing import Literal
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


class ApiResult(BaseModel):
    ok: bool
    message: str
    data: dict | list | None = None
