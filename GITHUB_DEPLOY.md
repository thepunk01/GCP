# GitHub 发布与一键安装

现在安装管理面板不需要 GCP Project ID。服务器上可以直接执行：

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash
```

安装后访问：`http://服务器IP:8080`，进入面板后再填写 Project ID / 上传 Service Account JSON。

# GitHub 发布与一键安装 / 更新

本项目已经准备成可直接推送到 GitHub 的形式。推送后，服务器可以通过一条命令安装，后续也可以一条命令更新。

## 0. 你的仓库地址

本项目已按你的 GitHub 仓库配置：

```text
https://github.com/thepunk01/GCP.git
```

你当前仓库是 public，可以使用 raw.githubusercontent.com 直接执行一键安装脚本。注意：仓库根目录需要是展开后的源码文件，不能只放 zip 包。

最省事的推送方式：

```bash
bash scripts/push_to_github.sh --force
```

`--force` 会用当前源码目录覆盖远端 main 分支，适合把现在仓库里的 zip 包替换成真正可安装的源码目录。

## 1. 推送到 GitHub

### 方案 A：用 GitHub CLI

本地进入项目目录：

```bash
cd gcp-compute-panel

git init
git add .
git commit -m "init gcp compute panel"
git branch -M main

gh auth login
gh repo create thepunk01/GCP --public --source=. --remote=origin --push
```

如果你想建私有仓库：

```bash
gh repo create thepunk01/GCP --private --source=. --remote=origin --push
```

### 方案 B：用网页先建仓库，再命令行推送

先在 GitHub 创建空仓库，例如：

```text
https://github.com/thepunk01/GCP
```

然后本地执行：

```bash
cd gcp-compute-panel

git init
git add .
git commit -m "init gcp compute panel"
git branch -M main
git remote add origin https://github.com/thepunk01/GCP.git
git push -u origin main
```

如果使用 SSH：

```bash
git remote add origin git@github.com:thepunk01/GCP.git
git push -u origin main
```

## 2. 服务器一键安装

把下面的 `<你的用户名>` 替换成你的 GitHub 用户名。

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash -s -- \
  --zone asia-east1-a \
  --domain panel.example.com
```

不使用域名 / Nginx，只在服务器本机监听：

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash -s -- \
  --zone asia-east1-a \
  --no-nginx
```

启用 HTTPS：

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash -s -- \
  --zone asia-east1-a \
  --domain panel.example.com \
  --https \
  --email you@example.com
```

安装完成后脚本会输出：

```text
访问地址
PANEL_TOKEN
安装目录
常用管理命令
```

## 3. 一键更新

服务器执行：

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/update.sh | sudo bash
```

或者进入项目目录执行：

```bash
cd /opt/gcp-compute-panel
sudo bash scripts/update.sh
```

更新会保留：

```text
.env
data/
已上传的 GCP Service Account JSON
```

## 4. 常用管理命令

```bash
cd /opt/gcp-compute-panel

docker compose ps
docker compose logs -f
docker compose restart
docker compose down
bash scripts/update.sh
bash scripts/panelctl.sh token
```

## 5. 私有仓库安装方式

如果仓库是 private，服务器需要有权限拉取。推荐使用 SSH deploy key：

```bash
ssh-keygen -t ed25519 -C "gcp-compute-panel-server" -f ~/.ssh/gcp_compute_panel_deploy
cat ~/.ssh/gcp_compute_panel_deploy.pub
```

把公钥添加到 GitHub 仓库：

```text
Settings -> Deploy keys -> Add deploy key
```

然后安装时使用 SSH 地址：

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash -s -- \
  --repo git@github.com:thepunk01/GCP.git \
  --domain panel.example.com
```

注意：如果 raw.githubusercontent.com 也需要私有访问，建议先把 `scripts/install.sh` 复制到服务器执行，或临时用 public 仓库发布安装脚本。

## 6. 推荐发布版本标签

每次稳定后打 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

服务器想固定版本时：

```bash
cd /opt/gcp-compute-panel
git fetch --tags
git checkout v0.1.0
docker compose up -d --build
```
