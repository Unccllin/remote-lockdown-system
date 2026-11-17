# Session Capture — 2026-11-17 — sess-281

## Context
- Task: Extract the Worker storage layer (devices/commands/secrets/locations/audit + their types) out of worker.ts into serverless/kv-store.ts
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
- A cohesive contiguous block with one dependency direction (only Env + the zero-dependency helper module) is the right unit to extract next: it keeps the split acyclic and the ADR comments travel with the code.
- Derive an extracted module import list from actual usage in the host file (scan the body for each export) instead of hand-writing it: 97 exports, 42 referenced.
- Source-grep contract tests break on any move; repoint them at the value not the path, and keep asserting the contract.
- After a scripted multi-file edit, grep the file to confirm the edit landed: a regex that matches nothing still prints success.

## Mistakes / Corrections
- mistake: sliced the interface block using the first banner-comment match in the file instead of the one after the interfaces, producing an empty slice; the stores moved without their types and tsc reported 33 missing names.
- mistake: import-pruning regex used patterns that did not match the real text, so four unused imports survived; the linter caught what my script claimed to have removed.
- mistake: assumed tsc exit 0 meant no unused imports (noUnusedLocals is not enabled in that tsconfig), so the linter was the first to see them.

## Open Questions
- <none recorded>

## File References
serverless/kv-store.ts, serverless/worker.ts, scripts/test_cross_surface_contract.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
