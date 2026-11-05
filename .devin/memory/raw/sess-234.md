# Session Capture — 2026-11-05 — sess-234

## Context
- Task: Session 234: point the QEMU firmware at this deployment's TLS front and locate where it stops.
- Environment: pbl-qemu container with --network host; Node TLS proxy on 127.0.0.1:9443 → Express :3001; policy URI https://10.0.2.2:9443/v1/verdict; provisioned swtpm state; artifacts mounted at /test/build
- Duration: <not specified>

## Decisions Made
- Add an external-server mode to the existing harness instead of duplicating its QEMU recipe.
- Make the harness prove only what this run produced: record the proxy log size before boot and match the appended tail.
- Log TLS events in the proxy rather than inferring failure from a missing request line.

## Actions Taken
- Implemented --external-server/--proxy-log with a fresh-log offset and a server-log guard.
- Added tlsClientError/secureConnection logging including protocol and cipher.
- Ran the firmware against the proxy: policy parsed (1518 B), CA pinned (386 B), TLSv1.2 established, then Aborted with ECONNRESET before any HTTP request.

## Outcomes
- What worked: - The serial log and the proxy's TLS log together pin the boundary to 'after handshake, before request'.
- The fresh-log offset turned my false PASS into an honest FAIL.
- What failed: - My first external run reported PASS on evidence an earlier probe had left in the log.
- What was unexpected: - The firmware completes TLS with our CA pinned but aborts the HTTP exchange, while the same firmware works with the harness's Python TLS server.

## Learnings
- A harness must distinguish evidence it produced from evidence that was already there.
- 'TLS works' is server-specific; record which server proved it.
- Log the transport layer's events, or a missing request is ambiguous.

## Mistakes / Corrections
- mistake: grepped a shared log and counted a prior run's POST as this run's; correction: offset-based matching with an explicit 'nothing appended' failure.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/test-d131-wire-harness.sh
- scripts/firmware-tls-proxy.js
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
