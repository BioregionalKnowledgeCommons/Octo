-- 057_commitment_pools.sql
-- CommitmentPool tables: aggregation of commitments with threshold mechanics
-- and pool-level governance.
--
-- NOTE: Run AFTER 056_commitment_registry.sql. The FK from commitments.pool_id
-- to commitment_pools.id is added at the end of this file (after both tables exist).

CREATE TABLE IF NOT EXISTS commitment_pools (
    id              SERIAL PRIMARY KEY,
    pool_rid        TEXT UNIQUE NOT NULL,          -- KOI RID for federation
    name            TEXT NOT NULL,
    description     TEXT,
    steward_uri     TEXT,                          -- entity_registry.fuseki_uri of governing org/bioregion
    bioregion_uri   TEXT,                          -- entity_registry.fuseki_uri of associated Bioregion
    activation_threshold_pct NUMERIC DEFAULT 80,  -- % of pledges that must be VERIFIED to activate
    activation_threshold_count INTEGER,            -- Absolute count alternative (NULL = use pct)
    demurrage_rate_monthly NUMERIC DEFAULT 0,      -- Optional: monthly decay rate (0 = disabled)
    state           TEXT NOT NULL DEFAULT 'forming', -- forming | active | suspended | closed
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_by      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Pool activation events (insert-only audit log)
CREATE TABLE IF NOT EXISTS commitment_pool_events (
    id          SERIAL PRIMARY KEY,
    pool_rid    TEXT NOT NULL,
    event_type  TEXT NOT NULL, -- 'created' | 'pledge_added' | 'threshold_reached' | 'activated' | 'suspended' | 'closed'
    actor       TEXT,
    payload     JSONB DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Additional predicates for pool entities
INSERT INTO allowed_predicates (predicate, description, subject_types, object_types)
VALUES
    ('aggregates_commitments', 'CommitmentPool contains and aggregates individual pledges',
        ARRAY['CommitmentPool'], ARRAY['Commitment']),
    ('governs_pool', 'Organization or Bioregion stewards a CommitmentPool',
        ARRAY['Organization','Bioregion'], ARRAY['CommitmentPool'])
ON CONFLICT (predicate) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pools_state       ON commitment_pools(state);
CREATE INDEX IF NOT EXISTS idx_pools_bioregion   ON commitment_pools(bioregion_uri);
CREATE INDEX IF NOT EXISTS idx_pool_events_rid   ON commitment_pool_events(pool_rid);
CREATE INDEX IF NOT EXISTS idx_pool_events_type  ON commitment_pool_events(event_type);

-- Add FK from commitments.pool_id → commitment_pools.id (both tables now exist)
ALTER TABLE commitments
    ADD CONSTRAINT fk_commitments_pool
    FOREIGN KEY (pool_id) REFERENCES commitment_pools(id) ON DELETE SET NULL;

-- Register migration
INSERT INTO koi_migrations (migration_id, checksum)
VALUES ('bkc:057_commitment_pools', 'manual')
ON CONFLICT (migration_id) DO NOTHING;
