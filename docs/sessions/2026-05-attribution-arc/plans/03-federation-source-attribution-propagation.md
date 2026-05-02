# Plan: federation-source-attribution-propagation

> **Status: PARKED 2026-05-02.** Written for future activation when one or
> more peer nodes (Front Range, Greater Victoria, Cowichan Valley) start
> serving their own Quartz site. Today, only Octo serves Quartz at
> `salishsee.life`. Until at least one peer publishes its own knowledge-garden
> surface, propagating attribution to peers has no consumer.

## Context

Octo's wiki-source-attribution work (2026-05-01) added per-entity `source_url` / `source_name` / `source_license` / `source_license_url` frontmatter to ~875 vault notes derived from the Salish Sea Wiki, plus a `SourceAttribution` Quartz component that renders that frontmatter as a footer ("Source: Salish Sea Wiki · License: CC-BY-SA 3.0 Unported"). Forward coverage runs as a weekly cron `30 4 * * 1 /root/koi-processor/scripts/run_wiki_attribution_backfill.sh`.

This is all **local to Octo**. The KOI-net federation protocol replicates entities to peers via signed envelopes (`koi_net_events` + `koi_net_edges`), and each node has its own vault on its own filesystem. When Octo replicates a wiki-derived entity to FR/GV/CV today, the peer receives the entity payload but **does not** receive the `source_url`/`source_license` frontmatter the local vault note carries. The peer would have to compute it independently — or, more likely, just not have it.

This plan covers extending federation replication to carry attribution-bearing frontmatter, and updating each peer's vault-write path to honor those fields.

## Why parked
1. **No consumer.** FR (`127.0.0.1:8355` on Octo host) has 4 entities, no Quartz serving setup. GV (`37.27.48.12`) has 5 entities, no Quartz site. CV (`202.61.242.194`) similar. None of these peers serves a knowledge-garden surface today, so attributing entities they receive doesn't show up anywhere user-visible.
2. **Higher-leverage local work first.** 5b (vault-stub creation for high-mention-count missing entities) directly improves Octo's chat answers; federation propagation only helps if/when peers publish their own surface.
3. **Federation evolves.** When a peer node decides to serve Quartz, that's the right moment to design propagation — by then the peer will have made decisions about attribution policy that this plan can't pre-specify (e.g. CC-BY-SA-only acceptance, attribution-required gates, license-aware federation membrane).

## Trigger condition for un-parking

Any of:
- A peer node (FR, GV, CV, or new) configures a public Quartz site and requests Octo replicate wiki-derived content with attribution intact.
- Octo's source corpus expands to include new external sources with different license terms (e.g. CC-BY-NC, GFDL, public domain) and federation needs license-aware edge gating.
- BKC ontology adds a `Source` or `Provenance` first-class entity type that participates in federation (not just frontmatter).

---

## Goal

When Octo replicates a wiki-derived entity to a peer node, the peer's local vault note for that entity carries the same `source_url` / `source_name` / `source_license` / `source_license_url` frontmatter Octo wrote, so the peer's Quartz site (if any) renders identical attribution.

## Non-goals

- Renegotiating federation protocol shapes, signed-envelope schemas, or `koi_net_events` payload structure.
- License-aware federation edge gating (e.g. "this peer only accepts CC-BY-SA content"). That's a separate governance plan.
- Backfilling already-replicated entities on peers — assume peers can run the same `backfill_wiki_attribution.py` tool against their own DB once it's part of the canonical `koi-processor` codebase.
- Octo's Quartz component is shared via the canonical `koi-processor` repo at vendor-pin time — not in scope here.

## Constraints

- KOI-net protocol envelopes are versioned. Adding fields to event payloads is forward-compatible but downstream parsers must handle missing fields.
- Vault note write paths on peers (`api/vault_note_utils.py`, `api/web_router.write_vault_note`, `api/mediawiki_ingest.py`) must continue to handle entities WITHOUT attribution fields gracefully (e.g. internal entities, web-ingested non-wiki).
- Migration story for existing peer DBs: we don't touch them; they pick up new fields on next entity replication.

## Assumptions

- The `koi_net_events` event payload for entity replication includes a `metadata` blob that survives signed-envelope wrapping and is forwarded verbatim to peer event handlers. DEFERRED: verify by reading `api/koi_protocol.py` and `api/koi_net_router.py` before execution.
- Peer nodes share the same `koi-processor` codebase via vendor-pin. So a coordinated change across all nodes is one canonical commit + a coordinated vendor-pin bump.
- Wiki entities at peers will originate as REPLICATED, not as locally-ingested. The local mediawiki sensor only runs at Octo (the only node that polls salishsearestoration.org). DEFERRED: verify by checking peer `personal.env` files for `MEDIAWIKI_SENSOR_ENABLED`.

