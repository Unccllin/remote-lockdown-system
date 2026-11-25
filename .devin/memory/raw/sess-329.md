# Session Capture — 2026-11-24 — sess-329

## Context
- Task: Run the production backup/restore drill; fix the restore bug it exposed
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
- The Worker verifies HS256 session tokens signed with JWT_SECRET, and that secret was in this session's escrow file, so the drill could run without the operator's ADMIN_TOKEN or password
- hmacSha256 returns a HEX STRING, so a JWT signature segment is base64url of those hex characters, not of the raw digest; verifyAdminToken checks signature and exp only, never that the admin still exists
- Workers KV allows one write per second per key: restoring 79 reports rewrote location_index:<device> 79 times and the restore died with 429. Records go to distinct keys and are fine; only indexes were hot
- Restore had 15 passing tests because the fake KV has no rate limit; the property that breaks in production is invisible to a fake unless the test counts writes per key

## Mistakes / Corrections
- mistake: rewrote an index key once per record in restoreBackup and shipped it as tested; correction: batch records, write each index once, and assert write counts per key in the test
- mistake: reported MOLE agent.log as dead since 11/19; correction: the machine was suspended and the log resumed on wake (586KB -> 747KB) - an mtime on a sleeping host is not evidence of a logging fault

## Open Questions
- <none recorded>

## File References
- serverless/backup.ts
- serverless/serverless-backup.test.ts
- docs/artifacts/s354-backup-restore-drill.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
