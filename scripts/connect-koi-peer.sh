#!/bin/bash
# Connect a running KOI node to a peer/coordinator with idempotent upserts.
#
# What this does:
# 1) Reads local node profile from LOCAL_URL/koi-net/health
# 2) Reads peer node profile from PEER_URL/koi-net/health
# 3) Upserts peer into local koi_net_nodes (including public_key)
# 4) Upserts local POLL edge (source=peer, target=local)
# 5) Sends handshake to peer so peer can register local key/profile
# 6) Prints reciprocal SQL for peer admin to run (edge + node upserts)
#
# Usage:
#   bash scripts/connect-koi-peer.sh --db cv_koi --peer-url http://45.132.245.30:8351

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

usage() {
  cat <<'EOF'
Usage:
  bash scripts/connect-koi-peer.sh --db <local_db> --peer-url <peer_base_url> [options]

Required:
  --db <name>            Local PostgreSQL database name (e.g. cv_koi)
  --peer-url <url>       Peer KOI base URL (e.g. http://45.132.245.30:8351)

Optional:
  --local-url <url>      Local KOI API URL (default: http://127.0.0.1:8351)
  --edge-rid <rid>       Override edge RID (default: orn:koi-net.edge:<local>-polls-<peer>)
  --rid-types <array>    PostgreSQL text[] literal (default: {Practice,Pattern,CaseStudy,Bioregion})
  --container <name>     Postgres container name (default: regen-koi-postgres)
  --api-container <name> KOI API container name for python3 fallback (default: koi-api)
  --no-handshake         Skip sending handshake to peer
  --help                 Show this help
EOF
}

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/-\{2,\}/-/g; s/^-//; s/-$//'
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Required command not found: $1"
    exit 1
  fi
}

# parse_json <python_expression>
# Reads JSON from stdin, evaluates a Python expression.
# Tries host python3 first, falls back to container python3.
parse_json() {
  local expr="$1"
  local input
  input=$(cat)
  if command -v python3 >/dev/null 2>&1; then
    echo "$input" | python3 -c "$expr" 2>/dev/null
  else
    echo "$input" | ${KOI_DOCKER_CMD:-docker} exec -i "${API_CONTAINER}" python3 -c "$expr" 2>/dev/null
  fi
}

DB_NAME=""
PEER_URL=""
LOCAL_URL="http://127.0.0.1:8351"
EDGE_RID=""
RID_TYPES="{Practice,Pattern,CaseStudy,Bioregion}"
CONTAINER="regen-koi-postgres"
API_CONTAINER="koi-api"
DO_HANDSHAKE="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB_NAME="$2"; shift 2 ;;
    --peer-url) PEER_URL="$2"; shift 2 ;;
    --local-url) LOCAL_URL="$2"; shift 2 ;;
    --edge-rid) EDGE_RID="$2"; shift 2 ;;
    --rid-types) RID_TYPES="$2"; shift 2 ;;
    --container) CONTAINER="$2"; shift 2 ;;
    --api-container) API_CONTAINER="$2"; shift 2 ;;
    --no-handshake) DO_HANDSHAKE="false"; shift ;;
    --help|-h) usage; exit 0 ;;
    *)
      err "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [ -z "$DB_NAME" ] || [ -z "$PEER_URL" ]; then
  usage
  exit 1
fi

require_cmd curl
require_cmd docker

PEER_URL="${PEER_URL%/}"
LOCAL_URL="${LOCAL_URL%/}"
DOCKER_CMD="${KOI_DOCKER_CMD:-docker}"
PSQL="$DOCKER_CMD exec -i $CONTAINER psql -U postgres -d $DB_NAME"

info "Checking local KOI health at $LOCAL_URL..."
LOCAL_HEALTH=$(curl -s --max-time 8 "$LOCAL_URL/koi-net/health" || true)
if [ -z "$LOCAL_HEALTH" ]; then
  err "Local KOI health unavailable at $LOCAL_URL/koi-net/health"
  exit 1
fi

