# Session Capture — 2026-10-30 — sess-158

## Context
- Task: Explain why an UNLOCKED verdict still ended in BLOCK, and make the decision engine say why
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
- Decision.c had zero PBL_DEBUG prints, so 'build a DEBUG PblApp to see the rationale' was a plan against a capability that did not exist. For C changes the build log is the authority, not the linter.
- The BLOCK on an UNLOCKED verdict is Decision Step 5 (REQ-01): Secure Boot disabled on the QEMU platform. Correct behaviour, not a verdict bug.
- Consequence: the PASS path cannot be demonstrated until Secure Boot is enabled (signed PblApp + enrolled keys), so D-130 gates both release hygiene and the last unproven behaviour.
- A security decision engine that can refuse to boot with no stated reason is a verification gap by construction: instrument the refusal path itself, unconditionally, because on a locked machine the serial log is the only channel.

## Mistakes / Corrections
- My first insertion of the diagnostics block split 'STATIC / EFI_STATUS' from PblGetUnixTime's name, breaking the build. Insert before the section banner, not before a function name.
- Read an inconclusive cascade warning while the build had already failed; checked the linter before the build log.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/Decision.c
- firmware/PblPkg/artifacts/d200-decision-basis-results.txt
- firmware/PblPkg/artifacts/d200-decision-basis-serial.log
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
