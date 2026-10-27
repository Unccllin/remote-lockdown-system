# Session Capture — 2026-10-27 — sess-140

## Context
- Task: Diagnose and fix 'the SQL code crashes / it never works as expected': DB driver precedence + SQLite migration idempotency
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
- Docker prod was accidentally safe only because WORKDIR=/app means dotenv looks for /app/.env; server/.env was still baked into the image. .dockerignore now excludes .env.

## Mistakes / Corrections
- mistake: assumed the reported crash was a SQL dialect bug; correction: reproduce before theorising - a fresh DB and real Postgres both passed, which localised it to state/config.

## Open Questions
- <none recorded>

## File References
- Makefile

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
