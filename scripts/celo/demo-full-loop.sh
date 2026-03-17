#!/bin/bash
# demo-full-loop.sh — End-to-end commitment economy demo
#
# Flow: Audio → Transcript → Commitments+Needs → Verify → Mint VCV → Agent Commits
#       → TBFF Settle → Settlement Evidence → Claim → EAS Attest
#
# Usage: bash demo-full-loop.sh <audio-file>
#        bash demo-full-loop.sh --skip-audio          (use existing commitments)
#        bash demo-full-loop.sh --act2-only            (agent self-commit only)
#        bash demo-full-loop.sh --act3-only            (settle + attest only)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

KOI_BASE="${KOI_API_BASE_URL:-http://localhost:8351}"
RESULTS_FILE="/tmp/demo-full-loop-results.json"

# Color output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[DEMO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

# Initialize results
echo '{}' > "$RESULTS_FILE"
update_result() {
  local key=$1 val=$2
  local tmp=$(mktemp)
  jq --arg k "$key" --arg v "$val" '. + {($k): $v}' "$RESULTS_FILE" > "$tmp" && mv "$tmp" "$RESULTS_FILE"
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
# TBFF settle → settlement evidence → claim → EAS attest
# ================================================================
act3_settle() {
  echo ""
  echo "================================================================"
  log "ACT 3: TBFF Settlement + Attestation"
  echo "================================================================"

  # 3a. Check settler status
  log "Step 3a: Checking settler status..."
  npx tsx deploy-settler.ts 2>&1 | head -20

  # 3b. Execute settlement
  log "Step 3b: Executing TBFF settlement..."
  local settle_output
  settle_output=$(npx tsx deploy-settler.ts --settle 2>&1)
  echo "$settle_output"

  local settle_tx
  settle_tx=$(echo "$settle_output" | grep "^TX:" | head -1 | awk '{print $2}')
  if [ -z "$settle_tx" ]; then
    warn "Could not extract settle TX hash"
    settle_tx="unknown"
  fi
  update_result "settle_tx" "$settle_tx"

  # 3c. Create settlement evidence
  log "Step 3c: Creating settlement evidence..."
  local evidence_resp
  evidence_resp=$(curl -sf -X POST "$KOI_BASE/claims/evidence-from-settlement" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg tx "$settle_tx" '{
      settlement_data: {
        total_redistributed_usd: 100,
        participants: ["darren", "octo-agent"],
        settle_tx_hash: $tx,
        chain_id: 42220,
        token_address: "0x4CDb98Ff88af070b1794752932DbAD9Edf7a1573",
        settler_address: "0x10De66A7f4e20d696Fb0d815c99068D4fA1f9030",
        converged: true,
        iterations: 3
      },
      operator_uri: "orn:koi-net.node:octo-salish-sea+f06551d75797303be1831a1e00b41cf930625961882082346cb3932175a17716"
    }')" 2>/dev/null || echo '{"error": "settlement endpoint may not exist"}')

  local evidence_uri
  evidence_uri=$(echo "$evidence_resp" | jq -r '.evidence_uri // .entity_uri // "none"')
  log "Settlement evidence: $evidence_uri"
  update_result "settlement_evidence" "$evidence_uri"

  # 3d. Create claim from a verified commitment
  log "Step 3d: Creating claim from commitment..."
  local first_verified
  first_verified=$(curl -sf "$KOI_BASE/commitments/?state=VERIFIED&limit=1" | jq -r '.[0].commitment_rid // empty')

  if [ -n "$first_verified" ]; then
    local claim_resp
    claim_resp=$(curl -sf -X POST "$KOI_BASE/commitments/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$first_verified', safe=''))")/create-claim" \
      -H 'Content-Type: application/json' \
      -d '{"actor": "demo-full-loop"}' 2>/dev/null || echo '{"error": "claim creation failed"}')

    local claim_rid
    claim_rid=$(echo "$claim_resp" | jq -r '.claim_rid // "none"')
    log "Claim: $claim_rid"
    update_result "claim_rid" "$claim_rid"

    # 3e. EAS attestation (if claim was anchored)
    if [ "$claim_rid" != "none" ]; then
      log "Step 3e: Checking if claim can be attested..."
      # Check claim state
      local claim_state
      claim_state=$(curl -sf "$KOI_BASE/claims/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$claim_rid', safe=''))")" 2>/dev/null | jq -r '.verification // "unknown"')
      log "Claim state: $claim_state"

      if [ "$claim_state" = "ledger_anchored" ]; then
        log "Creating EAS attestation..."
        cd "$SCRIPT_DIR/../eas"
        local attest_output
        attest_output=$(npx tsx attest.ts "$claim_rid" 2>&1)
        echo "$attest_output" | grep -E "^(Attestation UID|View:)" || true
        local attest_uid
        attest_uid=$(echo "$attest_output" | grep "Attestation UID:" | awk '{print $3}')
        update_result "eas_attestation" "${attest_uid:-pending}"
        cd "$SCRIPT_DIR"
      else
        log "Claim not yet ledger_anchored — attestation deferred"
        update_result "eas_attestation" "deferred_${claim_state}"
      fi
    fi
  else
    warn "No verified commitments found for claim creation"
  fi

  log "Act 3 complete"
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

  if [[ " ${args[*]:-} " =~ " --skip-audio " ]]; then
    log "Skipping Act 1 (--skip-audio)"
    act2_agent
    act3_settle
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
    exit 1
  fi

  [ -f "$audio_file" ] || fail "Audio file not found: $audio_file"

  act1_human "$audio_file"
  act2_agent
  act3_settle
  print_summary
}

main "$@"
