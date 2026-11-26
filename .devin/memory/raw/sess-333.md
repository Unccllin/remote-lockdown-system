# Session Capture — 2026-11-26 — sess-333

## Context
- Task: Fix D-225: bound the Worker's mutation queue so one stalled handler cannot wedge check-in and command-ack
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
- The mutation chain must bound the WAIT on the previous entry, not the handler: a Worker cannot cancel a promise, so bounding fn() is theatre while bounding the wait restores liveness. settleWithin() attaches both handlers (no unhandled rejection from an abandoned promise) and clears its timer.
- Rebuilding the chain from the new entry means an abandoned predecessor never re-enters the queue, so a stall costs one bounded wait rather than one per subsequent request.
- A wedged queue is invisible in normal telemetry: a device that cannot check in is indistinguishable from a powered-off device, so publishing the stall counter on /api/health is the operator signal, not a nicety.
- The serverless test suite's `worker` handle is `mod.default` (the handler object), so named exports (serializeMutation, mutationQueueStats) must be assembled into it explicitly or the tests fail with 'is not a function'.
- Teeth for a liveness fix needs a test that would HANG: the reverted version fails by timing out at vitest's 5 s bound, not by asserting a wrong value.

## Mistakes / Corrections
- mistake: five new tests failed with 'worker.mutationQueueStats is not a function' because I assumed named exports hang off mod.default; correction: read how the suite builds its worker handle before writing tests against module internals

## Open Questions
- <none recorded>

## File References
- serverless/worker.ts
- serverless/worker.test.ts
- docs/artifacts/s358-d225-mutation-queue.txt
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
