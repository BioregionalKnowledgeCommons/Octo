# CLAUDE.md — Octo Project Instructions

## Overview

Octo is a bioregional knowledge commoning agent built on OpenClaw, deployed on a VPS at `45.132.245.30`. It runs a KOI (Knowledge Organization Infrastructure) backend with a PostgreSQL knowledge graph and serves as the AI agent for the BKC CoIP (Bioregional Knowledge Commons Community of Inquiry & Practice).

## Production Server

- **Host:** `45.132.245.30`
- **Public Site (canonical):** `https://45.132.245.30.sslip.io`
- **Public Site (legacy/raw IP):** `http://45.132.245.30` (HTTPS on raw IP uses self-signed fallback cert)
- **User:** `root`
- **OS:** Ubuntu 24.04 LTS
- **SSH:** `ssh root@45.132.245.30` (key-based auth configured)
- **Resources:** 4 vCPU, 8GB RAM, 247GB disk

## Services

| Service | How it runs | Port | Details |
|---------|------------|------|---------|
| **Octo KOI API** | systemd (`koi-api.service`) | 8351 (localhost) | uvicorn, Python 3.12, KOI-net enabled |
| **FR KOI API** | systemd (`fr-koi-api.service`) | 8355 (localhost) | Front Range peer node, localhost-only |
| **KOI Federation Gateway** | nginx (`octo-koi-net-8351`) | 8351 (public IP) | Proxies only `/koi-net/*` and `/health` to Octo API |
| **GV KOI API** | **Remote** on `37.27.48.12` (poly) | 8351 (public) | Greater Victoria leaf node, migrated 2026-02-18 |
| **PostgreSQL** | Docker (`regen-koi-postgres`) | 5432 (localhost) | pgvector + Apache AGE, multiple DBs |
| **OpenClaw** | OpenClaw runtime (v2026.2.2-3) | — | Telegram + Discord channels |
| **Quartz** | nginx + cron rebuild | 80/443 | Static knowledge site (HTTPS on `45.132.245.30.sslip.io`) |
| **Octo Chat** | systemd (`octo-chat.service`) | 3847 (localhost) | Chat API → OpenClaw agent |

### KOI-net Node Identities

Node RID hash mode: `b64_64` = `sha256(base64(DER(pubkey)))` — BlockScience canonical (64 hex chars).
Legacy `legacy16` RIDs (16 hex chars) still accepted during migration via `KOI_ALLOW_LEGACY16_NODE_RID=true`.

| Node | Node RID | Public Key (truncated) |
|------|----------|----------------------|
| **Octo** | `orn:koi-net.node:octo-salish-sea+f06551d75797303be1831a1e00b41cf930625961882082346cb3932175a17716` | `MFkwEwYH...` |
| **FR** | `orn:koi-net.node:front-range+b5429ae7981decb0ddf5a45551b176846e6121f964543259eccf4a0a1a6ff21c` | `MFkwEwYH...` |
| **GV** | `orn:koi-net.node:greater-victoria+81ec47d80f2314449b0f4342c087eb91dabf7811fc2d846233c389ef2b0b6f58` | `MFkwEwYH...` |

> **RID migration complete (2026-02-18):** Node RIDs migrated from legacy16 (16-char) to b64_64 (64-char BlockScience canonical). Same keypairs, full SHA-256 hash suffix.
> **Octo RID rotated (2026-02-26):** Previous RID (`...+50a3c9ea...`) superseded after key rotation. FR RID reconciliation done (234 cross-refs updated, old node record marked inactive).

Octo's key: `/root/koi-state/octo-salish-sea_private_key.pem` (on 45.132.245.30).
FR's key: `/root/koi-state/front-range_private_key.pem` (on 45.132.245.30).
GV's key: `/home/koi/koi-state/greater-victoria_private_key.pem` (on poly 37.27.48.12).

## File Layout on Server

