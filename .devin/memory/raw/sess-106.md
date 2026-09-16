# Session Capture — 2026-09-16 — sess-106

## Context
- Task: Persist PBL lock state to TPM NV across QEMU+swtpm reboots
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
A two-boot CI harness is the only reliable way to prove TPM NV write/read persistence in QEMU/swtpm.

## Mistakes / Corrections
Initial ci-harness-persistence.sh reused a single swtpm daemon and failed on boot 2 because the control socket disappeared.

## Open Questions
- <none recorded>

## File References
pbl-persistence-artifacts/pbl-persistence-result.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
