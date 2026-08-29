-- 010: Hardware test artifacts table (SQLite version).
-- Stores artifacts uploaded by hw_test_harness v2.0 via POST /api/hw-test-artifact.

CREATE TABLE IF NOT EXISTS hw_test_artifacts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT,
    admin_id        INTEGER,
    hostname        TEXT,
    harness_version TEXT,
    agent_hash      TEXT,
    total_tests     INTEGER DEFAULT 0,
    passed          INTEGER DEFAULT 0,
    failed          INTEGER DEFAULT 0,
    skipped         INTEGER DEFAULT 0,
    errors          INTEGER DEFAULT 0,
    artifact_json   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
    FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_hw_test_artifacts_device_id
    ON hw_test_artifacts(device_id);
CREATE INDEX IF NOT EXISTS idx_hw_test_artifacts_created_at
    ON hw_test_artifacts(created_at DESC);
