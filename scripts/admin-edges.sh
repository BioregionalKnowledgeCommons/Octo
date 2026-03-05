#!/bin/bash
# Admin CLI for KOI-net edge governance (approve/reject/list).
#
# Usage:
#   admin-edges.sh list [--status PROPOSED|APPROVED|REJECTED|all]
#   admin-edges.sh approve <edge_rid>
#   admin-edges.sh reject <edge_rid> [--deactivate]
#
# Auth: reads KOI_ADMIN_TOKEN from env or $KOI_STATE_DIR/admin_token

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}→${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
err()   { echo -e "${RED}✗${NC} $1"; }

BASE_URL="${KOI_BASE_URL:-http://127.0.0.1:8351}"

# Resolve admin token
if [ -z "${KOI_ADMIN_TOKEN:-}" ]; then
  TOKEN_FILE="${KOI_STATE_DIR:-/data/koi-state}/admin_token"
  if [ -f "$TOKEN_FILE" ]; then
    KOI_ADMIN_TOKEN=$(cat "$TOKEN_FILE")
  else
    err "KOI_ADMIN_TOKEN not set and $TOKEN_FILE not found"
    exit 1
  fi
fi

usage() {
  cat <<'EOF'
Usage:
  admin-edges.sh list [--status PROPOSED|APPROVED|REJECTED|all]
  admin-edges.sh approve <edge_rid>
  admin-edges.sh reject <edge_rid> [--deactivate]

Environment:
  KOI_ADMIN_TOKEN   Admin bearer token (or stored in $KOI_STATE_DIR/admin_token)
  KOI_BASE_URL      API base URL (default: http://127.0.0.1:8351)
  KOI_STATE_DIR     State directory (default: /data/koi-state)
EOF
}

do_list() {
  local status="PROPOSED"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --status) status="$2"; shift 2 ;;
      *) err "Unknown option: $1"; usage; exit 1 ;;
    esac
  done

  local url="${BASE_URL}/koi-net/edges?status=${status}"

  info "Listing edges (status=${status})..."
  curl -s --max-time 10 \
    -H "Authorization: Bearer ${KOI_ADMIN_TOKEN}" \
    "$url" | python3 -m json.tool
}

do_approve() {
  local edge_rid="$1"
  info "Approving edge: $edge_rid"
  curl -s --max-time 10 \
    -H "Authorization: Bearer ${KOI_ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -X POST "${BASE_URL}/koi-net/edges/approve" \
    -d "{\"edge_rid\": \"${edge_rid}\"}" | python3 -m json.tool
}

do_reject() {
  local edge_rid="$1"
  shift
  local deactivate="false"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --deactivate) deactivate="true"; shift ;;
      *) err "Unknown option: $1"; usage; exit 1 ;;
    esac
  done

  info "Rejecting edge: $edge_rid (deactivate_node=${deactivate})"
  curl -s --max-time 10 \
    -H "Authorization: Bearer ${KOI_ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -X POST "${BASE_URL}/koi-net/edges/reject" \
    -d "{\"edge_rid\": \"${edge_rid}\", \"deactivate_node\": ${deactivate}}" | python3 -m json.tool
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

COMMAND="$1"; shift

case "$COMMAND" in
  list) do_list "$@" ;;
  approve)
    if [[ $# -lt 1 ]]; then
      err "Missing <edge_rid>"
      usage
      exit 1
    fi
    do_approve "$1"
    ;;
  reject)
    if [[ $# -lt 1 ]]; then
      err "Missing <edge_rid>"
      usage
      exit 1
    fi
    do_reject "$@"
    ;;
  --help|-h) usage ;;
  *)
    err "Unknown command: $COMMAND"
    usage
    exit 1
    ;;
esac
