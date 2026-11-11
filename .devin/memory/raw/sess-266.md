# Session Capture — 2026-11-11 — sess-266

## Context
- Task: Unblock the two verification gates that 'could not run here' (Playwright E2E, Semgrep) + install and launch the Electron admin app
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
- Playwright E2E passes 11/11 on this host after THREE separate blockers cleared: missing libnspr4/libnss3 (extract Ubuntu .debs to ~/.local/lib/nspr with apt-get download + dpkg-deb -x, no root), a hardcoded port 3001 in dashboard/e2e/fixtures.js that collided with an unrelated project (now E2E_BACKEND_PORT, vite proxy follows), and dashboard/.env's VITE_API_URL pointing at the deployed Worker which made every authenticated test 401 against PRODUCTION (playwright webServer now forces VITE_API_URL:'').
- A Playwright trace zip is the fastest way to see what the browser actually called: unzip and read *.network, filter /api/ URLs. That is how the production-URL leak was found after reading source failed to explain it.
- Semgrep's C parser cannot read EDK II C (EFIAPI after return type, unresolved typedefs) -> 17 files yield no findings and look clean. sast-gate.py now prints a coverage NOTE naming them; reported, not gated, because a permanently-red gate gets ignored.
- electron@42 install.js require()s ESM-only @electron/get -> ERR_REQUIRE_ESM on Node 20, leaving node_modules/electron/dist empty with no error the user sees. Run the install under Node >=22/24.
- Electron from source is always 'dev' (isDev = ELECTRON_IS_DEV==='1' || !app.isPackaged), so it loads the Vite dev server; the bundled static-server path exists only in a packaged build.
- The Electron config's worker_url must include the /api suffix: the dashboard uses it verbatim as the axios baseURL, so a bare worker URL renders the UI but 404s every call.

## Mistakes / Corrections
- mistake: piped a command whose exit code mattered (make sast | tail), so 'exit 0' was tail's status and two runs were misreported as passing; correction: run without a pipe or check PIPESTATUS, and read the output's verdict line.
- mistake: seeded Electron config with the bare worker URL (no /api) and only noticed because a probe returned 404.
- mistake: pkill -f PATTERN repeatedly matched my own shell's command line (the pattern appeared in the command I was running) and SIGTERM'd the session; correction: kill by PID from /proc, matching the exact binary path, not a substring that my command line also contains.

## Open Questions
- <none recorded>

## File References
dashboard/playwright.config.js, dashboard/vite.config.js, dashboard/e2e/fixtures.js, scripts/sast-gate.py, scripts/test_sast_gate.py, AGENTS.md, ~/.local/bin/remote-lockdown-admin, ~/.local/share/applications/remote-lockdown-admin.desktop, ~/.config/remote-lockdown-admin/config.json

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