LOCAL_RID=$(echo "$LOCAL_HEALTH" | parse_json "import sys,json; d=json.load(sys.stdin); n=d.get('node') or {}; print(n.get('node_rid',''))" || true)
LOCAL_NAME=$(echo "$LOCAL_HEALTH" | parse_json "import sys,json; d=json.load(sys.stdin); n=d.get('node') or {}; print(n.get('node_name',''))" || true)
LOCAL_KEY=$(echo "$LOCAL_HEALTH" | parse_json "import sys,json; d=json.load(sys.stdin); n=d.get('node') or {}; print(n.get('public_key',''))" || true)
LOCAL_BASE=$(echo "$LOCAL_HEALTH" | parse_json "import sys,json; d=json.load(sys.stdin); n=d.get('node') or {}; print(n.get('base_url',''))" || true)
LOCAL_STRICT=$(echo "$LOCAL_HEALTH" | parse_json "import sys,json; d=json.load(sys.stdin); p=d.get('protocol') or {}; print(str(bool(p.get('strict_mode', False))).lower())" || true)
LOCAL_REQUIRE_SIGNED=$(echo "$LOCAL_HEALTH" | parse_json "import sys,json; d=json.load(sys.stdin); p=d.get('protocol') or {}; print(str(bool(p.get('require_signed_envelopes', False))).lower())" || true)

if [ -z "$LOCAL_RID" ] || [ -z "$LOCAL_NAME" ]; then
  err "Could not parse local node profile from /koi-net/health"
  exit 1
fi
if [ -z "$LOCAL_BASE" ]; then
  LOCAL_BASE="$LOCAL_URL"
fi
ok "Local node: $LOCAL_NAME ($LOCAL_RID)"

info "Checking peer KOI health at $PEER_URL..."
PEER_HEALTH=$(curl -s --max-time 8 "$PEER_URL/koi-net/health" || true)
if [ -z "$PEER_HEALTH" ]; then
  err "Peer KOI health unavailable at $PEER_URL/koi-net/health"
  exit 1
fi

PEER_RID=$(echo "$PEER_HEALTH" | parse_json "import sys,json; d=json.load(sys.stdin); n=d.get('node') or {}; print(n.get('node_rid',''))" || true)
PEER_NAME=$(echo "$PEER_HEALTH" | parse_json "import sys,json; d=json.load(sys.stdin); n=d.get('node') or {}; print(n.get('node_name',''))" || true)
PEER_KEY=$(echo "$PEER_HEALTH" | parse_json "import sys,json; d=json.load(sys.stdin); n=d.get('node') or {}; print(n.get('public_key',''))" || true)
PEER_STRICT=$(echo "$PEER_HEALTH" | parse_json "import sys,json; d=json.load(sys.stdin); p=d.get('protocol') or {}; print(str(bool(p.get('strict_mode', False))).lower())" || true)
PEER_REQUIRE_SIGNED=$(echo "$PEER_HEALTH" | parse_json "import sys,json; d=json.load(sys.stdin); p=d.get('protocol') or {}; print(str(bool(p.get('require_signed_envelopes', False))).lower())" || true)

if [ -z "$PEER_RID" ] || [ -z "$PEER_NAME" ]; then
  err "Could not parse peer node profile from /koi-net/health"
  exit 1
fi
if [ -z "$PEER_KEY" ]; then
  warn "Peer public_key missing in health payload; signed verification may fail"
fi
ok "Peer node: $PEER_NAME ($PEER_RID)"

if [ "${LOCAL_STRICT:-false}" = "true" ] || [ "${PEER_STRICT:-false}" = "true" ]; then
  info "Strict-mode status: local=$LOCAL_STRICT peer=$PEER_STRICT"
  info "Signed-envelope requirement: local=$LOCAL_REQUIRE_SIGNED peer=$PEER_REQUIRE_SIGNED"
  warn "Ensure both peers are strict-mode compatible before production rollout."
fi

if [ -z "$EDGE_RID" ]; then
  EDGE_RID="orn:koi-net.edge:$(slugify "$LOCAL_NAME")-polls-$(slugify "$PEER_NAME")"
fi

if ! $DOCKER_CMD exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
  err "PostgreSQL container '$CONTAINER' is not ready"
  exit 1
fi

if [ -n "$PEER_KEY" ]; then
  PEER_KEY_SQL="'$PEER_KEY'"
else
  PEER_KEY_SQL="NULL"
fi
if [ -n "$LOCAL_KEY" ]; then
  LOCAL_KEY_SQL="'$LOCAL_KEY'"
else
  LOCAL_KEY_SQL="NULL"
fi

