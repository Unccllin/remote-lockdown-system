# Session Capture — 2026-10-28 — sess-150

## Context
- Task: Find where the previous session ended and finish it: make the red CI/Lint workflows green
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
- check-run ANNOTATIONS are readable anonymously on a public repo while job logs are admin-only (403): GET /repos/{o}/{r}/check-runs/{id}/annotations — this is how all four CI-only failures were identified without a token or gh
- the bare 'pytest' console script does not put cwd on sys.path; 'python -m pytest' does. A conftest doing 'import agent' therefore works locally (run-agent-tests.sh uses -m) and dies on CI with conftest ImportError, which pytest reports as a USAGE error: exit code 4
- pytest has a native 'pythonpath = ["."]' ini option (7.0+) that makes collection independent of the invocation form — better than sys.path hacking in conftest
- actionlint in CI runs with shellcheck bundled (raven-actions/actionlint), so it lints every run: block; a box without shellcheck silently skips those checks and prints green — five SC2155 findings sat in a red Lint job while actionlint was 'clean' locally
- server tests depended on agent/dist/lockdown-agent, which is GITIGNORED: a fresh checkout has no binary, /api/agent/update short-circuits to 'no_binary_available' before hashing or signing, and 5 signature assertions fail. Any test reading a build artifact is a CI-only failure waiting to happen
- dashboard HealthPage test waited for a static card title then asserted a fetched value synchronously ('10 devices' renders as '0 devices' until the payload lands) — a real race that a slower runner loses; await the fetched value itself (findBy*) instead
- 'export X=$(cmd)' masks the command's exit status (SC2155) and also blinds error detection; assign then export
- graph_session.py only parses '## Session ...' headers, so a block written as '### S149' is invisible to gen-state and current-state keeps advertising the older session

## Mistakes / Corrections
- mistake: assumed the previous session's 'CI is red, cause unknown' needed a container repro of the CI runner (it hit a glibc mismatch and taught nothing) — correction: read the public check-run annotations first, they carried the exact error text
- mistake: treated 'passes locally' as evidence of correctness for three separate jobs — correction: reproduce in the CI's conditions (no build artifacts, no .env, node 20, bare pytest with pinned versions) before believing a local pass

## Open Questions
- <none recorded>

## File References
- scripts/ci-annotate.py
- scripts/test_ci_annotate.py
- .github/workflows/ci.yml
- .github/workflows/pbl-ci.yml
- server/tests/agent.routes.test.js
- dashboard/tests/HealthPage.test.jsx
- agent/pyproject.toml
- Makefile
- scripts/verify-environment.sh
- AGENTS.md
- .devin/graph/trace.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