```
/root/
├── koi-processor/              # KOI backend (Python, shared by all agents)
│   ├── api/
│   │   ├── personal_ingest_api.py   # Main API (FastAPI/uvicorn)
│   │   ├── entity_schema.py         # 18 entity types, resolution config
│   │   ├── vault_parser.py          # YAML→predicate mapping (33 predicates)
│   │   ├── web_fetcher.py           # URL fetch + Playwright + content extraction
│   │   ├── koi_net_router.py        # KOI-net protocol + commons intake endpoints
│   │   ├── commons_ingest_worker.py # Async background worker for commons intake
│   │   ├── koi_envelope.py          # ECDSA P-256 signed envelopes
│   │   ├── koi_poller.py            # Background federation poller
│   │   ├── koi_protocol.py          # Wire format models (Pydantic)
│   │   ├── event_queue.py           # DB-backed event queue
│   │   ├── node_identity.py         # Keypair + node RID generation
│   │   └── github_sensor.py        # GitHub repo scanner (tree-sitter, vault notes)
│   ├── config/
│   │   └── personal.env             # Octo DB creds, OpenAI key, vault path
│   ├── migrations/
│   │   ├── 038_bkc_predicates.sql   # BKC ontology predicates
│   │   ├── 039–052_*.sql            # Federation, shared docs, assertion history, etc.
│   │   ├── 053_commons_decision_log.sql     # Decision audit log + expanded intake status
│   │   ├── 054_commons_merge_candidates.sql # Merge candidate queue for entity resolution
│   │   └── baselines/{octo,fr,gv}_koi.json # Migration manifests per node
│   ├── scripts/
│   │   └── backfill_koi_rids.py     # One-time RID backfill
│   ├── tests/
│   │   └── test_koi_interop.py      # KOI-net protocol interop tests
│   ├── requirements.txt
│   └── venv/                        # Python virtualenv
├── fr-koi-processor/           # FR KOI code (deployed by deploy.sh, separate from Octo's koi-processor/)
│   ├── api/                    #   Same code as koi-processor/api/ (vendored from canonical)
│   ├── migrations/
│   └── .version                # Stamped git SHA after each deploy
├── fr-agent/                   # Front Range config/workspace/vault (port 8355, localhost-only)
│   ├── config/
│   │   └── fr.env
│   ├── workspace/
│   │   ├── IDENTITY.md
│   │   └── SOUL.md
│   └── vault/
│       ├── Bioregions/
│       └── Practices/
├── gv-agent/                   # Greater Victoria (LEGACY local copy — deployed on poly at /home/koi/)
├── koi-state/                  # Node identity keys
│   └── octo-salish-sea_private_key.pem
├── scripts/                    # Multi-agent management + federation admin
│   ├── manage-agents.sh
│   ├── agents.conf
│   ├── test-federation.sh
│   ├── admin-edges.sh          # Edge approve/reject/list CLI (membrane governance)
│   └── check-proposed-edges.sh # Daily cron: log pending PROPOSED edges
├── koi-stack/                  # Docker config
│   ├── docker-compose.yml
│   ├── Dockerfile.postgres-age
│   ├── init-extensions.sql
│   └── create-additional-dbs.sh
├── personal-koi-mcp/          # MCP server (TypeScript, from regen-koi-mcp fork)
├── bioregional-koi/           # OpenClaw plugin
│   ├── openclaw.plugin.json
│   └── index.ts
├── .openclaw/
│   ├── openclaw.json               # OpenClaw config (channels, auth, model)
│   ├── credentials/                # Telegram pairing, etc.
│   └── workspace/
│       ├── IDENTITY.md             # Octo's identity
│       ├── SOUL.md                 # Philosophy and values
│       ├── KNOWLEDGE.md            # BKC domain expertise
│       ├── USER.md                 # About Darren
│       ├── AGENTS.md               # Agent routing rules
│       ├── TOOLS.md                # Environment config
│       ├── HEARTBEAT.md            # Periodic tasks
│       └── vault/                  # Entity notes (Obsidian-style)
│           ├── Bioregions/
│           ├── Practices/
│           ├── Patterns/
│           ├── CaseStudies/
│           ├── Protocols/
│           ├── Playbooks/
│           ├── Questions/
│           ├── Claims/
│           ├── Evidence/
│           ├── People/
│           ├── Organizations/
│           ├── Projects/
│           ├── Concepts/
│           └── Sources/             # Ingested web sources
├── octo-quartz/                # Quartz static site generator
│   ├── quartz.config.ts          # Site config (title, theme, plugins)
│   ├── content -> vault/         # Symlink to vault
│   ├── public/                   # Built site (served by nginx)
│   └── rebuild.sh                # Build + inject chat widget
├── octo-chat/                  # Chat API server
│   └── server.js                 # Node.js proxy → openclaw agent
├── github_sensor_clones/       # Git clones for GitHub sensor (persistent)
└── backups/                    # Daily DB + vault backups (7-day retention)
```

## Quartz Knowledge Site — "Salish Sea Knowledge Garden"

**Canonical URL:** `https://salishsee.life`
**Legacy URLs:** `https://45.132.245.30.sslip.io`, `http://45.132.245.30`

Quartz renders Octo's vault as a browsable static site with wikilinks, backlinks, graph view, and full-text search.

**Privacy:** The `People/` folder is excluded via `ignorePatterns` — no personal names/info are published. Entity files still reference People via wikilinks internally, but those pages don't render on the public site.

### Config
- **nginx:** `/etc/nginx/sites-available/octo-quartz`
- **KOI gateway nginx:** `/etc/nginx/sites-available/octo-koi-net-8351`
- **Quartz config:** `/root/octo-quartz/quartz.config.ts`
- **TLS cert deployment:** `/etc/nginx/ssl/octo-sslip-fullchain.pem` + `/etc/nginx/ssl/octo-sslip.key`
- **ACME client:** `~/.acme.sh/acme.sh` (ZeroSSL)
- **Landing page:** `/root/.openclaw/workspace/vault/index.md`
- **Auto-rebuild:** Cron every 15 minutes → `/var/log/quartz-rebuild.log`
- **Cert renew cron:** `34 0 * * * "/root/.acme.sh"/acme.sh --cron --home "/root/.acme.sh" > /dev/null`

### Manual rebuild
```bash
ssh root@45.132.245.30 "/root/octo-quartz/rebuild.sh"
```

### Update domain (when ready)
1. Edit `baseUrl` in `/root/octo-quartz/quartz.config.ts`
2. Issue/install cert for new host via ACME and update nginx cert paths/server_name in `/etc/nginx/sites-available/octo-quartz`
3. Rebuild and reload: `/root/octo-quartz/rebuild.sh && systemctl reload nginx`

## Vendor Sync & Deployment

Octo's KOI runtime code comes from the canonical repo (`RegenAI/koi-processor`) via pinned-SHA vendor sync.

### How it works
- `vendor/pin.txt` — SHA of the canonical commit to deploy
- `vendor/sync.sh` — Fetches and vendors the canonical code at the pinned SHA
- `deploy.sh` — Full deployment pipeline: vendor sync → rsync to servers → manifest-driven migrations → restart → health check

### Deploy
```bash
# Deploy to all nodes (FR → GV → Octo)
./deploy.sh --target all

# Deploy to a single node
./deploy.sh --target fr

# Dry run (preview what would happen)
./deploy.sh --target octo --dry-run

# Skip vendor sync (use existing vendored code)
./deploy.sh --target gv --skip-sync
```

Ops note (2026-04-20): the deferred Peninsula municipality embedding backfill was skipped after `GET /health` on poly reported `busy: true`; retry only in a later idle window, not via tight-loop polling.

Deploy procedure note: `deploy.sh` now syncs `requirements.txt` and runs `pip install -r requirements.txt` inside the target venv on every Octo/FR/GV deploy before service restart.

### Migration governance
Migrations are **manifest-driven** — only migrations listed in `migrations/baselines/${db}.json` are applied to each node. Each entry has a canonical `migration_id` (e.g. `bkc:039_koi_net_events`) and expected `sha256` checksum. Missing files or checksum mismatches halt the deploy with rollback.

