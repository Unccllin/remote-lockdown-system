# Session Capture — 2026-11-17 — sess-279

## Context
- Task: Get worker.ts back under the harness 5000-line analysis limit so diagnostics can see it, by extracting http/admin-auth/installer-scripts modules in dependency order
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
- A file over the harness LSP limit reports too_large, not errors: it is invisible, which is worse than noisy. Measure wc -l against the limit before assuming a checker is quiet.
- Extraction order is forced by dependency direction: move zero-dependency primitives (response/hash/parse helpers) first, or the extracted module imports back from the file it came from and you get a cycle.
- Taking a validated URL object into a pure function removes the only throwing construction; the caller already has a total parser (requestUrl).
- Source-grep contract tests couple to file layout: when a value moves, the test must follow the value (and say why), not be deleted.
- The shell working directory can persist between tool calls; a cd that silently no-ops makes a later gate command run in the wrong place and produce alarming, irrelevant failures. Use absolute paths.

## Mistakes / Corrections
- mistake: read a dashboard test failure storm as a break in serverless code; the vitest run had executed from the repo root because cd serverless was a no-op in that shell. correction: check pwd / use absolute paths for gate commands.
- mistake: first brace-matching extractor stripped // comments before strings, so https:// inside a literal truncated the line and the matcher ran away. correction: strip strings/regex-free literals first, then comments; or slice between known declaration boundaries instead of counting braces.
- mistake: over-imported symbols into worker.ts after extraction (AdminClaims, PBKDF2_ITERATIONS) and had to remove them when the checker flagged them.

## Open Questions
- <none recorded>

## File References
serverless/http.ts, serverless/admin-auth.ts, serverless/installer-scripts.ts, serverless/worker.ts, scripts/test_cross_surface_contract.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
