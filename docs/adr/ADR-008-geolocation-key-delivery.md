# ADR-008 — Google Geolocation key delivery at install time

**Status**: accepted (2026-11-19, session 306)
**Supersedes**: nothing
**Extends**: ruling C of the geolocation ruling (S306; the ruling text is recorded in
`.devin/graph/trace.md` §"Session 306" and `docs/artifacts/s306-geolocation-key-delivery.txt` §2 —
the live `PENDING-RULING.md` deletes answered sections by design)
**Relates to**: ADR-004 (per-entity location reports, the data this key makes less wrong)
**Constrains**: `serverless/worker.ts` (`handleEnroll`, `handleEnrollClaim`), `server/src/routes/devices.js`,
`server/src/routes/enroll.js`, `agent/installer.py`, `agent/installer_gui.py`,
`scripts/test_cross_surface_contract.py`

## Context

The Google Geolocation key previously reached an agent only via
`server/src/routes/installer.js::buildDeviceConfig` (Express's generated per-device installer,
`process.env.GOOGLE_API_KEY`, omitted when unset). The token flow (`setup.ps1` -> `lockdown-setup.exe
--server-url --token`) enrols via `POST /api/enroll/claim` and builds `config.json` in
`agent/installer.py::build_config`, which had no `google_api_key`; `agent/installer_gui.py`
duplicated that builder in its own `write_config()`.

`serverless/installer-scripts.ts` is the wrong place for the key: it is a served, cacheable,
secret-free PowerShell template (B-070), so a secret must never be embedded in it. A session-0
service install cannot scan BSSIDs, so the key only helps interactive installs.

## Decision

Install-time delivery: a top-level `google_api_key` on the admin-enrol and claim responses on
**both** surfaces (Express + Worker), present only when the operator configured the key
(`process.env.GOOGLE_API_KEY` / `env.GOOGLE_API_KEY`), omitted otherwise — never `null`, never
`""`. The key is never stored (no KV, no device record) and never appears in served script text.
Both agent config builders (`installer.py::build_config`/`write_config` and
`installer_gui.py::write_config`) accept an optional `google_api_key` and write `config["google_api_key"]`
only when non-empty. The `--config-file` (baked) install path adds no key.

## Consequences

The key is a **shared operator credential baked into each device config**, so rotation requires
reinstall. The no-key path is unchanged byte-for-byte.

## Alternatives rejected

- Serving the key in `installer-scripts.ts` — rejected: the served template is cacheable and
  secret-free (B-070).
- Check-in refresh (central rotation) — implemented by ADR-010 (tracked follow-up): rotation
  without reinstall via the check-in `settings` channel.

## Verification

- `server/tests/enroll.routes.test.js`, `server/tests/devices.routes.test.js` — present/absent on
  both Express endpoints.
- `serverless/worker.test.ts`, `serverless/enroll-setup.test.ts` — present/absent plus the served
  `setup.ps1` carries no key.
- `agent/tests/test_installer.py`, `agent/tests/test_installer_gui.py` — include-when-passed /
  omit-when-empty and claim-response-to-config.
- `scripts/test_cross_surface_contract.py` — parity pin that Express and the Worker read the
  same env name, both omit when unset, `installer.py` carries the field, and
  `installer-scripts.ts` does not.
