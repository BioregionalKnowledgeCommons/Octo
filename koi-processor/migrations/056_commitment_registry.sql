-- 056_commitment_registry.sql
-- Commitment entity registry: individual pledges with lifecycle state machine.
-- Models Community Asset Vouchers (CAVs) as first-class KOI entities.

-- Commitment lifecycle states
CREATE TYPE IF NOT EXISTS commitment_state AS ENUM (
    'PROPOSED',        -- Pledge submitted, awaiting steward review
    'VERIFIED',        -- Steward approved the pledge
    'ACTIVE',          -- Pool threshold met; commitment is routable
    'EVIDENCE_LINKED', -- Fulfillment evidence attached
    'REDEEMED',        -- Commitment fully fulfilled and verified
    'REJECTED',        -- Steward rejected the pledge
    'WITHDRAWN',       -- Pledger withdrew the commitment
    'DISPUTED',        -- Formal dispute raised against this commitment
    'RESOLVED'         -- Dispute resolved (may end in REDEEMED or REJECTED)
);

CREATE TABLE IF NOT EXISTS commitments (
    id              SERIAL PRIMARY KEY,
    commitment_rid  TEXT UNIQUE NOT NULL,          -- KOI RID for federation
    pledger_uri     TEXT NOT NULL,                 -- entity_registry.fuseki_uri of pledger
    pool_id         INTEGER REFERENCES commitment_pools(id) ON DELETE SET NULL,
    title           TEXT NOT NULL,                 -- Short description of the pledge
    description     TEXT,                          -- Full pledge description
    offer_type      TEXT NOT NULL DEFAULT 'labor', -- labor | goods | service | knowledge | stewardship
    quantity        NUMERIC,                       -- Optional: units promised
    unit            TEXT,                          -- e.g. 'hours', 'kg', 'sessions'
    validity_start  TIMESTAMPTZ,                   -- When the pledge becomes valid
    validity_end    TIMESTAMPTZ,                   -- When the pledge expires
    state           commitment_state NOT NULL DEFAULT 'PROPOSED',
    evidence_uri    TEXT,                          -- entity_registry.fuseki_uri of linked Evidence
    metadata        JSONB DEFAULT '{}'::jsonb,     -- Arbitrary extra fields
    created_by      TEXT,                          -- steward/operator who created the record
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- State transition audit log (insert-only, mirrors commons decision log pattern)
CREATE TABLE IF NOT EXISTS commitment_state_log (
    id              SERIAL PRIMARY KEY,
    commitment_rid  TEXT NOT NULL,
    from_state      commitment_state,
    to_state        commitment_state NOT NULL,
    actor           TEXT,                          -- steward or system performing transition
    reason          TEXT,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- New predicates for commitment entities
INSERT INTO allowed_predicates (predicate, description, subject_types, object_types)
VALUES
    ('pledges_commitment', 'Person or Organization makes a formal pledge', ARRAY['Person','Organization'], ARRAY['Commitment']),
    ('proves_commitment',  'Evidence verifies fulfillment of a Commitment', ARRAY['Evidence'], ARRAY['Commitment']),
    ('redeems_via',        'Path from pledge to proof of fulfillment', ARRAY['Commitment'], ARRAY['Evidence']),
    ('disputes',           'Formal dispute entry against a Commitment', ARRAY['Person','Organization'], ARRAY['Commitment'])
ON CONFLICT (predicate) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_commitments_pledger ON commitments(pledger_uri);
CREATE INDEX IF NOT EXISTS idx_commitments_state   ON commitments(state);
CREATE INDEX IF NOT EXISTS idx_commitments_pool    ON commitments(pool_id);
CREATE INDEX IF NOT EXISTS idx_commitment_log_rid  ON commitment_state_log(commitment_rid);

-- Register migration
INSERT INTO koi_migrations (migration_id, checksum)
VALUES ('bkc:056_commitment_registry', 'manual')
ON CONFLICT (migration_id) DO NOTHING;
