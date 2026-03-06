#!/bin/bash
# Interactive setup wizard for a new KOI federation node.
# Everything runs in Docker — no Python/pip/venv on the host.
#
# Usage: bash scripts/setup-node.sh
# Works as root or with sudo.

set -euo pipefail

OCTO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ─── Colors ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}→${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
err()   { echo -e "${RED}✗${NC} $1"; }
header(){ echo -e "\n${BOLD}── $1 ──${NC}\n"; }

# ─── Pre-flight ───
header "KOI Node Setup Wizard"
echo "This will set up a bioregional knowledge node on this server."
echo "Everything runs in Docker — no Python setup needed."
echo ""

# Detect privilege level
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
  info "Not running as root — will use sudo for system operations"
fi

# ─── Install Docker if needed ───
if ! command -v docker &>/dev/null; then
  info "Installing Docker..."
  $SUDO apt-get update -qq &>/dev/null
  $SUDO apt-get install -y -qq curl &>/dev/null
  if ! curl -fsSL https://get.docker.com | $SUDO sh &>/dev/null 2>&1; then
    info "Docker script had issues, trying manual install..."
    $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin &>/dev/null 2>&1 \
      || $SUDO apt-get install -y -qq docker.io docker-compose-v2 &>/dev/null
  fi
  if command -v docker &>/dev/null; then
    ok "Docker installed"
  else
    err "Failed to install Docker. Install it manually and re-run."
    exit 1
  fi
fi

if ! $SUDO docker info &>/dev/null 2>&1; then
  info "Starting Docker..."
  $SUDO systemctl start docker 2>/dev/null || $SUDO service docker start 2>/dev/null || true
  sleep 3
fi

if ! $SUDO docker info &>/dev/null 2>&1; then
  err "Docker failed to start"
  exit 1
fi
ok "Docker is running"

# Docker command prefix (handles sudo)
if [ -n "$SUDO" ]; then
  DOCKER="$SUDO docker"
  DC="$SUDO docker compose"
else
  DOCKER="docker"
  DC="docker compose"
fi

# ─── Vendor sync (fetch KOI code if not present) ───
KOI_CODE="$OCTO_DIR/vendor/koi-processor"
if [ ! -d "$KOI_CODE/api" ]; then
  info "Fetching KOI runtime code..."
  # Need git for vendor sync
  if ! command -v git &>/dev/null; then
    $SUDO apt-get update -qq &>/dev/null
    $SUDO apt-get install -y -qq git &>/dev/null
  fi
  bash "$OCTO_DIR/vendor/sync.sh"
  if [ ! -d "$KOI_CODE/api" ]; then
    err "Failed to fetch KOI code. Check vendor/sync.sh"
    exit 1
  fi
  ok "KOI code fetched (pin: $(head -c 8 "$OCTO_DIR/vendor/pin.txt"))"
else
  ok "KOI runtime code present"
fi

# ─── Gather info ───
header "Node Configuration"

echo "What is your bioregion or node name?"
echo "  Examples: Salt Spring Island, Cowichan Valley, Front Range"
read -rp "  Node name: " NODE_FULL_NAME

if [ -z "$NODE_FULL_NAME" ]; then
  err "Node name cannot be empty"
  exit 1
fi

# Derive names
NODE_SLUG=$(echo "$NODE_FULL_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | sed 's/[^a-z0-9-]//g')
DB_SHORT=$(echo "$NODE_FULL_NAME" | tr '[:upper:]' '[:lower:]' | awk '{for(i=1;i<=NF;i++) printf substr($i,1,1)}' | sed 's/[^a-z]//g')
if [ ${#DB_SHORT} -le 1 ]; then
  DB_SHORT=$(echo "$NODE_SLUG" | head -c 6)
fi

DB_NAME="${DB_SHORT}_koi"
NODE_DIR="$HOME/${NODE_SLUG}"

# Defaults
API_PORT=8351

echo ""
info "Derived configuration:"
echo "  Database:    $DB_NAME"
echo "  Directory:   $NODE_DIR"
echo "  Node slug:   $NODE_SLUG"
echo "  API port:    $API_PORT"
echo ""
read -rp "  Look good? (Y/n) " CONFIRM
if [[ "${CONFIRM,,}" == "n" ]]; then
  read -rp "  Database name (e.g. cv_koi): " DB_NAME
  read -rp "  Directory (e.g. $HOME/cowichan-valley): " NODE_DIR
  read -rp "  Node slug (e.g. cowichan-valley): " NODE_SLUG
  read -rp "  API port [$API_PORT]: " INPUT_PORT
  API_PORT="${INPUT_PORT:-$API_PORT}"
fi

# Node type
echo ""
echo "What type of node?"
echo ""
echo "  1) Leaf node  [recommended]"
echo "     Joins an existing network (e.g. Salish Sea). Your node shares"
echo "     knowledge upstream to a coordinator and receives network knowledge back."
echo "     Most new nodes start here."
echo ""
echo "  2) Peer network"
echo "     Independent bioregion that exchanges knowledge bidirectionally with"
echo "     other networks. Choose this if you're starting a new regional network."
echo ""
echo "  3) Personal/research"
echo "     Standalone knowledge graph, localhost only. No federation by default."
echo "     Good for experimentation. Can join a network later."
echo ""
echo "  You can change this later — leaf nodes can grow into coordinators,"
echo "  and personal nodes can join the network anytime."
echo ""
read -rp "  Choose (1/2/3) [1]: " NODE_TYPE_NUM
NODE_TYPE_NUM="${NODE_TYPE_NUM:-1}"

case "$NODE_TYPE_NUM" in
  1) NODE_TYPE="Leaf node" ;;
  2) NODE_TYPE="Peer network" ;;
  3) NODE_TYPE="Personal/research" ;;
  *) NODE_TYPE="Leaf node"; NODE_TYPE_NUM=1 ;;
