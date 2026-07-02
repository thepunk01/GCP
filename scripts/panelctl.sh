#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR="${APP_DIR:-/opt/gcp-compute-panel}"
cmd="${1:-help}"
case "${cmd}" in
  start)   cd "${APP_DIR}" && docker compose up -d ;;
  stop)    cd "${APP_DIR}" && docker compose down ;;
  restart) cd "${APP_DIR}" && docker compose restart ;;
  update)  cd "${APP_DIR}" && bash scripts/update.sh ;;
  logs)    cd "${APP_DIR}" && docker compose logs -f ;;
  status)  cd "${APP_DIR}" && docker compose ps ;;
  token)   cd "${APP_DIR}" && grep '^PANEL_TOKEN=' .env | cut -d= -f2- ;;
  *)
    cat <<USAGE
用法：APP_DIR=${APP_DIR} bash scripts/panelctl.sh <command>

命令：
  start     启动
  stop      停止
  restart   重启
  update    更新
  logs      查看日志
  status    查看状态
  token     显示当前 PANEL_TOKEN
USAGE
    ;;
esac
