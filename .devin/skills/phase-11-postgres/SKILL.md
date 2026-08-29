---
name: phase-11-postgres
description: PostgreSQL compatibility testing via PGlite (WASM PostgreSQL) for critical SQL queries
---

# Phase 11 — PostgreSQL Path Testing

## Context

All server tests use SQLite (via sqlitePool mock or sqlitePool directly). The
production deployment uses PostgreSQL. SQL syntax differences could cause
runtime failures in production. This phase adds tests that run against real
PostgreSQL (via PGlite, which is already a dependency).

## Current State

### PGlite Test Infrastructure
- `server/tests/postgres-compat.test.js` — PostgreSQL compatibility test suite
  - Creates PGlite pool in in-memory mode (`:memory:`)
  - Runs PG migrations (001-006) against PGlite
  - Tests critical SQL queries from each route:
    - Device CRUD (devices.js)
    - Agent checkin + command queue (agent.js)
    - Audit log insertion (audit.js)
    - HMAC nonce cache (hmacAuth.js)
    - Field encryption/decryption (fieldCrypto.js)
  - Verifies no SQL syntax errors
  - Verifies data integrity (insert → query → verify)

### SQL Differences Tested
1. Parameter placeholders: PG uses `$1, $2` — PGlite uses native `$1`
2. INTERVAL syntax: `NOW() - INTERVAL '2 minutes'` — PG native
3. `COUNT(*) FILTER (WHERE ...)` — PG native syntax
4. `pg_advisory_lock` / `pg_try_advisory_lock` — PG only (SQLite mock returns true)
5. RETURNING clause — PG supports it
6. JSONB operations: `->`, `->>`, `@>` operators
7. UPSERT (ON CONFLICT): `ON CONFLICT (col) DO UPDATE`
8. Type casting: `::text`, `::int`, `::jsonb`

### Pool Wrappers
- `server/src/db/pglitePool.js` — PGlite (WASM PostgreSQL) pool wrapper, already exists
- `server/src/db/sqlitePool.js` — SQLite pool with PG syntax translation
- `server/src/db/pool.js` — real PostgreSQL pool (pg)
- PGlite is in `server/package.json` dependencies (`@electric-sql/pglite`)

### Migration Files
- `server/src/db/migrations/` — PostgreSQL migrations (001-010)
- `server/src/db/migrations-sqlite/` — SQLite migrations (001-009)
- PGlite tests use the PostgreSQL migrations

## Verification

```bash
# Run PostgreSQL compatibility tests
cd server && npx jest tests/postgres-compat.test.js --verbose

# Verify PGlite is a dependency
grep "pglite" server/package.json

# Verify PGlite pool wrapper exists
ls server/src/db/pglitePool.js

# Verify migration files exist for both PG and SQLite
ls server/src/db/migrations/ server/src/db/migrations-sqlite/

# Full verification sweep
make full-verify
```

## Regression checks

1. **Verify PGlite tests use in-memory mode**: `grep -i "memory" server/tests/postgres-compat.test.js`
2. **Verify PGlite tests run PG migrations (not SQLite)**: `grep -i "migrations/" server/tests/postgres-compat.test.js`
3. **Verify advisory lock is tested with PGlite**: `grep -i "advisory" server/tests/postgres-compat.test.js`
4. **Verify INTERVAL queries are tested**: `grep -i "interval" server/tests/postgres-compat.test.js`
5. **Verify JSONB operations are tested**: `grep -i "jsonb" server/tests/postgres-compat.test.js`

## Gotchas

- Not all existing tests are re-run with PGlite — only a focused suite exercises critical SQL queries (avoids mocking changes across all test files)
- PGlite supports most PG features (types, intervals, advisory locks) but is WASM-based — some edge cases may differ from real PostgreSQL
- PGlite tests use in-memory mode for speed (no cleanup needed)
- SQLite migrations and PG migrations are separate directories — PGlite must use the PG migrations

## Graph Integration

**Phase node**: `P11` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P11` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-SERVER

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: — (none)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
