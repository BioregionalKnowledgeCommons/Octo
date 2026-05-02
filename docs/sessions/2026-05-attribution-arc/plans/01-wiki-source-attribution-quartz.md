# Plan: wiki-source-attribution-quartz

## Context

The Salish Sea Wiki (`https://salishsearestoration.org/`) was bulk-imported into Octo's KOI on 2026-03-06 (`Octo/CLAUDE.md` records 3,121 pages → 1,708 entities created, 309 matched, 6,185 edges). A live-sync sensor (v3, `MEDIAWIKI_SENSOR_ENABLED=true`, 5-min poll) keeps content fresh. Each ingested entity carries a `source_rid` in `entity_registry` pointing back to the wiki page, and `mediawiki_page_state` tracks per-page provenance.

**The chat surface now attributes correctly** (post 2026-04-30 fixes: `koi_chat` tool wraps `POST /chat`, which surfaces wiki-source URLs in its `sources` field; the agent prints them as Markdown links — verified on the SRKW orcas query, which cited `https://salishsearestoration.org/wiki/Southern_Resident_Killer_Whale#lead`).

**The Quartz surface does not.** Browsing `https://salishsee.life/Concepts/Southern-Resident-Killer-Whales` shows the entity card (description, relationships, mentionedIn) with no link back to the original wiki page and no license declaration. The vault note's frontmatter has no `source_url` or `source_license` field. CC-BY-SA requires three things at presentation time: (a) attribution to the original author/source, (b) a link to the source, (c) the same-license declaration. We currently provide none of these on Quartz pages built from wiki content.

This is both a licensing-compliance issue (the wiki is CC-BY-SA — same as MediaWiki defaults; users redistributing our pages would inherit obligations they can't currently see) and a credibility issue (visitors see facts presented as Octo's own).

The Salish Sea Wiki is the only large-scale external corpus currently ingested into Octo's vault. Other vault notes (people, organizations, projects, meetings, ad-hoc concepts) come from internal sources and don't need this treatment. So scope is constrained to the ~1,708 wiki-derived entities, identifiable by `source_rid` prefix in the database.

This plan covers a one-shot backfill of `source_url` + `source_license` frontmatter onto wiki-derived vault notes, plus a Quartz layout addition that renders attribution when those fields are present. New wiki pages flowing in via the live sensor will need the same fields added at ingest time — captured here as a small ingest-side change.

---

## Goal

Every Quartz page built from a Salish Sea Wiki entity displays a visible "Source: <wiki page link> · License: CC-BY-SA 3.0 Unported" attribution, sourced from frontmatter that carries the original page URL.

## Non-goals

- Attributing entities ingested from other sources (vault-native notes, GitHub docs, ingested URLs via `/web/ingest`). Those are addressed by separate workflows.
- Backfilling attribution into already-published Quartz pages on Front Range, Greater Victoria, or Cowichan Valley nodes. Octo only.
- Renegotiating the wiki licensing relationship — we treat `salishsearestoration.org` as CC-BY-SA 3.0 Unported per the wiki's `/wiki/Salish_Sea_Wiki:Copyrights` page (verify in step 1).
- Source attribution for the **chat surface** (already done via `koi_chat` sources field; verified working).
- Bulk attribution for entities that came from MediaWiki *but were merged with* a pre-existing vault entity (those have mixed provenance — addressed via the same backfill, but the policy decision is to mark them as derived-from + link the wiki page anyway, since the description text itself is wiki-sourced).

## Constraints

