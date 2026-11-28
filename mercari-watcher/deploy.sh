#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/tmp/runner-work/.env}"
IMAGE="${IMAGE:-mercari-watcher:ci}"
NAME="${NAME:-mercari-watcher}"

[ -f "$ENV_FILE" ] || { echo "❌ Không thấy ENV_FILE: $ENV_FILE (đặt .env trên Synology)"; exit 1; }

echo "▶ Build image $IMAGE ..."
docker build -t "$IMAGE" "$(dirname "$0")"

echo "▶ Recreate container $NAME ..."
docker stop "$NAME" >/dev/null 2>&1 || true
docker rm   "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  --env-file "$ENV_FILE" \
  "$IMAGE"

echo "✓ Container $NAME đang chạy (image=$IMAGE env=$ENV_FILE, health 127.0.0.1:${HEALTH_PORT:-8788})"
