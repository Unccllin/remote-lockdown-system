# Session Capture — 2026-10-29 — sess-153

## Context
- Task: D-131 firmware half: read NV 0x01C00003 with NV_Read (not NV_ReadPublic), populate DeviceId, suppress the verdict request when unprovisioned, and fix the QEMU harness
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
- TPM2_NV_ReadPublic returns the NV index Name (digest of the public template), not the stored data. Deriving device_id from it gives every device in the fleet the same id - worse than zeros because it looks valid. The stored 34 bytes need TPM2_NV_Read.
- C2 §1.3 and §5.1 disagreed (stores 34 bytes vs read via NV_ReadPublic); the implementation followed the section that was wrong. Read the section that DEFINES a structure before implementing against the section that describes using it.
- PBL CI's qemu job had a second failure behind the apt one: TIMEOUT="${1:-30}" with CI passing '--timeout 30' produced 'timeout --timeout qemu' / Python 'if elapsed > --timeout:'. A red job hides the next failure - after fixing one step, re-run rather than assume green.
- A harness that cannot provision cannot test the provisioned path, and silently looks identical to one that does. Assert per-branch, and print which branch ran.
- pbl-qemu:latest exists locally with EDK2 + custom OVMF + nasm, so firmware build and QEMU boot are fully verifiable on this machine; unprovisioned artifact was 17 PASS / 0 FAIL with a self-image hash matching the built binary.

## Mistakes / Corrections
- Edited ci-harness-docker.sh while a container was executing it; bash re-read the file mid-run and reported a bogus 'syntax error near unexpected token )' at a line inside a heredoc. Never edit a script a running process is reading.
- Declared libtss2-tcti-swtpm absent on jammy from a head-truncated ls (swtpm sorts after spi-helper). It was installed; the real fault was the TCTI config syntax. A truncated listing is not evidence.
- Wrote a grep -E check with (?!0000) lookahead, which POSIX ERE does not support and would have been permanently red. Replaced with an assertion on the expected bytes.
- Background run failed instantly because a previous container had created root-owned files in the shared artifact dir, so rm -rf short-circuited and the redirect never happened. Use a fresh dir per run, not a shared one that gets rm -rf'd.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/TpmClient.c
- firmware/PblPkg/PblApp/PlatformState.c
- firmware/PblPkg/PblApp/PblApp.c
- firmware/PblPkg/PblApp/PblApp.h
- firmware/PblPkg/PblApp/HttpsClient.c
- firmware/PblPkg/ci-harness-docker.sh
- firmware/PblPkg/ci-harness.sh
- docs/adr/PBL-C2-TPM-Contract.md
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
