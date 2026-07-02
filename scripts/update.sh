#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/gcp-compute-panel}"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-https://github.com/thepunk01/GCP.git}"
KEEP_ENV="${KEEP_ENV:-1}"

usage() {
  cat <<'USAGE'
GCP Compute Panel 一键更新脚本

用法：
  sudo bash scripts/update.sh [options]

参数：
  --dir <path>       项目目录，默认 /opt/gcp-compute-panel
  --branch <name>    分支，默认 main
  --repo <url>       如果目录不存在，可传 GitHub 仓库地址自动克隆，默认 https://github.com/thepunk01/GCP.git
  -h, --help         查看帮助

一键更新示例：
  curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/update.sh | sudo bash
USAGE
}

log() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir) APP_DIR="$2"; shift 2 ;;
      --branch) BRANCH="$2"; shift 2 ;;
      --repo) REPO_URL="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) err "未知参数：$1"; usage; exit 1 ;;
    esac
  done
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    err "请用 root 执行，或在命令前加 sudo。"
    exit 1
  fi
}

ensure_repo() {
  if [[ -d "${APP_DIR}/.git" ]]; then
    return
  fi

  if [[ ! -e "${APP_DIR}" && -n "${REPO_URL}" ]]; then
    log "项目目录不存在，克隆仓库到：${APP_DIR}"
    git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${APP_DIR}"
    return
  fi

  err "${APP_DIR} 不是 git 仓库，无法自动更新。请确认目录，或传 --repo 自动克隆。"
  exit 1
}

backup_env() {
  cd "${APP_DIR}"
  [[ -f .env ]] && cp .env "/tmp/gcp-compute-panel.env.$(date +%s)"
}

pull_latest() {
  cd "${APP_DIR}"
  log "拉取最新代码：${BRANCH}"
  git fetch origin "${BRANCH}"
  git checkout "${BRANCH}"
  git pull --ff-only origin "${BRANCH}"
}

restart_app() {
  cd "${APP_DIR}"
  if [[ ! -f .env && -f .env.example ]]; then
    warn ".env 不存在，已从 .env.example 创建；请检查 PANEL_TOKEN。GCP_PROJECT_ID 可进入面板后填写。"
    cp .env.example .env
  fi
  mkdir -p data
  chmod 700 data
  log "重新构建并启动。"
  docker compose up -d --build
  log "清理悬空镜像。"
  docker image prune -f >/dev/null || true
}

print_result() {
  cat <<RESULT

更新完成。

常用命令：
  cd ${APP_DIR}
  docker compose logs -f
  docker compose ps
  docker compose restart
RESULT
}

main() {
  require_root
  parse_args "$@"
  apt-get update -y
  apt-get install -y git ca-certificates curl
  ensure_repo
  backup_env
  pull_latest
  restart_app
  print_result
}

main "$@"
