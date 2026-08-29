-- 010_hw_test_artifacts.sql
-- Table to store hardware test artifacts uploaded by hw_test_harness v2.0.
-- The harness --upload flag POSTs CTRF/legacy JSON artifacts here.

CREATE TABLE IF NOT EXISTS hw_test_artifacts (
    id              SERIAL PRIMARY KEY,
    device_id       UUID REFERENCES devices(id) ON DELETE SET NULL,
    admin_id        UUID REFERENCES admins(id) ON DELETE SET NULL,
    hostname        TEXT,
    harness_version TEXT,
    agent_hash      TEXT,
    total_tests     INTEGER DEFAULT 0,
    passed          INTEGER DEFAULT 0,
    failed          INTEGER DEFAULT 0,
    skipped         INTEGER DEFAULT 0,
    errors          INTEGER DEFAULT 0,
    artifact_json   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hw_test_artifacts_device_id
    ON hw_test_artifacts(device_id);
CREATE INDEX IF NOT EXISTS idx_hw_test_artifacts_created_at
    ON hw_test_artifacts(created_at DESC);
