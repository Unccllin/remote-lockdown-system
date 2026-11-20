# Session Capture — 2026-11-18 — sess-292

## Context
- Task: S289: capture hardware evidence that a console sign-in is REFUSED on a locked MOLE, and re-promote E-LOCK-SCREEN
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
- Windows writes the refusal itself: Security 4625 with LogonType=2 (console), Status=0xc000006e, SubStatus=0xc0000072 (STATUS_ACCOUNT_DISABLED). That is the artifact field that settles E-LOCK-SCREEN, not a description of a lock screen.
- SubStatus 0xc0000072 only appears after the password validates (S288 experiment), so it proves both the credential and the refusal.
- graph_assert.artifact_supports_claim reads CTRF-shaped JSON (results.tests[].name/status), so a hardware claim can be cited per test id instead of a prose file.
- The S284 WinRE fix held on this third real lockdown: bcd success true, 3 critical, 5 best-effort, no rollback.
- I5 rule_zero_quality requires at least 2 RULE-ZERO lines that START with '-' and contain a path; a single prose '**Read**:' paragraph fails the gate.

## Mistakes / Corrections
- mistake: the S289 session block's RULE-ZERO was one paragraph, so I5 failed after close-session; correction: write RULE-ZERO as '- **Read**: <path> — what it told me' bullets.
- mistake: the first artifact JSON contained a 'normalized_payload' key describing a pipeline that never existed; correction: re-read evidence files before citing them.

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s289-lock-screen-signin-refused.json
- .devin/graph/GRAPH-SPEC.yaml
- .devin/graph/trace.md
- agent/bcd_lockdown.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