esac

# Embedding provider
echo ""
echo "Semantic matching uses embeddings to find similar entities across your"
echo "knowledge graph. It's optional — your node works without it (exact and"
echo "fuzzy matching still work), but embeddings improve entity resolution."
echo ""
echo "  1) OpenAI  [recommended, ~\$1-2/mo]"
echo "     Uses text-embedding-3-small via API. Requires an API key."
echo ""
echo "  2) Ollama  [free, runs locally]"
echo "     Uses a local Ollama server. No API key needed."
echo "     Requires Ollama installed and accessible from Docker."
echo ""
echo "  3) None / set up later"
echo "     Skip for now. Add OPENAI_API_KEY to .env later to auto-enable."
echo ""
read -rp "  Choose (1/2/3) [1]: " EMBED_CHOICE
EMBED_CHOICE="${EMBED_CHOICE:-1}"

OPENAI_KEY=""
EMBEDDING_PROVIDER=""
EMBEDDING_MODEL=""
OLLAMA_BASE_URL=""

case "$EMBED_CHOICE" in
  1)
    EMBEDDING_PROVIDER="openai"
    EMBEDDING_MODEL="text-embedding-3-small"
    echo ""
    echo "  Get a key at: https://platform.openai.com/api-keys"
    read -rp "  OpenAI API key: " OPENAI_KEY
    if [ -z "$OPENAI_KEY" ]; then
      warn "No key provided. Add OPENAI_API_KEY to .env later to auto-enable semantic matching."
      EMBEDDING_PROVIDER=""
      EMBEDDING_MODEL=""
    fi
    ;;
  2)
    EMBEDDING_PROVIDER="ollama"
    EMBEDDING_MODEL="nomic-embed-text"
    OLLAMA_BASE_URL="http://host.docker.internal:11434"
    echo ""
    echo "  Default model: nomic-embed-text (768 dimensions)"
    echo "  Default URL: $OLLAMA_BASE_URL (reachable from Docker)"
    echo "  If Ollama runs on another host, enter the URL it's reachable at from Docker."
    read -rp "  Ollama model [$EMBEDDING_MODEL]: " INPUT_MODEL
    EMBEDDING_MODEL="${INPUT_MODEL:-$EMBEDDING_MODEL}"
    read -rp "  Ollama URL [$OLLAMA_BASE_URL]: " INPUT_URL
    OLLAMA_BASE_URL="${INPUT_URL:-$OLLAMA_BASE_URL}"
    ;;
  *)
    info "Skipping embeddings. Add OPENAI_API_KEY to .env later to auto-enable."
    ;;
