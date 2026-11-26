# Session Capture — 2026-11-26 — sess-340

## Context
- Task: Close D-226: bring the Express backend onto ADR-011 (re-arm by administrator approval) so both backends agree a hardware UUID is not a credential
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- <none recorded>

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- The Express half was the same decision on a different storage model: migration 020 needs Postgres AND SQLite files (SQLite has no UUID type and no NOW(), so timestamps are ISO strings written by the route and idempotency comes from schema_migrations).
- Single-use must be a DELETE before the UPDATE that issues the key; flipping a status is exactly what two racing callers would both read.
- Put the authority in the admin queue and test it there: reinstating the old branch fails only 2 of 8 rearm tests (a denial is refused earlier and the approved path issues a key either way), so the queue suite is what pins it. Say that plainly instead of claiming parity with the Worker's 6-of-9.
- Adding a migration fails tests/migrationIdempotency.test.js (it enumerates the list) and closing a KNOWN_GAPS gap fails the cross-surface contract (shrink-only baseline). Both are the tests working; update the expectation, never loosen the test.
- Run the server suite with npm test, not npx jest: it needs --experimental-vm-modules, and a bare jest call dies in postgres-compat.test.js with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG, which looks like a code failure.

## Mistakes / Corrections
- mistake: read ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG as a code failure and lost a run; correction: when a failure names a Node flag, suspect the invocation first - the repo's npm script supplies it
- mistake: cited docs/artifacts/s366-... in the ledger before writing the file, so I2 failed on a missing artifact; correction: write the artifact before the ledger close that references it

## Open Questions
- <none recorded>

## File References
- server/src/routes/rearm.js
- server/src/routes/rearmRequests.js
- server/src/db/migrations/020_rearm_requests.sql
- server/src/db/migrations-sqlite/020_rearm_requests.sql
- server/src/index.js
- server/tests/rearm.routes.test.js
- server/tests/rearmRequests.routes.test.js
- docs/adr/PBL-DEBT-LEDGER.md
- docs/artifacts/s366-d226-express-parity.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