### Bump the pin
1. Verify the canonical commit passes contract tests
2. Update `vendor/pin.txt` with the new SHA
3. Run `./deploy.sh --target fr` (lowest risk first)
4. Verify health, then `--target gv`, then `--target octo`

### Branch lineage — critical context

`gaiaaiagent/koi-processor` has a **single unified branch:**

| Branch | Deployed to | Who uses it |
|--------|-------------|-------------|
| `regen-prod` | BKC nodes via vendor pin + Regen Network | Both BKC federation (Octo, FR, GV, CV) and Regen Network |

**History:** Prior to 2026-03-03, BKC work lived on `b1-chat-retrieval-hardening` (72 commits diverged from `regen-prod`). Merged in session `a9389700` with zero conflicts. Rollback tag: `pre-merge-regen-prod-20260303-232834` at `947bca3f`.

**Rules:**
- The vendor pin should always point to a commit on `regen-prod`.
- All new work happens on feature branches merged into `regen-prod`.

## Common Operations

### SSH to server
```bash
ssh root@45.132.245.30
```

### Check all agents status
```bash
ssh root@45.132.245.30 "bash ~/scripts/manage-agents.sh status"
```

### KOI API health check
```bash
ssh root@45.132.245.30 "curl -s http://127.0.0.1:8351/health"   # Octo
curl -s http://37.27.48.12:8351/health                           # GV (remote on poly)
```

### KOI-net health check
```bash
ssh root@45.132.245.30 "curl -s http://127.0.0.1:8351/koi-net/health"
curl -s http://45.132.245.30:8351/koi-net/health   # Public KOI gateway path
```

### Restart agents (after code changes)
```bash
ssh root@45.132.245.30 "systemctl restart koi-api"                # Octo
ssh root@37.27.48.12 "sudo systemctl restart gv-koi-api"          # GV (remote on poly)
```

### Deploy updated Python files
```bash
# Use the vendor-based deploy pipeline (see Vendor Sync & Deployment above)
./deploy.sh --target fr    # lowest risk first
./deploy.sh --target gv
./deploy.sh --target octo
```

### Deploy updated plugin + restart OpenClaw
```bash
scp plugins/bioregional-koi/index.ts root@45.132.245.30:~/bioregional-koi/index.ts
ssh root@45.132.245.30 "openclaw gateway restart"
```

### Run federation test
```bash
ssh root@45.132.245.30 "bash ~/scripts/test-federation.sh"
```

### Run interop test
```bash
ssh root@45.132.245.30 "cd ~/koi-processor && venv/bin/python tests/test_koi_interop.py"
```

### Run a database migration
```bash
# Migrations are applied automatically by deploy.sh via manifests.
# For manual one-off migrations:
cat vendor/koi-processor/migrations/038_bkc_predicates.sql | ssh root@45.132.245.30 "docker exec -i regen-koi-postgres psql -U postgres -d octo_koi"
```

### Query the database
```bash
ssh root@45.132.245.30 "docker exec regen-koi-postgres psql -U postgres -d octo_koi -c 'SELECT * FROM allowed_predicates;'"
```

### Resolve an entity via API
```bash
ssh root@45.132.245.30 'curl -s -X POST http://127.0.0.1:8351/entity/resolve -H "Content-Type: application/json" -d "{\"label\": \"Herring Monitoring\", \"type_hint\": \"Practice\"}"'
```

### Test web URL preview
```bash
ssh root@45.132.245.30 'curl -s -X POST http://127.0.0.1:8351/web/preview -H "Content-Type: application/json" -d "{\"url\": \"https://example.com\"}" | python3 -m json.tool'
```

### View OpenClaw logs
```bash
ssh root@45.132.245.30 "journalctl -u koi-api -f"
```

### Edit workspace files
```bash
ssh root@45.132.245.30 "nano ~/.openclaw/workspace/KNOWLEDGE.md"
# Or SCP from local:
scp workspace/KNOWLEDGE.md root@45.132.245.30:~/.openclaw/workspace/
```

## Federation Membrane Governance

The coordinator gates network admission. New nodes get PROPOSED edges (not auto-APPROVED). Admin must explicitly approve before knowledge flows.

**Coordinator env vars** (in `personal.env`):
- `KOI_NET_REQUIRE_APPROVED_EDGE_FOR_POLL=true` — gates all KOI-net data endpoints
- `KOI_NET_DEFER_UNKNOWN_HANDSHAKE=true` — unknown handshakes create PROPOSED edges

**Admin CLI** (`scripts/admin-edges.sh` on coordinator):
```bash
# List pending edges
ssh root@45.132.245.30 "KOI_STATE_DIR=/root/koi-state bash /root/scripts/admin-edges.sh list --status PROPOSED"

# Approve a new node
ssh root@45.132.245.30 "KOI_STATE_DIR=/root/koi-state bash /root/scripts/admin-edges.sh approve <edge_rid>"

# Reject + deactivate
ssh root@45.132.245.30 "KOI_STATE_DIR=/root/koi-state bash /root/scripts/admin-edges.sh reject <edge_rid> --deactivate"
```

**Daily check:** Cron at 9am UTC logs PROPOSED edges to `/var/log/proposed-edges.log`.

**Leaf nodes** keep `KOI_NET_REQUIRE_APPROVED_EDGE_FOR_POLL=false` and `KOI_NET_DEFER_UNKNOWN_HANDSHAKE=false` — the coordinator gates, not leaves.

## KOI-net Federation Debugging