esac

# Public IP + bind
PUBLIC_IP=$(curl -s --max-time 5 -4 ifconfig.me 2>/dev/null || echo "")
if [ "$NODE_TYPE_NUM" = "3" ]; then
  API_BIND="127.0.0.1"
else
  API_BIND="0.0.0.0"
fi

if [ -n "$PUBLIC_IP" ]; then
  KOI_BASE_URL="http://$PUBLIC_IP:$API_PORT"
else
  KOI_BASE_URL="http://127.0.0.1:$API_PORT"
  warn "Could not detect public IP. Update KOI_BASE_URL in .env for federation."
fi

# ─── Create everything ───
header "Setting Up Node"

# 1. Create node directory
info "Creating $NODE_DIR..."
mkdir -p "$NODE_DIR"/{vault,koi-state,workspace}
mkdir -p "$NODE_DIR"/workspace/{interviews/intake,interviews/transcripts,interviews/review,interviews/publication,protocol-library}
mkdir -p "$NODE_DIR"/vault/{Bioregions,Practices,Patterns,Organizations,Projects,Concepts,People,Locations,CaseStudies,Protocols,Playbooks,Questions,Claims,Evidence,Sources}
ok "Directory created"

# 2. Generate password
PG_PASS=$(openssl rand -hex 16 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(16))" 2>/dev/null || echo "changeme-$(date +%s)")

# 3. Write env file
ENV_FILE="$NODE_DIR/.env"
cat > "$ENV_FILE" << ENVEOF
# KOI Node: $NODE_FULL_NAME
# Generated by setup-node.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)

# PostgreSQL
POSTGRES_PASSWORD=$PG_PASS

# Database
KOI_DB_NAME=$DB_NAME

# Embedding (semantic entity resolution)
# Supported providers: openai, ollama, or omit for no embeddings
# If EMBEDDING_PROVIDER is omitted but OPENAI_API_KEY is set, auto-selects OpenAI

# Vault + state (paths inside container map to host mounts)
VAULT_PATH=/data/vault
KOI_STATE_DIR=/data/koi-state

# Federation
KOI_NET_ENABLED=true
KOI_NODE_NAME=$NODE_SLUG
KOI_BASE_URL=$KOI_BASE_URL

# Validation (relaxed for bootstrap — tighten later)
KOI_STRICT_MODE=false
KOI_REQUIRE_SIGNED_ENVELOPES=false
KOI_REQUIRE_SIGNED_RESPONSES=false
KOI_ENFORCE_TARGET_MATCH=false
KOI_ENFORCE_SOURCE_KEY_RID_BINDING=false

# Leaf trust model: coordinator gates network admission; leaf trusts its coordinator.
# Poll gating and handshake deferral are coordinator-only controls.
KOI_NET_REQUIRE_APPROVED_EDGE_FOR_POLL=false
KOI_NET_DEFER_UNKNOWN_HANDSHAKE=false

# API
KOI_API_HOST=0.0.0.0
KOI_API_PORT=8351
ENVEOF

# Append embedding config (only set vars)
[ -n "$EMBEDDING_PROVIDER" ] && echo "EMBEDDING_PROVIDER=$EMBEDDING_PROVIDER" >> "$ENV_FILE"
[ -n "$EMBEDDING_MODEL" ] && echo "EMBEDDING_MODEL=$EMBEDDING_MODEL" >> "$ENV_FILE"
[ -n "$OPENAI_KEY" ] && echo "OPENAI_API_KEY=$OPENAI_KEY" >> "$ENV_FILE"
[ -n "$OLLAMA_BASE_URL" ] && echo "OLLAMA_BASE_URL=$OLLAMA_BASE_URL" >> "$ENV_FILE"

