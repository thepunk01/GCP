from __future__ import annotations

import io
from typing import Any

try:
    import paramiko
except Exception:  # pragma: no cover
    paramiko = None


class SshRunError(RuntimeError):
    pass


def run_ssh_command(server: dict[str, Any], command: str, timeout: int = 60) -> dict[str, Any]:
    if paramiko is None:
        raise SshRunError("服务端未安装 paramiko，无法使用 SSH 命令下发。")
    ssh = server.get("ssh") or {}
    host = (server.get("host") or "").strip()
    username = (ssh.get("username") or server.get("username") or "root").strip()
    port = int(ssh.get("port") or server.get("ssh_port") or 22)
    password = ssh.get("password") or None
    private_key = ssh.get("private_key") or None

    if not host:
        raise SshRunError("服务器 host 为空。")
    if not username:
        raise SshRunError("SSH 用户名为空。")
    if not password and not private_key:
        raise SshRunError("缺少 SSH 密码或私钥。")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs: dict[str, Any] = {
        "hostname": host,
        "port": port,
        "username": username,
        "timeout": timeout,
        "banner_timeout": timeout,
        "auth_timeout": timeout,
        "look_for_keys": False,
        "allow_agent": False,
    }
    if private_key:
        key_stream = io.StringIO(private_key)
        key_error: Exception | None = None
        for key_cls in (paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.DSSKey):
            key_stream.seek(0)
            try:
                kwargs["pkey"] = key_cls.from_private_key(key_stream)
                key_error = None
                break
            except Exception as exc:
                key_error = exc
        if key_error and "pkey" not in kwargs:
            raise SshRunError(f"私钥解析失败：{key_error}")
    else:
        kwargs["password"] = password

    try:
        client.connect(**kwargs)
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        exit_code = stdout.channel.recv_exit_status()
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        return {"exit_code": exit_code, "stdout": out[-20000:], "stderr": err[-20000:]}
    finally:
        client.close()
