# Summarizer → BKC `/ingest` Contract
*Gate B artifact — frozen for Mar 5 build day integration*

**Version:** v0.1-draft
**Status:** DRAFT — awaiting Gate B confirmation with AG Neyer
**Owner:** Darren Zal (BKC) + AG Neyer (Clawsmos)
**Endpoint target:** Salish Sea node (Octo) via BFF

---

## Overview

This contract specifies how a Clawsmos Summarizer agent calls BKC's `/ingest` endpoint to write structured knowledge from meeting coordination into the BKC knowledge graph.

**What the Summarizer does:** After a Matrix room session, extracts entities (people, organizations, projects, decisions, action items) and posts them to BKC for persistent memory and federation across the bioregional network.

**What BKC does:** Resolves entities against the existing graph (deduplication), writes them directly via `/ingest`, and makes them queryable via `/chat` and eligible for federation to other nodes.

---

## 1. Endpoint

> **Note on URL structure:** The web dashboard runs with `basePath: '/commons'`. All BFF routes
> are therefore under `/commons/`. Node IDs use full slugs, not short aliases.

### Production (Salish Sea / Octo node)
```
POST https://salishsee.life/commons/api/nodes/octo-salish-sea/ingest
```

### For local testing (if running web dashboard locally)
```
POST http://localhost:3000/commons/api/nodes/octo-salish-sea/ingest
```

### Direct to KOI backend (bypasses BFF — emergency fallback only)
```
POST http://127.0.0.1:8351/ingest
```
*(Note: direct path skips the BFF auth token; the KOI API itself has no external auth gate —
only use this in a controlled SSH tunnel scenario.)*

---

## 2. Authentication

**Header:** `x-ingest-token: <token>`

The token is shared out-of-band (Darren → AG Neyer before build day). It is validated server-side against `BFF_INGEST_TOKEN` environment variable.

**Failure mode:** `401 Unauthorized` if token is wrong or missing.
**If token not configured on server:** `503 Service Unavailable` (BFF fails closed in production).

---

## 3. Request Schema

```json
POST /commons/api/nodes/octo-salish-sea/ingest
Content-Type: application/json
x-ingest-token: <token>

{
  "document_rid": "clawsmos:meeting:<room_id>:<timestamp>",
  "source": "clawsmos-summarizer",
  "content": "<optional: plain text summary of the meeting>",
  "entities": [
    {
      "name": "string",
      "type": "Person | Organization | Project | Concept | Location | Meeting | ...",
      "context": "optional description string",
      "confidence": 0.9
    }
  ],
  "relationships": [
    {
      "subject": "string",
      "predicate": "affiliated_with | collaborates_with | attended | knows | ...",
      "object": "string",
      "confidence": 0.9
    }
  ]
}
```

### Field Notes

**`document_rid`** — Required. Unique identifier for this ingest event. Format: `<source>:<type>:<room_or_session_id>:<iso_timestamp>`. Used as a partial idempotency key: entity-link records (`document_rid` + `entity_uri`) use `ON CONFLICT DO UPDATE` so duplicate entity mentions increment a counter rather than erroring. However, the receipt RID is a fresh UUID on every call — do not rely on receipt identity across retries.

**`source`** — Required. Must be `"clawsmos-summarizer"` or a more specific variant (e.g., `"clawsmos-summarizer:front-range"`). Used for provenance tracking and filtering.

**`content`** — Optional. Plain text summary. Passed through for future RAG chunking; not automatically indexed on this endpoint (chunking happens via `/web/ingest`, a separate pipeline).

**`entities`** — Required. At minimum, provide `name` and `type`. `context` is an optional free-text description used for entity disambiguation (semantic embedding).

**Entity types** (from BKC ontology):
- `Person` — individuals
- `Organization` — organizations, groups, projects with org identity
- `Project` — specific projects or initiatives
- `Concept` — ideas, frameworks, terms
- `Location` — geographic places
- `Meeting` — the meeting/session itself
- `Practice` — ongoing practices or methods
- `Bioregion` — named bioregions

**`relationships`** — Optional but encouraged. `subject` and `object` are entity names (matched against the `name` fields in the `entities` array). Supported predicates:
- `affiliated_with` — person/org is affiliated with another org
- `collaborates_with` — two entities are actively collaborating
- `attended` — person attended a meeting/event
- `knows` — person knows person (weak connection signal)
- `has_project` — org has a project
- `involves_person` — event/project involves a person
- `involves_organization` — event/project involves an org
- `located_in` — entity is located in a place/bioregion

