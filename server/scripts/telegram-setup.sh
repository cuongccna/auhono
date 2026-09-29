#!/usr/bin/env bash
# Đăng ký webhook Telegram cho Worker. Đọc bí mật từ biến môi trường (không nhận qua tham số để khỏi lọt vào lịch sử shell).
#
#   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... WORKER_URL=https://auhono-server.<tài-khoản>.workers.dev \
#     bash scripts/telegram-setup.sh
set -euo pipefail
: "${TELEGRAM_BOT_TOKEN:?cần TELEGRAM_BOT_TOKEN}" "${TELEGRAM_WEBHOOK_SECRET:?cần TELEGRAM_WEBHOOK_SECRET}" "${WORKER_URL:?cần WORKER_URL}"
[[ "$WORKER_URL" == https://* ]] || { echo "WORKER_URL phải là https://" >&2; exit 1; }
# secret_token: 1-256 ký tự A-Z a-z 0-9 _ -
[[ "$TELEGRAM_WEBHOOK_SECRET" =~ ^[A-Za-z0-9_-]{16,256}$ ]] || { echo "TELEGRAM_WEBHOOK_SECRET chỉ gồm A-Za-z0-9_- và dài >= 16 (openssl rand -hex 24)" >&2; exit 1; }
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL%/}/telegram/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]'
echo
