# 服务器部署说明

本项目现在支持 **不填写 GCP Project ID 直接安装运行管理面板**。Project ID 和 GCP 凭据进入网页后再配置。

## 1. 一键安装

在 Debian / Ubuntu 服务器执行：

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash
```

安装完成后会输出：

```text
访问地址：http://服务器IP:8080
面板 Token：xxxxxxxx
安装目录：/opt/gcp-compute-panel
```

然后浏览器访问：

```text
http://你的服务器IP:8080
```

## 2. 必须放行端口

云服务器安全组 / 防火墙放行：

```text
TCP 8080
来源 0.0.0.0/0
```

如果使用域名 + Nginx，则放行：

```text
TCP 80
TCP 443
```

## 3. 带域名安装

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash -s --   --domain panel.example.com
```

带 HTTPS：

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash -s --   --domain panel.example.com   --https   --email you@example.com
```

## 4. 查看 Token

```bash
cd /opt/gcp-compute-panel
bash scripts/panelctl.sh token
```

## 5. 配置 GCP

进入面板后：

1. 输入 Panel Token 登录
2. 在 Profile 区填写 Project ID
3. 上传 Service Account JSON
4. 刷新实例列表

推荐服务账号角色：

```text
roles/compute.instanceAdmin.v1
roles/monitoring.viewer
roles/iam.serviceAccountUser
```

## 6. 更新

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/update.sh | sudo bash
```

## 7. 排查

```bash
cd /opt/gcp-compute-panel
docker compose ps
docker compose logs --tail=100
curl -I http://127.0.0.1:8080
ss -lntp | grep 8080
```

正常应看到：

```text
0.0.0.0:8080->8080/tcp
HTTP/1.1 200 OK
```
