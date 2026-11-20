# Session Capture — 2026-11-18 — sess-284

## Context
- Task: S281: find the real reason MOLE cannot reach the lab server, after five sessions of naming the wrong mechanism
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
- The SSH route to MOLE is labadmin@192.168.1.249 with ~/.ssh/lockdown_lab_ed25519 (default id_ed25519 rejected, no ssh config alias).
- This host is native Arch/Omarchy (kernel 7.2.15-1-omarchy, no Windows interop), NOT WSL; it holds 192.168.1.43 on wlp0s20f3 directly, so no port proxy is needed anywhere. MOLE's netsh portproxy table is empty.
- The blocker is this host's ufw: ENABLED=yes, DEFAULT_INPUT_POLICY=DROP, allowed tcp 53317/8000/8787 only. Fix is 'sudo ufw allow 3001/tcp' and needs root.
- server/src/index.js cannot start without real secrets; the dev entry is server/dev-start-sqlite.js (SQLite + dev secrets, PORT=3001).

## Mistakes / Corrections
- mistake: repeated a blocker explanation (WSL port proxy) for five session blocks because each session re-measured the SYMPTOM (HTTP 000) but inherited the MECHANISM; correction: a blocker that names a mechanism must cite the command that showed the mechanism.
- mistake: started the server with node src/index.js and hit FATAL config validation; correction: dev-start-sqlite.js is the documented dev entry.

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s281-mole-reachability.txt
- .devin/graph/trace.md
- .devin/graph/current-state.md
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
