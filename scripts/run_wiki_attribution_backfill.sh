#!/bin/bash
# Weekly cron: regenerate the wiki-attribution-targets CSV from DB and re-run
# the backfill script. Forward coverage for any wiki entities added since the
# last run. Idempotent — already-attributed notes report `already_set` and skip.
#
# Cron suggestion: 30 4 * * 1 /root/koi-processor/scripts/run_wiki_attribution_backfill.sh
set -euo pipefail

KOI_DIR=/root/koi-processor
CSV=/tmp/wiki-attribution-targets.csv
LOG=/var/log/wiki-attribution-backfill.log

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

{
  echo "[$(ts)] === wiki attribution backfill start ==="

  docker exec regen-koi-postgres psql -U postgres -d octo_koi -A -t -F'|' -c "
    SELECT
      er.entity_text,
      er.entity_type,
      CASE WHEN er.vault_rid IS NOT NULL AND er.vault_rid != '' THEN er.vault_rid ELSE NULL END,
      mw.base_url || '/wiki/' || replace(mps.title, ' ', '_'),
      mps.source_rid,
      CASE WHEN er.vault_rid IS NOT NULL AND er.vault_rid != '' THEN 'vault_rid' ELSE 'derived' END
    FROM mediawiki_page_state mps
    JOIN mediawiki_wikis mw ON mw.id = mps.wiki_id
    JOIN entity_registry er ON er.fuseki_uri = mps.entity_uri
    WHERE mps.entity_uri IS NOT NULL
    ORDER BY er.entity_type, er.entity_text;
  " > "$CSV"

  echo "[$(ts)] CSV rows: $(wc -l < "$CSV")"

  "$KOI_DIR/venv/bin/python3" "$KOI_DIR/scripts/backfill_wiki_attribution.py" --csv "$CSV"

  echo "[$(ts)] === done ==="
} >> "$LOG" 2>&1
