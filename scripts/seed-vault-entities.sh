#!/bin/bash
# Seed vault entities from vault-seed/ into a KOI API instance.
# Usage: ./seed-vault-entities.sh [api_url] [vault_seed_dir]
# Defaults: http://127.0.0.1:8351  /root/Octo/vault-seed

set -euo pipefail

API_URL="${1:-http://127.0.0.1:8351}"
VAULT_SEED_DIR="${2:-$(dirname "$0")/../vault-seed}"

# Resolve to absolute path
VAULT_SEED_DIR="$(cd "$VAULT_SEED_DIR" 2>/dev/null && pwd)" || {
  echo "ERROR: vault-seed directory not found: $VAULT_SEED_DIR"
  exit 1
}

echo "Seeding vault entities from $VAULT_SEED_DIR into $API_URL"
echo "---"

SUCCESS=0
FAIL=0
SKIP=0

# Collect files into array (handles spaces in filenames)
mapfile -d '' MD_FILES < <(find "$VAULT_SEED_DIR" -name "*.md" -type f -print0 | sort -z)

for MD_FILE in "${MD_FILES[@]}"; do
  # Extract entity type from directory name
  DIR_NAME=$(basename "$(dirname "$MD_FILE")")
  case "$DIR_NAME" in
    Practices)     ENTITY_TYPE="Practice" ;;
    Bioregions)    ENTITY_TYPE="Bioregion" ;;
    Patterns)      ENTITY_TYPE="Pattern" ;;
    CaseStudies)   ENTITY_TYPE="CaseStudy" ;;
    Claims)        ENTITY_TYPE="Claim" ;;
    Evidence)      ENTITY_TYPE="Evidence" ;;
    Protocols)     ENTITY_TYPE="Protocol" ;;
    Playbooks)     ENTITY_TYPE="Playbook" ;;
    Questions)     ENTITY_TYPE="Question" ;;
    People)        ENTITY_TYPE="Person" ;;
    Organizations) ENTITY_TYPE="Organization" ;;
    Projects)      ENTITY_TYPE="Project" ;;
    Concepts)      ENTITY_TYPE="Concept" ;;
    *)             ENTITY_TYPE="$DIR_NAME" ;;
  esac

  # Extract entity name from filename (strip .md)
  ENTITY_NAME=$(basename "$MD_FILE" .md)

  # Generate vault_rid from path
  RELATIVE_PATH="${MD_FILE#"$VAULT_SEED_DIR"/}"
  VAULT_RID="orn:obsidian.entity:vault-seed/$(echo "$RELATIVE_PATH" | sed 's/ /-/g; s/\.md$//')"

  # Generate content_hash (sha256sum on Linux, shasum on macOS)
  if command -v sha256sum &>/dev/null; then
    CONTENT_HASH=$(sha256sum "$MD_FILE" | cut -d' ' -f1)
  else
    CONTENT_HASH=$(shasum -a 256 "$MD_FILE" | cut -d' ' -f1)
  fi

  # Extract description from frontmatter if present
  DESCRIPTION=$(sed -n '/^---$/,/^---$/{ /^description:/s/^description: *//p }' "$MD_FILE" | head -1)

  # Build JSON payload using python for safe escaping
  PAYLOAD=$(python3 -c "
import json, sys
print(json.dumps({
    'vault_rid': sys.argv[1],
    'vault_path': sys.argv[2],
    'entity_type': sys.argv[3],
    'name': sys.argv[4],
    'properties': {'description': sys.argv[5], 'source': 'vault-seed'},
    'content_hash': sys.argv[6]
}))
" "$VAULT_RID" "$DIR_NAME/$ENTITY_NAME.md" "$ENTITY_TYPE" "$ENTITY_NAME" "$DESCRIPTION" "$CONTENT_HASH")

  # POST to register-entity
  echo -n "  $ENTITY_TYPE/$ENTITY_NAME ... "
  RESP=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/register-entity" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>&1)

  HTTP_CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')

  if [ "$HTTP_CODE" = "200" ]; then
    IS_NEW=$(echo "$BODY" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("is_new", "?"))' 2>/dev/null || echo "?")
    if [ "$IS_NEW" = "True" ]; then
      echo "CREATED"
      SUCCESS=$((SUCCESS + 1))
    else
      echo "EXISTS (merged)"
      SKIP=$((SKIP + 1))
    fi
  else
    echo "FAILED (HTTP $HTTP_CODE)"
    echo "    $BODY" | head -3
    FAIL=$((FAIL + 1))
  fi
done

echo "---"
echo "Results: $SUCCESS created, $SKIP already existed, $FAIL failed"
echo ""
echo "Next steps:"
echo "  1. Run backfill_koi_rids.py to assign KOI RIDs to new entities"
echo "  2. Restart agents to pick up changes"
