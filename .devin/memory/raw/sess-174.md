# Session Capture — 2026-11-02 — sess-174

## Context
- Task: Finalise the Docker deploy path: build a local end-to-end stack verification, fix the red docker-live env gate
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
- The API E2E suite boots Express in-process on SQLite via supertest; nothing exercised the shipped image against PostgreSQL 16, the static dashboard in the container, or the agent ingress through the container. scripts/verify-docker-stack.sh now does: build image, up postgres+server under its own compose project with a loopback-only port override, wait for /api/health/ready, then 10 HTTP checks (health, 401 without token, dashboard text/html, create-admin 201, login JWT, devices 200, enrolment agent key, agent checkin 200 with key, checkin 401 with bogus key, second create-admin 403).
- make full-verify's only red was docker-live, and it hid the cause: docker compose up failed because Tailscale holds :443 on this host, so Caddy could not bind and the atomic up took postgres+server down with it. validate-docker.sh --live now delegates to the smoke script and prints the log tail instead of >/dev/null.
- Two smoke assumptions were mine, not the deployment's: POST /api/setup/create-admin returns success and NO token (must then POST /api/auth/login), and the device key travels in the x-agent-key header, not the body. REQUIRE_HMAC is unset, so unsigned agent requests are allowed in transition.
- Caddy/TLS cannot be verified locally (needs a real domain + ACME); everything else in the Docker path now is.

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- scripts/verify-docker-stack.sh
- scripts/validate-docker.sh
- Makefile
- docs/DEPLOYMENT.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
