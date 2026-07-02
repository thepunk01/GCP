# GCP Compute Panel

一个可以直接部署到服务器运行的 GCP Compute Engine 管理面板。

> 安装管理面板本身不需要填写 GCP Project ID。先把面板跑起来，进入网页后再在 Profile 里填写 Project ID，或上传 Service Account JSON 后自动读取。

## 功能

- Compute Engine 实例列表、创建、启动、停止、重启、删除
- 一键换外部临时 IP
- 概览统计：实例数、运行中、停止、外部 IP、磁盘、Zone 等
- 流量查询：24h / 7d / 30d / 90d
- Profile 管理：浏览器本地保存多个项目配置
- 上传 GCP Service Account JSON
- 可选 Cloudflare DNS 联动
- Docker Compose 一键部署

## 服务器一键安装

在 Debian / Ubuntu 服务器上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash
```

安装完成后访问：

```text
http://你的服务器IP:8080
```

安装脚本会自动：

1. 安装基础依赖
2. 安装 Docker 和 Docker Compose 插件
3. 克隆 `https://github.com/thepunk01/GCP.git` 到 `/opt/gcp-compute-panel`
4. 自动生成 `.env` 和随机 `PANEL_TOKEN`
5. 构建并启动容器
6. 直接开放 `0.0.0.0:8080`

如果你的云服务器安全组还没放行，需要放行：

```text
TCP 8080
来源 0.0.0.0/0
```

## 带域名安装

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash -s --   --domain panel.example.com
```

带 HTTPS：

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash -s --   --domain panel.example.com   --https   --email you@example.com
```

## 查看登录 Token

```bash
cd /opt/gcp-compute-panel
bash scripts/panelctl.sh token
```

或者看安装完成时终端输出的 `Panel Token`。

## 面板里配置 GCP

打开网页后：

1. 输入 `Panel Token` 登录
2. 在顶部 Profile / 项目输入框填写 GCP Project ID
3. 进入配置页上传 Service Account JSON
4. 刷新实例列表

Service Account 建议权限：

```text
roles/compute.instanceAdmin.v1
roles/monitoring.viewer
roles/iam.serviceAccountUser
```

## 一键更新

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/update.sh | sudo bash
```

或：

```bash
cd /opt/gcp-compute-panel
sudo bash scripts/update.sh
```

## 常用命令

```bash
cd /opt/gcp-compute-panel
bash scripts/panelctl.sh status
bash scripts/panelctl.sh logs
bash scripts/panelctl.sh restart
bash scripts/panelctl.sh token
```

## 手动部署

```bash
git clone https://github.com/thepunk01/GCP.git /opt/gcp-compute-panel
cd /opt/gcp-compute-panel
cp .env.example .env
openssl rand -hex 32
nano .env
docker compose up -d --build
```

## API

```text
GET  /api/config
GET  /api/credential/status
POST /api/credential/upload
GET  /api/health?project=...
GET  /api/overview?project=...
GET  /api/instances?project=...
POST /api/instances
POST /api/instances/action
POST /api/instances/change-ip
GET  /api/traffic?project=...&hours=24
POST /api/cloudflare/update-a-record
```

## 安全提醒

这个面板能创建、删除、关机、换 IP。公网部署时至少要：

- 使用强 `PANEL_TOKEN`
- 只开放给可信 IP，或放在 VPN / Cloudflare Access 后面
- 有域名时启用 HTTPS
