# Session Capture — 2026-11-06 — sess-255

## Context
- Task: Write the operator-facing half of the D-221 sunset — and correct the claim it was meant to announce (devices do NOT need updating; tokens do)
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
- The D-221 sunset breaks legacy TOKENS, not agent binaries: a pre-D-221 agent already sends device_id and the server binds from the authenticated device row, so old agent + new server works indefinitely
- The server records no agent version at all: /api/agent/update reads x-agent-version and discards it, checkin documents agent_version in the body, and devices has no column — grep -rn agent_version server/src returns one docstring
- tamper_protection.py's docstring documented verify_uninstall_token in the wrong argument order (token, device_id, server_url, api_key vs the real token, server_url, api_key, device_id); all real callers are correct, so it was a doc bug that would teach the next caller to write a broken one
- A plausible inference written into the trace's next-opening becomes the next session's premise — it must be checked against the call path before being recorded as fact

## Mistakes / Corrections
- mistake: S255 recorded 'every device must take an agent update before 2027-02-04' without reading the call path; it is false, and it sat in current-state.md where every session reads it first
- mistake: my first attempt to append the D-222 spec entry asserted on a string that did not match (the note ended with a quote char), and my comment-block edit left 'so it is where a new' dangling — both fixed by reading the file back instead of trusting the edit

## Open Questions
- <none recorded>

## File References
- docs/DEPLOYMENT.md
- docs/API.md
- docs/adr/PBL-DEBT-LEDGER.md
- .devin/graph/GRAPH-SPEC.yaml
- agent/tamper_protection.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
