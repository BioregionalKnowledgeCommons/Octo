# Octo 🐙

**A bioregional knowledge commoning agent for the Salish Sea**

Octo is an AI agent built on [OpenClaw](https://github.com/openclaw/openclaw) that serves as an organ of perception for the Salish Sea bioregion. It combines a knowledge graph backend with a formal ontology for bioregional knowledge commoning — enabling it to reason about practices, patterns, discourse, and the relationships between them.

## What Octo Does

- **Knowledge Commoning**: Tracks bioregional practices, identifies trans-bioregional patterns, and documents case studies using a formal ontology grounded in the work of David Bollier & Silke Helfrich
- **Discourse Graph**: Manages questions, claims, and evidence with typed relationships (supports, opposes, informs) — enabling progressive formalization of bioregional knowledge
- **Entity Resolution**: Multi-tier entity resolution (exact → fuzzy → semantic → create) with OpenAI embeddings and pgvector
- **Vault Integration**: Bidirectional linking between an Obsidian-style vault and a PostgreSQL knowledge graph

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  OpenClaw Runtime                  │
│  (Telegram / Discord / CLI)                       │
├──────────────────────────────────────────────────┤
│  Workspace: IDENTITY.md, SOUL.md, KNOWLEDGE.md   │
├──────────────────────────────────────────────────┤
│  bioregional-koi plugin                           │
│  ├─ Entity resolution (resolve, register, search) │
│  ├─ Vault read/write                              │
│  └─ Relationship sync                             │
├──────────────────────────────────────────────────┤
│  KOI Processor API (uvicorn, port 8351)           │
│  ├─ entity_schema.py  (15 entity types)           │
│  ├─ vault_parser.py   (27 predicates, aliases)    │
│  └─ personal_ingest_api.py                        │
├──────────────────────────────────────────────────┤
│  PostgreSQL + pgvector + Apache AGE               │
│  (Docker, localhost:5432)                         │
└──────────────────────────────────────────────────┘
```

## BKC Ontology

The formal ontology (`ontology/bkc-ontology.jsonld`) defines 9 entity types and 17 predicates for bioregional knowledge commoning:

### Entity Types

| Phase | Type | Description |
|-------|------|-------------|
| **Knowledge Commoning** | Practice | Bioregional-specific activity or approach |
| | Pattern | Trans-bioregional generalization from practices |
| | CaseStudy | Documented real-world example |
| | Bioregion | Named ecological/cultural region |
| **Discourse Graph** | Protocol | General coordination pattern |
| | Playbook | Local implementation of a protocol |
| | Question | Inquiry or hypothesis |
| | Claim | Assertion or conclusion |
| | Evidence | Data, observations, or results |

Plus 6 base types inherited from the KOI system: Person, Organization, Project, Location, Concept, Meeting.

### Key Predicates

**Knowledge Commoning**: `aggregates_into` (Practice → Pattern), `suggests` (Pattern → Practice), `documents` (CaseStudy → Practice), `practiced_in` (Practice → Bioregion)

**Discourse Graph**: `supports`, `opposes`, `informs`, `generates`, `implemented_by`, `synthesizes`, `about`

**SKOS + Hyphal**: `broader`, `narrower`, `related_to`, `forked_from`, `builds_on`, `inspired_by`

See [ontology/bkc-ontology.jsonld](ontology/bkc-ontology.jsonld) for the formal OWL/RDFS definitions.

## Repository Structure

```
├── workspace/              # OpenClaw workspace files (agent identity & config)
│   ├── IDENTITY.md         # Who Octo is
│   ├── SOUL.md             # Philosophy and values
│   ├── KNOWLEDGE.md        # BKC domain expertise
│   ├── USER.md             # About the human operator
│   ├── AGENTS.md           # Agent routing and session rules
│   ├── TOOLS.md            # Environment-specific tool config
│   └── HEARTBEAT.md        # Periodic check tasks
├── plugins/
│   └── bioregional-koi/    # OpenClaw plugin connecting to KOI API
│       ├── openclaw.plugin.json
│       └── index.ts
├── koi-processor/          # Python backend (entity resolution + vault sync)
│   ├── api/
│   │   ├── personal_ingest_api.py
│   │   ├── entity_schema.py
│   │   └── vault_parser.py
│   ├── config/
│   │   └── personal.env.example
│   ├── migrations/
│   │   └── 038_bkc_predicates.sql
│   └── requirements.txt
├── docker/                 # PostgreSQL stack with pgvector + Apache AGE
│   ├── docker-compose.yml
│   ├── Dockerfile.postgres-age
│   └── init-extensions.sql
├── ontology/               # Formal BKC ontology (JSON-LD)
│   └── bkc-ontology.jsonld
├── vault-seed/             # Seed entity notes exercising the full predicate chain
│   ├── Bioregions/
│   ├── Practices/
│   ├── Patterns/
│   ├── CaseStudies/
│   ├── Questions/
│   ├── Claims/
│   ├── Evidence/
│   ├── Protocols/
│   └── Playbooks/
└── systemd/                # Service definitions
    └── koi-api.service
```

## Deployment

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and configured
- Docker and Docker Compose
- Python 3.12+
- An OpenAI API key (for semantic entity resolution)

### Quick Start

1. **Clone and configure**
   ```bash
   git clone https://github.com/DarrenZal/Octo.git
   cd Octo
   cp koi-processor/config/personal.env.example koi-processor/config/personal.env
   # Edit personal.env with your credentials
   ```

2. **Start PostgreSQL stack**
   ```bash
   cd docker
   docker compose up -d
   ```

3. **Set up KOI Processor**
   ```bash
   cd koi-processor
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

4. **Run database migration**
   ```bash
   cat migrations/038_bkc_predicates.sql | docker exec -i <postgres-container> psql -U postgres -d octo_koi
   ```

5. **Start the API**
   ```bash
   source config/personal.env
   uvicorn api.personal_ingest_api:app --host 127.0.0.1 --port 8351
   ```

6. **Install workspace files**
   ```bash
   cp workspace/* ~/.openclaw/workspace/
   ```

7. **Seed the vault**
   ```bash
   cp -r vault-seed/* ~/.openclaw/workspace/vault/
   ```

8. **Verify**
   ```bash
   curl http://localhost:8351/health
   # Should show 15 entity types, 27 predicates
   ```

## Context

Octo is the agent of the [BKC CoIP](https://www.r3-0.org/bkc-coip/) (Bioregional Knowledge Commons Community of Inquiry & Practice) — a collaborative initiative focused on building shared knowledge infrastructure for bioregional organizing worldwide.

The ontology is grounded in:
- **Bollier & Helfrich** — *Free, Fair & Alive* (pattern mining from commoning practices)
- **Joel Chan** — Discourse Graphs (progressive formalization: Question → Claim → Evidence)
- **OpenCivics** — Protocol/Playbook extension (general patterns + local implementations)
- **SKOS** — Concept hierarchies (broader/narrower/related)
- **Hyphal Tips** — Genealogical relationships (forked_from, builds_on, inspired_by)

## License

MIT
