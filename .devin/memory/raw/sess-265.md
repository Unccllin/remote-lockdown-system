# Session Capture — 2026-11-11 — sess-265

## Context
- Task: D-224: host-side byte-level TPM command-buffer tests + COSE verification with test keys
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
- The seam for testing TpmClient.c on the host is EFI_TCG2_PROTOCOL->SubmitCommand (reached via gBS->LocateProtocol); fake it and the shipped code builds commands you can assert byte by byte.
- D-224 was mis-described as needing 'an EDK II crypto backend'. Tpm20.h is only a wire-format header (vendor it); the crypto the modules use is SHA-256/HMAC/AES-CBC/ECDSA-P256, all available via OpenSSL libssl-dev.
- EDK II EcDsaVerify takes RAW r||s, not DER (CryptEc.c:1060 rebuilds ECDSA_SIG from halves). Mirroring OpenSSL's ECDSA_verify would invent a bug.
- TPMS_AUTH_COMMAND is 137 bytes (TPM2B_* are fixed 66-byte buffers); the serialized empty auth area is 9 bytes. Do not infer wire sizes from sizeof.
- NV_Increment always carries TWO handles (authHandle + nvIndex); a failed epoch increment short-circuits the counter read; TPM2_GetRandom needs a TPM2B_DIGEST body (2-byte size + bytes).
- The host shim can drift from EDK II silently: its EFI status table had EFI_PROTOCOL_ERROR as 11 (EDK II: 24).

## Mistakes / Corrections
- mistake: used re.search(r'\bName\s*\(') to extract prototypes — it matched a COMMENT mention and duplicated six struct definitions; correction: anchor at line start with re.M.
- mistake: walked backwards over lines that merely lack ';' to find a return type — a struct field line ending in '// comment' qualifies; correction: require the line to be identifiers+spaces only (optional trailing '*').
- mistake: wrote EVP_PKEY_sign length through (size_t *)&Ok (an int) — 8 bytes into a 4-byte object; correction: own size_t variable.
- mistake: assumed one handle for NV_Increment and a 3-command NV_Write sequence; correction: read the firmware call, then assert.
- mistake: over-specified a truncated-COSE expectation as PROTOCOL_ERROR; correction: truncation is a LENGTH error (BUFFER_TOO_SMALL) — assert EFI_ERROR for fail-closed, and pin PROTOCOL_ERROR for a well-formed wrong-shape input.

## Open Questions
- <none recorded>

## File References
firmware/PblPkg/host-tests/host_tpm.c, firmware/PblPkg/host-tests/host_tpm.h, firmware/PblPkg/host-tests/host_crypto.c, firmware/PblPkg/host-tests/test_tpm_command.c, firmware/PblPkg/host-tests/test_cose_verify.c, firmware/PblPkg/host-tests/gen-host-tpm.py, firmware/PblPkg/host-tests/gen-host-pcd.py, firmware/PblPkg/host-tests/extract-decls.py, firmware/PblPkg/host-tests/run-host-tests.sh, firmware/PblPkg/host-tests/include/PblApp.h, firmware/PblPkg/artifacts/d224-mutation-check.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
