#!/usr/bin/env bash
#
# install.sh — 把 site-monitor 以「外挂子应用」方式安装到 XingSeq 控制台
#
# 做的事：
#   1. 构建前端（web/dist）
#   2. 复制整个应用目录到 skill-host 安装目录（electron-shell 自动发现）
#      注意：discoverSubApps 用 isDirectory() 扫描，symlink 不被识别，必须复制
#
# 前置依赖（不随本脚本安装）：
#   - Docker Desktop（Uptime Kuma 以容器方式运行）
#   - mail-app 子应用（告警邮件发送，可选）
#
# 用法：./install.sh          安装/覆盖更新
#       ./install.sh --remove 卸载（保留 Kuma 监控数据）
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECTS_DIR="$HOME/Library/Application Support/xingseq/projects"
TARGET_DIR="$PROJECTS_DIR/site-monitor"

if [[ "${1:-}" == "--remove" ]]; then
  rm -rf "$TARGET_DIR"
  echo "已卸载: $TARGET_DIR"
  echo "提示：Kuma 监控数据保留在 $HOME/Library/Application Support/xingseq/site-monitor/kuma-data"
  echo "      如需彻底清理，手动删除该目录，并执行 docker rm -f xingseq-uptime-kuma"
  exit 0
fi

echo "==> 构建前端..."
(cd "$APP_DIR/web" && npm install --no-fund --no-audit && npm run build)

echo "==> 复制到安装目录: $TARGET_DIR"
mkdir -p "$TARGET_DIR"
rsync -a --delete \
  --exclude 'web/node_modules/' \
  --exclude 'web/src/' \
  --exclude '.git/' \
  --exclude '.DS_Store' \
  --exclude 'install.sh' \
  "$APP_DIR/" "$TARGET_DIR/"

echo "==> 完成。重启 XingSeq 控制台（或刷新子应用列表）即可看到「站点监控」。"
echo "    首次启动会拉取 Uptime Kuma 镜像（约 600MB），请耐心等待。"