# Also write docker-compose override env for host-side variables
cat > "$NODE_DIR/docker.env" << DKEOF
POSTGRES_PASSWORD=$PG_PASS
KOI_DB_NAME=$DB_NAME
KOI_ENV_FILE=$NODE_DIR/.env
KOI_VAULT_PATH=$NODE_DIR/vault
KOI_STATE_DIR=$NODE_DIR/koi-state
KOI_API_PORT=$API_PORT
KOI_API_BIND=$API_BIND
DKEOF

ok "Config written to $ENV_FILE"

# 4. Write init-db.sql for this node's database
INIT_DB="$NODE_DIR/init-db.sql"
cat > "$INIT_DB" << DBEOF
-- Auto-generated: create $DB_NAME if it doesn't exist
SELECT 'CREATE DATABASE $DB_NAME' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\\gexec

\\c $DB_NAME

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS age;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

LOAD 'age';
ALTER DATABASE $DB_NAME SET search_path = ag_catalog, "\$user", public;
SET search_path = ag_catalog, "\$user", public;
SELECT create_graph('regen_graph');
GRANT USAGE ON SCHEMA ag_catalog TO PUBLIC;
DBEOF

ok "Database init script created"

# 5. Build and start containers
info "Building and starting containers (first build takes a few minutes)..."
cd "$OCTO_DIR/docker"

# Source the docker env vars
set -a; source "$NODE_DIR/docker.env"; set +a

# Mount the node-specific init SQL alongside the default one
export COMPOSE_FILE="$OCTO_DIR/docker/docker-compose.yml"

$DC build --quiet 2>&1 | tail -3
$DC up -d 2>&1 | tail -5

info "Waiting for PostgreSQL..."
for i in $(seq 1 60); do
  if $DOCKER exec regen-koi-postgres pg_isready -U postgres &>/dev/null; then break; fi
  sleep 2
done

if ! $DOCKER exec regen-koi-postgres pg_isready -U postgres &>/dev/null; then
  err "PostgreSQL failed to start. Check: $DOCKER logs regen-koi-postgres"
  exit 1
fi
ok "PostgreSQL is running"

# 6. Create node database (if not the default octo_koi)
if [ "$DB_NAME" != "octo_koi" ]; then
  info "Creating database $DB_NAME..."
  $DOCKER exec -i regen-koi-postgres psql -U postgres < "$INIT_DB" &>/dev/null 2>&1 || true
  ok "Database $DB_NAME ready"
fi

# 7. Wait for API to be healthy
info "Waiting for KOI API..."
for i in $(seq 1 30); do
  if $DOCKER exec koi-api curl -sf http://localhost:8351/health &>/dev/null; then break; fi
  sleep 2
done

if $DOCKER exec koi-api curl -sf http://localhost:8351/health &>/dev/null; then
  ok "API is healthy"
else
  warn "API still starting. Check: $DOCKER logs koi-api"
fi

# 7b. Ollama reachability check
if [ "$EMBEDDING_PROVIDER" = "ollama" ]; then
  info "Checking Ollama reachability from container..."
  if $DOCKER exec koi-api curl -sf "$OLLAMA_BASE_URL/api/tags" &>/dev/null; then
    ok "Ollama reachable from container at $OLLAMA_BASE_URL"
  else
    warn "Ollama not reachable from container at $OLLAMA_BASE_URL"
    echo "  Make sure Ollama is running and accessible from Docker."
    echo "  Update OLLAMA_BASE_URL in $ENV_FILE if needed."
  fi
fi

# 8. Run migrations
info "Running migrations..."
MIG_COUNT=0
for MIG_FILE in $(ls "$KOI_CODE/migrations/"*.sql 2>/dev/null | sort); do
  [ -f "$MIG_FILE" ] || continue
  MIG_NAME=$(basename "$MIG_FILE" .sql)
  cat "$MIG_FILE" | $DOCKER exec -i regen-koi-postgres psql -U postgres -d "$DB_NAME" &>/dev/null \
    && ok "  $MIG_NAME" || warn "  $MIG_NAME (may already exist)"
  MIG_COUNT=$((MIG_COUNT + 1))