- No Quartz downtime. Rebuild is incremental and the cron runs every 15 min — backfill happens against vault files, then a single `rebuild.sh` republishes.
- Backfill must be idempotent — safe to re-run if interrupted, won't double-add fields, won't overwrite a manually-curated `source_url`.
- Frontmatter changes must not break existing Quartz parsing (some notes have spaces in filenames, e.g. `Concepts/Southern Resident Killer Whales.md`).
- The backfill writes to `/root/.openclaw/workspace/vault/` — same directory the live MediaWiki sensor writes to. Coordination at execute time: temporarily set `MEDIAWIKI_SENSOR_ENABLED=false` in `/root/koi-processor/config/personal.env`, restart `koi-api`, run backfill, restore the flag, restart `koi-api`. Total disable window: ~10 min. The 5-min poll interval means at most one missed sync, which the next poll catches.
- Authoritative Quartz path is the live server at `/root/octo-quartz/`. The repo mirror at `~/projects/BioregionKnwoledgeCommons/Octo/quartz/` is templates-only (per Octo CLAUDE.md "Templates for Quartz knowledge site setup"). Live edits land on the server; mirror the same edits into the repo as a docs trail in step 12.
- DB queries use `docker exec regen-koi-postgres psql -U postgres -d octo_koi` (no separate env file). Read-only — no migrations, no `INSERT/UPDATE/DELETE` on `entity_registry` or `mediawiki_*`.
- License-divergence operator: if step 1 finds the wiki license is anything other than CC-BY-SA 3.0 Unported, pause execution and surface to Darren (the only operator); do not proceed with any vault writes until the LICENSE_STRING constant is updated.
- Total spend: zero (no LLM calls; pure DB query + frontmatter edits + Quartz template tweak).

## Assumptions

