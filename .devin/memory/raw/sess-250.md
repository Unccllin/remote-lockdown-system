# Session Capture — 2026-11-06 — sess-250

## Context
- Task: Classify all 45 Semgrep findings: fix the real ones, record the rest with evidence, and make sast-gate.py enforce classification in both directions
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
- Semgrep OSS sets extra.lines and extra.fingerprint to the literal string 'requires login' for registry rules, so a gate must key on the source line read from disk
- path-join-resolve-traversal flags ANY function parameter reaching path.join; path.basename(), whitelist-table lookups and literal-returning config helpers do not sanitize it (measured with a probe) — the rule cannot be satisfied by hardening, only by removing the parameter or recording an exception
- getPlatformConfig already returns a whitelisted 'win'|'linux'; passing plat.platform instead of the raw query argument removes the latent traversal in the installer's cache path
- A .ps1 bootstrap served as text/plain needs X-Content-Type-Options: nosniff so a browser cannot sniff it into a document
- A gate that only prints findings nobody must act on is a half-gate; the exceptions file now fails both on unclassified findings AND on stale entries

## Mistakes / Corrections
- mistake: wrote the exceptions gate before any test for it, so it crashed on its first real run (sorted() key applied to a (finding, entry) tuple) — tests first would have caught it in seconds
- mistake: assumed AGENT_BINARIES_DIR override was exclusive in server/tests/paths.test.js; it is first-but-not-exclusive and falls through to the in-repo agent/dist, which this host has. agent.routes.test.js already warned about exactly this trap

## Open Questions
- <none recorded>

## File References
- scripts/sast-gate.py
- scripts/sast-exceptions.json
- scripts/test_sast_gate.py
- server/src/routes/installer.js
- server/src/config/paths.js
- server/src/routes/rearm.js
- server/tests/paths.test.js
- server/tests/installer.helpers.test.js
- server/tests/rearm.routes.test.js
- .github/workflows/lint.yml
- Makefile
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
