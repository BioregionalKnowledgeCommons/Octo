-- Initialize PostgreSQL extensions for Octo KOI
-- This script runs on first container init only (fresh data volume)

-- Create octo_koi database (idempotent)
SELECT 'CREATE DATABASE octo_koi' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'octo_koi')\gexec

-- Connect to octo_koi
\c octo_koi

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS age;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Load AGE
LOAD 'age';

-- Make search_path persistent for this database
ALTER DATABASE octo_koi SET search_path = ag_catalog, "$user", public;
SET search_path = ag_catalog, "$user", public;

-- Create the knowledge graph
SELECT create_graph('regen_graph');

-- Grant permissions
GRANT USAGE ON SCHEMA ag_catalog TO PUBLIC;

-- Verify
DO $$
BEGIN
    RAISE NOTICE 'Extensions installed in octo_koi:';
    RAISE NOTICE '  - pgvector: %', (SELECT extversion FROM pg_extension WHERE extname = 'vector');
    RAISE NOTICE '  - Apache AGE: %', (SELECT extversion FROM pg_extension WHERE extname = 'age');
    RAISE NOTICE '  - fuzzystrmatch: %', (SELECT extversion FROM pg_extension WHERE extname = 'fuzzystrmatch');
    RAISE NOTICE '  - pg_trgm: %', (SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm');
    RAISE NOTICE '  - uuid-ossp: %', (SELECT extversion FROM pg_extension WHERE extname = 'uuid-ossp');
END $$;
