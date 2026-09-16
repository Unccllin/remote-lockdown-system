# Session Capture — 2026-09-16 — sess-109

## Context
- Task: D-217: runtime self-integrity — hash on-disk PblApp.efi, extend into PCR 13, Secure Boot deployment checklist
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
- On-disk PE bytes are deterministic (D-212 failed because in-memory image has DIR64 relocations at random base); resolve via LoadedImage->DeviceHandle+FilePath MEDIA_FILEPATH node + SimpleFS. - Self-measurement into PCR 13 before the inputs extend gives complete tamper detection: different hash OR missing extend both change PCR 13; prevention still requires Secure Boot. - EDK II Print %02x emits uppercase hex — case-fold in harness comparisons. - ci-harness-docker.sh set -eo pipefail exits silently on failing grep in command substitution — use || true.

## Mistakes / Corrections
- mistake: first harness run appeared to pass all checks then exited 1 with no output — set -e killed the script on the hash-grep substitution; always guard grep pipelines under pipefail

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/PblApp.c - firmware/PblPkg/ci-harness-docker.sh - firmware/PblPkg/ci-harness.sh - docs/adr/PBL-SECURE-BOOT-DEPLOYMENT.md - docs/adr/PBL-C2-TPM-Contract.md - docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
