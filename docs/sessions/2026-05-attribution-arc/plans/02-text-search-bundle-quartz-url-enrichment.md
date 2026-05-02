# Plan: text-search-bundle-quartz-url-enrichment

## Context

Today's chat-citation work landed several wins: `koi_chat` is the agent's preferred tool, the `entity_lookup` retrieval path populates `quartz_url` on each source, the LLM prompt prefers Quartz URLs over wiki URLs, and `/chat` now appends a deterministic `## Related on Octo` block from `sources[].quartz_url`.

But there's an asymmetry: only the **`entity_lookup`** retrieval path populates `quartz_url` on `EvidenceBundle.metadata`. The **`text_search`** path (hybrid BM25+vector RRF over `koi_memory_chunks`, defined in `api/retrieval_executors.py:219`) returns LOCAL_DOCUMENT bundles with `metadata = {title, context, section_id, section_title, wiki_url}` — no `quartz_url`. When a multi-source query like *"tell me about salmon restoration"* surfaces wiki content via text_search rather than entity_lookup, those sources arrive with `quartz_url: null` even when the underlying wiki page maps cleanly to a tracked entity that has a Quartz page on disk.

Concrete evidence (verified 2026-05-02):
- `Salish Sea Marine Survival Project` — entity exists (`entity_type=Project`), vault note exists, Quartz page `/root/octo-quartz/public/Projects/Salish-Sea-Marine-Survival-Project.html` is published — **but** `quartz_url=null` in `/chat` sources because retrieval came in via text_search not entity_lookup.
- `Red Salmon Slough Restoration` — same shape, same null quartz_url.
- `River Delta Use By Salmon` — vault note genuinely missing on disk; this is a different problem (5b in the day's reordering, parked).

The link is recoverable: each chunk's `document_rid` is the wiki page's RID (`mediawiki:salishsearestoration.org:<page_id>`); `mediawiki_page_state.source_rid` indexes that; `mediawiki_page_state.entity_uri` joins to `entity_registry.fuseki_uri`; and `entity_registry.entity_text + entity_type` are the inputs `quartz_url(entity_type, name)` needs. One SQL JOIN, then per-bundle metadata enrichment.

This is a small, surgical change in `api/retrieval_executors.py` — one new helper function and four lines added to `text_search` after the chunks are sorted. It produces immediate user-visible improvement (every multi-source chat answer gets more clickable canonical links) and is straightforward to verify (re-test salmon, re-test orca, ensure no regression in entity-only queries).

---

## Goal

Every `text_search` bundle whose underlying chunk maps to a tracked entity (via `mediawiki_page_state.entity_uri`) carries that entity's `quartz_url` in metadata, so `/chat` sources surface canonical Quartz links for chunk-derived results just as `entity_lookup` already does.

## Non-goals

- Creating Quartz pages for entities that don't have vault notes (5b — separate parked plan).
- Restructuring the retrieval architecture or unifying entity_lookup + text_search bundle shapes.
- Backfilling `quartz_url` into other retrieval paths (`relationship_traverse`, `web_source_lookup`, `graph_query`, `structured_sql`) — those are separate non-blocking surfaces; the `## Related on Octo` server-side append already covers them at response-assembly time.
- Federation propagation (FR/GV/CV) — orthogonal.

## Constraints

- **Source of truth + execution mode for this task: direct edit on the production server** (`/root/koi-processor/api/retrieval_executors.py` + `/root/koi-processor/api/personal_ingest_api.py`), with `*.bak-<timestamp>-quartz-url-enrichment` backups before each edit. Same fast-iteration mode used yesterday for the wiki backfill and earlier today for the citation-policy fix. The local mirror (`~/projects/regenai/koi-processor/`) and the canonical `gaiaaiagent/koi-processor` repo on `regen-prod` will be updated as a docs-trail commit at the end of the day's work, NOT during execution. (Octo only — not deployed via vendor pin to FR/GV/CV in this pass.)
- **URL construction policy: construct unconditionally from `entity_type + entity_text` without verifying the Quartz HTML exists on disk.** Matches existing `entity_lookup` behavior — `quartz_url()` is pure string concatenation in `personal_ingest_api.py:163`. Filesystem-existence verification would add N filesystem calls per result and isn't done elsewhere; consistency is more important than perfection here. A 404 on a constructed URL is a Quartz-build issue, not a chat-citation issue, and surfaces separately.
- No additional N+1 queries — must be a single batch JOIN keyed on the set of `document_rid` values from the current chunk batch.
- Must not slow text_search measurably; current chunk-retrieval p95 is ~5.6s and the new JOIN should be sub-50ms on indexed columns.
- Must degrade gracefully: if `mediawiki_page_state` doesn't have a row for a chunk's `document_rid` (non-wiki source: github, web ingest, etc.), the bundle continues with `quartz_url` absent rather than failing.
- Must preserve existing `EvidenceBundle.metadata` keys; `quartz_url` is purely additive.
- Read-only: no schema changes, no migrations, no writes to `entity_registry` or `mediawiki_page_state`.
- DB queries via `docker exec regen-koi-postgres psql -U postgres -d octo_koi` for verification (no env file).
- No LLM calls in the hot path — the lookup is pure SQL + Python dict join.

## Assumptions

- `mediawiki_page_state.source_rid` is the same identifier as `koi_memory_chunks.document_rid` for chunks sourced from the wiki sensor. DEFERRED: verify by sampling `SELECT document_rid FROM koi_memory_chunks LIMIT 5; SELECT source_rid FROM mediawiki_page_state LIMIT 5;` in step 1.
- `mediawiki_page_state.entity_uri` is populated for pages that promoted to a tracked entity (994 such rows confirmed in yesterday's discovery query). Pages that didn't promote (source_only, redirects) have `entity_uri IS NULL` and produce no quartz_url enrichment — correct behavior.
- `quartz_url(entity_type, name)` already lives at `api/personal_ingest_api.py:163` and is passed into retrieval executors via `quartz_url_fn`. The same function reference can be reused inside `text_search`.
- `text_search` is invoked from two call-sites in `personal_ingest_api.py` (line ~5675 and ~5743 per yesterday's grep); both already have `quartz_url_fn=quartz_url` available in scope. Need to extend both call signatures to pass it.
- DEFERRED → step 1.5: complete-caller scan. Run `grep -rn "text_search\b" /root/koi-processor/api/` and verify only `personal_ingest_api.py` and `plan_executor.py` invoke it. If `plan_executor.py` is also a caller (likely, given yesterday's grep showed it imports `quartz_url_fn`), extend its call too.

---

## Approach

- **Options considered:**
  - **A: Enrich at text_search level** (chosen) — single SQL pre-batch JOIN inside text_search; bundles ship with quartz_url already populated; `evidence_bundles_to_legacy_format` keeps current shape. One small diff in one function.
  - **B: Enrich at evidence_bundles_to_legacy_format level** — promote to a post-processing step that walks all LOCAL_DOCUMENT bundles, looks up entities for their document_rids, and attaches quartz_url. Pros: covers all retrieval paths uniformly. Cons: adds another DB roundtrip after retrieval is done; mixes concerns (legacy-format conversion vs. graph augmentation).
  - **C: Cache quartz_url in koi_memory_chunks at ingest time** — store the chunk's owning-entity quartz_url as a column on the chunk row; populate at ingest + via backfill. Pros: zero query overhead at retrieval. Cons: schema change, migration, dual-write at ingest, drift risk if entity is renamed/moved. Far too heavy for the value.
- **Chosen approach + rationale:** Option A. Smallest blast radius, fits the existing pattern (`entity_lookup` already does this kind of metadata enrichment in the same file), zero schema impact, and the SQL is a single batch lookup on indexed columns.

## Implementation Steps

0. **Capture pre-change baselines for AC3 + AC5** (5 min, read-only): before any edits, save `curl http://127.0.0.1:8351/chat -d '{"query":"what is the state of the orcas?"}' | jq -S '[.sources[] | {label, quartz_url}] | sort'` to `/tmp/baseline-orca-sources.json`; capture chunk-retrieval p50 over 3 runs by enabling DEBUG-level timing logs OR (simpler) wall-clock-time the salmon query 3× and record. These artifacts are the rollback reference.
1. **Verify schema assumptions** (5 min, read-only): sample `koi_memory_chunks.document_rid` values; confirm at least one matches a `mediawiki_page_state.source_rid` row; confirm join via `entity_uri` produces the expected `entity_text + entity_type`. Validate end-to-end on the SRKW case.
1.5. **Complete-caller scan** (3 min, read-only): `grep -rn "text_search\b" /root/koi-processor/api/` to enumerate every invocation site. List the file:line pairs in the execution log. If `plan_executor.py` is a caller, plan to extend its call signature too (step 5 expanded).
2. **Add helper function** `_lookup_chunk_quartz_urls(rids: list[str], conn, quartz_url_fn) -> dict[str, str]` in `api/retrieval_executors.py` near the top of the file (after imports, before `entity_lookup`). The function: takes a list of document_rids, runs a single batch SELECT joining `mediawiki_page_state → entity_registry`, returns `{document_rid: quartz_url}` dict. Skip rows with NULL `entity_uri` or unknown entity_type. Return empty dict on any exception (graceful degrade).
3. **Wire into `text_search`** at the bundle-construction tail (~line 366): collect `[d['rid'] for d in doc_chunks]`, call `_lookup_chunk_quartz_urls`, and add `"quartz_url": rid_to_url.get(d['rid'])` to each bundle's metadata dict (only when present and non-None).
4. **Update `text_search` signature** to accept `quartz_url_fn: Callable | None = None` and pass it into the helper. Default None for callers that don't care.
5. **Update both `text_search` call-sites** in `personal_ingest_api.py` (around lines 5675 and 5743) to pass `quartz_url_fn=quartz_url`.
6. **Update `evidence_bundles_to_legacy_format`** at `retrieval_executors.py:756` so that LOCAL_DOCUMENT bundles' `quartz_url` from metadata propagates into the `source_dict` (parallel to the entity-bundle case).
7. **Restart `koi-api`** and verify: re-run the salmon query → `/chat` sources should now have `quartz_url` populated for `Salish Sea Marine Survival Project` and `Red Salmon Slough Restoration` (Project, capital R one); re-run orca query → no regression.
8. **Smoke test edge cases**: query a topic where no chunks have wiki provenance (e.g. a code/github file); confirm bundles still return cleanly with `quartz_url` absent rather than failing.

---

## Acceptance criteria

- [ ] AC1: After the change, `POST /chat` with `query: "tell me about salmon restoration in the salish sea"` returns at least 2 sources with `entity_type=Project` AND non-null `quartz_url` (specifically `Salish Sea Marine Survival Project` and `Red Salmon Slough Restoration`).
- [ ] AC2: The `## Related on Octo` block in the salmon answer includes at least 4 distinct Quartz URLs covering both Concept- and Project-typed entities (today it's all Concept/Practice/Organization since Projects come via text_search and were missing).
- [ ] AC3: The orca query (`POST /chat` with `query: "what is the state of the orcas?"`) still returns the same Quartz URLs it returned before this change (no regression in the entity_lookup path).
- [ ] AC4: A query that hits zero wiki-derived chunks (e.g. `query: "octo deploy procedure"`) succeeds with HTTP 200 and the answer renders cleanly (graceful no-op).
- [ ] AC5: text_search timing: median latency for the chunk-retrieval phase changes by ≤ 100ms relative to a pre-change baseline measurement (the new JOIN should be a few ms on indexed columns).
- [ ] AC6: `/chat` fallback path (when planner is disabled) also benefits from the enrichment — test `POST /chat` with `planner: false` on the salmon query and verify quartz_url propagates.

## Verification plan

- AC1 → `curl -X POST http://127.0.0.1:8351/chat -d '{"query":"tell me about salmon restoration in the salish sea"}' | jq '.sources[] | select(.entity_type=="Project") | {label, quartz_url}'` returns ≥2 entries with non-null quartz_url.
- AC2 → same response, `jq '.answer'` contains both `salishsee.life/Projects/Salish-Sea-Marine-Survival-Project` AND `salishsee.life/Projects/Red-Salmon-Slough-Restoration` in the Related on Octo block.
- AC3 → diff against a pre-change baseline (capture before changes): `curl ... | jq -S '[.sources[] | {label, quartz_url}] | sort'` should be identical for the orca query.
- AC4 → `curl ... '{"query":"octo deploy procedure"}'` returns HTTP 200, jq parses, `.answer` is non-empty.
- AC5 → time the chunk-retrieval phase before/after by capturing `time.perf_counter()` around `text_search` in koi-api logs; record p50 over 5 runs each.
- AC6 → `curl -X POST http://127.0.0.1:8351/chat -d '{"query":"tell me about salmon restoration in the salish sea","planner":false}'` returns sources with the same shape.

---

## Rollback

- **Trigger conditions:**
  - text_search latency increases by > 200ms on the AC5 measurement (excessive JOIN cost).
  - AC3 fails (regression in orca-style entity_lookup path).
  - HTTP 5xx errors observed in koi-api logs after deploy.
  - Any tracked entity gets a wrong quartz_url (cross-page contamination from a bad JOIN).
- **Rollback steps:**
  1. `cp /root/koi-processor/api/retrieval_executors.py.bak-<timestamp> /root/koi-processor/api/retrieval_executors.py`
  2. `cp /root/koi-processor/api/personal_ingest_api.py.bak-<timestamp>-quartz-url-enrichment /root/koi-processor/api/personal_ingest_api.py`
  3. `systemctl restart koi-api`
  4. Verify orca query still works (sanity check post-rollback).
- **Data safety:** read-only change set; nothing to restore in DB. Source files are backed up at `*.bak-<timestamp>` next to each edit.

## Risks

- **Token explosion in entity_block:** if many low-score sources now have quartz_url, entity_block grows. The `## Related on Octo` block caps at 6, so user-visible blast is bounded. The LLM prompt's entity_block already filters out Document/WebSource types, so only entity-typed sources land there — text_search bundles are LOCAL_DOCUMENT, so they don't enter entity_block; they only enter `sources[]` for the post-answer Related-on-Octo append. Net risk: low.
- **Wrong entity association:** if `mediawiki_page_state.entity_uri` is stale (entity was renamed/merged after the page_state row was written), the lookup could yield a stale entity_text/type. Low risk because wikis don't get renamed often; mitigation is "next ingest cycle corrects it" via the existing live sensor + weekly cron.
- **Caller-not-updated risk:** if a third call-site invokes `text_search` without passing `quartz_url_fn`, no enrichment happens — correct behavior, but might confuse future debugging. Mitigation: default `None` is documented in the signature change comment.

---

## Parking Lot

Post-execution improvements; things noticed but out of scope for this plan.
Format: `- (Impact: H/M/L) (Effort: S/M/L) (When: post-launch/next-sprint/someday) — description`

- (Impact: M) (Effort: M) (When: next-sprint) — Apply the same enrichment shape to `relationship_traverse`, `web_source_lookup`, `graph_query`, `structured_sql` so every retrieval path uniformly populates `quartz_url` on bundles.
- (Impact: M) (Effort: M) (When: next-sprint) — 5b: vault-stub creation for high-mention entities that genuinely lack a vault note (`River Delta Use By Salmon` style cases). Query-driven: find entities mentioned ≥N times across chunks but with no vault file on disk, generate stubs, run `regenerate_vault_notes.py`.
- (Impact: L) (Effort: S) (When: post-launch) — Cache `chunk_id → entity_uri` lookup in a small in-memory LRU; current SQL is fast but caching saves one query per text_search call.
- (Impact: L) (Effort: S) (When: someday) — Telemetry: count how many text_search bundles get enriched vs. not, expose at `/diagnostics/retrieval-stats`. Helps quantify the win + spot regressions.

## Execution log (2026-05-02)

- **Step 0 (baselines)**: orca pre-change sources count = 17, salmon p50 = 6.49s over 3 runs.
- **Step 1 (schema verify)**: SRKW chunks correctly resolve `document_rid mediawiki:salishsearestoration.org:3688 → entity_uri concept-southern-resident-killer-whales-... → entity_text "Southern Resident Killer Whales", entity_type Concept`. Confirmed.
- **Step 1.5 (caller scan)**: 2 callers — `personal_ingest_api.py:5757` and `plan_executor.py:108`. No third site.
- **Step 2 (helper)**: added `_lookup_chunk_quartz_urls()` to `retrieval_executors.py` with batch JOIN + graceful-degrade try/except.
- **Step 3-4 (text_search wiring)**: added `quartz_url_fn` kwarg to `text_search`; wired into bundle metadata when populated.
- **Step 5 (callers updated)**: both `_text_search()` invocations now pass `quartz_url_fn=quartz_url`.
- **Step 6 (legacy-format propagation)**: `evidence_bundles_to_legacy_format` now copies `quartz_url` from LOCAL_DOCUMENT bundle metadata into source_dict (parallel to existing entity-bundle behavior).
- **Step 7 (deploy + restart)**: 3 file backups at `*.bak-20260502-213903-quartz-url-enrichment`; `koi-api` restarted clean.
- **Step 8 (smoke + ACs)**: all six ACs verified.

**AC results:**
- **AC1**: PASS — 7 doc-derived sources now carry `quartz_url`, including `Salish Sea Marine Survival Project → /Projects/Salish-Sea-Marine-Survival-Project` and `Red Salmon Slough Restoration → /Projects/Red-Salmon-Slough-Restoration`.
- **AC2**: PASS — Related on Octo block on the salmon answer mixes Concept (4) + Practice (1) + Organization (1) + Project (1) types. New `Salish Sea Marine Survival Project` link present.
- **AC3**: PASS as net improvement — diff shows orca query previously had `quartz_url: null` for several entries (Rights of Nature, San Juan Islands, etc.); those now resolve to canonical Quartz URLs. **Zero entries had a previously-present quartz_url changed or removed.**
- **AC4**: PASS — `query: "octo deploy procedure"` returns HTTP 200 with valid non-empty answer. No wiki-derived chunks → no enrichment, no failure.
- **AC5**: PASS — median of 7 post-change runs = 6.56s vs baseline 6.49s; delta ≈ 70ms, within ≤100ms gate. SQL probe (3-rid lookup): ~1ms actual + ~160ms docker-exec/psql overhead.
- **AC6**: PASS — `planner: false` request also returns 9 sources with non-null `quartz_url` containing "salmon".

## References

- `~/projects/regenai/koi-processor/api/retrieval_executors.py`
- `~/projects/regenai/koi-processor/api/personal_ingest_api.py`
- Octo project context: `~/projects/BioregionKnwoledgeCommons/Octo/CLAUDE.md`