### Fast checks
```bash
# Idempotent local peer connect (upsert node+edge, send handshake, print reciprocal SQL)
bash scripts/connect-koi-peer.sh --db <local_db> --peer-url http://<peer-ip>:8351

# Is Cowichan polling Octo?
ssh root@45.132.245.30 "journalctl -u koi-api --since '10 min ago' --no-pager | grep -E '202\\.61\\.242\\.194:0 - \\\"POST /koi-net/events/poll|Delivered .*cowichan|Confirmed .*cowichan'"

# Do we have peer public keys?
ssh root@45.132.245.30 "docker exec regen-koi-postgres psql -U postgres -d octo_koi -c \"SELECT node_rid, node_name, length(public_key) AS key_len, base_url FROM koi_net_nodes ORDER BY node_name;\""

# Is edge orientation correct? (source = provider, target = poller)
ssh root@45.132.245.30 "docker exec regen-koi-postgres psql -U postgres -d octo_koi -c \"SELECT edge_rid, source_node, target_node, status FROM koi_net_edges WHERE edge_rid LIKE '%polls%';\""
```

### Known failure modes
- `POST /koi-net/events/poll` returns `400` with `No public key for ...`:
  - Poller now retries with handshake automatically; if it persists, upsert peer `public_key` in `koi_net_nodes`.
- Poller runs but never polls peers:
  - Edge is flipped. For POLL, `target_node` must equal self.
- Poller appears "stuck" after prior peer outage:
  - Poller now uses time-based backoff (30s, 60s, 120s... capped at 600s) and should auto-recover without restart.
  - Watch for `POLL recovered for <node_rid> after <n> consecutive failures` in logs.
- New node handshake succeeds but can't poll/fetch data:
  - Edge is PROPOSED (membrane governance). Run `admin-edges.sh list --status PROPOSED` then `admin-edges.sh approve <edge_rid>`.
- `404` on `/koi-net/poll`:
  - Use `/koi-net/events/poll` (legacy path removed).
- Peer cannot reach Octo:
  - Ensure nginx KOI gateway is up (`/etc/nginx/sites-available/octo-koi-net-8351`) and `KOI_BASE_URL` is public.

## Databases

Octo's databases are in the local PostgreSQL container (`regen-koi-postgres`). GV's database is on poly (`37.27.48.12`, container `gv-koi-postgres`, port 5433).

| Database | Agent | Host | Entities |
|----------|-------|------|----------|
| `octo_koi` | Octo (Salish Sea) | `45.132.245.30` (local) | ~2,722 |
| `fr_koi` | Front Range | `45.132.245.30` (local) | 4 |
| `gv_koi` | Greater Victoria | `37.27.48.12` (poly, port 5433) | 5 |

### Key tables (per database)

- `entity_registry` — All registered entities with `koi_rid` for federation
- `entity_relationships` — Typed relationships between entities
- `allowed_predicates` — Valid predicate definitions (27 BKC predicates)
- `pending_relationships` — Unresolved relationship targets
- `document_entity_links` — Document↔entity mention tracking
- `web_submissions` — URL submission lifecycle (preview → evaluate → ingest)

### MediaWiki import tables (migration 063)

- `mediawiki_wikis` — Wiki registry (base_url, API endpoint, sync mode)
- `mediawiki_page_state` — Per-page state tracking with classification, confidence scores, and entity URIs
- `mediawiki_import_runs` — Import run tracking (pilot/full/rerun, page counts, entity/edge stats)
- `mediawiki_page_links` — Source-native page links with provenance (separate from promoted `entity_relationships`)

### Federation tables (KOI-net, per database)

- `koi_net_events` — Event queue (delivered_to, confirmed_by arrays, TTL)
- `koi_net_edges` — Node-to-node relationships (POLL/PUSH, rid_types filter)
- `koi_net_nodes` — Peer registry with public keys
- `koi_net_cross_refs` — Cross-references linking local entities to remote RIDs
- `koi_shared_documents` — Inbound shared documents with intake status lifecycle
- `koi_outbound_share_ledger` — Outbound share tracking

### Commons intake tables (per database, where `COMMONS_INGEST_ENABLED=true`)

- `koi_commons_decisions` — INSERT-only audit log of approve/reject decisions (migration 053)
- `koi_commons_merge_candidates` — Queue of ambiguous entity matches for admin review (migration 054)

### Schema infrastructure tables

- `koi_migrations` — Migration governance registry (canonical migration_id + checksum + applied_at)
- `source_schemas` — Schema registry with consent tracking (octo_koi only)
- `ontology_mappings` — Source→BKC field mappings (octo_koi only)

## Backups

### Octo (`45.132.245.30`)
Automated via cron (daily at 3am CET):
- **DB:** `pg_dump | gzip` → `/root/backups/octo_koi_YYYYMMDD.sql.gz`
- **Vault:** `tar czf` → `/root/backups/vault_YYYYMMDD.tar.gz`
- **Keys:** `tar czf` → `/root/backups/koi_state_YYYYMMDD.tar.gz` (Octo node identity key)
- **Retention:** 7 days (old backups auto-deleted at 4am)

### GV on poly (`37.27.48.12`)
Automated via systemd timer (`gv-backup.timer`, daily at 3am CET):
- **DB:** `pg_dump -Fc` → `/home/koi/backups/gv_koi_YYYYMMDD.dump` + `.sha256`
- **Vault:** `tar czf` → `/home/koi/backups/gv_vault_YYYYMMDD.tar.gz` + `.sha256`
- **Retention:** 7 days
- **Off-host copy:** Weekly rsync to `root@45.132.245.30:/root/backups/poly-mirror/` (`gv-backup-offhost.timer`, Sundays 4am)

## BKC Ontology

The formal ontology is at `ontology/bkc-ontology.jsonld`. It defines:

**25 entity types** (v1.3.0): Person, Organization, Project, Location, Concept, Meeting + Practice, Pattern, CaseStudy, Bioregion, Protocol, Playbook, Question, Claim, Evidence + **Commitment, CommitmentPool, CommitmentAction** + **Outcome, Initiative, WorkItem, Milestone, Decision, Risk, Metric** (roadmap types)

