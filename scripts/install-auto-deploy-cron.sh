#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRON_LOG="${CRON_LOG:-/var/log/smg-auto-deploy.log}"
CRON_EXPR="${CRON_EXPR:-* * * * *}"

chmod +x "$ROOT_DIR/scripts/auto-deploy.sh"

CRON_CMD="$CRON_EXPR cd $ROOT_DIR && /usr/bin/env bash $ROOT_DIR/scripts/auto-deploy.sh >> $CRON_LOG 2>&1"

(crontab -l 2>/dev/null | grep -v 'scripts/auto-deploy.sh'; echo "$CRON_CMD") | crontab -

echo "[install-cron] installed:"
echo "$CRON_CMD"
