# Session Capture — 2026-11-03 — sess-200

## Context
- Task: Session 200: verify the ledger's D-116/D-117 claims against the firmware code, and get the PBL QEMU harness running in this environment.
- Environment: repo=remote-lockdown-system; files=docs/adr/PBL-DEBT-LEDGER.md, Makefile, firmware/PblPkg/PblApp/{TlsVerify.c,PblApp.c,HttpsClient.c,PblApp.h}, firmware/PblPkg/artifacts/, firmware/Dockerfile.qemu; docker usable, no local qemu/edk2
- Duration: <not specified>

## Decisions Made
- Keep D-116 OPEN but rename/narrow it to hostname binding: the pinning half is done and proven, so closing it would be a false close.
- Mark D-116's SetSessionData criterion superseded by D-132's ruling rather than deleting the history.
- Add make firmware-qemu instead of leaving the working docker invocation as prose in a provisioning script.
- Record the edk2 absence as the next unblocker rather than attempting an unverifiable C change.

## Actions Taken
- Found D-132 is CLOSED (my S199 claim was wrong) and its mechanism is wired: PblInstallTlsCaCertificate at PblApp.c:600, fetch at 617.
- Corrected D-116: not an empty stub (223 lines); chain pinning proven by d132-mismatched-ca-results.txt; residual = hostname binding + dead PblTlsVerifyCert + TLS floor.
- Corrected D-117's 'QEMU cannot run locally': make firmware-qemu boots the prebuilt PblApp.efi in Docker at 17 PASS / 0 FAIL.
- Captured the run as firmware/PblPkg/artifacts/qemu-harness-2026-11-03.txt.
- Confirmed the pbl-qemu image has no EDK II build tool, so C changes are unverifiable until an edk2 checkout is added.

## Outcomes
- What worked: - Reading the code before the ledger produced two corrections in one pass.
- Docker was the unlock: the harness needed no local qemu/swtpm/edk2 because the image carries them and the .efi is prebuilt.
- A negative-test artifact (mismatched CA) was stronger evidence than any amount of code reading.
- What failed: - The pbl-qemu build produced an image but no build toolchain, so the plausible next step (implement hostname binding) is blocked on edk2 rather than on design.
- What was unexpected: - D-116's own text ('empty stub') had been false for a month while three sessions planned around it.
- The harness gives 17 checks, not the 10 recorded in D-100's text.

## Learnings
- Never cite a ledger entry as fact: read the code, cite file:line, attach a run artifact.
- Dockerised harnesses can unlock verification that the ledger calls impossible — check Docker availability before declaring a runtime path blocked.
- A prebuilt .efi plus a tool image is enough to run firmware checks even with no edk2 checkout; it is not enough to change them.

## Mistakes / Corrections
- mistake: S199 claimed D-132's residual was the only code-shaped item without enumerating the OPEN set; correction: enumerated it (grep), found D-132 closed and ~20 open items, and recorded the correction in the S200 block.

## Open Questions
- <none recorded>

## File References
- docs/adr/PBL-DEBT-LEDGER.md
- Makefile
- firmware/PblPkg/artifacts/qemu-harness-2026-11-03.txt
- firmware/PblPkg/PblApp/TlsVerify.c
- firmware/PblPkg/PblApp/PblApp.c
- firmware/PblPkg/PblApp/HttpsClient.c
- firmware/PblPkg/artifacts/d132-mismatched-ca-results.txt
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
