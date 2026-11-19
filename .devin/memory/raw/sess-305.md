# Session Capture — 2026-11-19 — sess-305

## Context
- Task: Round 3 of sisyphus: option (b) of the S303 artifact — provision google_api_key to token-flow installs
- Environment: cross-surface: Express (Jest 882/52), Worker (Vitest 490/4), agent Python (976), ADR-008
- Duration: <not specified>

## Decisions Made
- ruling C via PENDING-RULING instead of implementing my own stated mechanism: installer-scripts.ts is a secret-free served template (B-070)
- delivery is install-time: key on the enrolment response, written by build_config/write_config
- Express admin enrol is POST /api/devices in devices.js, NOT enroll.js (planner corrected the goal)
- rotation-without-reinstall recorded in ADR-008, not the debt ledger (ledger feeds graph convergence)

## Actions Taken
- read installer-scripts.ts, both config builders, all six enrolment success sites, Env type, API.md
- wrote the ruling, asked the user, marked Q1 [x] on answer C
- launched role-loop; two oracle blocks (missing tests + ADR claiming tests that did not exist; then API.md table split)
- fixed API.md sentence placement and ADR 'Extends: ADR-003' -> 'Relates to: ADR-004'
- re-ran every gate myself

## Outcomes
- What worked: - measuring the gap myself before implementing found the mechanism was wrong AND the gap was wider (both surfaces)
- property-absence assertions (not falsy checks) make 'no-key path unchanged' provable
- What failed: - worker round 0 shipped green gates with most plan tests missing and an ADR claiming verification that did not exist
- worker round 1 inserted a prose sentence into the middle of a markdown response table
- What was unexpected: - server/src/routes/enroll.js has no admin enrol route at all; Express's admin enrol is POST /api/devices (devices.js:340)
- installer_gui.py duplicates installer.py's config builder, so every config key needs two edits

## Learnings
- an ADR that lists verification must only name tests that exist; a shipped false claim is worse than a missing section
- prose inserted into a markdown table needs the table re-read after the edit: row alignment is the failure mode
- count added tests from the diff (grep '^+ *def test_') instead of trusting a claimed baseline

## Mistakes / Corrections
- mistake: wrote the goal naming Server/enroll.js for the admin enrol response; correction: the planner found Express enrols admins via POST /api/devices, and the oracle enforced the corrected map

## Open Questions
- <none recorded>

## File References
- serverless/pbl/env.ts
- serverless/worker.ts
- server/src/routes/devices.js
- server/src/routes/enroll.js
- agent/installer.py
- agent/installer_gui.py
- scripts/test_cross_surface_contract.py
- docs/API.md
- serverless/README.md
- docs/adr/ADR-008-geolocation-key-delivery.md
- docs/artifacts/s306-geolocation-key-delivery.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
