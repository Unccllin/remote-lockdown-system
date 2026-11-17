# Session Capture — 2026-11-17 — sess-270

## Context
- Task: Operator reported two product defects after using MOLE: a locked device still accepts sign-in, and the machine's time does not match local time. Fix both, plus the lifecycle defects the resumed acceptance run exposed.
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
- S269's poll-interval fix landed in handlePing (/api/ping, legacy) while the agent uses handleAgentCheckin (ADAPTIVE_POLL active=300). Fixing the code path you edited is not fixing the path the client uses.

## Mistakes / Corrections
- mistake: the acceptance harness failed a healthy device because my freshness limit (60s) fought the server-driven 300s interval. correction: a harness that fails a good device is a harness bug — floor the limit and print both numbers.

## Open Questions
- <none recorded>

## File References
- agent/agent.py\n- agent/service_host.py\n- agent/service_installer.py\n- agent/installer_gui.py\n- agent/installer.py\n- agent/tests/test_agent_serverless.py\n- agent/tests/test_service_host.py\n- agent/tests/test_service_installer.py\n- agent/tests/test_installer_gui.py\n- scripts/acceptance_lifecycle.py\n- scripts/acceptance_probe.ps1\n- scripts/test_acceptance_lifecycle.py\n- serverless/worker.ts\n- serverless/pbl/env.ts\n- server/src/routes/devices.js\n- .devin/graph/GRAPH-SPEC.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
