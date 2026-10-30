# Session Capture — 2026-10-29 — sess-154

## Context
- Task: Close D-131: derive device_id from the AK Name in NV 0x01C00003, and build a working TPM provisioning path for the QEMU harness
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
- TPM2_NV_ReadPublic returns the NV index Name (digest of the public template), not the stored data. Deriving device_id from it gives one identity for the whole fleet - worse than zeros because it looks valid. The stored 34 bytes need TPM2_NV_Read.
- Working swtpm provisioning recipe (5 wrong attempts to find it): TCTI must target the DATA port (swtpm:host=127.0.0.1,port=<data>) while swtpm runs --ctrl type=tcp,P1 --server type=tcp,P2; the path= form is rejected by tss2 3.2 AND 5.7; host/port aimed at the ctrl port fails identically; tpm2_startup -c is mandatory under --flags not-need-init or everything answers 0x100; attributes must be numeric 0x420D000D (PBL's platform set, needs PLATFORMCREATE); and the provisioning swtpm must be stopped before QEMU's starts or the second hits the state lock.
- swtpm state survives a restart (NV checkpoints into tpm2-00.permall), which is what lets a sidecar or an earlier step provision and a later step boot on it.
- EDK2 Print renders %x UPPER-case, so assertions against firmware hex output must be upper-case.
- On a never-enrolled device the AK-name read happens before PblTpmProvisionNvIndices, so it returns 0x28B = TPM_RC_HANDLE param 2 (index does not exist) rather than 0x14A (defined but unwritten). Both must map to 'unprovisioned'.
- A negative-path assertion is only meaningful if you can tell 'condition absent' from 'setup failed' - hence branch-specific assertions (enrolled asserts the id, unprovisioned asserts suppression).

## Mistakes / Corrections
- Spent five probe iterations guessing a TCTI config string. The right first move was reading the TCTI's documented options, not enumerating plausible syntaxes; the answer (data port not ctrl port) was documented behaviour.
- Wrote an assertion matching lower-case hex against firmware output that is upper-case, then reported a firmware failure that was my assertion's fault. Check the actual output string before writing the pattern.
- Built artifact result files but left the raw serial logs in /tmp at first - a run artifact in /tmp is not an artifact. Persist into the repo.
- A shared host dir reused across docker runs broke one run because a previous container had created root-owned files; use a fresh dir per run.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/ci-harness-docker.sh
- scripts/provision-qemu-tpm.sh
- firmware/PblPkg/PblApp/TpmClient.c
- firmware/PblPkg/PblApp/PlatformState.c
- firmware/PblPkg/PblApp/PblApp.c
- firmware/PblPkg/PblApp/HttpsClient.c
- firmware/PblPkg/artifacts/d131-enrolled-serial.log
- firmware/PblPkg/artifacts/d131-unprovisioned-serial.log
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
