#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS for the weglow.uz payment server. Run as root.
set -euo pipefail

apt-get update
apt-get install -y ca-certificates curl sqlite3 ufw rsync

# Docker Engine from Docker's official apt repository
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Firewall: SSH and web only
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

mkdir -p /opt/weglow/server /opt/weglow/deploy /opt/weglow/data/backups

# Daily SQLite backup at 03:30, keep 30 days
cat > /etc/cron.d/weglow-backup <<'CRON'
30 3 * * * root sqlite3 /opt/weglow/data/weglow.db ".backup '/opt/weglow/data/backups/weglow-$(date +\%F).db'" && find /opt/weglow/data/backups -name 'weglow-*.db' -mtime +30 -delete
CRON

echo "Server ready. Next: copy deploy/.env and run deploy/deploy.sh from the repo."
