# Session Capture — 2026-09-09 — sess-088

## Context
- Task: Set up QEMU+swtpm environment for PBL firmware TPM runtime testing (D-101)
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
- QEMU tpm_ioctl.h: CMD_GET_CAPABILITY=1, CMD_INIT=2, CMD_SHUTDOWN=3, CMD_GET_TPMESTABLISHED=4, CMD_SET_LOCALITY=5, ..., CMD_SET_DATAFD=0x10, CMD_SET_BUFFERSIZE=0x11, CMD_GET_INFO=0x12, CMD_LOCK_STORAGE=0x13.

## Mistakes / Corrections
- mistake: Used swtpm_ioctl -s (shutdown) during setup, which killed swtpm and caused QEMU connection errors. Fix: Don't use shutdown during setup; use -i (init) only.

## Open Questions
- <none recorded>

## File References
- .devin/graph/trace.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
