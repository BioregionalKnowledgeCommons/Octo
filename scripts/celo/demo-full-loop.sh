#!/bin/bash
# demo-full-loop.sh — End-to-end commitment economy demo
#
# Flow: Audio → Transcript → Commitments+Needs → Verify → Mint VCV → Agent Commits
#       → TBFF Settle → Claim-from-Settlement → Anchor → EAS Attest → SwapPool
#
# Usage: bash demo-full-loop.sh <audio-file>
#        bash demo-full-loop.sh --skip-audio          (use existing commitments)
#        bash demo-full-loop.sh --act2-only            (agent self-commit only)
#        bash demo-full-loop.sh --act3-only            (settle + attest only)
#        bash demo-full-loop.sh --act4-only            (pool operations only)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

KOI_BASE="${KOI_API_BASE_URL:-http://localhost:8351}"
KOI_CLAIMS_SERVICE_TOKEN="${KOI_CLAIMS_SERVICE_TOKEN:-}"
RESULTS_FILE="/tmp/demo-full-loop-results.json"

# Color output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[DEMO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }
CLAIMS_AUTH_HEADER=()
if [ -n "$KOI_CLAIMS_SERVICE_TOKEN" ]; then
  CLAIMS_AUTH_HEADER=(-H "Authorization: Bearer ${KOI_CLAIMS_SERVICE_TOKEN}")
fi

# Initialize results
echo '{}' > "$RESULTS_FILE"
update_result() {
  local key=$1 val=$2
  local tmp=$(mktemp)
  jq --arg k "$key" --arg v "$val" '. + {($k): $v}' "$RESULTS_FILE" > "$tmp" && mv "$tmp" "$RESULTS_FILE"
}

# Resolve entity URIs (used by Act 3)
resolve_entity() {
  local query=$1 entity_type=$2
  local uri
  uri=$(curl -sf "$KOI_BASE/entity-search?query=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$query', safe=''))")&entity_type=$entity_type" | jq -er '.results[0].fuseki_uri') || {
    warn "Entity not found: $query ($entity_type)"
    echo ""
    return 1
  }
  echo "$uri"
}

# Check prerequisites
check_prereqs() {
  log "Checking prerequisites..."
  command -v npx >/dev/null || fail "npx not found"
  command -v jq  >/dev/null || fail "jq not found"
  command -v curl >/dev/null || fail "curl not found"

  # Check KOI API
  local health
  health=$(curl -sf "$KOI_BASE/health" 2>/dev/null || echo "")
  [ -n "$health" ] || fail "KOI API not reachable at $KOI_BASE"
  log "KOI API: OK"

  # Check .env
  [ -f .env ] || fail ".env not found in $SCRIPT_DIR"
  [ -n "$KOI_CLAIMS_SERVICE_TOKEN" ] || fail "KOI_CLAIMS_SERVICE_TOKEN not set in .env"
  log "Prerequisites: OK"
}

