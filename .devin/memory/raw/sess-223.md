# Session Capture — 2026-11-05 — sess-223

## Context
- Task: Session 223: clean the dashboard device list and record FRANKENSTEIN as the first production device.
- Environment: server/lockdown.db on WSL; dashboard at localhost:5173; FRANKENSTEIN 192.168.1.119 (Windows 11 26300), service LockdownAgent
- Duration: <not specified>

## Decisions Made
- Delete every device that is not live, with its dependent rows, rather than hiding them in the UI.
- Record the first device in AGENTS.md with identifiers (UUID, serial, MAC, device id) instead of prose, so a later session does not rediscover it.
- Include what is still wrong on that machine in the same record, so the entry is a status, not a trophy.

## Actions Taken
- Listed devices + dependents, deleted HP-ELITEBOOK-840-G7, REPRO-01, REPRO-REASSOC, TEST-HOST-01 with commands/encryption_keys/audit_log rows and 2 orphan EFS cert rows.
- Verified GET /api/devices returns exactly FRANKENSTEIN.
- Added the first-device section to AGENTS.md with identity, install shape, evidence and known issues.

## Outcomes
- What worked: - Querying the API the UI uses (not the DB) confirmed the cleanup as the operator will see it.
- Checking dependent tables first meant no orphans were left behind.
- What failed: - Nine sessions of debugging left four synthetic rows because nothing said to clean up after a repro.
- What was unexpected: - Two device_efs_certs rows referenced devices that no longer existed; deleting devices does not cascade to them.

## Learnings
- Clean up the rows a repro creates; otherwise the product's own dashboard becomes the noise.
- Record identity with identifiers, and include known defects, or the record ages badly.

## Mistakes / Corrections
- mistake: earlier sessions created devices (REPRO-01, TEST-HOST-01) and never removed them; correction: cleaned now and noted the habit in the session record.

## Open Questions
- <none recorded>

## File References
- AGENTS.md
- server/lockdown.db (rows deleted)
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
