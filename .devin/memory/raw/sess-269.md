# Session Capture — 2026-11-17 — sess-269

## Context
- Task: Resume the MOLE lifecycle fixes: the installer/re-install defect S269 had recorded as 'the exit code lies', plus the open lifecycle defects it produced
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
- The re-install never ran: setup-inner.ps1 copied lockdown-service.exe over a running service, Copy-Item threw, $ErrorActionPreference='Stop' aborted before the installer started, and the wrapper printed the PREVIOUS run's install.log as this run's output. Exit 1 was correct; the artifact was stale. Any report must carry provenance (which run produced this line). 
- With the copy removed the installer crashed for a second lock: PermissionError WinError 32 on lockdown-agent.exe (the running agent holds its own image). installer.py::_copy_binary now lifts both locks (tamper protection + running image via service_installer.stop_service) and install_files uses it for both binaries. 
- A native child's stderr is a TERMINATING error under $ErrorActionPreference='Stop' in Windows PowerShell 5.1: the trap fired mid-run and kept one line. Start-Process -RedirectStandard{Output,Error} is the only reliable capture. 
- Windows PowerShell 5.1 rejects try{} as a hashtable VALUE (IncompleteHashLiteral) and rejects multi-line scripts on stdin (-Command - executes statement by statement); -EncodedCommand dies at the ~8KB command line. Use scp + -File. 
- S269's poll-interval fix (300->60s) landed in handlePing (/api/ping, legacy) while handleAgentCheckin (/api/agent/checkin, the agent's path) kept ADAPTIVE_POLL active:300 — MOLE logged '30s -> 300s' AFTER the fix. Both now share activePollSeconds(). 
- Plain-HTTP installs were broken: the agent requires verify_tls=false, the installer owns that via --allow-insecure-http, Express passed it, the Worker did not, and the post-install config patch could only run after the install that failed. 
- lockdown_effective/boot_lock_status were written onto the command record and unreadable: added GET /api/devices/:id/commands on both surfaces.

## Mistakes / Corrections
- mistake: trusted the S269 record that the install completed. correction: measure the artifact's provenance before believing a log printed next to a failure. 
- mistake: added a trap for a condition I had not reproduced end to end; it changed the failure mode instead of removing it (stderr became the abort). correction: reproduce, then fix the layer that is actually failing. 
- mistake: ran the acceptance harness against a live device and treated its first FAIL as a device fault; it was my own 60s limit fighting the server-driven 300s interval. correction: a harness that fails a healthy device is a harness bug — assert with a floor and print both numbers.

## Open Questions
- <none recorded>

## File References
- agent/installer.py
- agent/service_installer.py
- agent/tests/test_installer.py
- agent/tests/test_service_installer.py
- serverless/worker.ts
- serverless/worker.test.ts
- serverless/enroll-setup.test.ts
- serverless/device-commands.test.ts
- serverless/pbl/env.ts
- server/src/routes/devices.js
- server/tests/devices.routes.test.js
- scripts/acceptance_lifecycle.py
- scripts/acceptance_probe.ps1
- scripts/test_acceptance_lifecycle.py
- docs/artifacts/s270-acceptance-enroll.json
- .devin/graph/trace.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
