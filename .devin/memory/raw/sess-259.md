# Session Capture — 2026-11-06 — sess-259

## Context
- Task: Run the D-129 hardware window on FRANKENSTEIN: four enforcement paths moved from verified-in-unit-test to verified-on-hardware (3/13 -> 7/13)
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
- The four tagged harness tests use an in-process _StubServer with patched temp dirs, so a window needs no running server, no enrolment, no port proxy — the hard part was transferring 740KB to a machine with no git
- artifact_supports_claim() accepts both 'pass' and 'passed' case-insensitively; checked before citing because a mismatch would have made every window artifact uncitable
- FRANKENSTEIN cannot see \\wsl.localhost, is not on the tailnet, and the WSL host's C: is a different computer's C: — the only channel that already worked was the existing Windows port proxy 0.0.0.0:3001 -> WSL:3001, so serve a zip there and POST the artifact back
- E-TRACK's hardware run used the IP fallback ('ip, ~citym'), not a netsh WiFi scan: the path is hardware-verified for the reporting flow including the TLS-only IP lookup, not for the scan branch
- defender_exclusion was null on a real install, contradicting AGENTS.md

## Mistakes / Corrections
- mistake: my first two GRAPH-SPEC edits broke the YAML (a '\#' unknown escape, then a block scalar indented shallower than its key); the third was rebuilt as build -> parse -> refs byte-exact -> widths -> write, which is what caught the failure before writing
- mistake: wrote VERIFY-style numbers into the trace before the run reported in an earlier session; this session the artifact sha256 and test counts were taken from the actual files
- mistake: left an empty C:\Users\CLLIN\rls-hw-window behind (9p holds the handle so Remove-Item fails with IOException); recorded rather than claimed clean

## Open Questions
- <none recorded>

## File References
- agent/hw_test_artifact_frankenstein_win.json
- .devin/graph/GRAPH-SPEC.yaml
- AGENTS.md
- scripts/hw-window-preflight.py
- docs/D-129-HARDWARE-RUNBOOK.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
