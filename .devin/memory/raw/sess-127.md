# Session Capture — 2026-09-19 — sess-127

## Context
- Task: Implement S1.4 S3-resume detection via agent-reported TPM restartCount (Design A)
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
- PBL NEVER runs on S3 resume (finding F6): PEI S3 path jumps to OS resume vector, bypassing DXE/BDS — so restartCount must come from the OS agent, not firmware. Firmware emitting it would be architecturally useless.
- Windows OS-side TPM command path: tbs.dll Tbsi_Context_Create + Tbsip_Submit_Command (locality 0, priority 300) + Tbsip_Context_Close; TPM2_ReadClock needs no auth/session
- resetCount (boot_id) vs restartCount is the S3 discriminator: resume bumps restartCount without resetCount
- Agent pytest needs .venv/bin/python — pyproject sets --timeout=30 via pytest-timeout; system python3 lacks the plugin

## Mistakes / Corrections
- Almost scoped S1.4 as a firmware change — caught that PBL can't observe the resume it's meant to detect (F6)

## Open Questions
- <none recorded>

## File References
- agent/tpm_clock.py
- agent/agent.py
- server/src/routes/agent.js
- agent/tests/test_tpm_clock.py
- server/tests/agent.routes.test.js

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
