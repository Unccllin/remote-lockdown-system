# Session Capture — 2026-11-19 — sess-313

## Context
- Task: Run the §5 BSSID probe on MOLE over SSH and settle ADR-009 on hardware
- Environment: MOLE Win10.0.26300, consent Allow, console session 1 active, SSH labadmin session 0, temp services for SYSTEM
- Duration: <not specified>

## Decisions Made
- measure the numeric WLAN API return codes instead of netsh exit status, which cannot distinguish denial from no-interface
- take the SYSTEM measurement via a temporary sc create service using cmd.exe as the binPath
- treat consent=Allow as the strongest test case: denial there settles it
- reject option (c2) on hardware evidence rather than leaving it as a hope

## Actions Taken
- qwinsta + consent check to establish the environment
- control run as elevated admin session 0: WlanGetNetworkBssList rc=5
- SYSTEM via temp service: rc=5, identical
- SYSTEM Geolocator: 0x80070005 E_ACCESSDENIED
- deleted every temp service; wrote s315 artifact, updated ADR-009 and AGENTS.md, asserted B-183

## Outcomes
- What worked: - Add-Type C# P/Invoke gave numeric rc values, which made the result unambiguous
- the cmd.exe service wrapper worked where powershell.exe as binPath never started a process
- What failed: - first service batch lost whoami/netsh output through SCM redirection; netsh exit 1 was uninformative
- AsTask needed the concrete Geoposition generic argument, not Object
- What was unexpected: - WlanOpenHandle and WlanEnumInterfaces succeed (rc=0) while the BSS-list call is denied: the interface is visible, the BSSIDs are not
- Geolocator fails for SYSTEM too, which kills the 'no Google key on Windows' hope

## Learnings
- netsh exit codes cannot separate permission denial from other failures; use the API return code (5 = access denied)
- a service binPath of powershell.exe may never start; wrap it in cmd.exe /c and the same command runs

## Mistakes / Corrections
- mistake: first assumed the empty batch output meant denial; correction: it meant the redirect channel was unreliable, so I moved to numeric API codes

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s315-bssid-probe-hardware.txt
- docs/adr/ADR-009-location-precision-by-install-type.md
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
