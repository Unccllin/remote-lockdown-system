# Session Capture — 2026-09-16 — sess-108

## Context
- Task: D-215/D-219: exercise the policy-signature fail-closed path with a provisioned firmware root of trust
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
- PolicyRootOfTrust.generated.h existed but was dead code: guarded by a macro defined only inside itself — fixed with __has_include; the old JS generator also lacked the X.509 cert that EcGetPublicKeyFromX509 requires. - gen-policy-rot.py provisions ES256 key + self-signed cert + SPKI/kid/cert header and emits four policy.cose variants (valid/wrong-key/tampered/wrong-kid); tampered variant flips a byte inside a large CBOR bstr preserving the signature so failure is ECDSA not parse. - Invalid policy → EFI_SECURITY_VIOLATION → [BLOCK] before step [3/8], no lock screen — fail-closed verified, 12 PASS / 0 FAIL in QEMU+swtpm. - test-d205.py now signs policy with .pbl_policy_signing_key when present, keeping D-205 compatible with RoT-provisioned builds.

## Mistakes / Corrections
- mistake: assumed the stale JS generator output was active — the include guard could never be true; always grep the actual preprocessor condition before trusting generated-code wiring

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/gen-policy-rot.py - firmware/PblPkg/test-d215-harness.sh - firmware/PblPkg/PblApp/PolicyRootOfTrust.c - firmware/PblPkg/test-d205.py - docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
