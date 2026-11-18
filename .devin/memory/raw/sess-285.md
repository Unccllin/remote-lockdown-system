# Session Capture — 2026-11-18 — sess-285

## Context
- Task: S282: get MOLE enrolled and checking in after the reachability diagnosis
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
- MOLE's agent config targets http://192.168.1.43:8787 (ufw-allowed), never :3001 — the port traced for four sessions was the wrong port for the agent path.
- dev-start-sqlite.js does not mount /api/enroll; POST /api/devices is the mount that exists and returns the plaintext per-device key once.
- Enrolment that works without reinstalling: POST /api/devices -> patch api_key + device_id in config.json (back it up first) -> Restart-Service LockdownAgent; check-in landed in 8s.
- MOLE has no usable TPM: seal key creation fails, agent falls back to DPAPI/plaintext; firmware_audit reports secure_boot=false.

## Mistakes / Corrections
- mistake: reached for /api/enroll/token on the dev scaffold (404 as HTML) because enroll.js's docstring describes the full server; correction: grep the scaffold's app.use list before assuming a route exists.

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s282-mole-link-live.txt
- .devin/graph/trace.md
- .devin/graph/current-state.md
- .devin/brain/beliefs.yaml
- server/dev-start-sqlite.js

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
