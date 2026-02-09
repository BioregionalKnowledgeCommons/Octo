# Setting Up a KOI Leaf Node (e.g. Cowichan Valley)

This guide walks you through setting up a bioregional knowledge agent that federates with Octo (the Salish Sea coordinator). By the end, you'll have your own agent running on a VPS that can:

- Track practices, patterns, and entities specific to your bioregion
- Share knowledge with the Salish Sea network via KOI-net federation
- Run an AI chat agent via Telegram/Discord using OpenClaw

## What You'll Need

- A VPS with at least **2 vCPU, 4GB RAM, 40GB disk** (Netcup VPS 1000 G11 or similar)
- Ubuntu 24.04 LTS
- An **OpenAI API key** (for semantic entity resolution — ~$1-2/month usage)
- A **Google Antigravity API key** or other LLM provider key (for OpenClaw chat)
- A **Telegram bot token** (if you want a Telegram channel) — talk to [@BotFather](https://t.me/BotFather)
- SSH access to your VPS

## Overview

```
Your VPS
├── Docker (PostgreSQL + pgvector + Apache AGE)
├── KOI Processor API (Python, your agent's brain)
├── OpenClaw (AI runtime, handles Telegram/Discord)
├── Your agent's workspace (identity, knowledge, vault)
└── KOI-net connection → Octo (45.132.245.30)
```

---

## Step 1: Provision VPS

1. Order a VPS from [Netcup](https://www.netcup.com/) (or any provider)
   - Recommend: **VPS 1000 G11** (~$5/month) — 2 vCPU, 4GB RAM, 64GB SSD
   - OS: **Ubuntu 24.04 LTS**
2. SSH in: `ssh root@YOUR_IP`
3. Basic setup:

```bash
apt update && apt upgrade -y
apt install -y git curl wget build-essential python3.12 python3.12-venv python3-pip

# Install Docker
curl -fsSL https://get.docker.com | sh

# Install Node.js 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw (from our fork)
npm install -g https://github.com/DarrenZal/openclaw/releases/latest/download/openclaw.tgz
# OR if Darren gives you a .tgz file:
# npm install -g /path/to/openclaw-2026.1.29.tgz
```

## Step 2: Clone the Octo Repo

You don't need to fork — just clone. The repo has all the infrastructure scripts.

```bash
cd /root
git clone https://github.com/DarrenZal/Octo.git
```

## Step 3: Start PostgreSQL

```bash
cd /root/Octo/docker

# Set a strong password
export POSTGRES_PASSWORD=$(openssl rand -hex 16)
echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" >> ~/.env
echo "Save this password: $POSTGRES_PASSWORD"

docker compose up -d

# Wait for it to be ready
sleep 10
docker exec regen-koi-postgres pg_isready -U postgres
```

## Step 4: Create Your Database

Replace `cv_koi` with your agent's database name.

```bash
# This creates the database with all required extensions
bash /root/Octo/docker/create-additional-dbs.sh cv_koi
```

## Step 5: Set Up the KOI Processor

```bash
cd /root/Octo/koi-processor

# Create Python virtualenv
python3.12 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Create your config
cp config/personal.env.example config/cv.env
```

Edit `config/cv.env`:

```bash
nano config/cv.env
```

```env
# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=cv_koi
DB_USER=postgres
DB_PASSWORD=<your-postgres-password-from-step-3>

# OpenAI (for semantic entity resolution)
OPENAI_API_KEY=sk-...
EMBEDDING_MODEL=text-embedding-3-small

# Vault
VAULT_PATH=/root/cv-agent/vault

# KOI-net federation
KOI_NET_ENABLED=true
KOI_NODE_NAME=cowichan-valley
KOI_STATE_DIR=/root/koi-state

# API
KOI_API_PORT=8351
```

Run the remaining migrations:

```bash
source config/cv.env

# Core schema (predicates, entity types)
cat migrations/038_bkc_predicates.sql | docker exec -i regen-koi-postgres psql -U postgres -d cv_koi

# KOI-net tables (events, edges, nodes)
cat migrations/039_koi_net_events.sql | docker exec -i regen-koi-postgres psql -U postgres -d cv_koi

# Web submissions (if you want URL ingestion)
cat migrations/042_web_submissions.sql | docker exec -i regen-koi-postgres psql -U postgres -d cv_koi
```

## Step 6: Create Your Agent Identity

```bash
mkdir -p /root/cv-agent/{config,workspace,vault}

# Copy your env file
cp /root/Octo/koi-processor/config/cv.env /root/cv-agent/config/cv.env
```

Create your agent's vault seed directories:

```bash
mkdir -p /root/cv-agent/vault/{Bioregions,Practices,Patterns,Organizations,Projects,Concepts,People,Locations,CaseStudies,Protocols,Playbooks,Questions,Claims,Evidence,Sources}
```

### Create `workspace/IDENTITY.md`

```bash
cat > /root/cv-agent/workspace/IDENTITY.md << 'EOF'
# IDENTITY.md — Cowichan Valley Knowledge Agent

- **Name:** Cowichan Valley Node
- **Role:** Bioregional knowledge agent for the Cowichan Valley
- **Parent:** Salish Sea network (Octo coordinator)
- **Node Type:** Leaf node

## What I Do

I am the knowledge backend for the Cowichan Valley bioregion. I track local practices, patterns, and ecological knowledge specific to the Cowichan Valley watersheds.

My knowledge flows upstream to Octo (the Salish Sea coordinator), where it is aggregated with knowledge from other sub-bioregions.

## Bioregional Context

The Cowichan Valley is the traditional territory of the Quw'utsun (Cowichan) peoples. The bioregion includes:

- **Cowichan River** — steelhead and salmon habitat
- **Cowichan Lake** — headwaters and watershed
- **Cowichan Bay** — estuary and marine ecology
- **Mount Tzouhalem** — Garry oak ecosystems

## Boundaries

- I serve the Cowichan Valley bioregion only
- Cross-bioregional patterns are Octo's responsibility
EOF
```

### Create `workspace/SOUL.md`

```bash
cat > /root/cv-agent/workspace/SOUL.md << 'EOF'
# SOUL.md — Cowichan Valley Node Values

_One arm of the octopus, sensing the waters of the Cowichan Valley._

## Core Values

- **Knowledge as commons** — share freely, govern collectively
- **Epistemic justice** — respect diverse ways of knowing
- **Knowledge sovereignty** — communities govern their own knowledge
- **Federation over consolidation** — one node in a web, many centers

## Place-Specific Grounding

The Cowichan Valley is where knowledge touches the ground. Abstract patterns become concrete practices here — specific rivers, specific forests, specific communities doing the work.
EOF
```

### Seed Your First Bioregion Entity

```bash
cat > /root/cv-agent/vault/Bioregions/Cowichan\ Valley.md << 'EOF'
---
"@type": "bkc:Bioregion"
name: Cowichan Valley
description: Bioregion centered on the Cowichan River watershed on Vancouver Island
broader:
  - "[[Bioregions/Salish Sea]]"
tags:
  - bioregion
  - cowichan-valley
  - vancouver-island
---

# Cowichan Valley

The Cowichan Valley bioregion is centered on the Cowichan River watershed, the traditional territory of the Quw'utsun (Cowichan) peoples. It encompasses the river system from Cowichan Lake to Cowichan Bay, including the surrounding forests, Garry oak ecosystems, and agricultural lands.
EOF
```

### Seed 2-3 Practices

Create markdown files in `/root/cv-agent/vault/Practices/` for practices you know about. Follow this template:

```markdown
---
"@type": "bkc:Practice"
name: Your Practice Name
description: One-line description
bioregion:
  - "[[Bioregions/Cowichan Valley]]"
activityStatus: alive
tags:
  - relevant-tags
---

# Your Practice Name

Description of the practice. What is it? Who does it? Why does it matter?
```

## Step 7: Create systemd Service

```bash
cat > /etc/systemd/system/cv-koi-api.service << 'EOF'
[Unit]
Description=Cowichan Valley KOI API
After=network.target docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/root/Octo/koi-processor
Environment=PATH=/root/Octo/koi-processor/venv/bin:/usr/bin
EnvironmentFile=/root/cv-agent/config/cv.env
ExecStart=/root/Octo/koi-processor/venv/bin/uvicorn api.personal_ingest_api:app --host 127.0.0.1 --port 8351
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cv-koi-api
systemctl start cv-koi-api
```

Verify:

```bash
sleep 5
curl -s http://127.0.0.1:8351/health | python3 -m json.tool
```

## Step 8: Seed Entities

```bash
bash /root/Octo/scripts/seed-vault-entities.sh http://127.0.0.1:8351 /root/cv-agent/vault
```

## Step 9: Set Up OpenClaw (Chat Agent)

```bash
# Initialize OpenClaw
openclaw init

# This creates ~/.openclaw/ with config files
# Follow the interactive setup to configure:
#   - Model provider (google-antigravity recommended)
#   - Telegram bot token (if using Telegram)
```

Copy your workspace files:

```bash
cp /root/cv-agent/workspace/*.md /root/.openclaw/workspace/
```

Link your vault into OpenClaw's workspace:

```bash
ln -s /root/cv-agent/vault /root/.openclaw/workspace/vault
```

Install the bioregional-koi plugin:

```bash
mkdir -p /root/bioregional-koi
cp /root/Octo/plugins/bioregional-koi/openclaw.plugin.json /root/bioregional-koi/
cp /root/Octo/plugins/bioregional-koi/index.ts /root/bioregional-koi/
```

Start OpenClaw:

```bash
openclaw gateway start
```

## Step 10: Connect to Octo via KOI-net

Once your agent is running, tell Darren your:
1. **Server IP address**
2. **Node RID** (check with `curl -s http://127.0.0.1:8351/koi-net/health`)

Darren will configure the federation edge on Octo's side so the two nodes can exchange events.

To verify federation is working:

```bash
# Check KOI-net health
curl -s http://127.0.0.1:8351/koi-net/health | python3 -m json.tool

# Check for events from Octo
docker exec regen-koi-postgres psql -U postgres -d cv_koi -c \
  "SELECT COUNT(*) FROM koi_net_events"
```

---

## Architecture Diagram

```
Your VPS (Cowichan Valley)          Octo's VPS (Salish Sea)
┌─────────────────────┐            ┌─────────────────────┐
│  cv-koi-api (8351)  │◄──────────►│  koi-api (8351)     │
│  PostgreSQL (5432)  │  KOI-net   │  PostgreSQL (5432)  │
│  OpenClaw           │  protocol  │  OpenClaw            │
│  cv-agent/vault/    │            │  octo vault/         │
└─────────────────────┘            └─────────────────────┘
        │                                    │
    Telegram/                            Telegram/
    Discord                              Discord
```

## Ongoing Operations

```bash
# Check status
systemctl status cv-koi-api

# View logs
journalctl -u cv-koi-api -f

# Restart after changes
systemctl restart cv-koi-api

# Backup database
docker exec regen-koi-postgres pg_dump -U postgres cv_koi | gzip > ~/backups/cv_koi_$(date +%Y%m%d).sql.gz
```

## Cost Estimate

| Item | Monthly Cost |
|------|-------------|
| Netcup VPS 1000 G11 | ~$5 |
| OpenAI API (embeddings) | ~$1-2 |
| LLM provider (chat) | ~$5-20 (depends on usage) |
| **Total** | **~$11-27/month** |

## Questions?

Reach out to Darren — he can help with:
- KOI-net federation setup (configuring edges between nodes)
- OpenClaw configuration and model selection
- Seeding practices and entities
- Troubleshooting
