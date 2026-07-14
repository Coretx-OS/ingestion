#!/usr/bin/env bash
# Cron entry point for the daily briefing. Cron runs with a minimal
# environment (no nvm/PATH setup), so this pins the node/npx path explicitly.
set -euo pipefail

NODE_BIN_DIR="/home/robert/.nvm/versions/node/v20.19.6/bin"
export PATH="$NODE_BIN_DIR:$PATH"

REPO_DIR="/home/robert/projects/kens-chrome-extension/apps/youtube-briefing"
LOG_FILE="$REPO_DIR/logs/daily-brief.log"

cd "$REPO_DIR"
{
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
  npx tsx scripts/runDailyBrief.ts
} >> "$LOG_FILE" 2>&1
