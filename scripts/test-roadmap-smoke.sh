#!/usr/bin/env bash
# test-roadmap-smoke.sh — CI smoke tests for roadmap query endpoints + KOI entities
#
# Usage:
#   ./test-roadmap-smoke.sh                                    # default: production
#   ./test-roadmap-smoke.sh https://45.132.245.30.sslip.io/commons
#
# Exit codes:
#   0 = all checks pass
#   1 = one or more checks failed

set -euo pipefail

# Default to localhost when running on server, HTTPS when running externally
if [[ -f /root/koi-processor/config/personal.env ]]; then
  BASE="${1:-http://localhost:3100/commons}"
else
  BASE="${1:-https://45.132.245.30.sslip.io/commons}"
fi
PASS=0
FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  [PASS] $name (got: $actual)"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] $name (expected: $expected, got: $actual)"
    FAIL=$((FAIL + 1))
  fi
}

check_gte() {
  local name="$1" min="$2" actual="$3"
  if [[ "$actual" -ge "$min" ]] 2>/dev/null; then
    echo "  [PASS] $name (got: $actual >= $min)"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] $name (expected >= $min, got: $actual)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Roadmap Smoke Tests ==="
echo "Base URL: $BASE"
echo ""

# ---------------------------------------------------------------------------
# 1. Stats endpoint — entity + edge counts
# ---------------------------------------------------------------------------
echo "--- 1. Stats endpoint ---"
STATS=$(curl -sf "$BASE/api/roadmap/stats" 2>/dev/null || echo '{}')
TOTAL_NODES=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_nodes',0))" 2>/dev/null || echo 0)
TOTAL_EDGES=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_edges',0))" 2>/dev/null || echo 0)
VERSION=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || echo "")

check_gte "total_nodes" 100 "$TOTAL_NODES"
check_gte "total_edges" 140 "$TOTAL_EDGES"
check "version non-empty" "true" "$( [[ -n "$VERSION" ]] && echo true || echo false )"

# ---------------------------------------------------------------------------
# 2. Query endpoint — filter by status
# ---------------------------------------------------------------------------
echo "--- 2. Query endpoint ---"
DONE_COUNT=$(curl -sf "$BASE/api/roadmap/query?status=done" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('count', len(d.get('nodes',[]))))" 2>/dev/null || echo 0)
check_gte "done items" 30 "$DONE_COUNT"

IN_PROGRESS=$(curl -sf "$BASE/api/roadmap/query?status=in_progress" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('count', len(d.get('nodes',[]))))" 2>/dev/null || echo 0)
check_gte "in_progress items" 1 "$IN_PROGRESS"

# ---------------------------------------------------------------------------
# 3. Walk endpoint — backward from known outcome
# ---------------------------------------------------------------------------
echo "--- 3. Walk endpoint ---"
WALK=$(curl -sf "$BASE/api/roadmap/walk?from=outcome.bioregional-swarm-live&direction=backward&edge_type=delivers" 2>/dev/null || echo '{}')
WALK_COUNT=$(echo "$WALK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('node_count',0))" 2>/dev/null || echo 0)
check_gte "walk node_count (swarm backward)" 10 "$WALK_COUNT"

# ---------------------------------------------------------------------------
# 4. Chat — roadmap intent detection
# ---------------------------------------------------------------------------
echo "--- 4. Chat roadmap intent ---"
CHAT=$(curl -sf -X POST "$BASE/api/chat" \
  -H 'Content-Type: application/json' \
  -d '{"query": "What milestones are on the roadmap?"}' 2>/dev/null || echo '{}')
INTENT=$(echo "$CHAT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('intent',''))" 2>/dev/null || echo "")
RESP_NODE=$(echo "$CHAT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('respondingNode',''))" 2>/dev/null || echo "")
CHAT_SOURCES=$(echo "$CHAT" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('sources',[])))" 2>/dev/null || echo 0)

check "intent" "roadmap" "$INTENT"
check "respondingNode" "roadmap" "$RESP_NODE"
check_gte "chat sources" 5 "$CHAT_SOURCES"

# ---------------------------------------------------------------------------
# 5. Chat — non-roadmap falls through to KOI
# ---------------------------------------------------------------------------
echo "--- 5. Chat KOI fallthrough ---"
KOI_CHAT=$(curl -sf -X POST "$BASE/api/chat" \
  -H 'Content-Type: application/json' \
  -d '{"query": "Tell me about herring monitoring practices"}' 2>/dev/null || echo '{}')
KOI_NODE=$(echo "$KOI_CHAT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('respondingNode',''))" 2>/dev/null || echo "")
KOI_NOT_ROADMAP=$( [[ "$KOI_NODE" != "roadmap" ]] && echo true || echo false )
check "KOI fallthrough (not roadmap)" "true" "$KOI_NOT_ROADMAP"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
TOTAL=$((PASS + FAIL))
echo "=== Results: $PASS/$TOTAL passed ==="

if [[ "$FAIL" -gt 0 ]]; then
  echo "FAILED ($FAIL failures)"
  exit 1
else
  echo "ALL PASSED"
  exit 0
fi
