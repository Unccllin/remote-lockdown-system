# Session Capture — 2026-08-28 — sess-023

## Context
- Task: Hardware testing on HP machine + research test harness frameworks for redesign
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
- HP machine (DESKTOP-RUDJGI6) successfully enrolled via one-click installer downloaded from Worker
- Lockdown + recovery cycle verified on real hardware (status: locked → recovering → unlocked)
- Agent was killed when user closed terminal — fixed by building with console=False + file logging to C:\ProgramData\LockdownAgent\agent.log
- Windows Defender quarantines PyInstaller-built agent.exe — added Add-MpPreference exclusion in installer_gui.py
- Agent binary + installer hosted on Cloudflare KV, served via /api/download/installer and /api/download/agent
- Hardware UUID (B1198844-32B1-419B-B6BB-07371BE2DDD0) and MAC (74:70:FD:17:B7:67) collected at enrollment
- Serial number was null on HP — WMI query may need adjustment for this model
- Researched 30+ test frameworks: OpenHTF (best HIL), bench-vv (hash binding), f0_library (VHD isolation), FleetDM (command lifecycle), Windows-Red-Teaming (tri-mode)
- Decision: borrow 12 patterns rather than adopt a framework — redesign hw_test_harness.py to v2.0
- 12 patterns: phase lifecycle, service gating, tri-mode, hash binding, VHD isolation, command lifecycle, timeout, retry, CTRF JSON, tag filtering, evidence capture, rollback

## Mistakes / Corrections
- Built agent with console=True initially — closing the visible window killed the agent process. Fix: console=False in agent.spec
- Did not add Defender exclusion initially — PyInstaller exes trigger false positives. Fix: add_defender_exclusions() in installer_gui.py
- Agent only logged to stdout — when console=False, logs were lost. Fix: added FileHandler to C:\ProgramData\LockdownAgent\agent.log

## Open Questions
- <none recorded>

## File References
- agent/agent.py (console=False, file logging, --silent preserves file handler)
- agent/agent.spec (console=False)
- agent/installer_gui.py (add_defender_exclusions, download_agent_exe)
- agent/installer_gui.spec (no bundled agent)
- serverless/worker.ts (/api/download/installer, /api/download/agent, /api/enroll/token, hardware IDs, re-association)
- dashboard/src/pages/EnrollDevicePage.jsx (download buttons)
- dashboard/src/pages/DeviceDetailPage.jsx (hardware IDs display)
- AGENTS.md (harness research findings + redesign plan)
- scripts/hp-hardware-test-v2.sh (hardware test guide)

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
