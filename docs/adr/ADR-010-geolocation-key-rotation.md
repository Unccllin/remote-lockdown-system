# ADR-010 — Rotate the Google geolocation key without reinstalling the fleet

**Status**: accepted
**Extends**: ADR-008 (its tracked follow-up)
**Relates**: ADR-009
**Constrains**: `server/src/routes/agent.js`, `serverless/agent-routes.ts`, `agent/agent.py`

## Decision

The authenticated agent check-in response may carry a `settings` object:

`settings: { google_api_key: string | null, revision: string }`

It is present ONLY when the surface has an opinion, i.e. when its
`GOOGLE_API_KEY` env var is defined. When the env var is undefined the
`settings` key is entirely absent and the response is byte-identical to
the pre-ADR-010 shape.

- env defined and non-empty → `google_api_key: "<key>"`.
- env defined but empty/whitespace → `google_api_key: null` (explicit
  instruction to stop overriding).

`revision` is a sha256 hex prefix (16 chars) of the canonical JSON
`{"google_api_key": <value>}`. It is stable for the same payload and
changes when the value changes. It need not match between the two
surfaces, only be internally stable.

The agent reconciles the object into `_STATE_DIR/.runtime_settings`
(JSON, atomic write via temp file + replace, revision-gated: skip the
write when the stored revision already matches). A persist failure logs
a key-free warning and never breaks check-in or location reporting.

Precedence for the effective key, resolved through one helper
(`_effective_google_key`): env `GOOGLE_API_KEY` > runtime override
(`.runtime_settings`) > `cfg.get("google_api_key")`.

## `null` semantics

`google_api_key: null` removes the runtime override; the effective key
falls back to whatever `config.json` was installed with. Clearing the
operator key therefore still leaves an install-time key in place until
the device is reinstalled. This is deliberate: removing a key from an
installed config means writing to an ACL-protected file, which is exactly
what this change avoids.

## What is NOT solved

- No per-device keys (still one shared operator credential).
- The key still transits an authenticated check-in response (possibly
  plain-HTTP on lab deployments) — same exposure class ADR-008 accepted.
- Clearing an install-time key still requires reinstall.

## Verification

- `server/tests/agent.routes.test.js` (new describe 'POST /api/agent/checkin — runtime settings (ADR-010)'): env unset → `settings` absent with byte-identical top-level key set; env set → key + stable revision; env empty → `google_api_key: null`.
- `serverless/worker.test.ts` (new cases in 'POST /api/agent/checkin (agent-compatible)'): settings present on both branches (with and without pending command), absent when unset, revision stability, empty-string → null.
- `agent/tests/test_runtime_settings.py` (7 cases): reconcile present/absent/null/unchanged/write-failure and precedence helper.
- `scripts/test_cross_surface_contract.py::test_the_checkin_settings_contract_matches_on_both_surfaces`: both surfaces emit the same field names and omit the object when unset; installer keeps install-time delivery.

### Verified on real hardware (S311)

MOLE, Windows service install, 2026-11-19 — `docs/artifacts/s311-rotation-hardware.txt`:

- first check-in after installing 1.0.4 → `C:\ProgramData\LockdownAgent\.runtime_settings` written
  with the Worker's key (`key_len 39`, `revision 3f11ee4980d2a049`) in the same second as
  `.last_checkin_ok`;
- secret rotated to a throwaway value → `key_len 19`, `revision d8bf5ae6ff123fc3`, written six
  minutes into the *same* agent process's life, so the rotation happened with **no restart**;
- `wrangler rollback` to the version holding the real key → `key_len 39`,
  `revision 3f11ee4980d2a049` again — the identical digest, which also demonstrates revision
  stability for an unchanged value.

Two environment facts this run established, both recorded in the artifact: the service is configured
`IGNORES_SHUTDOWN`, so replacing the binary needs an explicit process kill rather than
`Stop-Service`; and a `wrangler secret put` deploys a new *version* whose source is "Secret Change",
so a secret change is not a code deploy and the rotation code had to be deployed separately.

Read-after-restart, closed the same session (§8 of the artifact): after a service restart at
13:03:22 and a successful check-in at 13:04:43, the override file's mtime stayed at 13:01:18 and its
revision was unchanged. The agent only rewrites when the stored revision differs from the one the
surface sent, so a service unable to read the file would have rewritten it. It did not — the restarted
`LocalSystem` agent read what the previous process wrote, in the ACL'd state directory.

Nothing in this ADR is now unmeasured on hardware: delivery, rotation without restart, restore, and
read-after-restart are all observed on MOLE.
