# Session Capture — 2026-11-04 — sess-202

## Context
- Task: Session 202: implement the D-116 ruling — enforce the TLS 1.2 floor at the terminator, prove it, and reconcile the ledger with the graph spec.
- Environment: repo=remote-lockdown-system; files=Caddyfile, scripts/test_tls_floor.py (new), serverless/README.md, docs/adr/PBL-DEBT-LEDGER.md, .devin/graph/GRAPH-SPEC.yaml, .devin/PENDING-RULING.md; docker + openssl available; local edk2 checkout
- Duration: <not specified>

## Decisions Made
- Enforce the floor server-side (owner ruling) and document that the device cannot: PBL holds only EFI_HTTP_PROTOCOL and TlsDxe defaults to TLS 1.0.
- State the protocol range explicitly in Caddyfile rather than relying on Caddy's default, so the floor is auditable and testable.
- Build the test around the OpenSSL-3 vacuity trap: force the TLS1.0 offer with SECLEVEL=0 and treat 'no protocols available' as a failure.
- Close D-116 in BOTH records and update GRAPH-SPEC's commit_ref/artifact_ref to evidence that resolves.

## Actions Taken
- Added protocols tls1.2 tls1.3 to Caddyfile and validated the real file with docker caddy validate.
- Wrote scripts/test_tls_floor.py (2 tests: config states the floor; a terminator with it refuses 1.0/1.1 and accepts 1.2/1.3).
- Falsified by lowering the floor to tls1.0 (both tests fail) and restored.
- Documented Cloudflare's zone Minimum TLS Version in serverless/README.md.
- Found and repaired the D-116 markdown/spec status drift; recorded the ruling in PENDING-RULING.md as closed.

## Outcomes
- What worked: - Probing the actual handshake behaviour before writing assertions revealed the vacuity trap (client refusing to offer), which a naive test would have hidden.
- Extracting the protocols line from the repo Caddyfile ties the behavioural test to the real config instead of a copy.
- graph_assert's I2 forced honest refs: the old closure cited a log showing an http:// fetch.
- What failed: - Initially edited the markdown ledger to say D-116 was OPEN when GRAPH-SPEC (the authoritative record for invariants) had it CLOSED; two sessions were spent on the non-authoritative file.
- What was unexpected: - The markdown ledger and the graph spec disagree on at least two items (D-116, D-117), and nothing checks them, so invariants stayed green while the human record said the opposite.
- Caddy validates 'protocols tls1.2 tls1.3' fine, and Caddy's default already excludes TLS<1.2 — but the default is invisible to an auditor.

## Learnings
- Check which record is authoritative before editing a status: graph_assert reads GRAPH-SPEC, not the markdown ledger.
- A TLS-floor test that does not force the client offer proves nothing; distinguish 'client refused' from 'server refused'.
- Enforce protocol floors at the terminator you control when the client structurally cannot.

## Mistakes / Corrections
- mistake: rewrote D-116 as OPEN in the markdown during S200/S201 without checking GRAPH-SPEC's status field; correction: closed it consistently in both files with resolving evidence, and recorded the drift as a harness gap.

## Open Questions
- <none recorded>

## File References
- Caddyfile
- scripts/test_tls_floor.py
- serverless/README.md
- docs/adr/PBL-DEBT-LEDGER.md
- .devin/graph/GRAPH-SPEC.yaml
- .devin/PENDING-RULING.md
- firmware/PblPkg/artifacts/d116-tls-floor-server-side.txt
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
