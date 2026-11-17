# Session Capture — 2026-11-17 — sess-272

## Context
- Task: S271: make the product's claims match the machine (lock, tracking, boot lock, offline tracking), then close the session
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
- Never echo a caller-supplied secret back in an ACK: it lands in the escrow and the UI vouches for a credential the machine rejects.

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- agent/agent.py\n- agent/hp_uefi_lockdown.py\n- agent/installer.py\n- agent/installer_gui.py\n- serverless/worker.ts\n- serverless/worker.test.ts\n- scripts/acceptance_lifecycle.py\n- scripts/acceptance_probe.ps1\n- scripts/lint-agent.sh\n- dashboard/src/api/alerts.js\n- dashboard/src/pages/DevicesPage.jsx\n- dashboard/src/utils/bootLockReason.js\n- docs/adr/ADR-002-per-entity-command-records.md\n- .devin/graph/trace.md\n- README.md\n- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
