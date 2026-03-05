# New Bioregion Quick-Start Guide

> **Audience:** Someone setting up their first BKC node. Total time: ~30 minutes.
> **Full reference:** [`join-the-network.md`](./join-the-network.md) (covers everything in depth)
> **Last updated:** 2026-03-05

---

## Overview

You're setting up a **KOI node** — a bioregional knowledge backend with a PostgreSQL knowledge graph, entity resolution, and federation. Your node will store local knowledge (practices, patterns, case studies) and exchange events with the wider BKC network via signed envelopes.

Everything runs in Docker — no Python, pip, or virtualenv setup needed on the host.

## Governance Prep (1–2 hours, before touching servers)

Before technical setup, define what your bioregion is commoning. Copy the governance template from GitHub:

- **[Pilot template directory](https://github.com/BioregionalKnowledgeCommons/BioregionalKnowledgeCommoning/tree/main/pilots/template-regional-pilot)** — 6 files to fill in
- **[Front Range example](https://github.com/BioregionalKnowledgeCommons/BioregionalKnowledgeCommoning/tree/main/pilots/front-range-cascadia-2026)** — a completed pilot for reference

Key files to fill in:
1. **`pilot-charter.md`** — bioregion name, objective, co-stewards, participation profile
2. **`tooling-and-authority-map.md`** — what is shared, who attests, who can use/how
3. **`decision-log.md`** — start empty, record decisions as you go

You don't need to finish everything — a rough charter is enough to start.

## Prerequisites

| Item | Details |
|------|---------|
| **VPS** | Any Linux VPS with 2+ vCPU, 4GB+ RAM. Netcup VPS 1000 G11 (~$5/mo), Hetzner, DigitalOcean, etc. |
| **SSH access** | Root or sudo on the VPS |
| **Embedding provider** | OpenAI API key (~$1–2/mo), local Ollama, or skip. Optional — node works without it. |
| **Budget** | ~$5–7/mo (VPS only) |

## Step 1: Bootstrap (5 min)

SSH into your VPS and run the one-command bootstrap:

```bash
curl -sSL https://raw.githubusercontent.com/BioregionalKnowledgeCommons/Octo/main/scripts/bootstrap.sh | bash
```

This installs Docker and git (if needed), clones the Octo repo, and launches the setup wizard.

Or do it manually:

```bash
# Install Docker (if not already installed)
curl -fsSL https://get.docker.com | sh

# Clone the repo
git clone https://github.com/BioregionalKnowledgeCommons/Octo.git
cd Octo

# Run the wizard
bash scripts/setup-node.sh
```

## Step 2: Setup Wizard (10 min)

The wizard walks you through everything interactively:

1. **Node name** — e.g. "Salt Spring Island", "Cowichan Valley"
2. **Derived config** — confirms database, directory, slug, port (Y to accept)
3. **Node type** — leaf node (recommended), peer network, or personal/research
4. **Embedding provider** — OpenAI (recommended), Ollama (free/local), or skip
5. **Federation** — connect to the BKC network (recommended)

The wizard automatically:
- Builds and starts Docker containers (PostgreSQL + KOI API)
- Creates your database with all extensions (pgvector, Apache AGE)
- Runs all migrations (70+)
- Generates ECDSA keypair and node identity (Node RID)
- Creates workspace files (IDENTITY.md, SOUL.md)
- Seeds a bioregion entity
- Connects to the Salish Sea federation (optional)

## Step 3: Customize Your Node (15 min)

Edit workspace files to give your agent its identity:

```bash
nano ~/your-node/workspace/IDENTITY.md   # Who is your agent?
nano ~/your-node/workspace/SOUL.md       # What values guide it?
```

Add practices to your vault:

```bash
nano ~/your-node/vault/Practices/My Practice.md
```

Use this template:

```yaml
---
"@type": "bkc:Practice"
name: Salmon Habitat Restoration
description: Community-led stream restoration for salmon spawning habitat
bioregion:
  - "[[Bioregions/Your Bioregion]]"
activityStatus: alive
tags:
  - salmon
  - restoration
---

# Salmon Habitat Restoration

Description of the practice. What is it? Who does it? Why does it matter?
```

## Step 4: Knowledge Site (Optional, 5 min)

The setup wizard offers to deploy a Quartz knowledge site — a browsable static site with full-text search, graph view, backlinks, and an optional chat widget.

If you skipped it during setup, run it standalone:

```bash
bash scripts/setup-quartz.sh \
  --node-name "Your Bioregion" \
  --node-slug "your-bioregion" \
  --node-dir "$HOME/your-bioregion"
```

The script handles: Quartz clone, config generation, npm install, initial build, nginx setup, optional TLS, and cron auto-rebuild (every 15 minutes).

To customize, edit your vault's landing page and the generated config:

```bash
nano ~/your-node/vault/index.md           # landing page content
nano ~/your-node-quartz/quartz.config.ts   # site title, theme, plugins
```

## Step 5: Federation (done by wizard)

If you chose to federate during setup, the wizard already:
1. Registered the coordinator (Octo) as a known peer
2. Created a POLL edge (your node polls the coordinator)
3. Sent a handshake to the coordinator
4. Printed **reciprocal SQL** for the coordinator to run

**Send the reciprocal SQL block to the coordinator** (Darren). Once they run it, knowledge flows both ways.

To connect to additional peers later:

```bash
bash scripts/connect-koi-peer.sh --db your_db --peer-url http://peer-ip:8351
```

## You're Done When...

```bash
# 1. Health check — should return {"status":"healthy", ...}
curl -s http://127.0.0.1:8351/health | python3 -m json.tool

# 2. KOI-net health — should show your node_rid and peers
curl -s http://127.0.0.1:8351/koi-net/health | python3 -m json.tool

# 3. Entity count — should be > 0
docker exec regen-koi-postgres psql -U postgres -d YOUR_DB \
  -c "SELECT count(*) FROM entity_registry;"
```

## Managing Your Node

```bash
cd ~/Octo/docker
docker compose logs -f koi-api    # watch logs
docker compose restart koi-api    # restart API
docker compose down               # stop everything
docker compose up -d              # start everything
```

## Top 5 First-Timer Issues

| Problem | Fix |
|---------|-----|
| Docker build fails | Run `docker compose build --no-cache` in `~/Octo/docker` |
| API won't start | `docker compose logs koi-api` — check for missing env vars or DB connection |
| Federation not connecting | Firewall open? `KOI_BASE_URL` correct? `ufw allow 8351` |
| Entity resolution weak | Add `OPENAI_API_KEY` to `~/.env` and restart containers |
| Lost private key | Restore from `koi-state/` — **back up early**, the key is your node identity |

Full troubleshooting: [`join-the-network.md` § Troubleshooting](./join-the-network.md#troubleshooting)

## Practice Note Template

See [`vault-seed/TEMPLATES/Practice-template.md`](../vault-seed/TEMPLATES/Practice-template.md) for the full annotated template. All YAML field names (`bioregion`, `aggregatesInto`, `parentOrg`) are parsed by `vault_parser.py` and mapped to ontology predicates.
