# Session Capture — 2026-11-26 — sess-344

## Context
- Task: D-230: stop serving a placeholder geolocation key on both backends, and document the Google Cloud restriction step
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
- The chosen option (restrict rather than move lookups server-side) is a cost decision for the owner; the code half is that a placeholder which cannot work must never be served, because handing it out turns the city-level fallback into a silent failure.
- One rule per deployable: servedGeolocationKey/geolocationKeyField in serverless/kv-store.ts and the same pair in server/src/lib/geolocationKey.js, duplicated because the backends share no module (same as the HMAC verifier and timing-safe compare).
- The boundary of 'placeholder' matters: matching /test/ classified 22 legitimate fixtures (test-google-key) as placeholders and broke two ruling-C tests. Grep the suites for the data a new rule classifies before choosing its pattern.

## Mistakes / Corrections
- mistake: first placeholder regex matched the word test, failing 22 fixtures worth of assumptions; correction: the fixtures are the specification of what placeholder should mean, so read them first

## Open Questions
- <none recorded>

## File References
- serverless/kv-store.ts
- serverless/worker.ts
- serverless/agent-routes.ts
- server/src/lib/geolocationKey.js
- server/src/routes/enroll.js
- docs/SERVERLESS-DEPLOY.md
- docs/artifacts/s370-d230-geolocation-key.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