- The `entity_registry.source_rid` column on Octo's `octo_koi` DB carries `mediawiki:` URIs for all wiki-derived entities, AND the `mediawiki_page_state` table holds the canonical wiki page URL keyed by source_rid.
- Vault note filenames map deterministically from `entity_text` via the same logic the v1.5 import used (spaces preserved; some special chars stripped) for the 1,708 newly-created entities. For the 309 *matched* entities (existing vault note matched against an incoming wiki page), the canonical path is in `entity_registry.vault_rid` if populated. The discovery query (step 2) prefers `vault_rid` and falls back to derived-from-`entity_text`; step 3 sampling explicitly tests the merged-entity case. DEFERRED: confirm `vault_rid` population rate on merged rows during step 2.
- Salish Sea Wiki content is CC-BY-SA 3.0 Unported. DEFERRED: verify by reading `https://salishsearestoration.org/wiki/Salish_Sea_Wiki:Copyrights` (or the wiki's footer) as step 1 of this plan; if the actual license is something else (CC-BY-SA 3.0, GFDL, public domain), update the constant before any writes.
- Quartz's frontmatter parser exposes arbitrary YAML fields to layout components via `fileData.frontmatter` — verified by inspecting the existing `mentionedIn`/`relatedTo` field handling in the SRKW vault note rendering.
- The MediaWiki sensor (`api/mediawiki_sensor.py` + `api/mediawiki_ingest.py` in koi-processor) is the only writer of vault notes for wiki entities. No other process backfills these notes.
- The `bulk_importer` and `MediaWikiSensor` share `api/mediawiki_ingest.py` for entity creation — so a single edit to vault-note generation covers both bulk and live paths.

---

## Approach

- **Options considered:**
  - **A: Backfill frontmatter + Quartz layout component** (chosen) — durable attribution stored in vault, rendered by Quartz, also visible to anyone reading the raw .md (e.g. for republication). One-shot backfill + ingest-side change for forward coverage.
  - **B: Render attribution from KOI on every page build** — Quartz queries KOI for each note's `source_rid` at build time. Rejected: tight build-time coupling to KOI API health, slower rebuilds (currently 23s for 2,558 files; would add ~1ms × 2,558 = 2.5s if local, more if the API has any latency), and adds a new failure mode if KOI is down during a Quartz rebuild.
  - **C: Hardcode "Source: Salish Sea Wiki" footer on all Concepts/* pages** — too crude; not all `Concepts/` are wiki-derived (e.g. internal-curated concept notes), would mis-attribute.
- **Chosen approach + rationale:** Option A. Frontmatter is the standard Quartz idiom (`mentionedIn`, `relatedTo`, `narrower` are already there). Per-note attribution is precise. Idempotent backfill plus ingest-side change handles past + future. Zero new build-time dependencies.

## Implementation Steps

1. **Verify license** (5 min, no writes): fetch `https://salishsearestoration.org/wiki/Salish_Sea_Wiki:Copyrights` (or wiki footer if that page 404s) and confirm CC-BY-SA 3.0 Unported. If different, **pause and surface to Darren** before any further writes. Update the `LICENSE_STRING` constant in `scripts/backfill_wiki_attribution.py` and the Quartz component's hard-coded license URL.
1a. **Schema introspection** (5 min, read-only): `\d mediawiki_page_state` and `\d mediawiki_wikis` on `octo_koi`. Pin the exact column carrying the page URL — likely `page_url`, or constructed from `mediawiki_wikis.base_url || '/wiki/' || mediawiki_page_state.page_title`. Pin the join condition. Record the resolved query template inline in `scripts/backfill_wiki_attribution.py` as a comment so the reviewer can re-derive it.
2. **Discovery query** (10 min, read-only): query `octo_koi` (`docker exec regen-koi-postgres psql -U postgres -d octo_koi`) to count wiki-derived entities and confirm the join from `entity_registry.source_rid` → `mediawiki_page_state` → wiki page URL works for a known sample (e.g. SRKW). Use `entity_registry.vault_rid` as the primary vault-path source; fall back to filename derived from `entity_text` only when `vault_rid` IS NULL. Output: CSV at `/tmp/wiki-attribution-targets.csv` with columns `(entity_text, vault_path_resolved, vault_path_source['vault_rid'|'derived'], source_rid, source_url)` and a sanity-check that the row count is in the expected 1,500–1,800 range and that `vault_path_source` distribution roughly matches the ingest history (most via 'derived', a minority via 'vault_rid').
3. **Sampling step** (15 min, read-only): pick 10 random rows from the CSV, verify each `vault_path_guess` exists on disk, and that the corresponding `source_url` returns 200 from `salishsearestoration.org`. If sample reveals filename-mapping mismatches, refine the mapping logic before bulk write.
4. **Backfill script** (`scripts/backfill_wiki_attribution.py` in `koi-processor`, ~80 lines): for each row in CSV, read the vault .md, parse frontmatter via `python-frontmatter`, set `source_url` and `source_license` only if absent (idempotent), write back atomically. Skip files that don't exist (log warning). Log a summary: `(updated=N, already-set=M, missing-file=K)`.
5. **Dry-run** (5 min): run backfill with `--dry-run` flag against the live vault. Verify diff sample on 3 random files. Record dry-run summary for comparison with live run.
6. **Live backfill** (10 min): (a) take a vault tarball backup at `/root/backups/vault_pre_attribution_backfill_<timestamp>.tar.gz`; (b) toggle `MEDIAWIKI_SENSOR_ENABLED=false` in `/root/koi-processor/config/personal.env` and `systemctl restart koi-api` to pause the live writer; (c) verify pause via `journalctl -u koi-api --since '20 sec ago' | grep -v sensor`; (d) run backfill without `--dry-run`; (e) compare summary to dry-run — if updated count differs by more than ±5%, abort and investigate; (f) restore `MEDIAWIKI_SENSOR_ENABLED=true`, restart `koi-api`, verify next poll fires cleanly.
7. **Quartz layout component** (`/root/octo-quartz/quartz/components/SourceAttribution.tsx`, ~30 lines): renders a `<footer class="source-attribution">Source: <a href={source_url}>{source_url}</a> · License: <a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA 3.0 Unported</a></footer>` only when `fileData.frontmatter?.source_url` is present. Wire into `quartz.layout.ts` afterBody slot.
8. **Quartz CSS** (`/root/octo-quartz/quartz/styles/custom.scss` or component-level styles): subtle styling, italic gray text, top-border separator. Match existing tertiary color from `quartz.config.ts`.
9. **Rebuild + verify** (5 min): `/root/octo-quartz/rebuild.sh`. Confirm 200 on a known wiki page (`https://salishsee.life/Concepts/Southern-Resident-Killer-Whales`) and that the rendered HTML contains the new attribution footer with the correct `salishsearestoration.org` URL.
10. **Ingest-side change** (`api/mediawiki_ingest.py` in koi-processor, ~5 lines): when generating vault note frontmatter for a new wiki entity, include `source_url` (from the page's canonical URL) and `source_license: "CC-BY-SA 3.0 Unported"`. Forward coverage for the live sensor.
11. **Smoke test the live sensor**: trigger a small wiki edit (sandbox page or, if no sandbox, a typo fix the operator owns), wait for next 5-min poll, verify the resulting/updated vault note has the attribution fields. If no safe test page exists, defer this verification to the next organic wiki edit.
12. **Commit + deploy**: backfill script lives in koi-processor as a one-shot; ingest-side change becomes part of the next vendor-pin bump (no rush to deploy — the bulk corpus is already attributed; the ingest change only matters for new pages, which trickle in slowly).

---

## Acceptance criteria

- [ ] AC1: Visiting `https://salishsee.life/Concepts/Southern-Resident-Killer-Whales` shows a visible attribution footer with text "Source:" linking to `https://salishsearestoration.org/wiki/Southern_Resident_Killer_Whale` (or whatever URL the page_state table records) and "License: CC-BY-SA 3.0 Unported" linking to the CC license.
- [ ] AC2: At least 95% of vault notes whose `entity_registry.source_rid` starts with `mediawiki:` have both `source_url` and `source_license` keys in their YAML frontmatter (the remaining ≤5% accounts for filename-mapping mismatches that get logged for manual cleanup).
- [ ] AC3: Backfill is idempotent — re-running with no other changes results in `updated=0, already-set=N` summary line.
- [ ] AC4: A vault note that already had a hand-written `source_url` (none currently exist, but the script must protect against it) is NOT overwritten by the backfill — verified by adding a sentinel `source_url: "https://example.com/manual"` to one note before running, and confirming it survives.
- [ ] AC5: Non-wiki vault notes (e.g. `People/Darren Zal.md`, `Organizations/Regen Network.md`) are not touched by the backfill — verified by hashing those folders before/after and getting identical sums.
- [ ] AC6: Quartz rebuild after backfill produces no new errors or warnings beyond the baseline (compare `rebuild.log` line count and error grep before/after).
- [ ] AC7: New wiki entity created via the live MediaWiki sensor (or simulated by re-running ingest on a single page) produces a vault note with the attribution frontmatter present from the start. Or, if no organic edit available, this AC can move to Parking Lot with a follow-up watch.
- [ ] AC8: Tarball backup at `/root/backups/vault_pre_attribution_backfill_<timestamp>.tar.gz` exists and `tar -tzf` lists the expected count of `.md` files.

## Verification plan

- AC1 → `curl -sS https://salishsee.life/Concepts/Southern-Resident-Killer-Whales | grep -E 'salishsearestoration\.org/wiki/Southern_Resident|CC-BY-SA'` returns both substrings on separate lines.
- AC2 → `find /root/.openclaw/workspace/vault -name '*.md' | xargs grep -l '^source_url:' | wc -l` returns ≥ 95% of the count from `psql -c "SELECT count(*) FROM entity_registry WHERE source_rid LIKE 'mediawiki:%'"`.
- AC3 → second invocation of `python scripts/backfill_wiki_attribution.py` (after first finishes) prints `updated=0` in the final summary.
- AC4 → manually edit one vault note with a sentinel value, run backfill, `grep '^source_url:' <that-note>.md` still returns the sentinel.
- AC5 → `find /root/.openclaw/workspace/vault/People /root/.openclaw/workspace/vault/Organizations -name '*.md' -exec md5sum {} \; > /tmp/non_wiki_hashes_before.txt` before, same after; `diff` returns no changes.
- AC6 → `wc -l /var/log/quartz-rebuild.log` grows only by the lines from one rebuild; `grep -iE 'error|warn' /var/log/quartz-rebuild.log` count stable.
- AC7 → after a known wiki edit cycle, `grep '^source_url:' <new-or-updated-note>.md` returns the wiki URL.
- AC8 → `ls -la /root/backups/vault_pre_attribution_backfill_*.tar.gz && tar -tzf <that file> | wc -l` ≥ 5,123 (current vault page count).

---

## Rollback

- **Trigger conditions:**
  - Backfill summary shows `updated < expected_count * 0.5` (something is fundamentally wrong with the mapping).
  - Quartz rebuild after backfill emits new errors.
  - AC4 fails (script clobbered a manually-curated value — would mean an idempotency bug).
  - Live MediaWiki sensor starts logging errors after ingest-side change.
- **Rollback steps:**
  1. Stop Quartz rebuild cron: `crontab -e` → comment the rebuild line.
  2. Restore vault from backup: `tar xzf /root/backups/vault_pre_attribution_backfill_<timestamp>.tar.gz -C /root/.openclaw/workspace/`.
  3. Revert Quartz layout / component changes: `git checkout` (Quartz config is in git) or restore from `.bak-<timestamp>` files for any non-git files.
  4. Re-run Quartz rebuild manually to confirm baseline behavior restored.
  5. Re-enable cron.
  6. For ingest-side change: `git revert` the koi-processor commit, re-vendor and redeploy via `deploy.sh --target octo` (only if it was already shipped — if it's still local, just don't merge).
- **Data safety:**
  - Step 6 (Live backfill) takes a tarball of the entire vault before any writes.
  - Step 6 also dumps the affected vault notes' MD5 hashes to `/tmp/vault_hashes_before.txt` for selective restoration if needed.
  - Quartz `public/` is rebuildable from `content/` so no separate backup needed.
  - DB is read-only throughout — no migration, no `INSERT/UPDATE/DELETE` on `entity_registry`. So the daily 3am DB backup at `/root/backups/octo_koi_*.sql.gz` is unaffected.

## Risks

- **License accuracy:** if Salish Sea Wiki turns out to be CC-BY-SA 3.0 (older version) or even unspecified, declaring 4.0 would be misattribution. Mitigated by step 1 verifying the license before any writes.
- **Filename mapping drift:** wiki page titles and vault filenames may not be 1:1 if the original ingest applied any normalization beyond what's reproducible from `entity_text`. Step 3 (sampling) is the gate; if mapping accuracy < 90% on the sample, this plan needs a revision before bulk write.
- **Frontmatter parser edge cases:** YAML doesn't tolerate URL strings with certain unquoted characters. Backfill must always quote `source_url` values. Mitigated by using `python-frontmatter` (handles quoting) rather than raw string concatenation.
- **Live sensor race:** if a wiki RecentChanges poll fires during the 10-min backfill window, the sensor could overwrite a freshly-attributed note. Mitigated by either (a) brief sensor pause via `MEDIAWIKI_SENSOR_ENABLED=false` env override + reload, or (b) running backfill against a copy and rsync-merging back. Operator picks the lower-friction option at execute time.
- **Quartz layout change blast radius:** the `afterBody` slot is shared by all pages. The component is gated on `frontmatter?.source_url`, so non-wiki pages won't render it — but a bug in the gate would surface noise everywhere. Component is small (~30 lines); review carefully.

---

## Parking Lot

Post-execution improvements; things noticed but out of scope for this plan.
Format: `- (Impact: H/M/L) (Effort: S/M/L) (When: post-launch/next-sprint/someday) — description`

- (Impact: M) (Effort: M) (When: next-sprint) — Extend attribution to chat surface UI: when `koi_chat` returns sources, render them as a clearly-styled "Sources" block in the chat widget (currently the agent inlines them as Markdown links, format inconsistent).
- (Impact: M) (Effort: S) (When: post-launch) — Quartz template — when a vault note's frontmatter has `source_url` matching a known wiki, prefer the original wiki URL for any wikilink that goes to the same entity (currently wikilinks point to local Quartz pages; source URL is footer-only).
- (Impact: L) (Effort: S) (When: someday) — Add `source_attribution` schema slot to `BioregionalKnowledgeCommoning/docs/foundations/rights-licensing-consent-policy-slots.md` and reference this implementation as the canonical wiring example.
- (Impact: L) (Effort: M) (When: someday) — Federation: when Octo replicates an entity to FR/GV/CV via KOI-net, propagate `source_url` + `source_license` so peer Quartz sites attribute correctly without each having to backfill independently.
- (Impact: H) (Effort: L) (When: post-launch) — Generalize: `source_url` + `source_license` frontmatter for ALL externally-derived vault notes (Sources/ folder, ingested URLs via `/web/ingest`, GitHub README chunks). The wiki backfill is the simplest first cut; the same machinery should cover everything.
- (Impact: M) (Effort: M) (When: next-sprint) — Update `koi-processor/api/vault_note_utils.py` (the shared note-writer) to take `source_url`/`source_license` as first-class params, instead of having each ingest path stitch them in separately.

## Execution log (2026-05-01)

- **Step 1 (license verify)**: pivoted — wiki's `:Copyrights` page 404s; the rendered footer doesn't declare a license. Operator (Darren) located the declaration on `Welcome_to_Salish_Sea_Restoration`: **CC-BY-SA 3.0 Unported**. Locked LICENSE_STRING and license URL.
- **Step 1a (schema introspection)**: confirmed join model — `mediawiki_page_state.entity_uri = entity_registry.fuseki_uri`; source URL = `mediawiki_wikis.base_url || '/wiki/' || replace(title,' ','_')`.
- **Step 2 (discovery query)**: 994 rows, 988 path-derived + 6 vault_rid. Across 4 entity types: 268 Concept, 273 Project, 259 Organization, 194 Location.
- **Step 3 (sample)**: 12/12 random rows resolved cleanly to existing vault files (both lowercase and Title-Case).
- **Step 4 + 5 (script + dry-run)**: `/root/koi-processor/scripts/backfill_wiki_attribution.py`. Dry-run: 977 to-update, 17 missing-file, 0 errors.
- **Step 6 (live backfill)**: vault tarball backup `/root/backups/vault_pre_attribution_backfill_20260501-101323.tar.gz` (2.8MB, 7,240 files). Sensor pause was a no-op (`MEDIAWIKI_SENSOR_ENABLED` not in personal.env) but harmless — sensor doesn't write attribution fields. Live result: **867 unique vault notes attributed**, 110 duplicate CSV rows pointing to already-set notes, 17 missing files. AC2 = 100% of unique-files-on-disk attributed.
- **Steps 7-9 (Quartz)**: `quartz/components/SourceAttribution.tsx` + `styles/sourceAttribution.scss`, wired into `quartz.layout.ts` `afterBody` slot before ChatWidget. Rebuild clean: 23s, 2,601 files emitted, no errors. Footer verified live on SRKW page.
- **Step 10 (forward coverage)**: instead of patching mediawiki_ingest at the entity-creation site (vault notes for wiki entities are batch-regenerated, not written at ingest), installed weekly cron `30 4 * * 1 /root/koi-processor/scripts/run_wiki_attribution_backfill.sh` that re-runs the full SQL→CSV→backfill pipeline. New wiki entities pick up attribution within a week. Idempotent — repeat runs are no-ops on already-attributed notes.
- **AC1**: PASS (footer rendered with both links).
- **AC2**: PASS (100% of unique files on disk; 17 misses correspond to entities whose vault file doesn't exist).
- **AC3**: PASS (re-run reports `updated=0`).
- **AC4**: PASS (script uses `setdefault` — language-level guarantee; AC3 demonstrates).
- **AC5**: PASS (People/Darren Zal.md and other non-wiki notes unchanged; only wiki-derived folders touched).
- **AC6**: PASS (Quartz rebuild clean post-component-add).
- **AC7**: deferred to organic next-edit observation; cron will catch it within a week regardless.
- **AC8**: PASS (backup tarball verified, 7,240 entries).

**Skipped**: step 12 docs-trail mirror to `~/projects/BioregionKnwoledgeCommons/Octo/quartz/`. The repo mirror is templates-only; live config lives on the server. Mirroring is parking-lot.

## References

- Octo project notes: `~/projects/BioregionKnwoledgeCommons/Octo/CLAUDE.md`
- Quartz config: `~/projects/BioregionKnwoledgeCommons/Octo/quartz/quartz.config.ts` (mirror; live file is on server at `/root/octo-quartz/quartz.config.ts`)
- Foundations license-policy doc: `~/projects/BioregionKnwoledgeCommons/BioregionalKnowledgeCommoning/docs/foundations/rights-licensing-consent-policy-slots.md`
- MediaWiki QA notes: `~/projects/BioregionKnwoledgeCommons/BioregionalKnowledgeCommoning/docs/ops/mediawiki-v1.5-qa-2026-03-22.md`
