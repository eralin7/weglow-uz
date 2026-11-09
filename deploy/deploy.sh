#!/usr/bin/env bash
# Ships the payment server to the Tashkent VPS and restarts it.
# Usage: deploy/deploy.sh root@<server-ip>
set -euo pipefail

HOST="${1:?usage: deploy/deploy.sh root@<server-ip>}"
KEY="${WEGLOW_SSH_KEY:-$HOME/.ssh/weglow_uz_ed25519}"
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

rsync -az --delete -e "$SSH" "$ROOT/server/" "$HOST:/opt/weglow/server/"
rsync -az -e "$SSH" "$ROOT/deploy/docker-compose.yml" "$ROOT/deploy/Caddyfile" "$HOST:/opt/weglow/deploy/"
$SSH "$HOST" 'test -f /opt/weglow/deploy/.env || { echo "Missing /opt/weglow/deploy/.env"; exit 1; }
  cd /opt/weglow/deploy && docker compose up -d --build && docker image prune -f >/dev/null && docker compose ps'
echo "Health: $(curl -s https://pay.weglow.uz/health || echo 'not reachable yet')"
