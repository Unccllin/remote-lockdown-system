# Session Capture — 2026-11-26 — sess-337

## Context
- Task: Finish the Cloudflare setup (D1 stage 0) and produce the company-side cost model
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
- D1 stage 0 per docs/SERVERLESS-D1-CUTOVER.md: create, apply d1/schema.sql, bind as DB (the code reads env.DB, not the 'lockdown' binding wrangler suggests), deploy. Exit condition is the three named indexes in sqlite_master.
- The binding must be shown to be USED: nonce rows grow per signed check-in (2 -> 3 across two MOLE polls) while devices stays at 0 rows, which is exactly what stage 0 should look like (replay authoritative, reads untouched).
- The backup cron is provably working from the audit log it writes itself: backup_written entries for 2026-11-25 and 2026-11-26 (40916 and 41186 bytes, 2 devices/8 commands), after a backup_restored drill on 2026-11-24. KV has no backup marker keys, so the audit index is the place to look.
- Cost model grounded in code: 60 s poll = 43,200 check-ins/device/month; one check-in = 1 request + 3 KV reads + 1 write + 1 list. KV writes/lists at $5/million dominate, so marginal cost is ~KES 66/device/month until the D1 cutover (~KES 10 after).
- Crossover against a KES 2,000-2,500 local VM is ~45-55 devices, NOT the ~325 the older cost doc claims; at 100 devices serverless is ~KES 5,161/month, twice the VM. The old figure predates the per-device command index (S348) and counts one read per poll instead of a write+list per poll.
- Cloudflare rates checked 2026-11-26: Workers Paid $5/mo min (10M req, 30M CPU-ms), KV reads 10M then $0.50/M, writes/lists 1M then $5/M, R2 10GB + egress free, D1 25B reads/50M writes/5GB included. FX 130.06 KES/USD (CBK 2026-11-26).

## Mistakes / Corrections
- mistake: queried MAX(expires) when the column is expires_at, and my JSON extractor assumed a top-level results key, so two queries died with KeyError while a third worked; correction: read the schema and print the raw response before parsing
- mistake: left a second, contradicting cost figure in docs/SERVERLESS-COST.md while writing a new one; correction: a customer-facing number must be corrected at its source, not superseded silently

## Open Questions
- <none recorded>

## File References
- serverless/wrangler.toml
- serverless/d1/schema.sql
- docs/COMPANY-SETUP-COST.md
- docs/SERVERLESS-COST.md
- docs/SERVERLESS-D1-CUTOVER.md
- docs/artifacts/s362-d1-stage0-and-cost.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
