#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="gcp-compute-panel"
APP_DIR="${APP_DIR:-/opt/gcp-compute-panel}"
REPO_URL="${REPO_URL:-https://github.com/thepunk01/GCP.git}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-}"
GCP_PROJECT_ID="${GCP_PROJECT_ID:-}"
GCP_DEFAULT_ZONE="${GCP_DEFAULT_ZONE:-asia-east1-a}"
PANEL_TOKEN="${PANEL_TOKEN:-}"
INSTALL_NGINX="${INSTALL_NGINX:-auto}"
ENABLE_HTTPS="${ENABLE_HTTPS:-0}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
FORCE="${FORCE:-0}"

usage() {
  cat <<'USAGE'
GCP Compute Panel 一键安装脚本

最简单用法（不需要 GCP Project ID，先把管理面板跑起来）：
  curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash

安装完成后访问：
  http://服务器IP:8080

常用参数：
  --repo <url>             GitHub 仓库地址，默认 https://github.com/thepunk01/GCP.git
  --branch <name>          分支，默认 main
  --dir <path>             安装目录，默认 /opt/gcp-compute-panel
  --project <id>           可选：预填 GCP Project ID；不填也能安装运行
  --zone <zone>            默认 zone，默认 asia-east1-a
  --token <token>          面板 Token；不填会自动生成
  --domain <domain>        可选：配置 Nginx 域名
  --no-nginx               不安装/配置 Nginx；默认直接开放 8080
  --https                  配置域名后自动申请 HTTPS，需要域名已解析到本机
  --email <email>          Certbot 邮箱，配合 --https 使用
  --force                  安装目录已存在且不是 git 仓库时，自动备份后继续
  -h, --help               查看帮助

示例：
  # 直接公网 8080 访问
  curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash

  # 指定域名反代
  curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash -s -- \
    --domain panel.example.com
USAGE
}
log() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    err "请用 root 执行，或在命令前加 sudo。"
    exit 1
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo) REPO_URL="$2"; shift 2 ;;
      --branch) BRANCH="$2"; shift 2 ;;
      --dir) APP_DIR="$2"; shift 2 ;;
      --project) GCP_PROJECT_ID="$2"; shift 2 ;;
      --zone) GCP_DEFAULT_ZONE="$2"; shift 2 ;;
      --token) PANEL_TOKEN="$2"; shift 2 ;;
      --domain) DOMAIN="$2"; shift 2 ;;
      --no-nginx) INSTALL_NGINX="0"; shift ;;
      --https) ENABLE_HTTPS="1"; shift ;;
      --email) CERTBOT_EMAIL="$2"; shift 2 ;;
      --force) FORCE="1"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) err "未知参数：$1"; usage; exit 1 ;;
    esac
  done
}

install_base_packages() {
  log "安装基础依赖。"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg git openssl lsb-release
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker 与 Compose 已存在，跳过安装。"
    return
  fi

  log "安装 Docker Engine 与 Compose 插件。"
  . /etc/os-release
  local docker_distro=""
  case "${ID}" in
    ubuntu) docker_distro="ubuntu" ;;
    debian) docker_distro="debian" ;;
    *)
      if echo "${ID_LIKE:-}" | grep -qi "ubuntu"; then
        docker_distro="ubuntu"
      elif echo "${ID_LIKE:-}" | grep -qi "debian"; then
        docker_distro="debian"
      else
        err "当前系统暂不支持自动安装 Docker：${PRETTY_NAME:-unknown}。请先手动安装 Docker 后重试。"
        exit 1
      fi
      ;;
  esac

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${docker_distro}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/${docker_distro}
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}
clone_or_update_repo() {
  if [[ -z "${REPO_URL}" ]]; then
    err "缺少 --repo。请传入仓库地址，例如：https://github.com/thepunk01/GCP.git"
    exit 1
  fi

  if [[ -d "${APP_DIR}/.git" ]]; then
    log "更新已有仓库：${APP_DIR}"
    git -C "${APP_DIR}" fetch origin "${BRANCH}"
    git -C "${APP_DIR}" checkout "${BRANCH}"
    git -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"
    return
  fi

  if [[ -e "${APP_DIR}" && -n "$(ls -A "${APP_DIR}" 2>/dev/null || true)" ]]; then
    if [[ "${FORCE}" != "1" ]]; then
      err "安装目录 ${APP_DIR} 已存在且不是 git 仓库。为避免覆盖，请换目录或加 --force 自动备份。"
      exit 1
    fi
    local backup="${APP_DIR}.bak.$(date +%Y%m%d%H%M%S)"
    warn "安装目录已存在，备份到：${backup}"
    mv "${APP_DIR}" "${backup}"
  fi

  log "克隆仓库到：${APP_DIR}"
  git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${APP_DIR}"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"
  if grep -qE "^#?${key}=" "${file}"; then
    sed -i "s|^#\?${key}=.*|${key}=${value}|" "${file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
}

