# Session Capture — 2026-11-05 — sess-235

## Context
- Task: Session 235: find why the firmware aborts against the Node TLS front and get it posting to this deployment.
- Environment: QEMU firmware + provisioned swtpm; two TLS fronts on 127.0.0.1:9443 (Node and Python) forwarding to Express :3001; policy URI https://10.0.2.2:9443/v1/verdict; agent venv (cryptography, cbor2)
- Duration: <not specified>

## Decisions Made
- Change one variable at a time: TLS version and tickets first, then the TLS implementation.
- Keep the Node front (with its knobs and TLS event log) as documentation of EDK2's behaviour, and use the Python front for the working path.
- Validate per-request inputs in the new proxy (scheme re-check, Content-Length) rather than assuming startup checks cover them.

## Actions Taken
- Forced TLS 1.2 + no tickets on Node: unchanged (handshake then reset).
- Wrote a stdlib Python TLS front and ran the same firmware: the request arrives (149 bytes) and Express answers 404.
- Hardened the proxy: scheme re-check before urlopen with the repo's S310 pragma, Content-Length validation (400/413), ruff clean.
- Verified a malformed Content-Length returns 400 instead of crashing the handler.

## Outcomes
- What worked: - Swapping only the TLS implementation isolated the cause with two runs.
- The proxy's protocol/cipher logging is what makes 'which setting the firmware accepted' visible.
- What failed: - S234 recorded 'TLS works' when what was true was 'TLS works with that server'.
- What was unexpected: - The firmware receives our 404 and reports HTTP Error rather than aborting, which proves the whole path and clarifies the remaining gap (enrolment).

## Learnings
- Attribute transport success to the specific peer that proved it.
- EDK2's client is picky in a way that survives version/ticket changes; the implementation matters.
- Validate per-request inputs even when startup validation exists.

## Mistakes / Corrections
- mistake: read S232's success as evidence about TLS in general; correction: re-ran with the implementation swapped and recorded the distinction.

## Open Questions
- <none recorded>

## File References
- scripts/firmware-tls-proxy.py
- scripts/firmware-tls-proxy.js
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
