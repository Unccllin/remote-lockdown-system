# Session Capture — 2026-11-06 — sess-253

## Context
- Task: Close D-221: device-bound uninstall token with a shared vector file, identical across Express and Worker, 503 when ADMIN_TOKEN is unset, constant-time compare, legacy scheme accepted for one release
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
- The binding id must come from the authenticated device row, never the request body, or the property becomes 'does the caller claim an id' rather than 'is this that device'
- Both surfaces could do the same derivation with no new storage because a caller always authenticates as something (device key -> row on both; getDeviceByApiKeyHash / listDevices)
- The Worker already had hmacSha256 and timingSafeEqualStr, so the Worker half was a few lines
- Dual-accept (Q2-A) is affordable only because the agent sends device_id already and the binding comes from the row — the agent needed no change
- A single vectors file read by both suites plus a python recompute is the durable form of 'these two surfaces agree'; a suite that pins whatever the code does is not a contract

## Mistakes / Corrections
- mistake: assumed the AGENTS.md serverless count (331) was current; measured 420 — the fourth stale number found in that same paragraph across three sessions
- mistake: my first API.md edit used |---|---| table separators and an unlabelled code fence, which the markdown checks then flagged; the file's own style is | | | + |--|--|
- note: three pre-existing Worker destructure-to-omit bindings blocked the delta check until they carried the _ prefix — harness-forced edit, behaviour identical

## Open Questions
- <none recorded>

## File References
- server/src/routes/agent.js
- server/tests/uninstallAuth.test.js
- serverless/worker.ts
- serverless/worker.test.ts
- docs/adr/D-221-token-vectors.json
- scripts/test_cross_surface_contract.py
- docs/API.md
- docs/openapi.yaml
- docs/adr/PBL-DEBT-LEDGER.md
- .devin/graph/GRAPH-SPEC.yaml
- .devin/PENDING-RULING.md
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
