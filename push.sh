#!/usr/bin/env bash
# ============================================================
# VideoCapture_EdgePlug 一键推送脚本
# 读取本地 .env 中的令牌，完成 add / commit / push
# 用法: bash push.sh "提交说明"
# ============================================================
set -euo pipefail

# 进入脚本所在目录（保证在仓库根执行）
cd "$(dirname "$0")"

# 安全确认：本目录必须是独立 git 仓库
TOPLEVEL="$(git rev-parse --show-toplevel)"
if [ "$TOPLEVEL" != "$(pwd -P)" ]; then
  echo "❌ 当前 git 仓库根是: $TOPLEVEL"
  echo "   这不在项目目录内，可能为误用主目录仓库。已终止以防误推。"
  exit 1
fi

# 读取 .env（令牌不写入 .git/config）
set -a
if [ ! -f .env ]; then
  echo "❌ 未找到 .env，请先创建（含 GIT_USER / GIT_TOKEN / GIT_REMOTE）。"
  exit 1
fi
. ./.env
set +a

# 参数：提交说明
MSG="${1:-update: $(date '+%Y-%m-%d %H:%M')}"

# 确保远程已设置（使用干净 URL，不含令牌）
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "$GIT_REMOTE"
else
  git remote set-url origin "$GIT_REMOTE"
fi

# 暂存并提交
git add -A
if git diff --cached --quiet; then
  echo "ℹ️ 没有需要提交的改动。"
else
  git commit -m "$MSG"
fi

# 推送：令牌直拼 URL，避免无 TTY 凭据弹窗
echo "→ 推送至 main ..."
git push "https://${GIT_USER}:${GIT_TOKEN}@${GIT_REMOTE#https://}" main

# 设置干净上游（不含令牌）
git config branch.main.remote origin
git config branch.main.merge refs/heads/main

echo "✅ 推送完成。"
