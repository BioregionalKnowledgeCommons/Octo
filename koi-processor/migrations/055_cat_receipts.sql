-- 055_cat_receipts.sql
-- CAT (Content Addressable Transformation) receipt chain for provenance tracking.
-- Records every transformation step in the web curation pipeline.

CREATE TABLE IF NOT EXISTS koi_transformation_receipts (
    receipt_id TEXT PRIMARY KEY,
    transformation_type TEXT NOT NULL,
    input_rid TEXT NOT NULL,
    output_rid TEXT NOT NULL,
    parent_receipt_id TEXT REFERENCES koi_transformation_receipts(receipt_id),
    processor_name TEXT NOT NULL,
    source_sensor TEXT DEFAULT 'unknown',
    metadata JSONB DEFAULT '{}'::jsonb,
    content_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cat_input ON koi_transformation_receipts(input_rid);
CREATE INDEX IF NOT EXISTS idx_cat_output ON koi_transformation_receipts(output_rid);
CREATE INDEX IF NOT EXISTS idx_cat_type ON koi_transformation_receipts(transformation_type);
CREATE INDEX IF NOT EXISTS idx_cat_parent ON koi_transformation_receipts(parent_receipt_id);

-- Register migration
INSERT INTO koi_migrations (migration_id, checksum)
VALUES ('bkc:055_cat_receipts', 'manual')
ON CONFLICT (migration_id) DO NOTHING;
