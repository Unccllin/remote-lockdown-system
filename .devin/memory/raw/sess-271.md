# Session Capture — 2026-11-17 — sess-271

## Context
- Task: Close the MOLE lifecycle: make tracking work (decoy + declared-unsupported EFS), then verify the whole cycle on hardware
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
- cipher cannot encrypt another user's profile file from a different account context (measured: [ERR], exit 1 with the account enabled). Profile EFS needs a Data Recovery Agent certificate at machine policy level; the agent now declares the layer unsupported instead of failing it every run.

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- agent/agent.py\n- agent/tests/test_agent_serverless.py\n- scripts/acceptance_lifecycle.py\n- scripts/acceptance_probe.ps1\n- scripts/test_acceptance_lifecycle.py\n- docs/artifacts/s271-acceptance-track-cycle-v4.json\n- .devin/graph/GRAPH-SPEC.yaml\n- .devin/graph/trace.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
