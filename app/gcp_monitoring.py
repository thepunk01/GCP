from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import google.auth
from google.auth.transport.requests import AuthorizedSession
from google.auth.exceptions import DefaultCredentialsError

from app.gcp_compute import GcpApiError, SCOPES


MONITORING_BASE = "https://monitoring.googleapis.com/v3"
NETWORK_METRICS = {
    "sent": "compute.googleapis.com/instance/network/sent_bytes_count",
    "received": "compute.googleapis.com/instance/network/received_bytes_count",
}


class GcpMonitoring:
    def __init__(self) -> None:
        try:
            credentials, _ = google.auth.default(scopes=SCOPES)
        except DefaultCredentialsError as exc:
            raise GcpApiError(
                "未找到 Google Application Default Credentials。请先运行 `gcloud auth application-default login` "
                "或设置 GOOGLE_APPLICATION_CREDENTIALS。"
            ) from exc
        self.session = AuthorizedSession(credentials)

    def _request(self, path: str, *, params: list[tuple[str, str]] | None = None) -> dict[str, Any]:
        response = self.session.get(f"{MONITORING_BASE}/{path.lstrip('/')}", params=params, timeout=60)
        if response.status_code >= 400:
            try:
                payload = response.json()
                message = payload.get("error", {}).get("message") or payload
            except Exception:
                message = response.text
            raise GcpApiError(f"Cloud Monitoring API 错误 {response.status_code}: {message}")
        if not response.text:
            return {}
        return response.json()

    def query_network_bytes(
        self,
        project: str,
        *,
        hours: int = 24,
        instance_id: str | None = None,
        align_seconds: int = 3600,
    ) -> dict[str, Any]:
        end = datetime.now(timezone.utc).replace(microsecond=0)
        start = end - timedelta(hours=hours)
        result: dict[str, Any] = {
            "project": project,
            "start": start.isoformat().replace("+00:00", "Z"),
            "end": end.isoformat().replace("+00:00", "Z"),
            "align_seconds": align_seconds,
            "series": [],
            "total_sent_bytes": 0,
            "total_received_bytes": 0,
        }

        buckets: dict[str, dict[str, int]] = defaultdict(lambda: {"sent": 0, "received": 0})
        for direction, metric in NETWORK_METRICS.items():
            data = self._list_time_series(project, metric, start, end, instance_id, align_seconds)
            total = 0
            for ts in data.get("timeSeries", []) or []:
                for point in ts.get("points", []) or []:
                    interval = point.get("interval", {})
                    ts_key = interval.get("endTime") or interval.get("startTime")
                    value_obj = point.get("value", {})
                    value = int(value_obj.get("int64Value") or value_obj.get("doubleValue") or 0)
                    if ts_key:
                        buckets[ts_key][direction] += value
                    total += value
            result[f"total_{direction}_bytes"] = total

        for ts_key in sorted(buckets.keys()):
            sent = buckets[ts_key]["sent"]
            received = buckets[ts_key]["received"]
            result["series"].append(
                {
                    "time": ts_key,
                    "sent_bytes": sent,
                    "received_bytes": received,
                    "total_bytes": sent + received,
                }
            )
        return result

    def _list_time_series(
        self,
        project: str,
        metric_type: str,
        start: datetime,
        end: datetime,
        instance_id: str | None,
        align_seconds: int,
    ) -> dict[str, Any]:
        metric_filter = f'metric.type = "{metric_type}" AND resource.type = "gce_instance"'
        if instance_id:
            metric_filter += f' AND resource.labels.instance_id = "{instance_id}"'
        params: list[tuple[str, str]] = [
            ("filter", metric_filter),
            ("interval.startTime", start.isoformat().replace("+00:00", "Z")),
            ("interval.endTime", end.isoformat().replace("+00:00", "Z")),
            ("aggregation.alignmentPeriod", f"{align_seconds}s"),
            ("aggregation.perSeriesAligner", "ALIGN_SUM"),
            ("view", "FULL"),
        ]
        return self._request(f"projects/{project}/timeSeries", params=params)