**39 predicates** across 6 categories:
- **Base KOI** (10): affiliated_with, attended, collaborates_with, founded, has_founder, has_project, involves_organization, involves_person, knows, located_in
- **Knowledge Commoning** (4): aggregates_into, suggests, documents, practiced_in
- **Discourse Graph** (7): supports, opposes, informs, generates, implemented_by, synthesizes, about
- **SKOS + Hyphal** (6): broader, narrower, related_to, forked_from, builds_on, inspired_by
- **Commitment Pooling** (6): pledges_commitment, aggregates_commitments, proves_commitment, redeems_via, governs_pool, disputes
- **Roadmap** (6): depends_on, delivers, measures, mitigates, blocks, references

**Parser aliases** (not stored as separate predicates):
- `documentedBy` → `documents` (direction swap)
- `implements` → `implemented_by` (direction swap)
- `protocol` → `implemented_by` (direction swap)

## Local Development

All KOI runtime code lives in the canonical repo (`~/projects/regenai/koi-processor/`) and is vendored at deploy time via `vendor/sync.sh`. There is no local copy of koi-processor in this repo — use `deploy.sh` for all deployments (see Vendor Sync & Deployment section above).

The remaining source files in this repo map to server paths:

| Repo path | Server path |
|-----------|-------------|
| `docker/` | `/root/koi-stack/` |
| `scripts/` | `/root/scripts/` |
| `systemd/` | `/etc/systemd/system/` |
| `fr-agent/` | `/root/fr-agent/` (on `45.132.245.30`) |
| `gv-agent/` | `/home/koi/gv-agent/` (on poly `37.27.48.12`) |
| `workspace/` | `/root/.openclaw/workspace/` |
| `plugins/bioregional-koi/` | `/root/bioregional-koi/` |
| `vault-seed/` | `/root/.openclaw/workspace/vault/` (subset) |
| `quartz/` | Templates for Quartz knowledge site setup (`setup-quartz.sh`) |
| `ontology/` | Local vault (`~/Documents/Notes/Ontology/`) |

## Related Local Projects

