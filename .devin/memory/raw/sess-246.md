# Session Capture — 2026-11-05 — sess-246

## Context
- Task: Session 247: try to reconcile the remaining Dependabot highs that npm audit cannot reproduce.
- Environment: repo at 0a0bcbf; electron now ^42.11.18; Node 20; no GitHub API access/token; agent venv with pip-audit
- Duration: <not specified>

## Decisions Made
- Measure each plausible surface instead of reasoning about it.
- Record the negative result, so a later session does not repeat the same search.

## Actions Taken
- Ruled out Actions pins (all SHA-pinned), Docker bases (current), Python deps (current, pip-audit clean).
- Audited the pre-fix electron lockfile with npm's DB: only low/moderate, zero high — disproving my per-advisory hypothesis.
- Recorded the likely explanation (Dependabot uses the GitHub Advisory Database, which npm's audit does not fully serve) as a hypothesis needing the Dependabot page.

## Outcomes
- What worked: - Measuring the pre-fix lockfile was the decisive test and took one command.
- Each ruled-out surface is now documented rather than re-guessed.
- What failed: - My first explanation (two packages counted per advisory) was wrong, and only measurement showed it.
- What was unexpected: - npm audit on the lockfile reports no highs at all while the installed tree did — the two data sources genuinely differ.

## Learnings
- npm audit clean does not imply Dependabot clean; they use different advisories.
- Negative results are worth recording; they bound future searches.
- A hypothesis that survives reasoning often dies to one measurement.

## Mistakes / Corrections
- mistake: presented the per-advisory explanation as if established; correction: tested it against the pre-fix lockfile and recorded it as disproved.

## Open Questions
- <none recorded>

## File References
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
