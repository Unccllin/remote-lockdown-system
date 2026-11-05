# Session Capture — 2026-11-05 — sess-216

## Context
- Task: Session 216: install on the real Windows machine FRANKENSTEIN to find out why enrolment kept failing.
- Environment: FRANKENSTEIN = 192.168.1.119, Windows 11 Pro 10.0.26300, user frankenstein\user (admin, elevated SSH), no Python initially; server = WSL on DESKTOP-G4PCDHH reachable at http://192.168.1.43:3001 via an existing Windows portproxy; Python 3.12 installed via winget on the target
- Duration: <not specified>

## Decisions Made
- Drive the real installer over SSH rather than hand-rolling steps, so the product path is what gets tested.
- Install Python on the target (winget) to run installer_gui.py --silent, since no CLI installer binary exists (S209).
- Keep verify_tls defaulting to True and require an explicit --allow-insecure-http for plain-HTTP lab servers; the served command adds it automatically when the server advertises http.
- Never guess a binary's platform: /api/download/agent now requires ?platform=.
- Prefer the installed exe over the source script when writing the scheduled task.

## Actions Taken
- Installed Python 3.12 + requests on FRANKENSTEIN, copied installer_gui.py/service_installer.py, ran the headless install repeatedly over SSH.
- Found and fixed seven defects: /TR 261-char limit (file-based watchdog), identity lost in headless mode (duplicate enrolments), Linux ELF served to Windows (WinError 216), http refused by the agent (verify_tls), watchdog pointing at a non-existent agent.py, IndexError parsing the command string, unbound tamper-protection names.
- Verified end to end: task created as SYSTEM, agent running, server recording check-ins.

## Outcomes
- What worked: - Each failure printed one precise line; running the same command after each fix turned a vague 'keeps failing' into seven concrete defects.
- The agent's own log named the http refusal verbatim, which led straight to the verify_tls gap.
- What failed: - I twice asserted the target was Linux from a single SSH banner (it was OpenSSH-for-Windows); and earlier sessions assumed a port was blocked when the real cause was the URL being wrong.
- What was unexpected: - The Windows portproxy and its firewall rule already existed, so the LAN path worked once the URL was right.
- FRANKENSTEIN had no Python at all, which is why the headless path had never been exercised there.
- Two agent processes ran simultaneously: nothing enforces single-instance.

## Learnings
- Environment assumptions (platform, TLS policy, schtasks limits, sys.frozen) are where installers break; unit tests cannot see them.
- Measure a machine's identity (detect-virt, TTL, SSH banner) instead of inferring it.
- A task that exits 0 may have started nothing; verify the process, not the exit code.

## Mistakes / Corrections
- mistake: inferred the target OS from a generic OpenSSH warning and told the user it was Linux; correction: verified with ttl=127 and SSH-2.0-OpenSSH_for_Windows_9.5.

## Open Questions
- <none recorded>

## File References
- agent/installer_gui.py
- agent/service_installer.py
- agent/tests/test_installer_gui.py
- agent/tests/test_service_installer.py
- server/src/routes/downloads.js
- server/src/routes/enroll.js
- server/tests/downloads.routes.test.js
- server/tests/enroll.routes.test.js
- dashboard/src/pages/EnrollDevicePage.jsx

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
