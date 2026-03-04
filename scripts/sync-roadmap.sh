#!/usr/bin/env bash
# sync-roadmap.sh — Fetch latest roadmap from GitHub + ingest into KOI
#
# Designed to run on the Octo server (45.132.245.30) via systemd timer or manually.
# Fetches the canonical roadmap JSON from GitHub, diffs against the last-ingested
# version, and re-ingests only when changed.
#
# Usage:
#   ./sync-roadmap.sh              # normal run (skip if unchanged)
#   ./sync-roadmap.sh --force      # force re-ingest even if unchanged
#
# Env (sourced from personal.env):
#   POSTGRES_URL, OPENAI_API_KEY

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ROADMAP_URL="https://raw.githubusercontent.com/BioregionalKnowledgeCommons/BioregionalKnowledgeCommoning/main/docs/roadmap/semantic-roadmap.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="/root/koi-processor/data/roadmap"
INGEST_SCRIPT="/root/koi-processor/scripts/ingest_roadmap_to_koi.py"
VENV_PYTHON="/root/koi-processor/venv/bin/python3"
ENV_FILE="/root/koi-processor/config/personal.env"
LOG_FILE="/var/log/roadmap-sync.log"
DB_NAME="octo_koi"
API_URL="http://127.0.0.1:8351"

FORCE=false
[[ "${1:-}" == "--force" ]] && FORCE=true

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
mkdir -p "$DATA_DIR"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG_FILE"; }

# Source env for DB creds + OpenAI key
if [[ -f "$ENV_FILE" ]]; then
  # Extract individual vars from POSTGRES_URL
  POSTGRES_URL=$(grep '^POSTGRES_URL=' "$ENV_FILE" | cut -d= -f2-)
  export OPENAI_API_KEY=$(grep '^OPENAI_API_KEY=' "$ENV_FILE" | cut -d= -f2-)

  # Parse: postgresql://user:pass@host:port/db
  DB_USER=$(echo "$POSTGRES_URL" | sed -n 's|postgresql://\([^:]*\):.*|\1|p')
  DB_PASS=$(echo "$POSTGRES_URL" | sed -n 's|postgresql://[^:]*:\([^@]*\)@.*|\1|p')
  DB_HOST=$(echo "$POSTGRES_URL" | sed -n 's|.*@\([^:]*\):.*|\1|p')
  DB_PORT=$(echo "$POSTGRES_URL" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')

  export POSTGRES_HOST="$DB_HOST"
  export POSTGRES_PORT="$DB_PORT"
  export POSTGRES_USER="$DB_USER"
  export POSTGRES_PASSWORD="$DB_PASS"
else
  log "ERROR: $ENV_FILE not found"
  exit 1
fi

# ---------------------------------------------------------------------------
# Fetch latest roadmap
# ---------------------------------------------------------------------------
ROADMAP_FILE="$DATA_DIR/semantic-roadmap.json"
PREV_HASH_FILE="$DATA_DIR/.last-hash"

log "Fetching roadmap from GitHub..."
HTTP_CODE=$(curl -sS -w '%{http_code}' -o "$ROADMAP_FILE.tmp" "$ROADMAP_URL")

if [[ "$HTTP_CODE" != "200" ]]; then
  log "ERROR: GitHub fetch failed (HTTP $HTTP_CODE)"
  rm -f "$ROADMAP_FILE.tmp"
  exit 1
fi

# Check for changes
NEW_HASH=$(sha256sum "$ROADMAP_FILE.tmp" | cut -d' ' -f1)
PREV_HASH=""
[[ -f "$PREV_HASH_FILE" ]] && PREV_HASH=$(cat "$PREV_HASH_FILE")

if [[ "$NEW_HASH" == "$PREV_HASH" ]] && [[ "$FORCE" == "false" ]]; then
  log "Roadmap unchanged (hash: ${NEW_HASH:0:12}). Skipping ingest."
  rm -f "$ROADMAP_FILE.tmp"
  exit 0
fi

mv "$ROADMAP_FILE.tmp" "$ROADMAP_FILE"
log "Roadmap updated (hash: ${NEW_HASH:0:12}, prev: ${PREV_HASH:0:12})"

# ---------------------------------------------------------------------------
# Run ingest
# ---------------------------------------------------------------------------
log "Running ingest..."
if $VENV_PYTHON "$INGEST_SCRIPT" \
    --db "$DB_NAME" \
    --roadmap "$ROADMAP_FILE" \
    --apply \
    --smoke --api "$API_URL" \
    2>&1 | tee -a "$LOG_FILE"; then
  echo "$NEW_HASH" > "$PREV_HASH_FILE"
  log "Ingest complete."
else
  log "ERROR: Ingest failed (exit $?). Hash NOT updated — will retry next run."
  exit 1
fi
