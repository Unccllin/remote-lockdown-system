# Session Capture — 2026-11-19 — sess-311

## Context
- Task: Push 23 unpushed commits and get CI green: triage the secret-scan finding and the SAST baseline
- Environment: GitHub Actions (CI + Lint + CodeQL), semgrep installed in /tmp/sgvenv, gh authenticated
- Duration: <not specified>

## Decisions Made
- redact the expired single-use token forward instead of rewriting history
- delete the stale exception rather than re-point it, because the finding moved not the line
- verify sast locally with a throwaway semgrep venv before pushing, since match strings are byte-exact keys
- label the pre-existing 0c13b19 CI failure as attribution-unknown rather than claiming my commits fixed it

## Actions Taken
- pushed 272b7fa (23 commits), 9ff542c (wizard), c330b3f (redaction), f96f7ef (sast triage)
- reproduced the secret finding locally, found it was a 900s-TTL enrollment token in S301's block
- added 3 dispositions with code-checkable reasons, deleted 1 stale entry, bumped reviewed to S312
- updated AGENTS.md: 45->48 findings, and how to run the gate locally

## Outcomes
- What worked: - reading each finding's code before writing a disposition meant the reasons cite line numbers and guards
- running the real semgrep locally caught nothing wrong, which is the point: the push then went green first time
- What failed: - my AGENTS.md guardrail example reproduced the very token fragment it warned about (WARN assigned-secret in fixture/example); amended before push
- What was unexpected: - two of the four SAST items were false positives guarded by checks a few lines above
- master's CI had been failing Server+Dashboard tests before the push, and passes now without a reproduction

## Learnings
- a gate whose tool is absent locally exits nonzero but nobody reads it; CI is then the only measurement and the doc drifts
- match-keyed exception files need byte-exact lines, so verify with the real binary instead of guessing

## Mistakes / Corrections
- mistake: wrote a 'never paste credentials' rule whose example pasted the credential; correction: illustrate the shape only

## Open Questions
- <none recorded>

## File References
- scripts/sast-exceptions.json
- AGENTS.md
- .devin/graph/trace.md (S301 token redacted)

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
