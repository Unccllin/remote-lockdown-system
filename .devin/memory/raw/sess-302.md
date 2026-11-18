# Session Capture — 2026-11-18 — sess-302

## Context
- Task: S303: diagnose why location maps to the wrong place
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
- The map is faithful: rows are source 'ip' with identical coords every time, and ipwho.is returns exactly those coords for the egress IP 41.90.239.213 (Karatina, Kenya, Safaricom). IP geolocation reports the ISP's booked location, so every device behind that egress plots the same dot.
- WiFi triangulation is unavailable to a service install: netsh wlan show networks mode=bssid needs a location-capable interactive session; it returns 0 SSIDs/BSSIDs with 'Access is denied' even after HKLM+HKCU consent Allow and an lfsvc restart. Agent runs as LocalSystem in session 0.
- The Worker has no google_api_key provisioning (Express does, installer.js:562), so a serverless fleet is IP-only by omission.
- The dashboard drops source/accuracy/age, so a city-level guess renders as a confident pin.

## Mistakes / Corrections
- mistake: tried three registry settings and a SYSTEM scheduled task before concluding; MOLE's Task Scheduler is known-broken (service_host.py documents it), so that probe was never going to produce evidence.

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s303-location-diagnosis.txt
- agent/agent.py
- dashboard/src/pages/DeviceDetailPage.jsx
- server/src/routes/installer.js

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