info "Upserting peer node + POLL edge in local DB ($DB_NAME)..."
echo "INSERT INTO koi_net_nodes (node_rid, node_name, node_type, base_url, public_key, status, last_seen) VALUES ('$PEER_RID', '$PEER_NAME', 'FULL', '$PEER_URL', $PEER_KEY_SQL, 'active', now()) ON CONFLICT (node_rid) DO UPDATE SET node_name = EXCLUDED.node_name, node_type = EXCLUDED.node_type, base_url = EXCLUDED.base_url, public_key = COALESCE(EXCLUDED.public_key, koi_net_nodes.public_key), status = 'active', last_seen = now();" | $PSQL >/dev/null
echo "INSERT INTO koi_net_edges (edge_rid, source_node, target_node, edge_type, status, rid_types) VALUES ('$EDGE_RID', '$PEER_RID', '$LOCAL_RID', 'POLL', 'APPROVED', '$RID_TYPES') ON CONFLICT (edge_rid) DO UPDATE SET source_node = EXCLUDED.source_node, target_node = EXCLUDED.target_node, edge_type = EXCLUDED.edge_type, status = 'APPROVED', rid_types = EXCLUDED.rid_types, updated_at = now();" | $PSQL >/dev/null
ok "Local federation rows upserted"

if [ "$DO_HANDSHAKE" = "true" ]; then
  info "Sending handshake to peer (register local profile/key remotely)..."
  HANDSHAKE_PAYLOAD=$(echo "$LOCAL_HEALTH" | parse_json "import sys,json; d=json.load(sys.stdin); n=d.get('node') or {}; print(json.dumps({'type':'handshake','profile':n}, separators=(',',':'))) if n else print('')" || true)
  if [ -n "$HANDSHAKE_PAYLOAD" ]; then
    HS_BODY=$(mktemp)
    HS_CODE=$(curl -s --max-time 10 -o "$HS_BODY" -w "%{http_code}" \
      -H "Content-Type: application/json" \
      -X POST "$PEER_URL/koi-net/handshake" \
      -d "$HANDSHAKE_PAYLOAD" || echo "000")
    if [ "$HS_CODE" = "200" ]; then
      EDGE_STATUS=$(cat "$HS_BODY" | parse_json "import sys,json; d=json.load(sys.stdin); print(d.get('edge_status',''))" 2>/dev/null || true)
      ok "Handshake accepted by peer"
      if [ "$EDGE_STATUS" = "PROPOSED" ]; then
        warn "Edge status is PROPOSED — coordinator admin must approve before polling begins."
        warn "Ask the coordinator to run: admin-edges.sh approve <edge_rid>"
      fi
    else
      warn "Handshake returned HTTP $HS_CODE (peer may still need manual node upsert)"
    fi
    rm -f "$HS_BODY"
  else
    warn "Could not build handshake payload from local profile"
  fi
fi

echo ""
echo "Local verification:"
echo "  docker exec $CONTAINER psql -U postgres -d $DB_NAME -c \"SELECT node_rid, node_name, length(public_key) AS key_len, base_url FROM koi_net_nodes WHERE node_rid IN ('$LOCAL_RID','$PEER_RID');\""
echo "  docker exec $CONTAINER psql -U postgres -d $DB_NAME -c \"SELECT edge_rid, source_node, target_node, edge_type, status FROM koi_net_edges WHERE edge_rid = '$EDGE_RID';\""

echo ""
echo "Reciprocal SQL for peer admin (replace <peer_db>):"
echo "  # NOTE: Edge is created as PROPOSED. Coordinator admin must approve it"
echo "  # before polling begins: admin-edges.sh approve <edge_rid>"
echo "  docker exec -i regen-koi-postgres psql -U postgres -d <peer_db> <<'SQL'"
echo "  INSERT INTO koi_net_nodes (node_rid, node_name, node_type, base_url, public_key, status, last_seen)"
echo "    VALUES ('$LOCAL_RID', '$LOCAL_NAME', 'FULL', '$LOCAL_BASE', $LOCAL_KEY_SQL, 'active', now())"
echo "    ON CONFLICT (node_rid) DO UPDATE SET"
echo "      node_name = EXCLUDED.node_name,"
echo "      node_type = EXCLUDED.node_type,"
echo "      base_url = EXCLUDED.base_url,"
echo "      public_key = COALESCE(EXCLUDED.public_key, koi_net_nodes.public_key),"
echo "      status = 'active',"
echo "      last_seen = now();"
echo "  INSERT INTO koi_net_edges (edge_rid, source_node, target_node, edge_type, status, rid_types)"
echo "    VALUES ('$EDGE_RID', '$LOCAL_RID', '$PEER_RID', 'POLL', 'PROPOSED', '$RID_TYPES')"
echo "    ON CONFLICT (edge_rid) DO UPDATE SET"
echo "      source_node = EXCLUDED.source_node,"
echo "      target_node = EXCLUDED.target_node,"
echo "      edge_type = EXCLUDED.edge_type,"
echo "      status = 'PROPOSED',"
echo "      rid_types = EXCLUDED.rid_types,"
echo "      updated_at = now();"
echo "  SQL"

echo ""
ok "Done. Local node now polls from $PEER_NAME via $PEER_URL."
