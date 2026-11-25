# Session Capture — 2026-11-24 — sess-326

## Context
- Task: Implement backup and restore for the serverless deployment (last functional gap)
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
- An unencrypted backup of the fleet store is a credential dump: the pass must refuse without a 64-hex key rather than degrade, and record backup_skipped with the reason.
- AES-GCM with the envelope header as AAD makes a tampered or truncated backup restore nothing, instead of restoring a plausible subset.
- Restore must re-establish api_key_hash and the per-device indexes or every device re-enrols in person; the test asserts it by restoring into an empty store.
- Discriminated-union narrowing on a literal discriminant is not reliable under this repo's non-strict tsconfig; use an explicit type guard instead of depending on a compiler setting.

## Mistakes / Corrections
- mistake: S349's cron test asserted the LAST audit entry was the retention purge, which broke when a fourth pass was added while behaviour correct; correction: assert over the set of entries, not the ordering of independent passes
- mistake: passed --learnings/--mistakes/--files repeatedly, but the CLI documents 'one per line' so argparse kept only the last; correction: one flag, newline-separated

## Open Questions
- <none recorded>

## File References
- serverless/backup.ts
- serverless/worker.ts
- serverless/pbl/env.ts
- serverless/wrangler.toml
- serverless/serverless-backup.test.ts
- docs/SERVERLESS-BACKUP.md
- docs/artifacts/s350-serverless-backup.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
