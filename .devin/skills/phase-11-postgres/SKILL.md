# Skill Domain: Phase 11 — PostgreSQL Path Testing

## Context
All server tests use SQLite (via sqlitePool mock or sqlitePool directly). The production deployment uses PostgreSQL. SQL syntax differences could cause runtime failures in production. This phase adds tests that run against real PostgreSQL (via PGlite, which is already a dependency).

## Current State
- server/src/db/pglitePool.js — PGlite (WASM PostgreSQL) pool wrapper, already exists
- server/src/db/sqlitePool.js — SQLite pool with PG syntax translation
- server/src/db/pool.js — real PostgreSQL pool (pg)
- All tests mock the pool or use SQLite
- PGlite is in server/package.json dependencies (`@electric-sql/pglite`)
- No tests exercise actual PostgreSQL SQL execution

## Research Findings
### PGlite as Test DB
- PGlite runs real PostgreSQL in-process via WASM
- Already a dependency — no installation needed
- Supports most PG features (types, intervals, advisory locks)
- In-memory mode available (FA7 comment in pglitePool.js)
- Interface matches pg.Pool

### SQL Differences to Test
1. **Parameter placeholders**: PG uses `$1, $2` — SQLite translates these. PGlite uses native `$1`.
2. **INTERVAL syntax**: `NOW() - INTERVAL '2 minutes'` — PG native, SQLite translates
3. **COUNT(*) FILTER (WHERE ...)**: PG native syntax
4. **pg_advisory_lock / pg_try_advisory_lock**: PG only — SQLite mock returns true
5. **RETURNING clause**: PG supports it, SQLite has it too but syntax differs
6. **JSONB operations**: PG has `->`, `->>`, `@>` operators
7. **UPSERT (ON CONFLICT)**: PG syntax `ON CONFLICT (col) DO UPDATE`
8. **Type casting**: `::text`, `::int`, `::jsonb`

### Test Strategy
1. Create a test file that uses PGlite pool instead of SQLite
2. Run migrations against PGlite (use PG migration files, not SQLite ones)
3. Test critical queries from each route:
   - Device CRUD (devices.js)
   - Agent checkin + command queue (agent.js)
   - Audit log insertion (audit.js)
   - HMAC nonce cache (hmacAuth.js)
   - Field encryption/decryption (fieldCrypto.js)
4. Verify no SQL syntax errors
5. Verify data integrity (insert → query → verify)

### Migration Files
- server/src/db/migrations/ — PostgreSQL migrations (001-006)
- server/src/db/migrations-sqlite/ — SQLite migrations (001-006)
- PGlite should use the PostgreSQL migrations

## Reasoning Questions
1. **Should all existing tests be re-run with PGlite?**
   - Answer: No. That would require mocking changes across all test files. Instead, write a focused test suite that exercises critical SQL queries against PGlite. This catches SQL compatibility issues without rewriting all tests.

2. **Should PGlite tests use in-memory or on-disk mode?**
   - Answer: In-memory. Faster, no cleanup needed. PGlite supports `:memory:` mode.

3. **Should we test pg_advisory_lock with PGlite?**
   - Answer: Yes. PGlite supports advisory locks. This is a critical concurrency mechanism that's currently mocked in SQLite tests.

## Implementation Guidelines
### server/tests/postgres-compat.test.js
- Setup: create PGlite pool in-memory mode
- Run PG migrations (001-006) against PGlite
- Test cases:
  - Create admin → query → verify
  - Create device → query → verify
  - Agent checkin → update last_checkin → verify
  - Queue command → poll command → verify
  - ACK command → verify status update
  - Audit log insert → query → verify
  - Advisory lock → unlock → verify
  - Field encryption → store → query → decrypt → verify
  - JSONB operations (if used in routes)
  - INTERVAL queries (stale agent detection)
  - UPSERT operations (if used)

## File Boundaries
- CREATE: `server/tests/postgres-compat.test.js`
- DO NOT EDIT: existing test files, source code, migration files

## Graph Integration

**Phase node**: `P11` in `.devin/graph/GRAPH-SPEC.yaml`

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P11` node
2. Read `.devin/graph/trace.md` — check last session's context
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md`

**Verification nodes gating this phase**: V-SERVER

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: —

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref

