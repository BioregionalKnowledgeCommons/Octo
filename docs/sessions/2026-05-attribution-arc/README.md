# 2026-05 Attribution Arc — Docs Trail

Two-day session arc fixing chat citation behavior, adding source attribution to wiki-derived Quartz pages, and unifying retrieval-side `quartz_url` propagation.

## Outcomes

| Surface | Before | After |
|---|---|---|
| Octo chat widget (port 3847) | "Could not parse response" — broken | answers grounded in KOI RAG; canonical `salishsee.life/...` links + deterministic "Related on Octo" block |
| Quartz wiki pages | no attribution; readers couldn't tell content came from Salish Sea Wiki | every wiki-derived page footer reads "Source: Salish Sea Wiki · License: CC-BY-SA 3.0 Unported" linking to original page |
| Quartz Sources/ web pages | no source rendering | footer reads "Source: <domain> · Accessed: <date>" |
| LLM model | dead `nvidia-build/moonshotai/kimi-k2.5` (HTTP 410) | `openai/gpt-4.1-mini` |
| Citation policy | LLM fabricated wiki URLs from chunk text | LLM uses `quartz_url` from sources, falls back to source-name without link when no Quartz page exists |

## Scope of canonical changes

Server-side (live at `/root/koi-processor/` and `/root/octo-quartz/` on Octo):

- `api/personal_ingest_api.py` — citation rules + entity_block format + doc_block url-stripping + server-side "Related on Octo" append
- `api/retrieval_executors.py` — `_lookup_chunk_quartz_urls` helper + `text_search` enrichment + `evidence_bundles_to_legacy_format` LOCAL_DOCUMENT propagation
- `api/plan_executor.py` — `quartz_url_fn` threaded through to `text_search` call
- `config/personal.env` — `QUARTZ_BASE_URL` → `https://salishsee.life`
- `octo-chat/server.js` — JSON parse-tolerance + provider-error fallback + `classifyError` wiring
- `quartz.config.ts` — `baseUrl` → `salishsee.life`
- `quartz/components/SourceAttribution.tsx` (new) + `styles/sourceAttribution.scss` (new)
- `quartz.layout.ts` — wired SourceAttribution into `afterBody` slot
- `.openclaw/workspace/TOOLS.md` — link-preference rule
- `agents.defaults.model.primary` (in openclaw.json) — `openai/gpt-4.1-mini`

Vault-side:

- 875 unique vault notes attributed with `source_url` / `source_name` / `source_license` / `source_license_url` frontmatter (out of 994 wiki-entity rows; 17 missing-file misses correspond to entities whose vault note doesn't exist on disk — captured in 5b parking-lot)
- Weekly cron `30 4 * * 1 /root/koi-processor/scripts/run_wiki_attribution_backfill.sh` for forward coverage

## Files in this docs-trail

- `plans/01-wiki-source-attribution-quartz.md` — full plan + execution log
- `plans/02-text-search-bundle-quartz-url-enrichment.md` — full plan + execution log
- `plans/03-federation-source-attribution-propagation.md` — parked, with explicit un-park triggers
- `../scripts/backfill_wiki_attribution.py` — copied here for visibility (canonical lives at `/root/koi-processor/scripts/`)
- `../scripts/run_wiki_attribution_backfill.sh` — weekly cron wrapper (canonical at `/root/koi-processor/scripts/`)
- `../quartz/components/SourceAttribution.tsx` + `styles/sourceAttribution.scss` — Quartz component (canonical at `/root/octo-quartz/quartz/components/`)

## License declaration source

The Salish Sea Wiki license is **CC-BY-SA 3.0 Unported**, declared on `https://salishsearestoration.org/wiki/Welcome_to_Salish_Sea_Restoration` (NOT the empty `:Copyrights` page which 404s). Site is operated by The Society for Ecological Restoration. Confirmation came from the operator on 2026-05-01.

## Backups

All server-side edits left `*.bak-<timestamp>` files next to each modified file — rollback by `cp` and `systemctl restart koi-api`.