prepare_env() {
  cd "${APP_DIR}"
  if [[ ! -f .env ]]; then
    cp .env.example .env
  fi

  if [[ -z "${PANEL_TOKEN}" ]]; then
    PANEL_TOKEN="$(openssl rand -hex 32)"
  fi

  [[ -n "${GCP_PROJECT_ID}" ]] && set_env_value "GCP_PROJECT_ID" "${GCP_PROJECT_ID}" .env
  set_env_value "GCP_DEFAULT_ZONE" "${GCP_DEFAULT_ZONE}" .env
  set_env_value "PANEL_TOKEN" "${PANEL_TOKEN}" .env
  set_env_value "APP_ENV" "prod" .env
  set_env_value "DATA_DIR" "/data" .env

  mkdir -p data
  chmod 700 data
}

start_app() {
  log "构建并启动容器。"
  cd "${APP_DIR}"
  docker compose up -d --build
  docker compose ps
  if curl -fsS -I http://127.0.0.1:8080 >/dev/null 2>&1; then
    log "本机 8080 检查通过。"
  else
    warn "本机 8080 暂未响应，请执行：docker compose logs --tail=100"
  fi
}

configure_nginx() {
  if [[ "${INSTALL_NGINX}" == "0" ]]; then
    log "已跳过 Nginx。"
    return
  fi

  if [[ -z "${DOMAIN}" ]]; then
    warn "未提供 --domain，将直接开放 8080 端口。请确认云服务器安全组已放行 TCP 8080。"
    if command -v ufw >/dev/null 2>&1; then
      ufw allow 8080/tcp >/dev/null 2>&1 || true
    fi
    return
  fi

  log "安装并配置 Nginx：${DOMAIN}"
  apt-get install -y nginx
  cat > /etc/nginx/sites-available/${APP_NAME} <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/${APP_NAME} /etc/nginx/sites-enabled/${APP_NAME}
  nginx -t
  systemctl reload nginx
  if command -v ufw >/dev/null 2>&1; then
    ufw allow 80/tcp >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
  fi

  if [[ "${ENABLE_HTTPS}" == "1" ]]; then
    log "申请 HTTPS 证书。请确认 ${DOMAIN} 已解析到当前服务器。"
    apt-get install -y certbot python3-certbot-nginx
    if [[ -n "${CERTBOT_EMAIL}" ]]; then
      certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${CERTBOT_EMAIL}" --redirect
    else
      certbot --nginx -d "${DOMAIN}"
    fi
  fi
}

print_result() {
  local host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  local url="http://${host_ip:-服务器IP}:8080"
  if [[ -n "${DOMAIN}" ]]; then
    if [[ "${ENABLE_HTTPS}" == "1" ]]; then
      url="https://${DOMAIN}"
    else
      url="http://${DOMAIN}"
    fi
  fi

  cat <<RESULT

============================================================
安装完成。

访问地址：${url}
面板 Token：${PANEL_TOKEN}
安装目录：${APP_DIR}

常用命令：
  cd ${APP_DIR}
  docker compose logs -f
  docker compose restart
  bash scripts/update.sh

GCP 凭据：
  方式 A：在面板里上传 Service Account JSON。
  方式 B：服务器执行 gcloud auth application-default login，docker-compose 已挂载 ~/.config/gcloud。

安全提醒：
  这个面板能创建/删除/换 IP，请务必使用强 Token，并优先放在 VPN、Cloudflare Access 或 IP 白名单后面。
============================================================
RESULT
}

main() {
  require_root
  parse_args "$@"
  install_base_packages
  install_docker
  clone_or_update_repo
  prepare_env
  start_app
  configure_nginx
  print_result
}

main "$@"
