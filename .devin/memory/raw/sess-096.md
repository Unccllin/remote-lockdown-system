# Session Capture — 2026-09-15 — sess-096

## Context
- Task: Study TCG TPM 2.0 Library Specification v1.85 and PBL TPM implementation (Source 3)
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- Cloned go-sdk-vtpm2 to /tmp/go-sdk-vtpm2 to access the vendored TPM 2.0 spec PDFs and text exports.
- Reviewed Part-0/1/2/3 text exports and PBL TPM source.
- Wrote consolidated study note docs/research/STUDY-TPM-2.0.md.
- Closed session and captured memory.

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- TPM 2.0 commands use a 10-byte big-endian header with tag, size, and command code; responses are also big-endian.
- PCRs are extend-only accumulators: newPCR = Hash(oldPCR || digest) per bank.
- TPM2_PCR_Read requires no authorization; TPM2_PCR_Extend does.
- NV indices are controlled by TPMA_NV_* attributes; platform-created indices survive TPM2_Clear(RH_OWNER).
- There is no standalone TPM2_Seal; sealing is Create/CreatePrimary with sensitive.data + authPolicy, then Load/Unseal.
- HMAC sessions authorize each command via pHash || nonces || sessionAttributes; unbound/unsalted sessions have an empty session key and rely on authValue.
- PBL uses EFI_TCG2_PROTOCOL->SubmitCommand and extends PCR 12 (decision) and PCR 13 (inputs).
- Current PBL gaps: TcgLog.c is a stub, no-session PCR extend fallback is not spec-valid, OVMF uses owner hierarchy for NV, and NV Name caching may be stale.
- BitLocker default PCR profiles do not include PBL PCR 12/13 unless explicitly configured.

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- docs/research/STUDY-TPM-2.0.md
- /tmp/go-sdk-vtpm2/docs/spec/v185/Part-1.txt
- /tmp/go-sdk-vtpm2/docs/spec/v185/Part-2.txt
- /tmp/go-sdk-vtpm2/docs/spec/v185/Part-3.txt
- firmware/PblPkg/PblApp/TpmClient.c
- firmware/PblPkg/PblApp/TpmSession.c
- firmware/PblPkg/PblApp/TcgLog.c

## Optional Fields (applied to consolidated memories)
- evidence_sources: spec:TCG TPM 2.0 Library v1.85 Part 1, spec:TCG TPM 2.0 Library v1.85 Part 2, spec:TCG TPM 2.0 Library v1.85 Part 3, file:firmware/PblPkg/PblApp/TpmClient.c, file:firmware/PblPkg/PblApp/TpmSession.c, file:docs/adr/PBL-C2-TPM-Contract.md
- impact: PBL TPM behavior, PCR 12/13, NV lock state, HMAC sessions, BitLocker PCR sealing
- response: Next: Intel platform security (Boot Guard, TXT, PTT); revisit PTP/PC Client spec if a mirror becomes available