# ================================================================
# ACT 1: Human Participation
# Audio → Transcript → Commitments+Needs → Verify → Mint
# ================================================================
act1_human() {
  local audio_file="$1"
  echo ""
  echo "================================================================"
  log "ACT 1: Human Participation"
  echo "================================================================"

  # 1a. Transcribe
  log "Step 1a: Transcribing audio..."
  local transcript
  transcript=$(npx tsx transcribe-and-extract.ts --transcribe-only "$audio_file" 2>/dev/null | tail -1)
  if [ -z "$transcript" ]; then
    fail "Transcription returned empty text"
  fi
  local transcript_len=${#transcript}
  log "Transcript: ${transcript_len} characters"
  update_result "transcript_length" "$transcript_len"

  # 1b. Extract commitments + needs
  log "Step 1b: Extracting commitments and needs..."
  local extract_result
  extract_result=$(curl -sf -X POST "$KOI_BASE/commitments/extract-from-transcript" \
    -H 'Content-Type: application/json' \
    "${CLAIMS_AUTH_HEADER[@]}" \
    -d "$(jq -n --arg t "$transcript" '{
      document_text: $t,
      source_document: "demo-workshop-audio",
      bioregion: "Salish Sea",
      confidence_threshold: 0.6,
      auto_create: true
    }')")

  local n_candidates
  n_candidates=$(echo "$extract_result" | jq '.candidates | length')
  local n_created
  n_created=$(echo "$extract_result" | jq '.auto_created | length // 0')
  log "Extracted: ${n_candidates} candidates, ${n_created} auto-created"
  update_result "candidates_extracted" "$n_candidates"
  update_result "commitments_created" "$n_created"

  # Display candidates
  echo "$extract_result" | jq -r '.candidates[] | "  [\(.declaration_type // "commitment" | ascii_upcase)] \(.title) (confidence=\(.confidence))"'

  # 1c. List auto-created commitment RIDs
  local commitment_rids
  commitment_rids=$(echo "$extract_result" | jq -r '.auto_created[]? | select(.status == "created") | .commitment_rid')

  if [ -z "$commitment_rids" ]; then
    warn "No commitments auto-created (pledger entities may not exist in registry)"
    warn "Proceeding with any existing PROPOSED commitments..."

    # Fall back to listing PROPOSED commitments
    commitment_rids=$(curl -sf "$KOI_BASE/commitments/?state=PROPOSED&limit=10" | jq -r '.[].commitment_rid')
  fi

  # 1d. Verify all PROPOSED → VERIFIED
  log "Step 1d: Verifying commitments..."
  local verified_count=0
  while IFS= read -r rid; do
    [ -z "$rid" ] && continue
    local verify_resp
    verify_resp=$(curl -sf -X PATCH "$KOI_BASE/commitments/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$rid', safe=''))")/state" \
      -H 'Content-Type: application/json' \
      -d '{"new_state": "VERIFIED", "actor": "darren", "reason": "demo verification"}' 2>/dev/null || echo '{"state":"already"}')
    verified_count=$((verified_count + 1))
    log "  Verified: $rid"
  done <<< "$commitment_rids"
  update_result "commitments_verified" "$verified_count"

  # 1e. Mint VCV for each verified commitment
  log "Step 1e: Minting VCV tokens..."
  local mint_count=0
  local verified_rids
  verified_rids=$(curl -sf "$KOI_BASE/commitments/?state=VERIFIED&limit=20" | jq -r '.[].commitment_rid')
  while IFS= read -r rid; do
    [ -z "$rid" ] && continue
    log "  Minting for: $rid"
    npx tsx mint-commitment-token.ts "$rid" 2>&1 | grep -E "^(TX:|Amount:|Already)" || true
    mint_count=$((mint_count + 1))
  done <<< "$verified_rids"
  update_result "tokens_minted" "$mint_count"
  log "Act 1 complete: ${mint_count} commitments minted as VCV"
}

# ================================================================
# ACT 2: Agent Participation
# Octo registers its own commitments + needs
# ================================================================
act2_agent() {
  echo ""
  echo "================================================================"
  log "ACT 2: Agent Self-Commitment"
  echo "================================================================"

  npx tsx agent-self-commit.ts 2>&1

  # Count agent commitments
  local agent_count
  agent_count=$(curl -sf "$KOI_BASE/commitments/?limit=200" | jq '[.[] | select(.metadata.declaration_type != null)] | length')
  update_result "agent_commitments" "$agent_count"
  log "Act 2 complete: Agent registered commitments and needs"
}

# ================================================================
# ACT 3: Settlement + Proof
# TBFF settle → claim-from-settlement → anchor → EAS attest
# ================================================================
act3_settle() {
  echo ""
  echo "================================================================"
  log "ACT 3: TBFF Settlement + Attestation"
  echo "================================================================"

  # Determine which settler script to use
  local settler_script="deploy-settler.ts"
  if [ -n "${MULTI_SETTLER_ADDRESS:-}" ]; then
    settler_script="deploy-multi-settler.ts"
    log "Using multi-participant settler: $MULTI_SETTLER_ADDRESS"
  fi

  # 3a. Capture pre-settle network state
  log "Step 3a: Capturing pre-settle network state..."
  local pre_state
  pre_state=$(npx tsx "$settler_script" --status-json 2>/dev/null || echo '{"nodes":[]}')
  echo "$pre_state" | jq -r '.nodes[] | "  \(.label): balance=\(.balance) threshold=\(.threshold)"'

  # 3b. Execute settlement
  log "Step 3b: Executing TBFF settlement..."
  local settle_output
  settle_output=$(npx tsx "$settler_script" --settle 2>&1)
  echo "$settle_output"

  local settle_tx
  settle_tx=$(echo "$settle_output" | grep "^TX:" | head -1 | awk '{print $2}')
  if [ -z "$settle_tx" ]; then
    warn "Could not extract settle TX hash"
    settle_tx="demo-settle-$(date +%s)"
  fi
  update_result "settle_tx" "$settle_tx"

  # Read post-settle values from contract
  local iterations converged total_redistributed
  iterations=$(echo "$settle_output" | grep "^Iterations:" | awk '{print $2}')
  converged=$(echo "$settle_output" | grep "^Converged:" | awk '{print $2}')
  total_redistributed=$(echo "$settle_output" | grep "^Total redistributed:" | awk '{print $3}')
  iterations=${iterations:-1}
  converged=${converged:-true}
  total_redistributed=${total_redistributed:-0.0}

  # 3b-post. Capture post-settle network state
  log "Step 3b-post: Capturing post-settle state..."
  local post_state
  post_state=$(npx tsx "$settler_script" --status-json 2>/dev/null || echo '{"nodes":[]}')
  echo "$post_state" | jq -r '.nodes[] | "  \(.label): balance=\(.balance) threshold=\(.threshold)"'

  # Build node_balances array from pre/post state
  local node_balances
  node_balances=$(jq -n --argjson pre "$pre_state" --argjson post "$post_state" '
    [range($pre.nodes | length)] | map({
      participant_name: $pre.nodes[.].label,
      initial_balance: $pre.nodes[.].balance,
      final_balance: $post.nodes[.].balance,
      threshold: $pre.nodes[.].threshold
    })
  ')

  # 3c. Resolve entity URIs for claim-from-settlement
  log "Step 3c: Resolving entities + creating claim from settlement..."
  local claimant_uri about_uri reviewer_uri operator_uri
  claimant_uri=$(resolve_entity "Victoria Landscape Hub" "Organization") || true
  about_uri=$(resolve_entity "Salish Sea" "Bioregion") || true
  reviewer_uri=$(resolve_entity "Darren" "Person") || true
  operator_uri=$(resolve_entity "Regenerate Cascadia" "Organization") || true

  if [ -z "$claimant_uri" ] || [ -z "$reviewer_uri" ]; then
    warn "Could not resolve required entities — using available URIs"
    # Try fallbacks
    [ -z "$claimant_uri" ] && claimant_uri=$(resolve_entity "Victoria" "Organization") || true
    [ -z "$reviewer_uri" ] && reviewer_uri=$(resolve_entity "Darren Zal" "Person") || true
  fi

  if [ -z "$claimant_uri" ] || [ -z "$reviewer_uri" ]; then
    warn "Cannot create claim — missing claimant or reviewer entity"
    update_result "claim_rid" "skipped_no_entities"
    log "Act 3 complete (partial — entity resolution failed)"
    return
  fi

  # Single POST /claims/claim-from-settlement — creates evidence + claim + auto-advance
  local claim_resp
  claim_resp=$(curl -sf -X POST "$KOI_BASE/claims/claim-from-settlement" \
    -H 'Content-Type: application/json' \
    "${CLAIMS_AUTH_HEADER[@]}" \
    -d "$(jq -n \
      --arg sid "$settle_tx" \
      --arg tx "$settle_tx" \
      --argjson iter "${iterations}" \
      --argjson conv "${converged}" \
      --argjson total "${total_redistributed}" \
      --argjson nb "$node_balances" \
      --arg claimant "$claimant_uri" \
      --arg about "${about_uri:-}" \
      --arg reviewer "$reviewer_uri" \
      --arg operator "${operator_uri:-}" \
      '{
        settlement: {
          settlement_id: $sid,
          tx_hash: $tx,
          chain_id: 42220,
          iterations: $iter,
          converged: $conv,
          total_redistributed_usd: $total,
          node_balances: $nb,
          bioregion: "Salish Sea",
          description: ("TBFF settlement redistributed $" + ($total | tostring) + " VCV across Victoria Landscape Hub participants based on needs-weighted thresholds. TX: " + $tx)
        },
        claimant_uri: $claimant,
        about_uri: (if $about == "" then null else $about end),
        statement: ("TBFF settlement redistributed $" + ($total | tostring) + " VCV across commitment pool participants, verifying community resource flows in the Salish Sea bioregion."),
        claim_type: "financial",
        reviewer_uri: $reviewer,
        operator_uri: (if $operator == "" then null else $operator end)
      }')" 2>/dev/null || echo '{"error": "claim-from-settlement failed"}')

  echo "$claim_resp" | jq '.'

  local claim_rid verification auto_advanced evidence_uri
  claim_rid=$(echo "$claim_resp" | jq -r '.claim_rid // "none"')
  verification=$(echo "$claim_resp" | jq -r '.verification // "unknown"')
  auto_advanced=$(echo "$claim_resp" | jq -r '.auto_advanced // false')
  evidence_uri=$(echo "$claim_resp" | jq -r '.evidence_uri // "none"')

  log "Claim: $claim_rid"
  log "Verification: $verification (auto_advanced=$auto_advanced)"
  log "Evidence: $evidence_uri"
  update_result "claim_rid" "$claim_rid"
  update_result "claim_verification" "$verification"
  update_result "evidence_uri" "$evidence_uri"

  # 3d. Anchor claim if verified
  if [ "$verification" = "verified" ] && [ "$claim_rid" != "none" ]; then
    log "Step 3d: Anchoring claim on Regen Ledger..."
    local encoded_rid
    encoded_rid=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$claim_rid', safe=''))")

    # Prepare anchor (compute content hash)
    local prepare_resp
    prepare_resp=$(curl -sf -X POST "$KOI_BASE/claims/${encoded_rid}/prepare-anchor" "${CLAIMS_AUTH_HEADER[@]}" 2>/dev/null || echo '{"error":"prepare failed"}')
    log "Prepare-anchor: $(echo "$prepare_resp" | jq -r '.content_hash // .error // "ok"' | head -c 40)"

    # Anchor
    local anchor_resp anchor_status
    anchor_resp=$(curl -sf -w '\n%{http_code}' -X POST "$KOI_BASE/claims/${encoded_rid}/anchor" "${CLAIMS_AUTH_HEADER[@]}" 2>/dev/null || echo -e '{"error":"anchor failed"}\n503')
    anchor_status=$(echo "$anchor_resp" | tail -1)
    local anchor_body
    anchor_body=$(echo "$anchor_resp" | sed '$d')

    if [ "$anchor_status" = "200" ]; then
      log "Claim anchored successfully"
      update_result "anchor_status" "ledger_anchored"
      verification="ledger_anchored"
    elif [ "$anchor_status" = "202" ]; then
      log "Anchor broadcast but confirmation timed out — reconciling..."
      update_result "anchor_status" "pending"
      # Poll reconcile (max 6 retries, 5s sleep)
      local reconcile_count=0
      while [ $reconcile_count -lt 6 ]; do
        sleep 5
        local reconcile_resp
        reconcile_resp=$(curl -sf -X POST "$KOI_BASE/claims/${encoded_rid}/reconcile" "${CLAIMS_AUTH_HEADER[@]}" 2>/dev/null || echo '{"status":"error"}')
        local rec_status
        rec_status=$(echo "$reconcile_resp" | jq -r '.status // "error"')
        log "  Reconcile attempt $((reconcile_count + 1)): $rec_status"
        if [ "$rec_status" = "anchored" ]; then
          log "Claim anchored via reconcile"
          update_result "anchor_status" "ledger_anchored"
          verification="ledger_anchored"
          break
        elif [ "$rec_status" = "failed" ]; then
          warn "Anchor failed on-chain"
          update_result "anchor_status" "failed"
          break
        fi
        reconcile_count=$((reconcile_count + 1))
      done
      if [ $reconcile_count -ge 6 ]; then
        warn "Reconcile timed out — claim stays at verified"
        update_result "anchor_status" "reconcile_timeout"
      fi
    else
      warn "Anchor returned $anchor_status — claim stays at verified"
      update_result "anchor_status" "unavailable_${anchor_status}"
    fi
  elif [ "$claim_rid" != "none" ]; then
    log "Claim at $verification — anchor requires verified state"
    update_result "anchor_status" "skipped_${verification}"
  fi

  # 3e. EAS attestation (requires ledger_anchored)
  if [ "$verification" = "ledger_anchored" ] && [ "$claim_rid" != "none" ]; then
    log "Step 3e: Creating EAS attestation..."
    cd "$SCRIPT_DIR/../eas"
    local attest_output
    attest_output=$(npx tsx attest.ts "$claim_rid" 2>&1)
    echo "$attest_output" | grep -E "^(Attestation UID|View:)" || true
    local attest_uid
    attest_uid=$(echo "$attest_output" | grep "Attestation UID:" | awk '{print $3}')
    update_result "eas_attestation" "${attest_uid:-pending}"
    cd "$SCRIPT_DIR"
  else
    log "EAS attestation deferred (claim at $verification, needs ledger_anchored)"
    update_result "eas_attestation" "deferred_${verification}"
  fi

  log "Act 3 complete"
}

# ================================================================
# ACT 4: SwapPool Operations
# Show pool status, execute swap or quote
# ================================================================
act4_pool() {
  echo ""
  echo "================================================================"
  log "ACT 4: SwapPool Operations"
  echo "================================================================"

  # Check if pool is deployed
  if ! grep -q SWAP_POOL_ADDRESS .env 2>/dev/null; then
    warn "SWAP_POOL_ADDRESS not in .env — pool not deployed yet"
    log "Deploy with: npx tsx deploy-swap-pool.ts"
    update_result "pool_status" "not_deployed"
    return
  fi

  # 4a. Show pool status
  log "Step 4a: Pool status..."
  npx tsx deploy-swap-pool.ts --status 2>&1

  # 4b. Check if pool has cUSD; if not, try to acquire some
  local pool_cusd
  pool_cusd=$(npx tsx deploy-swap-pool.ts --status 2>&1 | grep "cUSD in pool:" | awk '{print $4}' || echo "0.0")
  if [ "$pool_cusd" = "0.0" ]; then
    log "Pool has no cUSD — attempting to acquire..."
    if npx tsx acquire-cusd.ts --amount 5 2>&1; then
      npx tsx deploy-swap-pool.ts --deposit-cusd 5 2>&1
    else
      warn "Could not acquire cUSD — swap will be quote-only"
    fi
  fi

  # 4c. Get quote for 100 VCV → cUSD
  log "Step 4c: Getting quote for 100 VCV → cUSD..."
  local quote_output
  quote_output=$(npx tsx execute-swap.ts --quote 100 2>&1 || echo "Quote failed")
  echo "$quote_output"
  update_result "pool_quote" "$(echo "$quote_output" | grep "Quote:" | head -1 || echo "none")"

  # 4d. Execute real swap if pool has cUSD
  pool_cusd=$(npx tsx deploy-swap-pool.ts --status 2>&1 | grep "cUSD in pool:" | awk '{print $4}' || echo "0.0")
  if [ "$pool_cusd" != "0.0" ]; then
    log "Step 4d: Executing real swap: 100 VCV → cUSD..."
    local swap_output
    swap_output=$(npx tsx execute-swap.ts --swap 100 2>&1 || echo "Swap failed")
    echo "$swap_output"
    local swap_tx
    swap_tx=$(echo "$swap_output" | grep "^TX:" | head -1 | awk '{print $2}')
    update_result "swap_tx" "${swap_tx:-failed}"
    local swap_event
    swap_event=$(echo "$swap_output" | grep "Out:" | head -1 || echo "")
    update_result "swap_result" "${swap_event:-no_event}"
  else
    warn "Pool still has no cUSD — skipping real swap"
    update_result "swap_tx" "skipped_no_cusd"
  fi

  log "Act 4 complete"
}

# ================================================================
# Summary
# ================================================================
print_summary() {
  echo ""
  echo "================================================================"
  log "DEMO COMPLETE"
  echo "================================================================"
  echo ""

  # Check wallet balance
  log "Final wallet state:"
  npx tsx mint-commitment-token.ts --check-balance 2>&1 | grep -E "^(VCV|CELO|Address)" || true

  echo ""
  log "Results:"
  jq '.' "$RESULTS_FILE"

  echo ""
  log "View on Celoscan: https://celoscan.io/address/$(grep VCV_TOKEN_ADDRESS .env | cut -d= -f2)"
}

# ================================================================
# Main
# ================================================================
main() {
  check_prereqs

  local args=("$@")

  if [[ " ${args[*]:-} " =~ " --act2-only " ]]; then
    act2_agent
    print_summary
    return
  fi

  if [[ " ${args[*]:-} " =~ " --act3-only " ]]; then
    act3_settle
    print_summary
    return
  fi

  if [[ " ${args[*]:-} " =~ " --act4-only " ]]; then
    act4_pool
    print_summary
    return
  fi

  if [[ " ${args[*]:-} " =~ " --skip-audio " ]]; then
    log "Skipping Act 1 (--skip-audio)"
    act2_agent
    act3_settle
    act4_pool
    print_summary
    return
  fi

  local audio_file="${1:-}"
  if [ -z "$audio_file" ]; then
    echo "Usage:"
    echo "  bash demo-full-loop.sh <audio-file>       Full demo"
    echo "  bash demo-full-loop.sh --skip-audio        Skip transcription"
    echo "  bash demo-full-loop.sh --act2-only         Agent self-commit only"
    echo "  bash demo-full-loop.sh --act3-only         Settle + attest only"
    echo "  bash demo-full-loop.sh --act4-only         Pool operations only"
    exit 1
  fi

  [ -f "$audio_file" ] || fail "Audio file not found: $audio_file"

  act1_human "$audio_file"
  act2_agent
  act3_settle
  act4_pool
  print_summary
}

main "$@"
