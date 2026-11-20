# Session Capture — 2026-11-19 — sess-307

## Context
- Task: Settle the session-0 BSSID question before coding option (c) of the S303 location artifact
- Environment: Windows 11 24H2+ location consent; LocalSystem service in session 0; MOLE hardware measurements from S303
- Duration: <not specified>

## Decisions Made
- do not build (c1) helper or (c2) Geolocator on documentation alone: read the platform rule and write it down first
- ruling (d): accept IP-level for service installs and document it (ADR-009)
- record helper and Geolocator as unproven-not-disproven with a concrete probe, not as rejected

## Actions Taken
- fetched the Microsoft Wi-Fi access and location page and quoted the consent rule
- wrote docs/artifacts/s308-session0-bssid-feasibility.txt (rule, our measurements, three routes, probe procedure)
- opened PENDING-RULING Q1, asked, marked [x] on (d), deleted the section once ADR-009 existed
- wrote ADR-009 + README Location Reporting section + privacy-policy qualification + serverless pointer + AGENTS.md paragraph
- committed c48fa77 (docs only, no source file)

## Outcomes
- What worked: - the MS page gives the decisive sentence: the prompt only appears in a user context outside System32
- separating 'what the docs say' from 'what this repo measured' made the gaps obvious
- What failed: - nothing failed; no code was written, so no suite was run (documented as such)
- What was unexpected: - consent can be set at DEVICE level per MS docs, which is why the question was genuinely open rather than settled by 'services cannot'
- the privacy policy claimed Wi-Fi access points are collected, which a service install cannot do at all

## Learnings
- a privacy policy is a specification of collection: qualify it when the platform can refuse, or it describes a capability the product does not have
- record unproven options as unproven with a probe, not as rejected on the merits

## Mistakes / Corrections
- mistake: earlier framed option (c) as 'architectural, needs design'; correction: it first needed a platform fact (can a service get BSSIDs at all), which documentation answered and measurement still has not

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s308-session0-bssid-feasibility.txt
- docs/adr/ADR-009-location-precision-by-install-type.md
- README.md
- docs/PRIVACY_POLICY.md
- serverless/README.md
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