---

## 4. Response Schema

### Success (200)

```json
{
  "success": true,
  "canonical_entities": [
    {
      "name": "Clare Attwell",
      "uri": "bkc:person:clare-attwell",
      "type": "Person",
      "is_new": false,
      "merged_with": null,
      "confidence": 0.97
    }
  ],
  "receipt_rid": "orn:personal-koi.receipt:a1b2c3d4e5f6a7b8",
  "stats": {
    "entities_processed": 5,
    "new_entities": 2,
    "resolved_entities": 3,
    "relationships_processed": 4
  }
}
```

**`canonical_entities`** — The resolved canonical form of each submitted entity. `is_new: true` means a new entity was created. `merged_with` (if not null) is the URI of the entity it was deduplicated into.

**`receipt_rid`** — Provenance receipt. A fresh `orn:personal-koi.receipt:<uuid>` is generated on every call — it is NOT stable across retries.

**`stats`** — Counts for the operation. `resolved_entities` counts entities matched to existing records; `new_entities` counts freshly created records.

### Error cases

| Status | Body | Meaning |
|---|---|---|
| `400` | `{"error": "source field required for BFF ingest"}` | Missing `source` field |
| `400` | `{"error": "Invalid JSON body"}` | Malformed JSON |
| `401` | `{"error": "Unauthorized"}` | Wrong or missing token |
| `404` | `{"error": "Unknown node"}` | Invalid `nodeId` in URL path |
| `502` | `{"error": "unreachable"}` | KOI backend unreachable |
| `503` | `{"error": "Ingest route disabled..."}` | Token not configured on server |

---

## 5. Idempotency

**Partial idempotency:** `document_rid` is used as part of the entity-link key (`document_rid` + `entity_uri` in `document_entity_links`). Resubmitting the same `document_rid` will increment mention counts rather than creating duplicate link rows. However:
- Entity records themselves use name+type deduplication (not `document_rid`) — submitting the same entity name twice always resolves to the same canonical URI
- The `receipt_rid` in the response is a fresh UUID on every call — do not expect the same receipt on retry
- There is no request-level duplicate detection — a retry will re-run the full resolution pipeline

**Retry policy recommendation:** Safe to retry on 502 (upstream unreachable). Do NOT retry on 400 or 401 (caller error). On retry, the same `document_rid` prevents duplicate entity-link rows; new entities are skipped if already created by the first attempt.

**Recommendation:** Use a stable `document_rid` for the same meeting session: `clawsmos:meeting:<matrix_room_id>:<session_start_iso>`.

---

## 6. Sample Call (Success)

```bash
curl -X POST https://salishsee.life/commons/api/nodes/octo-salish-sea/ingest \
  -H "Content-Type: application/json" \
  -H "x-ingest-token: <token>" \
  -d '{
    "document_rid": "clawsmos:meeting:!abcdef:2026-03-05T14:30:00Z",
    "source": "clawsmos-summarizer",
    "content": "Build day session. Participants discussed BKC/Clawsmos integration seam. Decided to wire Summarizer to /ingest. AG Neyer and Darren Zal to pair on schema.",
    "entities": [
      {"name": "AG Neyer", "type": "Person", "context": "Clawsmos co-founder"},
      {"name": "Darren Zal", "type": "Person", "context": "BKC steward, Salish Sea"},
      {"name": "Clawsmos", "type": "Organization", "context": "Agent-native coordination layer"},
      {"name": "Bioregional Knowledge Commons", "type": "Organization"},
      {"name": "Build Day Mar 5 2026", "type": "Meeting"}
    ],
    "relationships": [
      {"subject": "AG Neyer", "predicate": "affiliated_with", "object": "Clawsmos"},
      {"subject": "Darren Zal", "predicate": "affiliated_with", "object": "Bioregional Knowledge Commons"},
      {"subject": "AG Neyer", "predicate": "attended", "object": "Build Day Mar 5 2026"},
      {"subject": "Darren Zal", "predicate": "attended", "object": "Build Day Mar 5 2026"}
    ]
  }'
```

