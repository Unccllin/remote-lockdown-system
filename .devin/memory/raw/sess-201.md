# Session Capture — 2026-11-03 — sess-201

## Context
- Task: Session 201: check whether firmware changes are buildable/verifiable here, and settle D-116's residual against the edk2 source.
- Environment: repo=remote-lockdown-system; edk2 at ~/.local/src/edk2 (2970e56), nasm 2.16.01 at ~/.local/bin, BaseTools+OVMF prebuilt; files=docs/adr/PBL-DEBT-LEDGER.md, Makefile, firmware/PblPkg/build-pbl.sh, firmware/PblPkg/artifacts/
- Duration: <not specified>

## Decisions Made
- Do not add an edk2 checkout to the Docker image: EDK II is already installed for the host build script; the S200 opening was based on a wrong check.
- Keep D-116 OPEN but retitle it to the TLS version floor, since pinning and hostname are both covered.
- Treat the TLS-floor fix as an owner ruling (three options), not a unilateral code change.
- Add make firmware-build so the build path is discoverable.

## Actions Taken
- Found ~/.local/src/edk2 + nasm, i.e. build-pbl.sh's documented defaults, already built.
- Ran ./build-pbl.sh --arch X64: exit 0, git status firmware/ empty, all three binaries byte-identical.
- Read edk2's HttpsSupport.c/TlsDriver.c/TlsInit.c to settle D-116: hostname verified by HttpDxe; TLS floor is 1.0; PBL only holds EFI_HTTP_PROTOCOL.
- Rewrote D-116 with file:line citations from both PBL and edk2; added make firmware-build and the build-reproducible artifact.

## Outcomes
- What worked: - Running the repo's own build script was faster than building a Docker toolchain, and it produced a stronger result: byte-identical outputs.
- Reading edk2 source (now available locally) turned 'hostname missing' into 'hostname covered, version floor missing' — a sharper and more actionable finding.
- What failed: - S200's conclusion that firmware could not be built was wrong and cost a session's opening; it came from checking only inside the Docker image.
- What was unexpected: - The reproducible-build claim actually holds: three binaries, identical hashes.
- The real C3 §4 gap is TLS 1.0, hidden in edk2's TlsDxe default rather than in PBL's code.

## Learnings
- Check the tool the repo documents (build-pbl.sh names EDK2_DIR) before declaring a capability blocked.
- 'No tool inside the container' is not 'no tool': the host had the whole toolchain.
- A dependency's source is evidence: reading HttpDxe/TlsDxe ended the guesswork about hostname and TLS floor.

## Mistakes / Corrections
- mistake: concluded 'no EDK II build tool' after checking only the Docker image and guessed paths; correction: the host had edk2, BaseTools and nasm exactly where build-pbl.sh expects, and the build reproduces byte-identically.

## Open Questions
- <none recorded>

## File References
- docs/adr/PBL-DEBT-LEDGER.md
- Makefile
- firmware/PblPkg/artifacts/build-reproducible-2026-11-03.txt
- firmware/PblPkg/build-pbl.sh
- ~/.local/src/edk2/NetworkPkg/HttpDxe/HttpsSupport.c
- ~/.local/src/edk2/NetworkPkg/TlsDxe/TlsDriver.c
- ~/.local/src/edk2/CryptoPkg/Library/TlsLib/TlsInit.c
- firmware/PblPkg/PblApp/HttpsClient.c
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
