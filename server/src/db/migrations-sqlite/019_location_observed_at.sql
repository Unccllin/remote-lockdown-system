-- 019: location_reports.observed_at — SQLite version.
-- See the PostgreSQL file for why this exists. SQLite has no ADD COLUMN IF NOT EXISTS, so the
-- runner's `schema_migrations` bookkeeping is what makes this idempotent; the value is an
-- ISO-8601 string written by the route, ordered with `reported_at` through COALESCE.

ALTER TABLE location_reports ADD COLUMN observed_at TEXT;
