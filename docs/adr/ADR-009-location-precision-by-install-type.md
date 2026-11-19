# ADR-009 — Location precision by install type (a service install is IP-level, by design)

**Status**: accepted (2026-11-19, session 308)
**Supersedes**: nothing
**Relates to**: ADR-004 (per-entity location reports), ADR-008 (geolocation key delivery)
**Constrains**: `README.md`, `docs/PRIVACY_POLICY.md`, `serverless/README.md`;
`agent/agent.py`'s `scan_wifi_networks()` keeps its existing fallback behaviour unchanged

## Context

S303 measured why the fleet map looked wrong: a device's location rows were `source: 'ip'` with
`accuracy_meters: null` and identical coordinates, because IP geolocation reports the ISP's booked
location. S304 fixed the presentation (source, accuracy and an explicit "Approximate — IP-based fix"
label). S306 made the Google Geolocation key reach a token-flow install on both surfaces.

What remained was option (c) of `docs/artifacts/s303-location-diagnosis.txt` §5: "capture BSSIDs
another way on service installs". That cannot be decided without knowing whether a session-0 service
can obtain BSSIDs at all. The reading is in
`docs/artifacts/s308-session0-bssid-feasibility.txt`, and the answer is no, for a documented reason:

- Microsoft's *Changes to API behavior for Wi-Fi access and location* says the BSSID-returning calls
  (`WlanGetAvailableNetworkList`, `WlanGetNetworkBssList`, `WlanScan`, and
  `WlanQueryInterface` with `wlan_intf_opcode_current_connection`) return `ERROR_ACCESS_DENIED`
  without precise-location consent, that consent can be set at device, user or individual-app level,
  and that the consent prompt is shown only when "the process is running within the user's context
  and outside of the `C:\Windows\System32` folder".
- A `LocalSystem` service in session 0 satisfies neither condition: it can never prompt, and it can
  hold no app-level consent. Device-level consent is the only possible foothold, and S303 measured on
  MOLE that the scan is still refused with the HKLM consent value set to `Allow`.

## Decision

**A Windows service install reports `source: 'ip'` and that is the product's stated behaviour**, not
a defect to work around. Documentation, not code, carries this from here on:

- `README.md` gains a **Location Reporting** section: a table of install type → source → precision,
  the platform rule in one sentence, and the citation.
- `docs/PRIVACY_POLICY.md` qualifies what is actually collected: Wi-Fi access points are collected
  only "where the operating system permits the scan", and an `ip` fix carries no accuracy radius.
- `serverless/README.md` points at this ADR instead of asserting the limitation without a source.
- `AGENTS.md` carries a one-line pointer so a future session does not re-open the BSSID question.

No agent behaviour changes: `scan_wifi_networks()` already falls back to IP when the OS refuses, and
S304's UI already labels the result approximate.

## Consequences

- **The map is honest but not precise on service installs.** Operators who need precision must run an
  interactive install with `GOOGLE_API_KEY` provisioned (ADR-008) on a platform whose consent is
  available to that session. This is documented rather than promised.
- **The alternative paths stay unproven, not disproven.** Neither "session-0 `LocalSystem` with
  device-level consent" nor "`Geolocator` called from the service" has ever been measured in this
  repo; the evidence ladder puts both at `spec-checked`. They are recorded as future options, with
  the probe procedure in §5 of the artifact, so choosing one later starts from measurement.
- The Google key keeps its value for the interactive installs it can actually help, which is what
  ADR-008 delivered.

## Alternatives rejected (for now)

- **Probe first, then decide.** Cheapest to accept was documentation; the probe needs hardware time
  and a way to run as `LocalSystem` that does not use Task Scheduler (broken on MOLE, B-073). Kept as
  the documented next step, not rejected on the merits.
- **In-session helper now** (a per-user process scanning at logon and writing a file the service
  reads). Helps only while a user is logged on, is unproven on this platform, and needs its own
  ruling because B-075 forbids the *agent* being a Run key or scheduled task — a separate helper is a
  different actor, which is a decision, not a workaround.
- **Geolocator from the service.** Microsoft's own recommended replacement for Wi-Fi scans, and it
  would need no Google key. Untested from session 0, so it cannot be promised; the probe in §5
  measures it in one call.

## Verification

Documentation-only change. Evidence for the claim: the Microsoft page (quoted in
`docs/artifacts/s308-session0-bssid-feasibility.txt` §1) plus S303's measured refusals (§3 of the same
file). The repository is unaffected functionally: no source file changes, so the existing suites keep
their standing — server 882, agent 976, dashboard 272, worker 490, electron 30, API E2E 14.
