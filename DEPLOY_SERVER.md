# 服务器部署说明

## 直接安装

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash
```

安装完成后访问：

```text
http://服务器IP:8080
```

服务器安全组放行 TCP 8080。

## Debian / Ubuntu 支持

脚本会根据系统自动使用 Docker 官方 Debian 或 Ubuntu 源，并会先清理历史残留的错误 Docker 源。

## 更新

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/update.sh | sudo bash
```

## 面板功能

- GCP 实例管理
- 添加已经开机的服务器
- TCP / HTTP / HTTPS 检测
- 检测失败自动换 IP
- 实例不可用自动替换
- SSH 预设命令下发
- 新建实例开机脚本预设

## 查看日志

```bash
cd /opt/gcp-compute-panel
docker compose logs -f
```