done
ok "Applied $MIG_COUNT migrations"

# 9. Generate workspace files
info "Creating workspace files..."

cat > "$NODE_DIR/workspace/IDENTITY.md" << IDEOF
# $NODE_FULL_NAME Knowledge Agent

- **Name:** $NODE_FULL_NAME Node
- **Role:** Bioregional knowledge agent for $NODE_FULL_NAME
- **Node Type:** $NODE_TYPE

## What I Do

I am the knowledge backend for the $NODE_FULL_NAME bioregion.
I track local practices, patterns, and ecological knowledge specific to this place.

## Bioregional Context

TODO: Describe your bioregion — the land, water, peoples, and ecology.
IDEOF

cat > "$NODE_DIR/workspace/SOUL.md" << SOEOF
# $NODE_FULL_NAME — Values

## Core Values

- **Knowledge as commons** — share freely, govern collectively
- **Epistemic justice** — respect diverse ways of knowing
- **Knowledge sovereignty** — communities govern their own knowledge
- **Federation over consolidation** — one node in a web, many centers

## Place-Specific Grounding

TODO: What makes this place unique? What does knowledge mean here?
SOEOF

# Bioregion vault note
BIOREGION_FILE="$NODE_DIR/vault/Bioregions/$(echo "$NODE_FULL_NAME" | sed 's/[\/:]/-/g').md"
cat > "$BIOREGION_FILE" << BIOEOF
---
"@type": "bkc:Bioregion"
name: $NODE_FULL_NAME
description: TODO — describe this bioregion
tags:
  - bioregion
---

# $NODE_FULL_NAME

TODO: Describe this bioregion — its watersheds, ecology, communities, and Indigenous territories.
BIOEOF

ok "Workspace and vault files created"

# 10. Seed bioregion entity
info "Seeding bioregion entity..."
curl -sf -X POST "http://127.0.0.1:$API_PORT/entity/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"label\": \"$NODE_FULL_NAME\", \"type_hint\": \"Bioregion\"}" &>/dev/null \
  && ok "Bioregion entity seeded" \
  || warn "Seeding failed (may need OpenAI key). You can seed later."

echo ""
warn "IMPORTANT: Back up $NODE_DIR/koi-state/ — it contains your node's"
echo "  private key. If lost, you'll need to re-register with a new identity."
echo "  cp -r $NODE_DIR/koi-state/ /safe/backup/location/"

# ─── Federation ───
header "Federation"

NODE_HEALTH=$(curl -sf "http://127.0.0.1:$API_PORT/koi-net/health" 2>/dev/null || echo "")
NODE_RID=$(echo "$NODE_HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); n=d.get('node') or {}; print(n.get('node_rid',''))" 2>/dev/null || echo "")