### Expected response:
```json
{
  "success": true,
  "canonical_entities": [
    {"name": "AG Neyer", "uri": "bkc:person:ag-neyer", "type": "Person", "is_new": true, "merged_with": null, "confidence": 1.0},
    {"name": "Darren Zal", "uri": "bkc:person:darren-zal", "type": "Person", "is_new": false, "merged_with": null, "confidence": 0.99},
    {"name": "Clawsmos", "uri": "bkc:org:clawsmos", "type": "Organization", "is_new": true, "merged_with": null, "confidence": 1.0},
    {"name": "Bioregional Knowledge Commons", "uri": "bkc:org:bioregional-knowledge-commons", "type": "Organization", "is_new": false, "merged_with": null, "confidence": 0.98},
    {"name": "Build Day Mar 5 2026", "uri": "bkc:meeting:build-day-mar-5-2026", "type": "Meeting", "is_new": true, "merged_with": null, "confidence": 1.0}
  ],
  "receipt_rid": "orn:personal-koi.receipt:a1b2c3d4e5f60001",
  "stats": {"entities_processed": 5, "new_entities": 3, "resolved_entities": 2, "relationships_processed": 4}
}
```

---

## 7. Sample Call (Failure — wrong token)

```bash
curl -X POST https://salishsee.life/commons/api/nodes/octo-salish-sea/ingest \
  -H "Content-Type: application/json" \
  -H "x-ingest-token: wrong-token" \
  -d '{"source": "test", "entities": [], "document_rid": "test:001"}'
```

Expected: `401 {"error": "Unauthorized"}`

---

## 8. Gate B Checklist

Before freezing this contract (by Mar 3, 18:00 MT):

- [ ] AG Neyer has reviewed and confirmed entity type list is sufficient for Clawsmos Summarizer output
- [ ] Auth token shared securely (out-of-band, not in this doc)
- [ ] At least one successful test call executed against live `/ingest` endpoint
- [ ] At least one failure case tested (wrong token, missing `source`, malformed JSON)
- [ ] Entity resolution confirmed working (try submitting "Darren Zal" twice — second call should return `is_new: false`)
- [ ] Partial idempotency confirmed (same `document_rid` twice → no duplicate entity-link rows; entity records deduplicated by name+type; receipt is a fresh UUID each call — that is expected)
- [ ] Response schema confirmed compatible with Clawsmos Summarizer's expectations
- [ ] Error handling policy agreed: Summarizer should retry on 502 (upstream unreachable) but NOT on 401/400/400 (caller error)

---

## 9. What BKC Does With Ingested Data

1. **Entity resolution:** Each submitted entity is matched against the existing graph using 3-tier resolution (exact match → fuzzy Jaro-Winkler → semantic embedding). Near-matches are surfaced as merge candidates for steward review via the commons merge queue.

2. **Direct write (no staging):** `/ingest` writes entities directly to the knowledge graph — it does NOT create staged commons-intake items. The staged → approved → ingested consent flow is triggered by a different path: `/koi-net/share` with `recipient_type=commons`. For the build day integration, entities submitted via `/ingest` are immediately in the graph and queryable. The governance membrane demo (Segment 3) requires a separately pre-staged entity or a KOI-net share event — not a direct `/ingest` call.

3. **RAG availability:** The `content` field is passed through but not automatically chunked for RAG on this endpoint. Full RAG indexing happens via the `/web/ingest` pipeline (separate from this endpoint). Entities themselves are immediately searchable by name/type.

4. **Federation:** Newly created entities become eligible for federation to connected nodes (FR, GV, CV) via KOI-net protocol on the next federation cycle.

5. **Provenance:** A `receipt_rid` (`orn:personal-koi.receipt:<uuid>`) is returned for each call. This is a fresh UUID per call (not stable across retries).

---

## 10. Open Questions (to resolve at Gate B)

- **Auth token rotation:** Who holds the master token? What is the rotation process?
- **Consent level for Clawsmos data:** Current behavior is direct write via `/ingest`. Should Clawsmos use the staged commons path (`/koi-net/share` with `recipient_type=commons`) for specific meeting types?
- **PII handling:** Does the Summarizer need to redact or anonymize any participant data before calling `/ingest`? (Names are fine; personal contact info should not be included in entity properties.)
- **Rate limiting:** No rate limit currently configured. Clawsmos should not send more than ~10 requests/minute during build day testing.
- **Multi-node:** This contract is for the Octo/Salish Sea node. Should a second contract be established for the FR node to support front-range sessions?