---

## Approach (sketch)

- **Option A: Carry attribution in entity-event metadata.** Wrap the four fields into the entity replication event payload at Octo's emit-side; peer handlers extract them and write to vault frontmatter on entity creation/update. Pros: piggybacks on existing protocol, no new event types. Cons: vault frontmatter and DB columns drift if not kept in sync at both nodes.
- **Option B: Persist attribution in a peer-replicated DB column (`entity_registry.source_metadata`).** Add `source_url` etc. to the `entity_registry` JSONB column at write time; replicate via existing entity-event flow; peer's vault generator reads from DB, not just envelope. Pros: durable, queryable. Cons: schema migration on all nodes.
- **Option C: Per-entity provenance event** (new event type carrying just attribution metadata, sent alongside entity events). Pros: clean separation. Cons: protocol expansion, additional ack/retry surface, ordering concerns.

Recommended for actual execution: **Option A** for short-term + **Option B** for long-term durability (`entity_registry.source_metadata` jsonb already exists per the live schema we read). Detailed design at activation time.

## Implementation Steps (sketch)

(Filled in at activation time. High-level skeleton:)

1. Verify peer node Quartz consumer requirement at activation time.
2. Inspect `koi_net_events` payload shape; identify metadata field for forward-compatible attribution embedding.
3. Update Octo's entity replication emit-side to include attribution fields.
4. Update peer event-handlers + vault-note generation to honor incoming attribution.
5. Migrate `entity_registry.source_metadata` writes at all nodes to include attribution fields when wiki-derived.
6. Test federation roundtrip: ingest a wiki page on Octo → replicate to peer → verify peer's vault note has attribution → verify peer's Quartz (if running) renders the footer.
7. Coordinated `vendor/pin.txt` bump + deploy across all nodes.

---

## Acceptance criteria (sketch — to be concrete at activation)

- [ ] AC1: A wiki entity created on Octo and replicated to a peer ends up with identical `source_url`/`source_name`/`source_license`/`source_license_url` frontmatter on the peer's vault note.
- [ ] AC2: Peer's Quartz site (when running) renders the same attribution footer Octo's site does.
- [ ] AC3: Pre-existing replicated entities at peers can be backfilled by running the canonical `backfill_wiki_attribution.py` against the peer's DB.
- [ ] AC4: Peers without an active Quartz site continue to operate normally — frontmatter is written but unused.

## Verification plan (sketch)

- AC1 → SQL query at peer: `SELECT vault_rid FROM entity_registry WHERE source_metadata->>'source_url' IS NOT NULL` returns ≥ N where N is the count of wiki-derived entities replicated.
- AC2 → curl peer Quartz page, grep for `source-attribution` and license string.
- AC3 → run backfill at peer; verify N entries newly attributed.
- AC4 → no errors in peer logs; chat retrieval continues.

---

## Rollback (sketch)

- Trigger: peer event handlers fail to process incoming envelopes after the change.
- Roll back the canonical commit on `regen-prod`; bump vendor pin back; redeploy peers.

## Risks (sketch)

- KOI-net envelope size growth (4 small string fields per replicated entity — negligible).
- Peer schema drift if not all peers deploy the same canonical commit (mitigated by deploy.sh's manifest-driven migrations + the existing canonical-branch discipline).
- License-aware membrane is NOT yet decided. Until it is, peers replicate everything regardless of license (matches current behavior).

---

## Parking Lot

- (Impact: M) (Effort: M) (When: post-activation) — License-aware edge gating: peers can declare which licenses they accept; federation membrane filters at edge based on incoming entity's `source_license`.
- (Impact: L) (Effort: M) (When: someday) — Cross-node attribution-conflict resolution (what happens if Octo and Peer both ingest the same wiki page from different mirrors with different declared licenses?).

## References

- `~/projects/BioregionKnwoledgeCommons/Octo/CLAUDE.md` (federation membrane governance section)
- `~/projects/regenai/koi-processor/api/koi_protocol.py`, `api/koi_net_router.py`, `api/koi_envelope.py` (canonical federation plumbing)
- This-arc plans: `~/.claude/plans/wiki-source-attribution-quartz.md`, `~/.claude/plans/text-search-bundle-quartz-url-enrichment.md`