if [ -z "$NODE_RID" ]; then
  # Try without python3 (might not be on host)
  NODE_RID=$($DOCKER exec koi-api python -c "
import urllib.request, json
d = json.loads(urllib.request.urlopen('http://localhost:8351/koi-net/health').read())
print(d.get('node',{}).get('node_rid',''))
" 2>/dev/null || echo "")
fi

if [ -n "$NODE_RID" ]; then
  ok "Node RID: $NODE_RID"
else
  warn "Could not read node RID (API may still be starting)"
fi

if [ "$NODE_TYPE_NUM" = "3" ]; then
  info "Personal node — skipping federation. Set it up later with:"
  echo "  bash $OCTO_DIR/scripts/connect-koi-peer.sh --db $DB_NAME --peer-url http://45.132.245.30:8351"
else
  echo ""
  echo "Federation connects your node to the BKC network. This means:"
  echo "  - Your node polls the coordinator for shared knowledge (practices,"
  echo "    patterns, case studies from other bioregions)"
  echo "  - The coordinator can poll your node for knowledge you publish"
  echo "  - Knowledge flows via signed envelopes — you control what you share"
  echo ""
  echo "You can set this up later with: bash scripts/connect-koi-peer.sh"
  echo ""
  read -rp "  Set up federation now? (Y/n) " FED_CONFIRM

  if [[ "${FED_CONFIRM,,}" != "n" ]]; then
    COORD_URL="http://45.132.245.30:8351"
    echo ""
    echo "  The default coordinator is Octo (Salish Sea) — the main hub of the"
    echo "  BKC network. Most nodes connect here first."
    echo ""
    read -rp "  Connect to Octo at 45.132.245.30? (Y/n) " COORD_CONFIRM
    if [[ "${COORD_CONFIRM,,}" == "n" ]]; then
      read -rp "  Coordinator URL (e.g. http://1.2.3.4:8351): " COORD_URL
    fi

    # connect-koi-peer.sh needs docker access and python3 for parsing.
    # Run it via the koi-api container to avoid host Python dependency.
    info "Connecting to federation..."
    if KOI_DOCKER_CMD="$DOCKER" bash "$OCTO_DIR/scripts/connect-koi-peer.sh" \
        --db "$DB_NAME" \
        --local-url "http://127.0.0.1:$API_PORT" \
        --peer-url "$COORD_URL" \
        --container "regen-koi-postgres" \
        --rid-types "{Practice,Pattern,Protocol,CaseStudy,Bioregion,Organization,Project,Concept}"; then
      COORD_STATUS="ok"
    else
      warn "Federation had issues. Retry later:"
      echo "  KOI_DOCKER_CMD=\"$DOCKER\" bash $OCTO_DIR/scripts/connect-koi-peer.sh --db $DB_NAME --peer-url $COORD_URL"
      COORD_STATUS="failed"
    fi

    # Open firewall if ufw is available
    if command -v ufw &>/dev/null; then
      $SUDO ufw allow "$API_PORT/tcp" &>/dev/null 2>&1 && ok "Firewall opened on port $API_PORT" || true
    fi
  fi
fi

# ─── Knowledge Site (Quartz) ───
header "Knowledge Site"

echo "A Quartz knowledge site gives your node a browsable website with"
echo "full-text search, graph view, backlinks, and an optional chat widget."
echo ""
read -rp "  Set up a knowledge site (Quartz)? [y/N] " setup_quartz
if [[ "${setup_quartz,,}" =~ ^y ]]; then
  bash "$OCTO_DIR/scripts/setup-quartz.sh" \
    --node-name "$NODE_FULL_NAME" \
    --node-slug "$NODE_SLUG" \
    --node-dir "$NODE_DIR" \
    --koi-api-port "$API_PORT"
fi

# ─── Summary ───
header "Setup Complete!"

echo "Your node is running. Here's a summary:"
echo ""
echo "  Node:       $NODE_FULL_NAME ($NODE_TYPE)"
echo "  Directory:  $NODE_DIR"
echo "  Database:   $DB_NAME"
echo "  API:        http://127.0.0.1:$API_PORT"
echo "  Base URL:   $KOI_BASE_URL"
if [ -n "$NODE_RID" ]; then
  echo "  Node RID:   $NODE_RID"
fi
if [ -n "${PUBLIC_IP:-}" ]; then
  echo "  Public IP:  $PUBLIC_IP"
fi
echo ""

if [ "${COORD_STATUS:-}" = "ok" ]; then
  echo -e "${GREEN}Federation configured.${NC}"
  echo "Send the reciprocal SQL block (printed above) to the coordinator."
  echo ""
fi

echo "Manage your node:"
echo "  cd $OCTO_DIR/docker"
echo "  docker compose logs -f koi-api    # watch logs"
echo "  docker compose restart koi-api    # restart API"
echo "  docker compose down               # stop everything"
echo "  docker compose up -d              # start everything"
echo ""
echo "Next steps:"
echo "  1. Edit workspace files: nano $NODE_DIR/workspace/IDENTITY.md"
echo "  2. Add practices: nano $NODE_DIR/vault/Practices/My Practice.md"
echo "  3. Health check: curl http://127.0.0.1:$API_PORT/health"
