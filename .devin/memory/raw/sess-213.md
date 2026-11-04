# Session Capture — 2026-11-04 — sess-213

## Context
- Task: Session 213: enrolment 'keeps failing' — the installer defaulted to the deployed Worker instead of the operator's server, and the Windows peer has no sshd so the offered access needs one step first.
- Environment: repo=remote-lockdown-system; live API :3001 (tailnet 100.99.13.53); Windows peer 100.104.11.34 (SSH alias win, user newark, sshd not running); files=agent/installer.py, agent/installer_gui.py, agent/tests/test_installer.py
- Duration: <not specified>

## Decisions Made
- Remove the baked-in Worker default from both installers; require the operator to state the server, because a prefilled-but-wrong value is worse than an empty field.
- Make the CLI's silent mode fail with the exact flag to pass, and the GUI refuse at the enrollment step with an example URL.
- Switch PUBLIC_SERVER_URL to the tailnet address, since the two machines are on different subnets.
- Do not claim access to the Windows box: sshd is not running (port 22 times out), so driving it needs an enablement step first.

## Actions Taken
- Read the API request log: 156 requests, exactly one from the Windows peer (GET /api/download/installer in Chrome), zero claims.
- Found DEFAULT_SERVER_URL hardcoded to the Worker in both installers and prefilled in the GUI URL field.
- Emptied both defaults, added guards with actionable messages, added 2 tests (agent 772 green, ruff clean).
- Verified the tailnet path end-to-end (tailscale ping, wizard download over 100.99.13.53).

## Outcomes
- What worked: - The request log answered 'did the client call us, and as whom' in one pass; the user-agent (Chrome) showed it was a browser download, not the installer.
- Probing service ports established that SSH access is currently impossible rather than assuming it.
- What failed: - Three sessions (211-213) treated this as a token/URL problem before reading the access log; the log was the cheapest oracle and should have been first.
- What was unexpected: - The wizard's Server URL field was prefilled with the public Worker, so 'token rejected' came from a completely different server.
- The Windows peer's SSH was configured previously (alias win) but sshd is not running now.

## Learnings
- Check the request log before theorising about tokens, TLS, or firewalls.
- Never ship a default backend in an installer: the default silently decides which server a device joins.
- A prefilled wrong value is worse than an empty field because it removes the operator's reason to look.

## Mistakes / Corrections
- mistake: spent S211/S212 fixing token semantics and URLs while the installer was talking to the Worker; correction: read the request log first, then fix the default.

## Open Questions
- <none recorded>

## File References
- agent/installer.py
- agent/installer_gui.py
- agent/tests/test_installer.py
- server/.env
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