| Path | What |
|------|------|
| `~/projects/regenai/koi-processor/` | Full KOI processor (superset of what's deployed here) |
| `~/projects/personal-koi-mcp/` | KOI MCP server (TypeScript). Implements the `koi-tool-contract` (15 tools) + 27 personal-only tools (email search, sessions, vault ETL, meeting prep). Currently a hybrid personal+BKC system — the 15 contract tools are identical to what `plugins/bioregional-koi/` provides for OpenClaw. Future plan: split into `commoning-koi-mcp` (15 contract tools only, deployable on any BKC node) + keep personal tools here. See `docs/koi-protocol-alignment-master.md` §8C. |
| `~/Documents/Notes/Ontology/` | Local vault ontology schemas |
| `~/projects/BioregionKnwoledgeCommons/bioregional-commons-web/` | Web dashboard (Next.js). Forked from `omniharmonic/bioregionalknowledgecommons`. BFF API routes proxy to all 4 KOI nodes server-side. 3D globe with live node health, federation arcs, entity browser. Designed to run on Octo server (Option A) where it can reach all nodes directly. |

## Current Status

**Date:** 2026-05-02
**Status:** HEALTHY — Attribution arc complete (chat citations + Quartz source attribution). Octo on pin `08594441` (server-direct edits this arc, not yet vendor-pinned). Live: `salishsee.life` shows `Source: Salish Sea Wiki · License: CC-BY-SA 3.0 Unported` on ~875 wiki-derived pages; chat widget answers consistently cite canonical Quartz URLs across Concept/Practice/Organization/Project entity types.

### What's Done
- **Attribution arc (2026-04-30 → 2026-05-02)**: octo-chat parse bug fixed, OpenAI key rotated post-exposure, openclaw model switched to `openai/gpt-4.1-mini`, new `koi_chat` plugin tool wraps full RAG pipeline, ~875 vault notes attributed via `backfill_wiki_attribution.py` (CC-BY-SA 3.0 Unported declared on Welcome page), Quartz `SourceAttribution` component renders footers (gated on `source_url` OR `@type: schema:WebPage`+`url`), citation policy fix in `personal_ingest_api.py` (entity_block markdown links + doc_block url-stripping + deterministic server-side `## Related on Octo` block), `text_search` bundles now carry `quartz_url` via `mediawiki_page_state → entity_registry` JOIN (`_lookup_chunk_quartz_urls` in `retrieval_executors.py`), weekly cron `30 4 * * 1 run_wiki_attribution_backfill.sh` for forward coverage. Hygiene: gateway-token rotated, 9 dead model-registry entries pruned, `nvidia-env` removed, Anthropic key revoked + drop-in disabled. Docs trail: `docs/sessions/2026-05-attribution-arc/`. Server-direct edits with `.bak-<timestamp>` rollback files; canonical `koi-processor` `regen-prod` not yet bumped (operator call when next vendor-pin coordinated deploy is scheduled).
- **Sprint 2b coordinated deploy (2026-04-23, pin `08594441`)**: pre-deploy audit clean (`regen-prod` frozen at `08594441`, 36 commits reviewed, 0 SURPRISE, migration 088 confirmed out-of-manifest/no-op), pre-deploy DB backup captured at `/root/backups/pre-sprint-2b-20260422-232905.sql.gz` (`79M`), pin-bump branch `deploy/sprint-2b-octo` committed as `c4b9b24`, and `./deploy.sh --target octo` completed in ~1 minute with the Sprint 1.5a pip fix validated end-to-end.
- **Primary production bug fixed live**: `/knowledge/episodes?limit=5` and `/knowledge/unified-search?query=Peninsula+Streams&limit=3` now return `200` on Octo with `X-Facts-Surface: unavailable`; `facts_surface_available=False` is confirmed at startup, so the missing `knowledge_facts` / `knowledge_episodes` tables no longer produce 500s on bioregional nodes.
- **Claims-auth live on Octo**: unauthenticated `POST /claims/` returns `401`, service-token-authenticated writes reach schema validation (`422`, not `401`), and `KOI_CLAIMS_SERVICE_TOKEN` was verified in Octo API, commons-web, `celo-scripts`, `eas-scripts`, and the restarted OpenClaw gateway.
- **OpenAI recovery revalidated post-deploy**: immediate post-deploy `/diagnostics/embedding-preflight` failures were confirmed as pre-existing `429 insufficient_quota`; after credits were topped up, `/diagnostics/embedding-preflight` returned `overall_pass=true`, `/knowledge/unified-search` returned `embedding_available=true`, and `POST /chat` returned `200`.
- Sprints 1-3 deployed: KOI-net federation working between Octo (coordinator) and GV (leaf)
- **GV migrated to remote server** (2026-02-18): `37.27.48.12` (poly), port 8351, user `koi`, own PostgreSQL container (port 5433). Same keypair, RID preserved. 3-node topology: Octo + GV (remote) + CV (Shawn)
- P0-P9 protocol alignment complete (98 tests, deployed), keys encrypted at rest (P9)
- **Front Range agent deployed** (2026-02-19): `127.0.0.1:8355` on Octo server, `fr_koi` DB, bidirectional federation with Octo, localhost-only (peer through coordinator topology). Code path: `/root/fr-koi-processor/`
- Node RID migration to b64_64 (BlockScience canonical) complete
- **~2,722 entities** in Octo — MediaWiki full import (2,027 from wiki, 482 from vault, rest from seeding/ingest)
- Cowichan Valley (Shawn's node) live at `202.61.242.194:8351`
- **Phase 5.7: GitHub sensor activated** (2026-02-19): 4 repos, 35k+ code artifacts, tree-sitter extraction, 6-hour auto-scan interval
- **Commons intake workflow deployed** (2026-02-26, commit `1bb24b50`):
  - Decision audit log (migration 053) + merge candidate queue (migration 054)
  - Async ingest worker (`commons_ingest_worker.py`) on all 3 nodes (`COMMONS_INGEST_ENABLED=true`)
  - Merge review endpoints, admin guard, transaction safety
  - POST `/chat` RAG endpoint for web dashboard
  - E2E verified: `staged → approved → ingesting → ingested`
- **Octo RID rotated** (2026-02-26): New RID `...+f06551d7...`; FR RID reconciliation done (234 cross-refs updated)
- **Web dashboard deployed** with commons merge review UI, chat, entity browser, knowledge panel
- **Vault auto-note creation (2026-03-05, pin `a54b626e`)**: `POST /web/ingest` now creates `.md` vault notes automatically for new entities. Direction-aware wikilinks, `entity_rid_mappings` upsert with collision guard. Backfilled 16 existing web_ingest entities. salishsee.life pages verified 200 ✓
- **MediaWiki import v1–v3 (2026-03-06)**: Salish Sea Wiki graph densification. v1: parser, dump reader, bulk importer, migration 063. v2: vault notes, review CLI, section chunking. v3: live sync sensor (`MediaWikiSensor`) polls RecentChanges API every 5 min, auto-ingests updated/new pages. Full import: 3,121 pages → 1,708 entities created, 309 matched, 6,185 edges. Env: `MEDIAWIKI_SENSOR_ENABLED=true`, `MEDIAWIKI_POLL_INTERVAL=300`. Endpoints: `/mediawiki/scan`, `/mediawiki/status`, `/mediawiki/wikis`. Vendor pin `698b5042`.

### GV Remote Node (poly)
- **Host:** `37.27.48.12` (poly server, shared with AlgoTrading)
- **SSH:** `ssh root@37.27.48.12` (or `koi` user for KOI work)
- **Service:** `gv-koi-api.service` (systemd, runs as `koi` user)
- **DB:** `gv_koi` in Docker container `gv-koi-postgres` on port 5433
- **Code:** `/home/koi/koi-processor/`
- **Vault:** `/home/koi/gv-agent/vault/`
- **Key:** `/home/koi/koi-state/greater-victoria_private_key.pem`
- **Env:** `/home/koi/gv-agent/config/gv.env`
- **Logs:** `ssh root@37.27.48.12 "journalctl -u gv-koi-api -f"`
- **Firewall:** iptables `KOI_FEDERATION` chain on poly — only Octo + CV IPs can reach port 8351. Persistent via `netfilter-persistent`.
- **Version stamp:** `/home/koi/koi-processor/.version` (git SHA, stamped after each deploy)
- **Backups:** `gv-backup.timer` (daily 3am), `gv-backup-offhost.timer` (weekly Sun 4am → Octo). See Backups section.

### What's Left

Tracked in master plan `~/.claude/plans/octo-production-grade-master.md`. Current priority order:

1. **Manual post-deploy smokes** (operator-validated at convenience): Smoke 6 (Telegram interview flow), Smoke 7 (commons-web BFF), Smoke 8 (agentic crawl end-to-end — `/crawl_site https://example.com/` via Telegram)
2. **Sprint 5 — observability basics** (1-2 hr): alerting on OpenAI quota / 503 rates / koi-api errors. Today's mid-deploy quota exhaustion is proof this gap exists.
3. **Sprint 8 — cost telemetry** (3-4 hr): per-endpoint cost aggregation; addresses production-grade criterion #7.
4. **Sprint 6 — backup verification** (1-2 hr): exercise a restore from the daily backup onto a scratch DB; proves criterion #3.
5. **Sprint 7 — automated nightly eval** (2-3 hr): criterion #2.
6. **Sprint 14 — BKC facts extraction** (multi-day feature): option A2 from the unified-search architecture discussion.
7. **Sprint 4 / Tier 2a — fuzzy tuning** (multi-day): broader formal-prefixed false-merge protection beyond the commit-time rename guard.
8. **Dependency hygiene**: `google-cloud-aiplatform vs google-genai` pip warning; Sprint 1.5b's 4 residual spin-off plans (classifier-openai-quota, task-registry-null-due-date, unified-search-embedding-timeout, koi-flow-integration-module-path).
9. **`fix/deploy-sh-scripts-rsync`** (Octo repo, `6981a15`): still unmerged; rides whichever future deploy needs it.
10. **Indigenous Peoples ontology governance** (BKC foundations track, not code).

All production-grade criteria except #1 remain partially open; see master plan for scoring.

### New Node Onboarding (External — Fresh VPS)

For someone setting up their own BKC federation node on a new server:

```bash
# One-command bootstrap (installs Docker, clones repo, runs wizard)
curl -sSL https://raw.githubusercontent.com/BioregionalKnowledgeCommons/Octo/main/scripts/bootstrap.sh | bash
```

Everything runs in Docker — no Python/pip/venv on the host. The wizard handles database creation, migrations, keypair generation, workspace files, and federation connection.

See `docs/new-bioregion-quickstart.md` for the full guide.

### Adding a New Agent on the Octo Server

For adding a co-located agent on 45.132.245.30 (like FR):

```bash
# 1. Create database
ssh root@45.132.245.30 "bash ~/koi-stack/create-additional-dbs.sh cv_koi"

# 2. Create agent directory (follow gv-agent/ pattern)
ssh root@45.132.245.30 "mkdir -p ~/cv-agent/{config,workspace,vault}"

# 3. Create env file (copy gv.env, change DB_NAME, port, node name)

# 4. Create systemd service (copy gv-koi-api.service, change paths/ports)

# 5. Generate identity + configure edges

# 6. Seed entities
bash ~/scripts/seed-vault-entities.sh http://127.0.0.1:8354 ~/cv-agent/vault

# 7. Start and verify
systemctl start cv-koi-api
curl -s http://127.0.0.1:8354/health
```

## Session History

| Session ID | Date | Scope | Key Work |
|------------|------|-------|----------|
| `eca2a0ec` | 2026-02-08 | Holonic infra | Strategy docs, implementation plan, SSH setup, hyperlinks |
| `7aead4bb` | 2026-02-08 | Cleanup sprint | Fix deployment bugs, seed 70 entities, event_id confirm flow, architecture update (CV + FR), GitHub sensor plan (Phase 5.7) |
| `de8dd498` | 2026-02-25/26 | Convergence | KOI Runtime Convergence Plan: Phase 0 audit, Phase 0.5 contracts, Phase 1-2 implementation, Phase 3-5 scaffolding. |
| `eaecf381` | 2026-02-26 | Accelerated Rollout | Early soak close; FR canary/e2e PASS; FR + Octo convergence deploys; GV deferred on `/health`. |
| `45c44f93` | 2026-02-26 | Commons Intake Deploy | Full commons intake to all 3 nodes (migrations 053-054, async worker, merge review); GV `/health` resolved; Octo RID rotated; FR RID reconciliation; web dashboard deployed. |
| `a56e7930` | 2026-03-05 | Vault Auto-Notes | Auto-create vault .md notes during web ingest. `vault_note_utils.py`, `backfill_vault_notes.py`, web_router.py updated. Backfilled 16 entities. All 3 nodes deployed (pin `a54b626e`). |
| `0d84c823` | 2026-03-06 | MediaWiki Import v1 | Salish Sea Wiki graph densification: parser, dump reader, bulk importer, migration 063. Pilot 50 pages → 319 entities created, 565 edges. Entity count 70→~1,005. Three confidence tiers + editorial edges. Deployed to Octo production. |
| `d7a4d981` | 2026-03-06 | MediaWiki v3 Deploy | Live sync sensor: commit v3 on feat/mediawiki-import, merge to regen-prod, bump vendor pin to `698b5042`, deploy to Octo. Sensor polling every 5 min. 2,722 entities, 5,123 vault pages live on salishsee.life. |
| | 2026-04-19/20 | Phase 4 live deploy + rename guard | Phase 4 end-to-end deploy (koi-processor `b372f66c`): agentic crawl flag flipped, canary job 1 + peninsula job 7 committed, 3 Phase-1/2 hotfixes (raw_html, proxy retry, deferred OCR), rename-time fuzzy false-merge defect remediated (Part A SQL: +7 municipality RIDs, +6 edges, 1 retarget; Part B code: skip_fuzzy guard on renamed unresolved entities). Phase 4 closed from production-safety standpoint. |
| | 2026-04-20 | Phase 4 tails cleanup | 3 dead-test deletions (audio_pipeline, quality_control, integration_test) + 4 test-file fixes + poly capacity note written (later corrected — see embedding switch row). Zero collection errors achieved. `regen-prod` advanced to `3eefd07b`. |
| | 2026-04-21 | Octo embedding switch (OpenAI) | Switched Octo runtime from poly-qwen3 to OpenAI `text-embedding-3-large` @ dim=1024 (pin `adcf26ed`). One-time re-embed: 2,839 entities + 3,675 chunks via OpenAI direct ($0.17, ~45s). 10 NULL entities + 42 NULL chunks (incl. 7 peninsula municipality RIDs) embedded as side-effect. Corrected prior "poly idle" finding: poly was actually at 85% 503 rate (12k req/day from Octo). Poly now serves FR/GV/personal-KOI only. Full 100q eval: CR +5.2%, AR +3.8%, F flat, all 6 categories improved, no regressions. Eval baselines archive established at `tests/eval/baselines/`. 4 residual branches land on feature branches (not merged/deployed). |
| | 2026-04-21 | Runtime test health sweep + classifier triage | 47 pre-existing test failures + 2 collection errors triaged: 7 fixed, 2 skip-marked with spin-off plans, 3 dead-code deletions cherry-picked. Per-file decisions documented. `regen-prod` advanced to `3eefd07b`. Production-grade master plan drafted at `~/.claude/plans/octo-production-grade-master.md`. |
| | 2026-04-22 | Production-grade push (Sprints 1 / 2a / 3 / 13 / 1.5a) | **Sprint 1 PARTIAL**: 3-of-4 residual branches merged to regen-prod (`655e3f0e`); Octo-repo pin-bump + `fix/deploy-sh-scripts-rsync` merge rolled back cleanly after discovering (a) pip resolver pathology on the target venv (30+ min hang → `resolution-too-deep`), (b) an unreviewed claims-auth ride-along (`4f67ff6a + 8d75e8e3`) in the pin-bump range. Stashed `deploy.sh` pip-filter WIP preserved as `stash@{0}`. **Sprint 2a COMPLETE**: unified-search `knowledge_facts` runtime gate merged (`380f47a8`) — fixes production 500 on `/knowledge/unified-search` for bioregional nodes without the facts table. 6/6 new tests pass; gate mirrors existing `to_regclass()` pattern from `personal_ingest_api.py:1283`. **Sprint 3 COMPLETE (Path B)**: classifier regression harness unskipped via refreshed baselines (thematic_5..10 accepted as legitimate relabels), commitment_claim_7 isolated as real regression with new spin-off plan, 2 Phase 5b "still wrong" cases encoded as xfail, per-case matrix test added, merged (`704e5c94`). **Sprint 1.5a COMPLETE**: pip resolver pathology fixed via 2-line change — `openai==2.17.0` (eliminates 150+-version backtracking) + drop `[fetchers]` extra from `scrapling>=0.4` (resolves fastapi-anyio conflict). Install time 30+min-hang → 27s local / 57s server. Merged (`0217a562`). **Full-suite discovery**: 47 net-new failures on regen-prod since 2026-04-21 sweep, dominated by `test_claims_attestations` + `test_claims_reconcile` (claims-auth 401) + `test_contract::test_entity_resolve_response_shape`. All pre-existing, not introduced by today's work. **Expands Sprint 1.5b scope**: deployment review covers claims-auth + OAuth + 47-failure test triage. **No Octo deploy today.** Server remains at pin `adcf26ed`. |
| `17370f92` | 2026-04-22/23 | Sprint 2b coordinated Octo deploy | Pre-deploy audit confirmed `regen-prod` frozen at `08594441`, 36 commits reviewed with 0 SURPRISE, migration `088_auth_requests_callback_url.sql` out-of-manifest/no-op, and all service-token env files populated. Backup `/root/backups/pre-sprint-2b-20260422-232905.sql.gz` (`79M`) captured before deploy. Pin bump committed as `c4b9b24` on `deploy/sprint-2b-octo`; dry-run clean; live `./deploy.sh --target octo` completed in ~1 minute. `koi-api` and root user `openclaw-gateway` healthy after restart. Automated smokes passed for `/web/preview`, `/knowledge/episodes`, `/knowledge/unified-search`, and claims-auth (`401` without auth / `422` with service token). Immediate post-deploy OpenAI quota failures were confirmed pre-existing; after credit top-up, `/diagnostics/embedding-preflight` returned `overall_pass=true` and `/chat` returned `200`. Octo now runs pin `08594441`. All 14 Sprint 2b ACs pass. Production-grade criterion #1 (known production bugs fixed) closed. |
| `7d416a87` | 2026-04-30 / 2026-05-02 | Attribution arc | **Two-day arc fixing chat citation behavior + Quartz source attribution.** Day 1: octo-chat parse bug fixed (stdout preamble + provider-error fallback + `classifyError` wiring); OpenAI key rotated after exposure incident, propagated to `personal.env`+`bioregional-commons-web/.env.local`+`celo-scripts/.env`+`fr-agent/fr.env`; openclaw model switched `nvidia-build/moonshotai/kimi-k2.5` (HTTP 410, dead) → `openai/gpt-4o-mini` → `openai/gpt-4.1-mini`; new `koi_chat` tool added to `bioregional-koi` plugin wrapping `POST /chat`; TOOLS.md tightened (never fabricate URLs, prefer Quartz over external); `QUARTZ_BASE_URL=salishsee.life`; wiki-source attribution backfill — 875 unique vault notes carry `source_url`/`source_name`/`source_license: "CC-BY-SA 3.0 Unported"`/`source_license_url`; `SourceAttribution` Quartz component (gated on `source_url` OR `@type: schema:WebPage` + `url`) renders footer on wiki AND web-ingest pages; Anthropic key rotated + drop-in disabled; `OPENCLAW_GATEWAY_TOKEN` rotated; weekly cron `30 4 * * 1 run_wiki_attribution_backfill.sh` for forward coverage. Day 2: hygiene cleanup (model registry pruned, `nvidia-env` removed); 17 missing-file rows fixed via `sanitize_filename` mirroring; **citation-policy fixes** in `personal_ingest_api.py` — entity_block now emits `[Name](quartz_url) (Type)` markdown links; doc_block `wiki_url` stripped from prompt context; deterministic server-side `## Related on Octo` block appended to every `/chat` answer (drawn from sources with non-null `quartz_url`, capped at 6, suppressed on refusals); **text_search bundle quartz_url enrichment** (`api/retrieval_executors.py`) — new `_lookup_chunk_quartz_urls` helper joins `mediawiki_page_state → entity_registry`, batch lookup; `text_search` accepts `quartz_url_fn` kwarg; `evidence_bundles_to_legacy_format` propagates `quartz_url` on LOCAL_DOCUMENT bundles too; `plan_executor.py` threads `quartz_url_fn` through. Verification sweep: orcas/salmon/non-wiki/refusal all behave as designed; salmon Related-on-Octo now mixes Concept/Practice/Organization/**Project** (the new enrichment win); latency delta ~70ms within 100ms gate. Plans + scripts + components mirrored to `docs/sessions/2026-05-attribution-arc/`. **5b parking-lot**: vault-stub creation for high-mention entities with no vault note (e.g. `River Delta Use By Salmon`). **Federation propagation parked** with explicit un-park triggers (peer Quartz site goes live OR new license terms enter the corpus). All edits server-side at `/root/koi-processor/` and `/root/octo-quartz/` with `.bak-<timestamp>` rollback files; canonical `koi-processor` repo not yet bumped (operator call). |
