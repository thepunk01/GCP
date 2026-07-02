# GCP Compute Panel

一个可以直接部署到服务器运行的云服务器管理面板。安装面板本身不需要填写 GCP Project ID；先把面板跑起来，进入网页后再配置 GCP 项目、上传 Service Account JSON、添加服务器资产。

## 主要功能

### GCP Compute Engine

- 实例列表、创建、启动、停止、重启、删除
- 一键更换外部临时 IP
- 新建实例 startup script / 开机脚本
- 开机脚本预设管理
- 概览统计：实例数、运行中、停止、外部 IP、磁盘、Zone 等
- 流量查询：24h / 7d / 30d / 90d
- Profile 管理：浏览器本地保存多个项目配置
- 上传 GCP Service Account JSON
- 可选 Cloudflare DNS 联动

### 服务器资产池 / 自动化运维

- 添加已经开机的服务器，支持普通服务器和 GCP 绑定实例
- TCP / HTTP / HTTPS 连通性检测
- 检测时间可调：全局间隔 + 单台服务器间隔
- 失败阈值可调
- 绑定 GCP 实例后，检测失败可自动更换外部 IP
- 绑定 GCP 实例后，实例不可用可自动创建替换实例
- 替换实例模板 JSON，可配置机器类型、镜像、磁盘、网络、开机脚本等
- 操作事件日志

### 命令下发

- 服务器 SSH 信息配置
- 预设命令保存
- 批量向服务器下发预设命令或手动命令
- 命令执行结果回显

> 安全提醒：SSH 密码 / 私钥会保存在服务器的 `/data/panel-state.json` 中。建议只使用专用低权限 SSH Key，并把面板放在 VPN、Cloudflare Access、IP 白名单或内网后面。

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

1. 清理错误 Docker APT 源
2. 安装基础依赖
3. 安装 Docker 和 Docker Compose 插件
4. 克隆 `https://github.com/thepunk01/GCP.git` 到 `/opt/gcp-compute-panel`
5. 自动生成 `.env` 和随机 `PANEL_TOKEN`
6. 构建并启动容器
7. 直接监听 `0.0.0.0:8080`

云服务器安全组需要放行：

```text
TCP 8080
来源 0.0.0.0/0
```

## 带域名安装

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash -s -- \
  --domain panel.example.com
```

带 HTTPS：

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash -s -- \
  --domain panel.example.com \
  --https \
  --email you@example.com
```

## 查看登录 Token

```bash
cd /opt/gcp-compute-panel
bash scripts/panelctl.sh token
```

## 面板里配置 GCP

打开网页后：

1. 输入 `Panel Token` 登录
2. 在 Profile / 项目输入框填写 GCP Project ID
3. 上传 Service Account JSON
4. 刷新实例列表

Service Account 建议权限：

```text
roles/compute.instanceAdmin.v1
roles/monitoring.viewer
roles/iam.serviceAccountUser
```

## 添加已经开机的服务器

进入 `服务器资产池`：

1. 填名称和服务器 IP / 域名
2. 类型选择 `普通服务器` 或 `GCP 实例`
3. 如果要自动换 IP / 自动替换，类型必须选 `GCP 实例`，并填写 Project、Zone、实例名
4. 配置检测类型、检测端口、检测间隔、失败阈值
5. 勾选 `检测失败后自动换 IP` 或 `实例不可用时自动替换`
6. 保存服务器

自动检测在 `自动化` 区域开启，可设置全局检测间隔。

## 下发预设命令

进入 `命令`：

1. 先在服务器资产里配置 SSH 用户名和私钥 / 密码
2. 保存命令预设，例如安装 Docker、更新软件包、重启服务等
3. 选择目标服务器
4. 执行预设命令或手动命令

## 新建实例开机脚本

进入 `开机脚本`：

1. 保存常用 startup script
2. 回到 `快捷开机`
3. 在 `开机脚本预设` 下拉框选择脚本并应用
4. 创建实例时脚本会写入 GCP metadata `startup-script`

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

## API 概览

```text
GET  /api/config
POST /api/credentials/gcp-service-account
GET  /api/health?project=...
GET  /api/overview?project=...
GET  /api/instances?project=...
POST /api/instances
POST /api/instances/action
POST /api/instances/rotate-ip
GET  /api/traffic?project=...&hours=24

GET    /api/ops/servers
POST   /api/ops/servers
PUT    /api/ops/servers/{id}
DELETE /api/ops/servers/{id}
POST   /api/ops/servers/{id}/check
POST   /api/ops/servers/{id}/rotate-ip
POST   /api/ops/servers/{id}/replace
GET    /api/ops/monitor
PUT    /api/ops/monitor
GET    /api/ops/events
GET    /api/ops/command-presets
POST   /api/ops/command-presets
DELETE /api/ops/command-presets/{id}
POST   /api/ops/commands/run
GET    /api/ops/startup-scripts
POST   /api/ops/startup-scripts
DELETE /api/ops/startup-scripts/{id}
```

## 安全建议

这个面板能创建、删除、关机、换 IP、下发 SSH 命令。公网部署时至少要：

- 使用强 `PANEL_TOKEN`
- 只开放给可信 IP，或放在 VPN / Cloudflare Access 后面
- 有域名时启用 HTTPS
- SSH 命令下发使用专用低权限密钥
- 不要把 GCP Owner 权限的 Service Account JSON 上传到公网裸奔的面板
