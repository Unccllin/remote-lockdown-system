# trace.md — Cross-Session Context Trace

> This file persists context across agent sessions. Every session starts by
> reading this file and ends by appending a session-end status block.
>
> **Graph invariant I4**: `assert_session_closed_with_trace()` enforces that
> the session-end block includes all required sections.

---

## Session 270 — 2026-11-17 (the installer was not wrong about the exit code — the log was wrong about which run it belonged to)

### RULE-ZERO — understanding logged before each change

**Read**: `.devin/graph/current-state.md`, `.devin/graph/trace.md` (S269 block and both
MOLE addenda), `agent/installer.py` (`main`, `run_baked_install`, `install_files`,
`verify_checkin`, `make_writable`), `agent/service_installer.py` (`install_service`,
`_copy_service_host`, `_service_bin_path`), `agent/service_host.py` (`agent_is_running`,
`run_supervisor`), `serverless/worker.ts` (`composeEnrollSetupScript`,
`generateServerlessInstallScript`, `handleAgentCheckin`, `handlePing`, the `/api/*`
dispatch table), `server/src/routes/enroll.js` (the Express one-liner, for parity),
`server/src/routes/devices.js`, `agent/agent.py` (`apply_tracking_data_protection`,
`_get_real_username`, `_count_encrypted_files`, `write_pending_ack`, heartbeat writes),
`agent/installer_gui.py` (`install_files`), `scripts/hw-window-preflight.py` (the
established S310/urllib pattern), `scripts/rsh.py` (env-only credentials).

**Findings** (each one measured on MOLE, not inferred):

- `setup-inner.ps1` copied `lockdown-service.exe` over a **running** service. `Copy-Item`
  threw `IOException: ... being used by another process`, `$ErrorActionPreference='Stop'`
  aborted the script **before the installer started**, and exit 1 was therefore correct.
  What lied was the artifact: `install.log` still held the PREVIOUS run's text, which the
  wrapper printed as this run's output — so S269's "the install completed, only the exit
  code is wrong" was itself an unverified reading. Corrected below, verbatim quoted.
- With the copy removed the installer ran and crashed for a *second* lock:
  `installer.py:711 install_files -> shutil.copy2 -> PermissionError: [WinError 32]` on
  **lockdown-agent.exe**. S269's "it overwrites the hardened binary" held only because
  the agent was not running during that run (agent restarted at 16:28:49, after the
  16:25 install).
- A native child's **stderr** is a terminating error under `$ErrorActionPreference='Stop'`
  in Windows PowerShell 5.1, so the first `trap` I added fired mid-run and kept one line
  ("Traceback (most recent call last):") with the PermissionError discarded.
- The agent refuses `http://` unless its config says `verify_tls: false`
  (`agent.py:517`), the GUI installer owns that decision (`--allow-insecure-http`,
  `installer_gui.py:1296-1306`), and the Express one-liner passes it
  (`server/src/routes/enroll.js:369`) — the Worker's did not, while patching the config
  *after* a successful install that could never happen.
- The S269 poll-interval fix (300 s -> 60 s) landed in `handlePing`, served at `/api/ping`;
  the agent calls `/api/agent/checkin`, whose `ADAPTIVE_POLL` still returned 300. MOLE
  logged `Adaptive polling: 30s -> 300s (status=active)` **after** the fix.

### Fog cleared

- **The S269 installer defect, corrected.** Quoted: *"the run exits non-zero, so the
  wrapper prints its failure banner and throws even though the install completed.
  Recorded as an open defect: the exit code, not the install, is wrong."* Measurement:
  the install never ran. `install.log`'s tail was the 16:26 run's (LastWriteTime
  16:26:04 across a 17:31 run that downloaded its binaries at 17:31:5x). The class is
  *stale artifact presented as this run's evidence*, not a wrong exit code.
- **An upgrade now lands on a running machine.** `installer.py::_copy_binary` lifts both
  locks in one place — tamper protection (`make_writable`) and the running image
  (`service_installer.stop_service()`, then one retry) — and `install_files` uses it for
  the agent as well as the service host. Live: agent sha256 `77AE143E…` (the b6f6f47
  build) installed over the running agent, exit 0.
- **The served install log is a ledger.** Per-run `=== installer run started <iso> ===`
  and `=== installer exited <code> ===`, appended, plus a trap that records an early
  abort. Live: the log now shows null / 1 / 0 across this session's three runs, in order.
- **stderr can no longer abort the install.** `Start-Process
  -RedirectStandardOutput/-RedirectStandardError`, both appended to the log, `$code` from
  `$p.ExitCode`.
- **Plain HTTP is the installer's decision, and it is read back.** The script passes
  `--allow-insecure-http`, then reports `verify_tls in config: False` (live) and exits 3
  if the value is not false. The takeown/icacls/JSON-rewrite block is deleted — it was a
  manual step after install, and unreachable exactly when needed.
- **One poll interval for both response branches.** `activePollSeconds(env)` is used by
  `handleAgentCheckin` and `handlePing`; `ACTIVE_POLL_SECONDS` and `INSTALLER_GUI` are
  declared on `Env` instead of `as unknown as Record<…>`. Live: the agent checks in every
  ~68 s (was 300).
- **The ACK's evidence is readable.** `GET /api/devices/:id/commands` on both surfaces
  (viewer, newest first, limit clamped, 404 for an unknown device). Previously
  `lockdown_effective` / `boot_lock_status` were written and unreachable.
- **A lifecycle acceptance harness exists and runs.** `scripts/acceptance_lifecycle.py` +
  `scripts/acceptance_probe.ps1` (read-only snapshot): enroll -> lock -> recover -> track
  -> stop-track, each step asserting the observed post-condition on the machine *and* the
  server, SKIP when unobservable, `--snapshot` to re-derive a report offline. Live:
  `[PASS] enroll  service Running · config parses · agent checked in 68s ago (limit 300s)
  · device id matches the server · hostname matches`.

### Fog remaining (measured, open)

- **A wedged agent is invisible to every layer that should notice.** MOLE stopped
  checking in at 2026-11-16T14:33Z and was still wedged at 05:12Z the next day (~14 h):
  `Get-Service` said `Running`, `service_host.py` logged `agent already running — not
  starting another` every 30 s, and `agent_is_running()` is process existence only
  (`service_host.py:79-95`). The scheduled-task watchdog that would have killed it is
  **removed by `remove_legacy_starters()` when the service is installed**, so a
  service-based install has no liveness check at all. Recovery required
  `Stop-Process -Id 6124 -Force` by hand; `Restart-Service` cannot fix it, because the
  service host refuses to start a second agent while the wedged one exists. The heartbeat
  file the agent already writes (`.heartbeat`) is the right signal and is not consulted.
- **The GUI installer does not upgrade `lockdown-service.exe`.** `installer_gui.py:497`
  copies the agent and the lock screen only. Live after the successful upgrade:
  agent `77AE143E…` (new) vs service `8029CCA0…` (the 16:25 build). The service keeps
  running the old host until it is replaced by hand.
- **`verify_tls` defaults to true while the config's `server_url` is plain HTTP** when no
  flag is passed, which is a self-contradictory config the installer will happily write.
  The flag fixes the two shipped paths; the default is still wrong for `http://`.
- **The destructive half of the acceptance cycle has not been run.** lock / recover /
  track / stop-track are implemented and unit-tested (32 checks) but only `enroll` has
  been run live this session; `track` disables the signed-in account and EFS-encrypts its
  profile.
- Unchanged from S269: `make test-scripts` stops at the docker-dependent TLS suite on this
  host, and seven PGlite-backed server suites cannot run on Node 26.13.1
  (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`) — proven at b6f6f47 in a clean worktree,
  so it is the environment, not the change.

### Debt items closed

- None. This session fixed live defects (D-119/D-120-adjacent behaviour) and added
  evidence paths; no graph-tracked debt item met its close criteria.

### Debt items still open

- D-120, D-129, D-130, D-134 — unchanged.

### Blockers

- MOLE was unreachable for ~13 h (`No route to host` from 2026-11-16T14:33Z, back at
  05:10Z on 2026-11-17) — unexplained; nothing in this session's commands could take the
  box off the network, and it returned without intervention.
- The destructive lifecycle steps need a named window: a failed `track` leaves the machine
  with a disabled account and EFS-encrypted profile folders.

### Failure attribution

- **Layer 4 — verification feedback (primary, three times).** A successful install was
  "confirmed" by printing the log without checking which run produced it; a fix was
  "verified" by reading the code path that was edited, not the handler the agent calls;
  a test pinned 300 on the branch the fleet was not on. In all three the report was
  consulted instead of the artifact.
- **Layer 2 — context provision (secondary).** The Express one-liner and the Worker one
  had diverged on `--allow-insecure-http`, and nothing in the repo states that the two
  surfaces must carry the same flags. `scripts/test_cross_surface_contract.py` exists for
  exactly this and does not cover the installers.

### VERIFY

- Live one-command re-install on MOLE over SSH: exit **0**, log
  `=== installer run started 2026-11-17T08:20:42 === … === installer exited 0 ===`,
  `verify_tls in config: False`, `service: Running`, agent sha256 `77AE143E…`
  (published build), device checking in every ~68 s.
- `scripts/acceptance_lifecycle.py --step enroll --dry-run` → `[PASS] enroll`, artifact
  `docs/artifacts/s270-acceptance-enroll.json`.
- Suites: agent 884 passed, worker 447 passed (2 new poll-interval tests), server 773
  passed in 44 suites (7 PGlite suites excluded, see above), acceptance harness 32 passed,
  `tsc --noEmit -p .` clean, eslint clean, ruff check + format clean on the new scripts.
- Local KV republished from CI run 44020904202 (b6f6f47): `binary:installer`,
  `binary:agent`, `binary:service`, `binary:agent-installer`; each verified by comparing
  the served `x-content-sha256` with the artifact's own digest.

### Next session opening

Run the destructive half of the acceptance cycle on MOLE
(`--step lock --step recover --step track --step stop-track --allow-destructive`) and fix
what it finds; then make the service host notice a wedged agent (heartbeat-fresh, kill and
restart) and make `installer_gui.py` stage `lockdown-service.exe`.

---

## Session 271 — 2026-11-17 (a lock that does not lock, and a notification that stops the agent)

### RULE-ZERO — understanding logged before each change

**Read**: `agent/agent.py` (`_lock_workstation`, `handle_lockdown`, `handle_unlock`,
`show_lockdown_notification`, `apply_tracking_data_protection`,
`remove_tracking_data_protection`, `_lockdown_effective`, `agent_is_running` callers,
`checkin`, the main loop), `agent/lock_screen.py` (`CreateWindowExW`),
`agent/service_host.py` (`run_supervisor`, `agent_is_running`),
`agent/service_installer.py` (`remove_legacy_starters`, `install`),
`agent/installer_gui.py` (`install_files`, `stop_running_agent`),
`serverless/worker.ts` (`handleAgentCheckin`, `handlePing`, `ADAPTIVE_POLL`,
`handleTrackAction`, `handleFlagStolen`), `.devin/graph/GRAPH-SPEC.yaml`
(`E-LOCK-SCREEN`, `E-BCD` as the demotion precedent), `agent/tests/*` for the pinned
contracts.

**Findings**, each measured before it was changed:

- `lock` prevents no logon. From Session 0 `_lock_workstation` only runs `tsdiscon`; the
  overlay cannot be created (`CreateWindowEx failed: 2` every 10 s in MOLE's log); and
  `handle_lockdown` never touches the account (grep for `/active:`/`GuestUser`: 0 hits).
  The operator signed straight back in — "i can still sign in even on lock".
- The main loop blocks forever right after the lockdown ACK, in
  `show_lockdown_notification()` — a `MessageBoxW` that waits for a click in Session 0,
  where nobody can click. That is the ~14 h silence after the S269 lockdown, reproduced on
  demand: ACKed at 08:54:13, no further check-in, pending unlock unfetchable.
- `w32time` was Stopped/Manual on MOLE, so the clock only advanced from the CMOS value at
  boot and never resynced (the operator's "it does not have correct time"). Measured:
  MOLE 06:07:50Z = host 06:07:50Z, so no drift *yet*; nothing prevents it.
- The S269 poll-interval fix had landed in `handlePing` (`/api/ping`, legacy) while the
  agent uses `handleAgentCheckin` (`ADAPTIVE_POLL['active'] = 300`). MOLE logged
  `Adaptive polling: 30s -> 300s` AFTER the fix.
- The GUI installer (`lockdown-setup.exe`, the binary the one-liner runs) never staged
  `lockdown-service.exe`: after a "successful" upgrade agent `77AE143E…` (new) but service
  `8029CCA0…` (previous build).

### Fog cleared

- **A locked device is now sign-in-proof, and says so.** `lock` holds the interactive
  account disabled, verified by reading the account back (`net user /active:no` can exit 0
  and change nothing). `lockdown_effective` requires it, so an encrypted-but-signable
  machine reports false instead of looking locked. `recover` re-enables first, before it
  looks at the key, so a `failed` ACK cannot strand the account.
- **The notification can no longer stop the agent.** Fire-and-forget daemon thread.
- **The service host supervises on evidence, not existence.** `.last_checkin_ok` (written
  only when the server ANSWERS) replaces the pid check; a stalled agent is restarted only
  when `/api/health` also answers, so an offline machine is left alone. Proven live:
  `agent stalled — no answered check-in for 921s; terminating it` → fresh agent →
  `UNLOCK command received` → `BIOS password backup deleted (unlock successful)` →
  `sentinel: False`.
- **One owner for the account.** `lock` and `track` used independent files and reversed
  each other's disable; a reason set `.logon_holds = {"user", "reasons"}` now decides, and
  the account is re-enabled only when the set is empty.
- **E-LOCK-SCREEN demoted** to `verified-in-unit-test` with the reason in GRAPH-SPEC: its
  Azure artifact recorded that `tsdiscon` was *issued*, not that a sign-in was *refused*.
  `make graph-check` passes.
- **The acceptance harness runs the whole non-destructive half on the real machine** and
  reports `[PASS] enroll`, `[FAIL] lock` for exactly the reasons above. Four harness
  defects fixed en route: `hostname_confirm` (400), the recover wait predicate, the
  `__INSECURE__` quoting (PowerShell parse error), and `tracking_state.json` read from the
  wrong directory.

### Fog remaining

- **The tracking half has still not run live** (`track` → `stop-track`). It EFS-encrypts
  the console user's profile and disables them; the interlock is in place, but the cycle
  needs a window and the console user's cooperation.
- **E-LOCK-SCREEN is re-promotable only by a hardware run** that shows a console sign-in
  REFUSED. The harness now asserts it; no artifact exists yet.
- **The 14 h wedge mechanism is now explained for locks** (blocking notification) but the
  earlier S269 instance had no pending unlock to disprove other causes; the supervision
  fix makes the mechanism moot for availability, not for root cause.
- **The timezone question is unanswered**: the operator reports a time mismatch; the clocks
  agree with this host to the second, so either their wall clock is not +03:00 (a timezone
  setting) or they are comparing UTC (`Z`) records with local (`+03:00`) logs.
- Deferred by decision: per-entity KV keys / Durable Object per device (whole-record writes
  still race across isolates), and cross-surface installer-flag contract tests.

### Debt items closed

- None. D-119/D-120-adjacent behaviour changed; no graph-tracked item met its close
  criteria.

### Debt items still open

- D-120, D-129, D-130, D-134 — unchanged.

### Blockers

- None. The build for `ae415f0` is running; MOLE is unlocked, supervised, and checking in.

### Failure attribution

- **Layer 4 — verification feedback (primary).** E-LOCK-SCREEN carried `verified-on-hardware`
  on an artifact that proved a command was issued. The harness that produced it asserted the
  action, not the post-condition — the same acceptance criterion this session spent on
  everything else. New check: "logon prevented (interactive account disabled)".
- **Layer 2 — context provision.** Nothing recorded that `lock` only means "disconnected +
  encrypted", so the product's name implied enforcement the code did not do. GRAPH-SPEC now
  says what each layer does and does not do.

### VERIFY

- Live: `[PASS] enroll` (service Running, config parses, checked in 68 s, device id matches);
  `lock` ACK `executed effective=False boot_lock_status=partial`; supervision restart at 921 s
  → `UNLOCK command received` → `sentinel: False`.
- Suites: agent 922, worker 447, server 773 (44 suites), acceptance harness 48,
  `tsc --noEmit` clean, ruff clean on every touched file, `make graph-check` all invariants
  pass.
- Published to local KV from CI: `binary:installer/agent/service/agent-installer`, each
  verified against the served `x-content-sha256`.

### Next session opening

Publish the `ae415f0` build, install it on MOLE, then run `lock` and confirm from the
console that `newark user` is disabled and a sign-in is refused, followed by `recover`; only
then re-promote E-LOCK-SCREEN.

---

## Session 271 — 2026-11-17 (close) — a lock that does not lock, and a notification that stops the agent


### RULE-ZERO
- **Read**: `agent/agent.py` (handle_lockdown, disable_console_account, hold_logon, report_location, drain_offline_queue, apply_tracking_data_protection), `agent/hp_uefi_lockdown.py` (_set_and_verify, _rollback_bios_settings, remove_boot_lockdown, _is_setup_password_set), `serverless/worker.ts` (command helpers, handleListDevices, handleCommandAck), `scripts/acceptance_lifecycle.py` + `acceptance_probe.ps1`, `docs/adr/DEBT-LEDGER.md` index, `agent/service_host.py`, `agent/installer.py`.
- **Finding**: the agent's *claims* and the machine's *state* disagreed in five independent places — `lockdown_effective` reported true with sign-in possible, tracking reported layers it never applied, a BIOS rollback reported "restored" after deleting the only record, `stop_track` re-enabled a account a lockdown still held, and the escrow served an operator's own password as the device's. Every one was fixed by making the record read the observation rather than the intention.

### Fog cleared
- Sign-in was possible on a "locked" device: `UF_ACCOUNTDISABLE` was never verified; the probe now reads it via ADSI (513 enabled / 515 disabled) — `52d5509`, artifact `docs/artifacts/s271-acceptance-lock-recover-v2.json`.
- `LogonUserW` with a wrong password cannot detect a disabled account (1326 for nonexistent/enabled/disabled alike) — calibrated on MOLE, B-135.
- The lockdown folder is Fernet-encrypted (`.enc` siblings), not EFS — a false FAIL corrected in the same commit.
- Tracking's decoy never existed: `net user` asks its >14-char password prompt on the CONSOLE, not stdin — `New-LocalUser` fix `54b216f`, recorded correction `2ffcd84`.
- Profile EFS cannot work from a service context (measured `[ERR]`), declared `unsupported` — `d94293b`, ADR note in GRAPH-SPEC.
- `net user`/BIOS dead ends now carry `reason` + `next_action` in the record — `36c8f7e`, `86c2299` (dashboard card).
- A refused BIOS write is the only failure; accepted-but-uncommitted is `pending_reboot` — `111ab45`.
- A failed rollback deleted the boot-state file; the removal claimed a restore it never verified — `d44b931`, `9a43329`.
- An operator-supplied BIOS password echoed into the escrow — `dc9ba13`.
- Commands were a whole-list KV write (ACK clobbered by concurrent check-in) — ADR-002 per-entity records, migration verified on live KV (37 `command:<id>` keys, legacy key gone) — `6da840d`, ADR `docs/adr/ADR-002-per-entity-command-records.md`.
- `status: stolen` is a queue-time claim: `lock_state` derived (`applied`/`applying`/`armed`/`failed`/`none`), amber chip + red "Lockdown Not Applied" alert — `2f79c12`, `9e464ab`.
- Offline tracking: the raw WiFi scan is queued when no fix is obtainable and resolved on reconnect with `observed_at` — `33a99c8`.
- Gate defects: `make full-verify` aborted three times on its own tooling (no system ruff; ruff pin disagreed with CI; actionlint/shellcheck absent; electron `node_modules` absent) — `51f4b6c`, `f69034e`, plus installed actionlint 1.7.12 + shellcheck 0.10.0 to `~/.local/bin`.

### Fog remaining
- The firmware password itself. Not recoverable: SPI-protected verifier, `HP_BIOSPassword` exposes only `IsSet`, BIOS minimum length is 8 (so the supplied 4-char value was never a candidate), and a full sweep of Panther/Setup/ProgramData\HP/Temp/profiles/scheduled-tasks/PS-history found no provisioning artifact. HP signed reset (serial `5CG0398GCN`) is the only route.
- Why `SetBIOSSetting` returns `4 Failed` after the reboot while the same writes were accepted before it — not documented by HP, unchanged by password/no-password/encoding variants.
- Express parity for `lock_state`, and whether the server should honour `observed_at`.

### Debt items closed

None formally. The graph I2 gate requires `commit_ref` + a resolving `artifact_ref` per item; these were defect fixes, not ledger closures. Artifacts produced: `docs/artifacts/s271-acceptance-lock-recover.json`, `…-v2.json`, `…-track-cycle.json`, `…-track-cycle-v2.json`, `…-v3.json`, `…-v4.json`, `…-per-entity-commands.json`.

### Debt items still open

D-120 (BitLocker), D-129/D-134 (firmware hardware time), D-130 (update signing), D-210 (PBL route integration), plus the new named gaps above (Express parity, device/audit per-entity writes).

### Blockers
- MOLE's boot settings remain `Disable` (USB/PXE/Legacy/Fast Boot) with every software write refused; needs the HP reset or a BIOS visit. OPEN, operator action.
- `E-LOCK-SCREEN` stays `verified-in-unit-test`: the evidence is the OS account flag, not a console sign-in attempt. OPEN, needs a human attempt.
- 60-device rollout: `devices`/`audit`/`bios_passwords`/`locations` are still whole-list KV writes. OPEN, next engineering item.

### Next session opening

Close the two one-subquery gaps (`lock_state` on Express, honouring `observed_at`) and ship `9e464ab` to MOLE, then start the `devices` per-entity write migration before any fleet rollout.

---

## Session 272 — 2026-11-18 (what the lock actually did, and when the fix was taken)

### RULE-ZERO — understanding logged before each change

**Read**: `server/src/routes/devices.js` (`GET /`, `GET /:id`, `publicDevice`,
`parseDbTimestamp`, `isAgentVersionStale`, `/:id/locations`, `/:id/location/latest`,
`/:id/commands`, `module.exports.helpers`), `serverless/worker.ts` (`lockStateFor`,
`LOCK_STATE_FRESH_MS`, `handleListDevices`, `handleGetDevice`, `handleAgentLocation`,
`handleGetLocations`, `handleLatestLocation`, `LocationReport`, `ADAPTIVE_POLL`),
`server/src/routes/agent.js` (`POST /location`), `server/src/db/migrations/001_base.sql`
+ `migrations-sqlite/001_base.sql` (`commands`, `location_reports`),
`server/src/db/migrations{, -sqlite}/004_privacy.sql` and `018_agent_version.sql`
(the two shapes a column migration takes in this repo), `server/src/db/migrationRunner.js`
(`schema_migrations` bookkeeping), `agent/agent.py` (`report_location`,
`resolve_pending_wifi_scans`), `server/tests/mockPool.js`, `server/tests/devices.routes.test.js`,
`scripts/test_cross_surface_contract.py`.

**Findings**, each measured before it was changed:

- Express never derives `lock_state`. `GET /api/devices` and `GET /api/devices/:id` return
  `publicDevice(row)` and nothing else, so a self-hosted deployment shows a row that says
  `stolen` with no statement about the machine — the exact confusion S271 fixed on the Worker.
- `lock_state` **cannot** live in `publicDevice`. That helper is used by ~15 responses,
  including the lockdown/recover/track POSTs, which return a device row that carries no
  command columns. Deriving there would answer `none` for a lockdown queued one line earlier.
  It must be computed at the two GET routes from command rows.
- `SELECT * FROM devices` is matched verbatim by 162 `setResult` fixtures across 16 test files.
  Adding the command columns to that statement (as one correlated subquery) would break all of
  them or force a fixture rewrite, so the read is two statements: the existing device query,
  then one ranked query over `commands` for the returned ids (`ROW_NUMBER() OVER (PARTITION BY
  device_id, command_type ORDER BY created_at DESC)`, portable to SQLite ≥3.25 and supported by
  PGlite) — not the "one SQL subquery" the S271 commit message guessed at.
- Timestamps: SQLite writes `datetime('now')` zoneless and V8 reads that as local time
  (D-258), while the Worker compares ISO strings. Comparisons go through the existing
  `parseDbTimestamp`; ordering stays in SQL, where each dialect is internally consistent.
- `observed_at` appears **nowhere** in `server/` or `serverless/` (grep: 0 hits). The agent
  sends it at the **top level** of the body, not inside `location`, and only on the
  backfilled path — `report_location`'s normal payload has no `observed_at` at all. So the
  read side has to treat it as optional and fall back to receipt time, or every online report
  would lose its timestamp.
- `location_reports` has only `reported_at` (migration 001, both dialects). A new column needs
  a file in `migrations/` (with `IF NOT EXISTS`) **and** `migrations-sqlite/` (plain
  `ADD COLUMN` — SQLite has no `IF NOT EXISTS` there); idempotency comes from the runner's
  `schema_migrations`, exactly as `018_agent_version.sql` documents.
- The retention purge deletes on `reported_at` (`jobs/retentionScheduler.js`), which stays the
  right key: `observed_at` is an agent-supplied claim about when, and retention must be driven
  by when the row arrived.
- Worker locations live in one KV list keyed `created_at`, mapped to `reported_at` on read for
  dashboard parity, and `handleGetLocations` slices *before* sorting — so it can drop the
  newest rows of a >limit list.
- `LOCK_STATE_FRESH_MS` is 180 s on the Worker while `ADAPTIVE_POLL['active']` is 300 s, so a
  healthy device that checked in 200 s ago reads `armed`. Recorded as fog below, not changed
  here: the session's job is parity on the same rule, and silently re-tuning a user-visible
  threshold in one commit with a parity change is how the two surfaces drifted apart.

### IMPLEMENT (this session)

- `server/src/routes/devices.js` — `LOCK_STATE_FRESH_MS`, `lockStateFor(parts, device, now)`,
  `loadLockStateParts(deviceIds)`, wired into `GET /` and `GET /:id`; helpers exported for
  direct tests, like `parseDbTimestamp`.
- `server/src/routes/agent.js` — `POST /location` stores `observed_at` (top level, optional,
  5-minute future clamp so a device cannot claim a fix from tomorrow); falls back to the
  column default.
- migration `019_location_observed_at.sql` in both dialect directories.
- Read side (`/:id/locations`, `/:id/location/latest`) orders by
  `COALESCE(observed_at, reported_at)` so a backfilled trail reads in the order it happened.
- Worker parity: `observed_at` accepted and stored, ordering by the same expression.

---

## Session 272 — 2026-11-18 (close) — what the lock actually did, and when the fix was taken

### RULE-ZERO — understanding logged before code changes

**Read**: `server/src/routes/devices.js` (GET /, GET /:id, `publicDevice`,
`parseDbTimestamp`, `isAgentVersionStale`, both location read routes, `module.exports.helpers`),
`serverless/worker.ts` (`lockStateFor`, `LOCK_STATE_FRESH_MS`, `handleListDevices`,
`handleGetDevice`, `handleAgentLocation`, `handleGetLocations`, `handleLatestLocation`,
`LocationReport`), `server/src/routes/agent.js` (POST /location),
`server/src/db/migrations{, -sqlite}/001_base.sql` + `004_privacy.sql` + `018_agent_version.sql`,
`server/src/db/migrationRunner.js`, `server/src/db/sqlitePool.js` (`translateSql`),
`agent/agent.py` (`report_location`, `resolve_pending_wifi_scans`),
`server/tests/mockPool.js`, `scripts/test_cross_surface_contract.py`.

**Finding**: `lock_state` cannot be derived in `publicDevice` (shared by motion responses that
hold no command rows); `SELECT * FROM devices` is matched by 162 fixtures, so the read is two
statements, not the one correlated subquery the S271 message guessed; `observed_at` existed
nowhere in `server/` or `serverless/` and is sent only on the backfill path, at the top level of
the body; the two location timestamp columns hold different text SHAPES in SQLite.

### Fog cleared

- **`lock_state` reaches Express.** `GET /api/devices` and `GET /api/devices/:id` now derive the
  same five values as the Worker (`applied`/`applying`/`armed`/`failed`/`none`) from a ranked
  `ROW_NUMBER() OVER (PARTITION BY device_id, command_type)` read of `commands`, with the same
  180 s freshness window. Proven on real SQLite through the real routes: `none → armed` (flagged,
  never checked in) `→ applying` (check-in) `→ applied` (ACK) `→ none` (recover).
- **`observed_at` is stored and honoured.** Migration `019_location_observed_at.sql` in both
  dialect directories; `POST /api/agent/location` accepts the scan time (top level, optional,
  unparseable or future claims dropped — a device clock is not trusted); both read routes order
  by it with receipt time as the fallback; the Worker gained the same field, clamp and ordering.
- **A defect the tests did not catch, found by running the thing.** The first version ordered by
  `COALESCE(observed_at, reported_at) DESC`, which in SQLite compares TEXT: `'T'` (0x54) sorts
  after `' '` (0x20), so a fix taken at 06:45 outranked one taken at 11:45 and `/location/latest`
  returned the older fix. Measured on real SQLite (artifact step 15: `Middle > Earlier > Newer`).
  Fixed with `coalescedTimeOrderSql()` — `datetime(COALESCE(...))` on SQLite, plain `COALESCE` on
  PostgreSQL, switched on `pool.driver` rather than an env var (a caller that requires
  `sqlitePool` directly, as the migration and E2E harnesses do, gets it right too). After the fix
  the same rows read `Newer > Middle > Earlier` and `/latest` returns `Newer`.
- `parseDbTimestamp` moved to `server/src/db/timestamps.js` so `routes/agent.js` can validate
  `observed_at` without the two route modules requiring each other; re-exported from
  `devices.js` so the D-258 fixture still tests it through the same module.

### Fog remaining

- **The freshness window does not match the poll interval.** `LOCK_STATE_FRESH_MS` is 180 s while
  `ADAPTIVE_POLL['active']` is 300 s, so a healthy device that checked in 200 s ago reads `armed`.
  Named, not changed: re-tuning a user-visible threshold in the same commit as a parity change is
  how the two surfaces drifted apart in the first place. Both surfaces move together or not at all.
- **Express parity is not completeness.** The dashboard alert added in `9e464ab` derives from
  `/devices`, so it now works against Express — but only because the field is present. No field on
  Express is now silently `undefined`-shaped for the alert path; nothing verifies that beyond the
  contract test.
- **The 60-device rollout blocker is untouched**: `devices`, `audit`, `bios_passwords` and
  `locations` are still whole-list KV writes.
- **The Worker's KV location list is capped at 1000 rows** (`saveLocations` keeps the last 1000,
  in insertion order). A long backfill can now be evicted before it is read; ordering is fixed,
  retention of the row is not.
- **MOLE has not been shipped the dashboard work** (`9e464ab` + `lock_state` chip). Operator action.

### Debt items closed

None formally — this closes fog, not ledger items. No `commit_ref`/`artifact_ref` pair is claimed
for any D-xxx here, so no I2 closure was made.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration), plus the named gaps above (per-entity writes, freshness window,
Worker location cap).

### Blockers

- MOLE's boot settings remain `Disable`; needs the HP reset or a BIOS visit. OPEN, operator action.
- `E-LOCK-SCREEN` stays `verified-in-unit-test` (the evidence is the OS account flag, not a console
  sign-in attempt). OPEN, needs a human attempt.
- 60-device rollout: `devices`/`audit`/`bios_passwords`/`locations` are whole-list KV writes.
  OPEN, the next engineering item.

### Session artifacts

- `docs/artifacts/s272-lock-state-observed-at.json` — 17 steps against a real SQLite database
  through the real Express routes: the full state machine, the raw `ROW_NUMBER()` query result,
  the backfill write, and the history/latest ordering before and after the fix.

### Failure attribution

- **Layer 4 (verification feedback)**, first pass: the new tests asserted that the SQL *text*
  contained `COALESCE(observed_at, reported_at)` instead of asserting the *ordering outcome*. The
  defect passed every test and was caught only by the artifact run. Harness change made this
  session: `server/tests/locationOrdering.test.js` runs the real migration files against a real
  in-memory SQLite database and asserts the resulting row order — and the first of its tests pins
  the WRONG order of a bare `COALESCE` as evidence the normalisation is doing work. Mutation-checked:
  reverting the helper fails 2 of its 7 tests.
- **Layer 3 (execution environment)**, advisory only: `scripts/test_tls_floor.py` fails on this host
  because `/var/run/docker.sock` is not readable by this login session (documented in AGENTS.md);
  `test_cross_surface_contract.py` carried a pre-existing `UP017` at line 365 in a file this session
  was already editing, fixed as `datetime.UTC`.

### VERIFY

- `server`: `npm test` → **876 passed / 52 suites** (was 848 / 51; +21 new tests, 1 new suite).
- `serverless`: `npx vitest run` → **458 passed**; `npx tsc --noEmit -p .` → clean.
- `scripts/test_cross_surface_contract.py` → **23 passed** (5 new parity assertions).
- `npx eslint .` (server) → exit 0.
- `make test-scripts` → 14 suites pass; the single red is `test_tls_floor.py`, host limitation above.
- Artifact: `docs/artifacts/s272-lock-state-observed-at.json` (steps 01–17).

### Next session opening

Ship `9e464ab` plus this `lock_state`/ordering work to MOLE and re-run the lock → recover
acceptance with the chip visible, then start the `devices` per-entity KV write migration — the
last blocker before any fleet rollout.

---

## Session 273 — 2026-11-18 (the last rollout blocker: devices stop being one KV value)

### RULE-ZERO — understanding logged before each change

**Read**: `docs/adr/ADR-002-per-entity-command-records.md` (the blueprint being extended),
`serverless/worker.ts` (`listDevices`, `saveDevices`, `listCommandIds`/`getCommand`/
`deleteCommandsForDevice` as the ADR-002 shape, `verifyAgentAuth`, `serializeMutation`,
`getCheckinMetadata`/`mergeCheckinMetadata`, all 27 `listDevices` read sites and all 17
`saveDevices` write sites, `handleReleaseDevice`, `handleRotateKey`),
`serverless/worker.test.ts` (`MockKV`, `signRequest`, `enrollDevice`, `readCommandViaApi` and
the tests that read the `devices` key directly), `serverless/README.md` (the published KV
layout), `docs/adr/ADR-003-per-entity-device-records.md` (written first, then implemented).

**Findings**, each measured before the change:

- `saveDevices` had **17 call sites** and `listDevices` **27**. Every write was a whole-fleet
  read-modify-write, so two writers in different colos lose one of the two changes —
  `serializeMutation()` cannot help across isolates (ADR-002 said so and left `devices` behind).
- `verifyAgentAuth` found the device by scanning the list. Converting devices to per-entity
  records *without* an index would have made every agent request an N-device read: a 60-device
  fleet polling every 300 s goes from ~288 reads/day to ~17,000. The `agent_key:<hash>` pointer
  is therefore part of the decision, not an optimisation for later.
- `MockKV` implements only `get`/`put`/`delete` as far as the Worker uses them (grep of
  `LOCKDOWN_KV.*`: 25 get, 27 put, 10 delete, **no list**), so a prefix scan was not an option
  even in tests — the index is the mechanism, and `ROW_NUMBER`-style key listing does not exist
  in KV without pagination.
- 12 existing tests read the legacy `devices` key directly (`deviceIdByHostname` and two
  helpers). They are the storage-layout coupling the repo already warns about — `readCommandViaApi`
  exists for exactly this reason (ADR-002).
- The check-in path and `/api/ping` re-read **the whole fleet** to find the device the auth
  layer had just loaded. Under per-entity records that would be one get per device on the
  hottest path in the system, so both now use the authenticated record.
- `serverless/README.md` still documented `devices` as "still one value" — a published fact that
  this session made false.

### Fog cleared

- **`devices` is per-entity (ADR-003).** `device:<id>` + `device_index` + `agent_key:<sha256>`,
  lazy idempotent migration from the legacy `devices` key, and all 15 write sites converted.
  `saveDevices` is deleted, so a whole-list write cannot come back without a compile error.
- **Authentication is one read.** `verifyAgentAuth` and the `/v1` firmware auth path both use the
  pointer; `rotate-key` deletes the stale mapping, so a re-keyed device fails closed with the old
  key (asserted, not assumed).
- **Two cost regressions avoided in the same commit**: the check-in path and `/api/ping` now use
  the record `verifyAgentAuth` already loaded instead of re-reading the fleet.
- **The storage change surfaced as 12 immediate test failures**, all of them tests reading the
  KV layout. They were rewritten to go through the API (`deviceIdByHostname`) or through the
  documented check-in metadata key — no test was weakened.
- `serverless/README.md` gained a "Device storage (ADR-003)" section and no longer claims
  `devices` is one value.
- Four pre-existing style blockers in `worker.ts` (nested ternaries in the version filter and
  `signature_alg`, two string-concatenation joins in the installer scripts) were cleared, since
  the file is in this diff anyway and they blocked every edit.

### Fog remaining

- **Three stores are still whole lists**: `locations`, `audit_log`, `bios_passwords`,
  `encryption_keys`. Named in ADR-003 and in the README rather than implied. The release cascade
  still rewrites all four on every delete — visible in the artifact's final key snapshot.
- **`device_index` is a whole-value write**, accepted for the same reason ADR-002 accepted
  `command_index`: append-mostly, ids only, and `putDevice` re-appends a missing id on every
  write so a lost append cannot hide a device from `listDevices` permanently.
- **`worker.ts` is now 5056 lines**, past the harness LSP's 5000-line limit, so `lens_diagnostics`
  reports "too_large" instead of a verdict. `tsc --noEmit` and the 464-test suite remain the
  gates, as AGENTS.md already states for the serverless surface. Splitting the file is now a
  concrete, named task rather than a style preference.
- **MOLE has still not been shipped** `9e464ab` or this storage change. Operator action.
- The 180 s `LOCK_STATE_FRESH_MS` vs 300 s adaptive poll mismatch (S272) is unchanged.

### Debt items closed

None formally. ADR-003 closes the rollout blocker recorded as a blocker line, not a ledger item,
so no `commit_ref`/`artifact_ref` pair is claimed.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration), plus the store-by-store work named above.

### Blockers

- MOLE's boot settings remain `Disable`; needs the HP reset or a BIOS visit. OPEN, operator action.
- `E-LOCK-SCREEN` stays `verified-in-unit-test`. OPEN, needs a human sign-in attempt.
- **The 60-device rollout blocker narrowed from four stores to three** (`locations`, `audit_log`,
  `bios_passwords`). Devices are done; the rest is the same change applied store by store.

### Session artifacts

- `docs/artifacts/s272-device-per-entity-keys.json` — the real Worker (bundled from source,
  driven through its own `fetch`) taken through enrol → flag-stolen → ACK → rotate-key →
  release, with the full KV key layout at each step and **20 assertions**, including "B's record
  was not rewritten by A's mutation" and "the whole fleet was not written".

### Failure attribution

- **Layer 4 (verification feedback), and the harness worked this time**: 12 tests failed the
  moment the storage shape changed because they read `devices` out of KV. That is the failure
  mode this repo has already paid for once (tests pinning a layout instead of a contract), and
  the fix was the one ADR-002 established — read through the API. Harness change: `deviceIdByHostname`
  now goes through `GET /api/devices`, and the `lock_state` seed writes the documented
  `device_checkin:<id>` key instead of patching a list.
- **Layer 4, second signal**: the first artifact run for this change is what proved the write
  set (`device:<A>`, `agent_key:<A>`, `command:<id>`, `command_index`, `audit_log` — no `devices`).
  A passing suite would not have shown that.

### VERIFY

- `serverless`: `npx vitest run` → **464 passed / 4 files** (was 458; +6 ADR-003 tests).
- `serverless`: `npx tsc --noEmit -p .` → clean.
- `scripts/test_cross_surface_contract.py` → **23 passed**.
- `make graph-check` → all invariants pass.
- Agent suite (`scripts/run-agent-tests.sh -q`) → exit 0.
- The only red anywhere on this host is `scripts/test_tls_floor.py`, the documented
  unreadable-`/var/run/docker.sock` limitation (AGENTS.md), unrelated to this change.

### Next session opening

Take `locations` off the whole-list write next — it is the highest-volume of the three remaining
stores and the same ADR-003 shape applies — and ship the accumulated dashboard/storage work to
MOLE so the lock → recover acceptance runs against something current.

---

---

## Session 274 — 2026-11-18 (location reports leave the shared window)

### RULE-ZERO — understanding logged before each change

**Read**: `docs/adr/ADR-002-per-entity-command-records.md` and
`docs/adr/ADR-003-per-entity-device-records.md` (the shape being extended), `serverless/worker.ts`
(`listLocations`, `saveLocations` and its 1000-row global cap, `handleAgentLocation`,
`handleGetLocations`, `handleLatestLocation`, `handleReleaseDevice`, `locationTime`/`observed_at`
from S272, `activePollSeconds` as the precedent for an env-overridable number, `ADAPTIVE_POLL`),
`serverless/worker.test.ts` (the location tests and `MockKV`), `serverless/README.md`,
`agent/agent.py` (`report_location` call sites).

**Findings**, each measured before the change:

- The cap was **global**: 1000 rows for the whole fleet. At 60 tracked devices that is 16
  reports each — about 8 minutes at the 30 s tracking poll (`ADAPTIVE_POLL.tracking = 30`).
  The last writer wins, so the chattiest device starves every other device's trail.
- Every report was a read-modify-write of up to 1000 rows. One tracking device rewrites ~1000
  rows every 30 s to append one fix.
- Only **three** read sites and **two** write sites touched the store, so the conversion was
  contained; `LOCATIONS_KEY` was referenced nowhere else (grep of `worker.ts`, `dashboard/src`,
  `scripts`). That is why this store could be done in one session while `devices` needed 27.
- `MockKV` stores keys in a plain object and **does** implement `list({prefix})`, so tests can
  assert the key layout through the KV interface — but `worker.ts` itself never calls `list()`,
  which is why the ADRs choose an explicit index over a prefix scan.

### Fog cleared

- **Location reports are per-entity (ADR-004)**: `location:<id>` records plus a **per-device**
  `location_index:<deviceId>`. No two devices share a window any more, so one device's report
  cannot evict another's.
- **The per-device cap is a real retention policy** — `LOCATION_HISTORY_LIMIT` (default 500 ≈ 4 h
  of continuous tracking), overridable as a `[vars]` entry the way `ACTIVE_POLL_SECONDS` is, so
  the pruning path is reachable by a test rather than asserted by inspection.
- **Pruning deletes the records**, not just the index: a command is rewritten in place, a report
  never is, so an unindexed report would otherwise live forever. Verified on a real run.
- **The legacy migration is idempotent under concurrency** because migrated rows get a
  deterministic id derived from their content — `generateId()` would duplicate every report when
  two isolates migrate at once.
- **The response gained a stable id.** The two read routes used to synthesise
  `loc-<deviceId>-<idx>`, which changed whenever the window shifted; the row now keeps its
  identity across reads.
- `listLocations`/`saveLocations` are deleted, and `serializeMutation`'s docstring plus the README
  now name only the stores still whole-list: `audit_log`, `bios_passwords`, `encryption_keys`.

### Fog remaining

- **Two stores plus one remain whole-list**: `audit_log`, `bios_passwords`, `encryption_keys`.
  The release cascade still rewrites all three per delete (visible in the S273 artifact).
- **The index writes per report are still whole-value writes**, bounded per device by the cap —
  the residual ADR-002 accepted, now scoped to one device instead of the fleet.
- **History reads load the device's whole retained window** (≤500 records) and sort it by
  `locationTime` before slicing, to keep the S272 `observed_at` semantics exact. A device at the
  cap therefore costs up to 500 gets per history request. If that proves slow, the fix is a
  stored sort key, not a narrower fetch — narrowing the fetch would reintroduce the S272 defect
  (a backfilled report with an older scan time dropping rows).
- **`worker.ts` is 5,006+ lines**, past the harness LSP's 5000-line limit: diagnostics report
  "too_large" and only `tsc` + the suite can see it. Splitting it is a named task.
- **MOLE has not been shipped** `9e464ab`, the `lock_state` work, or either storage change.
  Operator action.

### Debt items closed

None formally — ADR-004 closes a blocker line, not a ledger item, so no `commit_ref`/
`artifact_ref` pair is claimed.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration), plus the store-by-store work named above.

### Blockers

- MOLE's boot settings remain `Disable`; needs the HP reset or a BIOS visit. OPEN, operator action.
- `E-LOCK-SCREEN` stays `verified-in-unit-test`. OPEN, needs a human sign-in attempt.
- **The 60-device rollout blocker is down to two stores plus one**: `audit_log`,
  `bios_passwords`, `encryption_keys`. `devices` (S273) and `locations` (this session) are done.

### Session artifacts

- `docs/artifacts/s274-location-per-entity-keys.json` — the real Worker with a 5-report cap,
  driven through two interleaved devices, 8 reports on one of them (crossing the cap), and a
  release: **11 assertions**, including "evicted reports were deleted, not just unindexed",
  "B is untouched by A crossing its cap", and "no shared whole-list key exists".

### Failure attribution

- **No failures this session.** The only adjustments were mine: the first version of the new
  tests reached into `MockKV`'s private storage (`data.keys()`), which does not exist — the fix
  was to assert through the KV interface (`list({prefix})`) the mock actually implements. That is
  the same lesson as S272/S273 from the other direction: assert the contract, not the internals.

### VERIFY

- `serverless`: `npx vitest run` → **470 passed / 4 files** (was 464; +6 ADR-004 tests).
- `serverless`: `npx tsc --noEmit -p .` → clean.
- `scripts/test_cross_surface_contract.py` → **23 passed**.
- Artifact: 11/11 assertions on a real Worker run.
- `make graph-check` → all invariants pass.

### Next session opening

Take `audit_log` off the whole-list write — it is the highest-volume of the three remaining stores
and every mutation in the Worker appends to it — and ship the accumulated work to MOLE so the
lock → recover acceptance finally runs against something current.

---

---

## Session 275 — 2026-11-18 (audit leaves the fleet scan)

### RULE-ZERO — understanding logged before each change

**Read**: `docs/adr/ADR-00{2,3,4}-*.md` (the shape being extended a fourth time),
`serverless/worker.ts` (`listAudit`, `saveAudit`, `addAuditEntry` and its 16 call sites,
`handleGetAudit`, `handleReleaseDevice`, `AuditEntry`), `serverless/worker.test.ts`,
`serverless/README.md`, `serverless/pbl/env.ts` (where `[vars]` are declared).

**Findings**, measured before the change:

- `addAuditEntry` reads the whole audit list **and** scans the whole fleet for one hostname.
  Since ADR-003 that scan is one index read plus one read per device, on the write path **every
  mutation takes**. Measured on the artifact afterwards: 3 device-record reads for one mutation
  with 6 devices enrolled, versus one per device before.
- The append rewrote up to 500 entries to add one line, so two concurrent appends lost one.
- `GET /api/audit?device_id=` loaded the whole trail and discarded most of it.
- `handleReleaseDevice` rewrote the **entire** trail to amend a few lines, and in doing so could
  drop entries that fell off the 500-row cap mid-rewrite.
- Nine admin handlers found their device with `listDevices(env).find(d => d.id === deviceId)` —
  the same N+1 S273 fixed for the agent paths but not for admin ones. The artifact surfaced this;
  no test did.

### Fog cleared

- **Audit entries are per-entity (ADR-005)**: `audit:<id>` records behind one `audit_index` of
  `{id, device_id}`, capped at `AUDIT_HISTORY_LIMIT` (1000, env-overridable) with records pruned
  alongside their index entries. Legacy `audit_log` migrated with deterministic ids and deleted.
- **The fleet scan in the audit path is gone.** A mutation now reads a constant number of device
  records (3 with 6 devices enrolled), not one per device.
- **Release amends only its own entries** — asserted byte-for-byte that another device's entry is
  untouched — so it can no longer drop entries while rewriting the trail.
- **A device-scoped audit read selects its own ids** from the index instead of loading everything.
- **Nine admin handlers** now do one record read instead of a fleet scan; `handleLinkPbl` is the
  one that genuinely needs the fleet (pbl_device_id uniqueness) and its read moved after the 404.
- README and the `serializeMutation` docstring now name only `bios_passwords` and
  `encryption_keys` as whole lists.

### Fog remaining

- **Two stores remain whole-list**: `bios_passwords`, `encryption_keys`. Both are small,
  per-device, and the release cascade still rewrites them.
- **`audit_index` is a whole-value write**, bounded by the cap — the residual ADR-002 accepted,
  now over 1000 `{id, device_id}` tuples rather than over the entries.
- **The audit trail is still truncated by retention** (1000 entries). That is a compliance limit
  inherent to KV without an external sink; named here rather than discovered at an audit.
- **`addAuditEntry` still reads the device record for the hostname** on every call. Callers that
  already hold the device could pass it — a signature change across 16 sites, deliberately not
  bundled into this one.
- **`worker.ts` is past 5,000 lines**: harness diagnostics report "too_large"; `tsc` and the
  suite are the gates until it is split.
- **MOLE has not been shipped** any of the S272–S275 work. Operator action.

### Debt items closed

None formally — ADR-005 closes a blocker line, not a ledger item.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration), plus the two stores named above.

### Blockers

- MOLE's boot settings remain `Disable`; needs the HP reset or a BIOS visit. OPEN, operator action.
- `E-LOCK-SCREEN` stays `verified-in-unit-test`. OPEN, needs a human sign-in attempt.
- **The rollout blocker is down to two stores**: `bios_passwords`, `encryption_keys`. `devices`,
  `locations` and `audit_log` are all per-entity now.

### Session artifacts

- `docs/artifacts/s275-audit-per-entity-keys.json` — the real Worker with 6 devices enrolled,
  driven through mutations, a scoped read, a cap crossing and a release: **13 assertions**,
  including "a mutation does not scan the fleet for device records" (3 reads, 6 devices),
  "pruned entries took their records with them", and "another device's entry bytes are untouched
  by the release".

### Failure attribution

- **No suite failures.** Two artifact fixtures were mine and both were corrected by measuring
  rather than by guess: `flag-stolen` 409s on an already-stolen device (so it writes no second
  entry — used `rotate-key` instead), and the cap correctly pruned the bystander entry the release
  test wanted to protect (raised the limit for that section). Layer 4 in the useful direction: the
  artifact told me something the tests had not.
- **One real defect found by the artifact, not the suite**: nine admin handlers were still
  scanning the fleet to find one device. Fixed in the same commit, and the artifact's assertion
  now measures it (3 record reads with 6 devices enrolled).

### VERIFY

- `serverless`: `npx vitest run` → **476 passed / 4 files** (was 470; +6 ADR-005 tests).
- `serverless`: `npx tsc --noEmit -p .` → clean (covers `pbl/`; a harness "name cascade" advisory
  on `pbl/signing.ts` was checked and is a shared-name artifact, not a break).
- `scripts/test_cross_surface_contract.py` → **23 passed**.
- Artifact: 13/13 assertions on a real Worker run.
- `make graph-check` → all invariants pass.

### Next session opening

Take the last two whole-list stores — `bios_passwords` and `encryption_keys`, both small and
per-device — off the rewrite in one pass, and ship the accumulated S272–S276 work to MOLE so the
lock → recover acceptance finally runs against something current.

---

---

## Session 276 — 2026-11-18 (the last two whole-list stores hold secrets)

### RULE-ZERO — understanding logged before each change

**Read**: `docs/adr/ADR-00{2,3,4,5}-*.md`, `serverless/worker.ts` (`listKeys`/`saveKeys`,
`listBiosPasswords`/`saveBiosPasswords`, the KEK encrypt/decrypt helpers `encSecret`/`decSecret`,
and all eight call sites: check-in unlock, ACK, deadman, escrow, recover, PBA credentials, release),
`serverless/worker.test.ts` (the KEK at-rest test), `serverless/README.md`.

**Findings**, measured before the change:

- Both stores are read and written **only ever for one device**, at eight sites between them.
  There is no global read of either. So the defect was not the read shape — it was that a
  per-device operation rebuilt every other device's secrets into one value: two devices escrowing
  at once could lose a key, and **a lost encryption key is an unrecoverable device**.
- The population is the device set itself, and the rows per device are single digits (one key per
  escrowing command; one credential per type, of which there are four). That is the opposite of
  ADR-004/005, where the population was unbounded — so an index and a cap would be wrong here,
  and a cap on secrets could silently evict the key an unlock still needs.
- The key-selection rule is "newest wins", which exists because of the S269 defect (`find()`
  returned the oldest key and decryption failed). Any change had to preserve it.
- BIOS credentials are KEK-encrypted at rest; a migration must carry the encoding, not re-encrypt.

### Fog cleared

- **Both secret stores are per-device (ADR-006)**: `encryption_keys:<deviceId>` and
  `bios_passwords:<deviceId>`, legacy lists migrated once and deleted. `listKeys`, `saveKeys`,
  `listBiosPasswords` and `saveBiosPasswords` no longer exist, so a whole-list write cannot return.
- **No index and no cap, by construction.** The key set is exactly the device set and the rows per
  device are bounded by the command and credential types, so there is nothing to prune — which is
  the only safe design for material that must never be truncated.
- **The S269 rule survived and is now pinned**: `recover` releases the *newest* unreleased key with
  two candidates present, asserted on both the response and the stored `released_at` flags.
- **Every fleet-scale store is now per-entity**: commands (ADR-002), devices (ADR-003), locations
  (ADR-004), audit (ADR-005), secrets (ADR-006). What remains as single-value lists is `admins` and
  `hw_test_artifacts` — small, and not per-device collections.

### Fog remaining

- **`admins` and `hw_test_artifacts` are still whole-list writes.** Neither is a per-device
  collection and both are small; named rather than implied. An admin mutation still rewrites the
  admin list, which is acceptable at this size but is the same shape.
- **The three indexes are whole-value writes** — `device_index`, `audit_index`, and the per-device
  `location_index` — capped (audit) or append-mostly (devices), the residual ADR-002 accepted.
- **Location history still loads a device's whole retained window** (≤500 records) to keep the
  S272 `observed_at` ordering exact; the fix, if it proves slow, is a stored sort key.
- **`worker.ts` is past 5,000 lines**, so harness diagnostics report "too_large" and `tsc` + the
  suite are the only gates on it.
- **MOLE has none of S272–S276** — `lock_state`, `observed_at`, and four storage changes.

### Debt items closed

None formally — ADR-006 closes the last part of a blocker line, not a ledger item.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- MOLE's boot settings remain `Disable`; needs the HP reset or a BIOS visit. OPEN, operator action.
- `E-LOCK-SCREEN` stays `verified-in-unit-test`. OPEN, needs a human sign-in attempt.
- **The 60-device rollout storage blocker is CLOSED**: the four stores it named — `devices`,
  `audit`, `bios_passwords`, `locations` — are all per-entity. The remaining single-value lists
  (`admins`, `hw_test_artifacts`) are not per-device volume, and the index residuals are recorded
  above. What is left before a rollout is the MOLE shipment and a hardware acceptance run.

### Session artifacts

- `docs/artifacts/s276-secret-stores-per-device-keys.json` — the real Worker taking two devices
  through ACK → deadman → recover → release: **13 assertions**, including "B's key bytes are
  untouched by A's escrow", "the newest key was the one released", and "the bystander device's key
  record is untouched" after a release.

### Failure attribution

- **No suite failures from the change**; the four new tests needed **three rounds of fixture
  correction**, all mine and all about API state I had not checked before writing them:
  an ACK needs a real queued command id (not `'ignored'`), the PBA route migrates only *its* store
  (the key store needed its own reader to migrate), and `recover` leaves a device in `recovering`
  where release refuses it (so the unlock must be ACKed to reach `active`).
- **Layer 4, cost:** each of those was a guess about a state machine I had read but not traced.
  The lesson is the one this repo keeps re-learning: drive the fixture through the real endpoints
  and read the status codes, rather than seeding the store and assuming the transitions.

### VERIFY

- `serverless`: `npx vitest run` → **480 passed / 4 files** (was 476; +4 ADR-006 tests).
- `serverless`: `npx tsc --noEmit -p .` → clean.
- `scripts/test_cross_surface_contract.py` → **23 passed**.
- Artifact: 13/13 assertions on a real Worker run.
- `make graph-check` → all invariants pass.

### Next session opening

Ship S272–S276 to MOLE and run the lock → recover acceptance with `lock_state` visible — the
storage blocker is closed, so the next evidence needed is a hardware run, not more refactoring.

---

---

## Session 277 — 2026-11-18 (the Worker comes back into view)

### RULE-ZERO — understanding logged before each change

**Read**: `serverless/worker.ts` (all top-level declarations with line numbers, the helper
dependency graph, the three `new URL(request.url)` call sites), `serverless/pbl/env.ts`,
`scripts/test_cross_surface_contract.py` (the tests that grep `worker.ts` for values),
`serverless/enroll-setup.test.ts` + `serverless/pbl.test.ts` (coverage for the code being moved),
`AGENTS.md`'s harness notes on the 5000-line LSP limit.

**Findings**, measured before the change:

- `worker.ts` was **5,419 lines**. The harness LSP refuses files over 5,000, so it reported
  `too_large` instead of a verdict: the file every storage and route change of the last five
  sessions went through was **invisible to diagnostics**. That is a tooling defect, not a style
  one, and it is why this session's work started with a measurement rather than a fix.
- Extraction order is forced by the dependency graph: the zero-dependency primitives
  (`jsonResponse`, `sha256`, `parseKvJson`, `b64*`, `generateId`, `requestUrl`) must move first or
  `admin-auth`/storage would import from `worker.ts` and create a cycle.
- Three call sites built `new URL(request.url)` directly when `requestUrl()` — the total parser
  that exists precisely so handlers do not need try/catch — was already imported.
- `composeEnrollSetupScript` took a **string** and constructed a `URL` inside: the one genuinely
  throwing construction in the moved code.

### Fog cleared

- **`worker.ts` is 4,925 lines** (from 5,419) and the LSP now reports `too_large=0` — the file is
  analysable again. Three modules were extracted in dependency order:
  `serverless/http.ts` (134), `serverless/admin-auth.ts` (214),
  `serverless/installer-scripts.ts` (188).
- **Three unsafe `new URL` sites now use `requestUrl()`**, so a malformed request URL degrades to
  empty route params instead of throwing — which is the behaviour `requestUrl` was written for.
- **The installer composer takes a validated `URL`**, so that module contains no throwing
  construction at all (the checker was right about this one).
- **The contract test follows the code it pins**: it asserts `PBKDF2_ITERATIONS = 100_000` against
  ADR-001 in `admin-auth.ts` now, rather than in the file that happened to hold it.

### Fog remaining

- **`worker.ts` is still 4,925 lines** and its `fetch` dispatch measures complexity 145. The two
  obvious next cuts are the storage layer (~900 lines, ADR-002..006) into `serverless/kv/`, and
  the `/v1` PBL routes (~460 lines) into `pbl/routes.ts`. Both need the same dependency care.
- **The ship to MOLE is blocked on the operator, with evidence**: the lab server at
  `192.168.1.43:3001` is unreachable (HTTP 000 — MOLE's port proxy does not survive a WSL restart)
  and `wrangler whoami` reports **not authenticated**, so neither a Worker deploy nor a hardware
  acceptance run is possible from this host.
- **`admins` and `hw_test_artifacts` remain whole-list writes** (small, not per-device volume).
- The index residuals (`device_index`, `audit_index`, `location_index`) are unchanged.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- MOLE's boot settings remain `Disable`; needs the HP reset or a BIOS visit. OPEN, operator action.
- `E-LOCK-SCREEN` stays `verified-in-unit-test`. OPEN, needs a human sign-in attempt.
- **Ship to MOLE / deploy the Worker: BLOCKED, operator action.** Two independent requirements:
  bring the Windows port proxy back up on MOLE, and `wrangler login` (or `CLOUDFLARE_API_TOKEN`)
  on this host. Verified this session: `curl` → HTTP 000, `wrangler whoami` → not authenticated.

### Session artifacts

- None produced. This session's evidence is the harness verdict change itself: `too_large=1` →
  `too_large=0` on `serverless/worker.ts`, plus 480 tests / `tsc` / 23 contract tests green.

### Failure attribution

- **Layer 3 (execution environment), caught and corrected mid-session**: a `cd serverless` in a
  command did not take effect (the shell's working directory had persisted from the previous call),
  so a `vitest run` executed from the repo root and reported **dashboard** suites failing. It
  looked like a catastrophic break of code I had not touched. The fix is a habit, not a check:
  use absolute paths for gate commands and read `pwd`, rather than trusting a silent `cd` chain.
- **Layer 4 (verification feedback)**: moving `PBKDF2_ITERATIONS` broke a cross-surface test that
  greps `worker.ts` by source text. The test was right to fail — it pins a value — but the coupling
  to a file path is the hazard. It now reads the module the value lives in, with the reason stated.

### VERIFY

- `serverless`: `npx vitest run` → **480 passed / 4 files**.
- `serverless`: `npx tsc --noEmit -p .` → clean.
- `scripts/test_cross_surface_contract.py` → **23 passed**.
- `make graph-check` → all invariants pass.
- `lens_diagnostics` (full, LSP) on the four modules → no errors, and `worker.ts` no longer
  reports `too_large`.

### Next session opening

Ship S272–S277 to MOLE — the only remaining requirement is operator access (port proxy up,
`wrangler login`) — and if that stays blocked, cut the storage layer out of `worker.ts` next, since
it is the cohesive 900-line block the last five ADRs describe.

---

---

## Session 278 — 2026-11-18 (the stores get their own module)

### RULE-ZERO — understanding logged before each change

**Read**: `serverless/worker.ts` (top-level declaration map, the storage block boundaries, the
dependency direction of every store helper), `serverless/http.ts`, `serverless/admin-auth.ts`,
`scripts/test_cross_surface_contract.py` (the assertions that grep `worker.ts` for values),
`docs/adr/ADR-00{2,3,4,5,6}-*.md` (the decisions the code implements).

**Findings**, measured before the change:

- The storage block was **contiguous** — devices (ADR-003, with the check-in metadata split and
  derived `lock_state`), commands (ADR-002), secrets (ADR-006), locations (ADR-004), audit
  (ADR-005) — 986 lines plus 195 lines of the ten types they speak. The largest cohesive block
  left in a 4,925-line file.
- The dependency direction allows an acyclic split: every storage helper needs only `Env` and
  `http.ts`'s zero-dependency helpers, so nothing in the module imports back from `worker.ts`.
- Two cross-surface assertions grep `worker.ts` for `lock_state` values and
  `LOCK_STATE_FRESH_MS = 180_000`, so the move would break them — the same coupling S277 hit with
  `PBKDF2_ITERATIONS`.
- 97 declarations are exported by the store module and only **42** are referenced by `worker.ts`.
  The import list had to be derived from usage, not hand-written.

### Fog cleared

- **`worker.ts` is 3,751 lines** (from 4,925) and `serverless/kv-store.ts` is 1,203. The file now
  has a five-module layout: `http.ts` (134), `admin-auth.ts` (214), `installer-scripts.ts` (188),
  `kv-store.ts` (1,203), `worker.ts` (3,751).
- **The five storage ADRs now map to one module.** The ADR comments travel with the code that
  implements them, so "where is ADR-004 implemented" has a file answer rather than a line range in
  a 5,000-line file.
- **Both broken contract assertions follow the value, not the path** — they pin the Worker/Express
  agreement, which is the actual contract; the file it lives in is incidental.

### Fog remaining

- **`worker.ts` is still 3,751 lines** with a `fetch` dispatch measuring complexity 145. The
  remaining obvious cuts: the `/v1` PBL routes (~460 lines, into `pbl/routes.ts`) and the agent
  handlers (check-in, ACK, escrow, deadman).
- **The ship to MOLE is still blocked on operator access** — unchanged and re-verified this
  session: `agent/.venv/bin/python -m pytest scripts/test_tls_floor.py` fails on the unreadable
  `docker.sock` (the documented host limitation), and the lab server + wrangler remain
  unreachable/unauthenticated as recorded in S277.
- **`admins` and `hw_test_artifacts` remain whole-list writes** (small, not per-device volume).
- Index residuals (`device_index`, `audit_index`, `location_index`) unchanged.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- MOLE's boot settings remain `Disable`; needs the HP reset or a BIOS visit. OPEN, operator action.
- `E-LOCK-SCREEN` stays `verified-in-unit-test`. OPEN, needs a human sign-in attempt.
- **Ship to MOLE / deploy the Worker: BLOCKED, operator action** (port proxy on MOLE,
  `wrangler login` here). Unchanged since S277.

### Session artifacts

- None beyond the harness verdicts: 480 tests, `tsc` clean, 23 contract tests, invariants pass,
  and `worker.ts` at 3,751 lines.

### Failure attribution

- **Layer 4 (verification feedback), twice, both mine and both caught by the gates rather than by
  review**: (1) the type-block slice came back empty because my banner regex matched the file's
  FIRST banner instead of the one after the interfaces — the stores moved without their types and
  `tsc` reported 33 missing names immediately; (2) my import-pruning regex silently matched
  nothing, so four unused imports survived until the linter named them. The lesson is the same in
  both cases: a scripted edit's own success message is not evidence — grep the file afterwards.
- **Layer 4 (contract coupling), third occurrence this series**: two cross-surface tests broke
  because they grep `worker.ts` by path. Each time the right fix was to follow the value and say
  why, not to weaken the assertion.

### VERIFY

- `serverless`: `npx vitest run` → **480 passed / 4 files** (unchanged count — a pure move).
- `serverless`: `npx tsc --noEmit -p .` → clean.
- `scripts/test_cross_surface_contract.py` → **23 passed** (two assertions repointed at
  `kv-store.ts`).
- `make graph-check` → all invariants pass.
- `scripts/test_tls_floor.py` → still the one documented host failure (docker socket), unrelated.

### Next session opening

Ship S272–S278 to MOLE if the operator has restored access (port proxy up, `wrangler login`);
otherwise cut the `/v1` PBL routes into `pbl/routes.ts`, which is the next ~460 lines and the last
block that is not already behind a module boundary.

---

---

## Session 279 — 2026-11-18 (the firmware routes leave the Worker)

### RULE-ZERO — understanding logged before each change

**Read**: `serverless/worker.ts` (the `/v1` dispatcher block and every identifier it calls),
`serverless/pbl/*` (signing, certs, devices, rateLimit, routes/verdict|policy|enroll|attest|
override|signingKey|firmware), `serverless/worker.test.ts` (how it obtains `resetKeyCache`).

**Findings**, measured before the change:

- The dispatcher is **458 lines** and every handler it routes to already lives in `pbl/routes/`.
  Of the twelve things it calls, **ten come from `pbl/*` and two — `getSigningKeys` /
  `getPolicySigningKeys` — were worker-local**, purely because they memoise the signing key per
  isolate. That pair was the only thing keeping the `/v1` surface tied to `worker.ts`.
- `errorResponse` and `requireRole` are importable modules since S277, so the routes need nothing
  from the Worker itself beyond `Env`.
- `worker.test.ts` reads `resetKeyCache` **off the worker module** (`mod.resetKeyCache`), so moving
  the cache state requires a re-export or the harness silently stops resetting between cases
  (`if (resetKeyCache) resetKeyCache();` — a guard that hides the loss).

### Fog cleared

- **`worker.ts` is 3,259 lines** (from 3,751). `serverless/pbl/routes/index.ts` holds the 458-line
  dispatcher; `serverless/pbl/keys.ts` (34 lines) holds the isolate signing-key cache.
- **The `/v1` firmware surface no longer imports from the Worker at all** — `Env`, `errorResponse`
  and `requireRole` are modules, and the key getters now live beside the routes that use them.
- **Twenty-four imports that became unused in `worker.ts` were removed**, not left for the linter:
  the module graph genuinely does not need them any more.
- `resetKeyCache` is re-exported, so the harness contract is unchanged while the state moved.

### Fog remaining

- **`worker.ts` is 3,259 lines.** Remaining cohesive blocks: the agent handlers (check-in, ACK,
  escrow, deadman — ~500 lines), the device admin handlers (~700), uninstall auth (~200), the
  installer endpoints (~250). The `fetch` dispatch still measures complexity 145.
- **`admins` and `hw_test_artifacts` remain whole-list writes** (small, not per-device volume).
- **Ship to MOLE / Worker deploy: still blocked on operator access** (MOLE port proxy,
  `wrangler login`) — unchanged and re-verified this session.
- Index residuals unchanged.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- MOLE's boot settings remain `Disable`; needs the HP reset or a BIOS visit. OPEN, operator action.
- `E-LOCK-SCREEN` stays `verified-in-unit-test`. OPEN, needs a human sign-in attempt.
- **Ship to MOLE / deploy the Worker: BLOCKED, operator action.** Unchanged since S277.

### Session artifacts

- None beyond the verdicts: 480 tests / `tsc` / 23 contract tests / invariants, and the three file
  sizes (`worker.ts` 3,259, `pbl/routes/index.ts` 484, `pbl/keys.ts` 34).

### Failure attribution

- **Layer 4, caught by a gate**: `tsc` found the one symbol the move broke — `resetKeyCache`, called
  from the key-rotation route but defined in the block that moved. Worth naming because the test
  harness reads it defensively (`if (resetKeyCache)`), so a missing re-export would have turned into
  a silently-unreset cache between cases rather than a failure.
- **My own instrumentation was wrong twice**: a print statement's escaping produced nonsense line
  counts ("worker.ts: 3"), and an earlier attempt to prune imports by regex reported success while
  matching nothing. Both were caught by `wc`/the linter rather than by trusting the script.

### VERIFY

- `serverless`: `npx vitest run` → **480 passed / 4 files** (unchanged — a pure move).
- `serverless`: `npx tsc --noEmit -p .` → clean.
- `scripts/test_cross_surface_contract.py` → **23 passed**.
- `make graph-check` → all invariants pass.

### Next session opening

Ship S272–S279 to MOLE if access is restored; otherwise extract the agent handlers (check-in, ACK,
escrow, deadman) — the last ~500-line cohesive block in `worker.ts`.

---

---

## Session 280 — 2026-11-18 (the agent protocol leaves the Worker)

### RULE-ZERO — understanding logged before each change

**Read**: `serverless/worker.ts` (the agent-auth section, the five agent handlers, the `fetch`
dispatch, and the import block that sits at the bottom of the file), `serverless/http.ts` /
`kv-store.ts` headers (the extraction convention and its acyclicity rule),
`serverless/pbl/routes/index.ts` + `pbl/keys.ts` (S279's precedent),
`serverless/vitest.config.mts`, `serverless/enroll-setup.test.ts` (a source-text assertion pinned
to a file path), `scripts/test_cross_surface_contract.py` (the `observed_at` contract),
`scripts/audit_test_teeth.py` (the mutation table), `docs/adr/PBL-SERVERLESS-COMPAT.md` (the agent
auth contract, §91-105), `.devin/skills/codebase-navigation/SKILL.md`.

**Findings**, measured before the change:

- `worker.ts` was **3,259 lines**. The agent block is three ranges — the auth section (63-107) and
  the two handler ranges (391-641, 670-886) — **513 lines total**, and it is the only remaining
  cohesive block that is entirely agent protocol.
- `verifyAgentAuth` is called in **seven** places, and **four of them are not agent-protocol
  handlers** (`handlePing`, `handleUploadEfsCert`, `handleAgentUpdate`, `handleAgentBinaryDownload`).
  It therefore had to move out and be *exported*, not travel as a private helper.
- `serializeMutation` sits inside the same range but is used by the dispatch for **admin**
  mutations (flag / recover / track), so moving it would have inverted the dependency. It stays.
- Two harness pieces pin source text to `worker.ts` **by path** and would rot silently:
  `enroll-setup.test.ts:273` (newest-key selection) and `test_cross_surface_contract.py:544`
  (`OBSERVED_AT_MAX_SKEW_MS`, `l.observed_at || l.created_at`). `audit_test_teeth.py`'s table names
  `serverless/worker.ts` for 35 rows, **8 of which anchor inside the moving block**.
- The coverage gate covered `worker.ts` **only** (`include: ['worker.ts']`).

### Fog cleared

- **`worker.ts` is 2,727 lines** (from 3,259); `serverless/agent-routes.ts` is 541 and holds the
  agent protocol: `verifyAgentAuth` plus check-in, deadman report, location report, command ACK and
  key escrow.
- **The moved text is byte-identical.** Verified programmatically against
  `git show HEAD:serverless/worker.ts`: the 513 lines reassemble to exactly the three source ranges,
  equal modulo the seven added `export ` keywords — a move, not a rewrite.
- **The agent credential has one home again.** `verifyAgentAuth` moved with the handlers and is
  exported for the four agent-authenticated handlers that stayed behind.
- **The coverage gate had been narrowing silently.** `include: ['worker.ts']` meant every module
  extracted since S277 (`http.ts`, `admin-auth.ts`, `kv-store.ts`, `installer-scripts.ts`, `pbl/*`)
  and now `agent-routes.ts` was outside the denominator — `worker.ts`'s own score had *risen* to
  90.54/85.87/95.45/92.94 precisely because 17% of the code left the measurement. Widened to every
  source module; the honest whole-tree figure is **86.36 / 82.99 / 95.04 / 88.52** and **every
  existing floor still passes**, so no threshold was lowered to accommodate it.
- Dead section markers left by the earlier splits (two empty `Types` blocks, one `Helpers` block in
  the first 62 lines of `worker.ts`) removed, since the auth section that followed them moved.
- **Harness rows repointed rather than left to skip**: 8 mutation-table rows now name
  `agent-routes.ts`, and both source-text assertions read *both* modules, so a future move cannot
  turn them vacuous.

### Fog remaining

- **`worker.ts` is 2,727 lines.** Remaining cohesive blocks: the device admin handlers (~700), the
  installer endpoints (~200), uninstall auth (~120), admin handling and hardware artifacts. The
  `fetch` dispatch's complexity is unchanged.
- **12 mutation rows in `scripts/audit_test_teeth.py` anchor on pre-ADR-002 code and match 0 times**,
  so the script prints `SKIPPED` for them: `WRK/ack-ownership`, `ack-terminal`, `ack-uuid`,
  `ack-blocked-files`, `ack-session-context`, `ack-track-status`, `ack-audit-detail`,
  `effectiveness-persist`, `recover-unlock`, `uninstall-authz`, `uninstall-verify`,
  `hw-artifact-list-blob`. This is **pre-existing** — they matched 0 times in `HEAD` before this
  session — and is not fixed here; re-anchoring them means authoring new mutations against code this
  session did not change.
- **`pbl/routes/signingKey.ts` 0% and `pbl/routes/firmware.ts` 16.66% coverage** — visible only now
  that the include widened; both are reached solely through the `/v1` URL download path the unit
  suite never takes.
- `B-146` still says the `/v1` dispatcher is 458 lines; S279 recorded 484 after the file grew. Not
  re-verified.
- **Ship to MOLE / Worker deploy: still blocked on operator access** — re-verified this session.
- **`brain.py` has no file locking**: two concurrent invocations lose one write (observed).

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- MOLE's boot settings remain `Disable`; needs the HP reset or a BIOS visit. OPEN, operator action.
- `E-LOCK-SCREEN` stays `verified-in-unit-test`. OPEN, needs a human sign-in attempt.
- **Ship to MOLE / deploy the Worker: BLOCKED, operator action.** Re-measured this session:
  `curl http://192.168.1.43:3001/api/health` → **HTTP 000** (curl exit 7), and
  `npx wrangler whoami` → **not authenticated**. Both requirements unchanged since S277.

### Session artifacts

- `docs/artifacts/s280-agent-routes-split.txt` — the sweep in one file: 480 worker tests, `tsc`
  clean, coverage 86.36 / 82.99 / 95.04 / 88.52 over the widened include, 23 contract tests, all
  graph invariants, and both file sizes (2,727 / 541).

### Failure attribution

- **Layer 4 (verification feedback), caught by gates**: `tsc` found the seven missing `export`
  keywords — the module compiled as a set of private functions, and `worker.ts`'s import would have
  failed at build. And `enroll-setup.test.ts` caught the more interesting class: an assertion that
  reads one file *by path* passes when the line it pins has moved out of that file, so it goes
  vacuous instead of red. Both assertion sites now name every module that can hold the line.
- **Layer 5 (state management)**: two `brain.py` invocations issued in parallel lost one write —
  both allocated `B-147`, and the refutation of `B-144` vanished until it was re-run serially. The
  store has no lock; the tool fix belongs in `brain.py`, the operating rule until then is one write
  at a time.
- **A harness gap I was not looking for**: the coverage include had been shrinking since S277 and
  nothing reported it, because a shrinking denominator only makes the number go up. Found by
  measuring, not by any gate.

### VERIFY

- `serverless`: `npx vitest run` → **480 passed / 4 files**.
- `serverless`: `npx tsc --noEmit -p .` → clean.
- `serverless`: `npx vitest run --coverage` → **86.36 / 82.99 / 95.04 / 88.52**, all floors pass.
- `scripts/test_cross_surface_contract.py` → **23 passed**.
- `make graph-check` → all invariants pass.

### Next session opening

Extract the device admin handlers (~700 lines: list / get / flag / recover / track / rearm /
commands / locations / efs-cert / pba-credentials / release) into `serverless/device-routes.ts` —
unless MOLE access is restored, in which case ship S272–S280 and run the lock → recover acceptance.

---

---

## Session 281 — 2026-11-18 (the ship blocker was misattributed for five sessions)

### RULE-ZERO — understanding logged before each change

**Read**: the trace's blocker text across S277–S280 (`trace.md` lines 1009-1030, 1060, 1127, 1158,
1202), `AGENTS.md` (the "the debt ledger can be stale — verify the actual codebase state" rule, and
the hardware-window notes about the port proxy), `server/package.json` + `server/dev-start-sqlite.js`
+ `server/src/config/env.js` (how a server can legally start on this host),
`server/src/index.js` (`app.listen(PORT)`, `PORT || 3001`), `~/.ssh/` (which key the lab box
accepts), `/etc/ufw/ufw.conf`, `/etc/default/ufw`, `/etc/ufw/user.rules`.

**Findings**, measured before any claim:

- **The SSH route to MOLE is `labadmin@192.168.1.249` with `~/.ssh/lockdown_lab_ed25519`.** The
  default `~/.ssh/id_ed25519` is rejected (`Permission denied (publickey)`), there is no
  `~/.ssh/config` entry, and nothing in the repo recorded either fact — the route existed only in a
  trace addendum ("OpenSSH + `administrators_authorized_keys` on `192.168.1.249`, run as
  `labadmin`") that does not name the key.
- **This host is not WSL.** `uname -r` = `7.2.15-1-omarchy`, `/etc/os-release` = Omarchy, LAN address
  `192.168.1.43` on `wlp0s20f3`, no Windows interop binaries. The S277–S280 blocker text ("MOLE's
  port proxy does not survive a WSL restart") describes a topology that does not exist here.
- **MOLE has no port proxy at all**: `netsh interface portproxy show v4tov4` prints nothing. None is
  needed — this host holds `192.168.1.43` directly and `ping` from MOLE answers in 2 ms at TTL 64.
- **`node src/index.js` cannot start here**: config validation refuses non-production NODE_ENV
  without `ALLOW_NON_PROD=1` and rejects placeholder secrets. The supported dev entry is
  `server/dev-start-sqlite.js`, which supplies SQLite + dev secrets and listens on `PORT` (3001).

### Fog cleared

- **The web route and the failure are now separate, measured facts**: from this host
  `curl http://192.168.1.43:3001/api/health` → **200** with the server listening on `*:3001`; from
  MOLE the same request → **000**, and `Test-NetConnection -Port 3001` → **False**, while ICMP
  still answers.
- **The gate is this host's own firewall.** `ufw` is `ENABLED=yes`, `DEFAULT_INPUT_POLICY="DROP"`,
  and `user.rules` allows TCP **53317, 8000, 8787** only — `3001` has no rule, so MOLE's SYN is
  dropped. That is the whole blocker, and it is one command away from resolution:
  `sudo ufw allow 3001/tcp`.
- **The two sessions of "operator access is blocked" were two different problems.** The Worker
  deploy needs `wrangler login` (still true, still operator-only); reaching MOLE's API needed one
  ufw rule on this host and nothing on MOLE.
- **The server is running** for the next step (SQLite, `server/.sqlite-data/lockdown-dev.db`,
  `PORT=3001`), verified by a local 200.

### Fog remaining

- **`sudo ufw allow 3001/tcp` was NOT applied**: passwordless sudo is unavailable in this session
  (`sudo -n` → "a password is required"). This is an operator action, now named precisely.
- **The fresh SQLite database holds zero devices**, so MOLE's `LockdownAgent` service (state
  `RUNNING`, verified over SSH) will keep getting `401` at check-in until the device is re-enrolled
  or the previous DB is restored. A 200 on `/api/health` proves the route, not the enrolment.
- **`npx wrangler whoami` → not authenticated.** Unchanged; the Worker deploy still cannot run.
- Untouched and still open from earlier blocks: the ~700-line device admin handlers in `worker.ts`,
  the 12 stale `audit_test_teeth.py` rows, the two thin PBL route modules.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **Reaching the lab server from MOLE: one ufw rule, needs root.** Not an operator-on-MOLE action —
  MOLE is reachable and correct; this host refuses the SYN.
- **Deploying the Worker: `wrangler login`.** Operator action, unchanged since S277.
- MOLE's boot settings remain `Disable`; needs the HP reset or a BIOS visit. OPEN, operator action.
- `E-LOCK-SCREEN` stays `verified-in-unit-test`. OPEN, needs a human sign-in attempt.

### Session artifacts

- `docs/artifacts/s281-mole-reachability.txt` — every probe above captured from the two machines
  that produced it: the working SSH command and the rejected key, MOLE's empty portproxy table,
  ping TTL 64 vs TCP `False`, local `200` vs MOLE `000`, the OS identity that rules out WSL, the
  ufw policy and its allowed port list, and the exact command not yet run.

### Failure attribution

- **Layer 5 (state management), and the most expensive kind**: the same blocker sentence was copied
  forward through five session blocks (S277→S280) without re-measurement. Each session recorded
  honest evidence *for its own re-check* ("HTTP 000") but inherited the *explanation* from the
  session before, and the explanation was wrong from the start — there is no WSL and no proxy in the
  path. AGENTS.md already demands this discipline for the debt ledger ("the ledger can be stale —
  verify the actual codebase state"); the rule was never applied to blockers. The fix that would
  have prevented it: a blocker that names a mechanism must cite the command that showed the
  mechanism, not just the symptom, which is what this session's artifact does.
- **Layer 4 (verification feedback)**: the first server start used `node src/index.js` and died on
  config validation. The failure was loud and correct; the documented dev entry
  (`dev-start-sqlite.js`) was one `grep` away, not one guess.

### VERIFY

- This host: `curl http://192.168.1.43:3001/api/health` → **200**
  `{"status":"ok","timestamp":"2026-11-18T05:57:18.752Z"}`; `ss -ltnp` → `LISTEN *:3001`.
- MOLE, over SSH: `curl` → **000**; `Test-NetConnection -Port 3001` → **False**; `ping` → 2 ms.
- `ufw`: `ENABLED=yes`, `DEFAULT_INPUT_POLICY="DROP"`, allowed tcp = 53317/8000/8787.
- `brain.py check` → 150 beliefs, integrity clean; B-150 confirmed at level `hardware`.

### Next session opening

Run `sudo ufw allow 3001/tcp` on this host (or `from 192.168.1.0/24 to any port 3001 proto tcp`),
then re-verify `curl http://192.168.1.43:3001/api/health` from MOLE over
`ssh -i ~/.ssh/lockdown_lab_ed25519 labadmin@192.168.1.249` and run the lock → recover acceptance.

---

---

## Session 282 — 2026-11-18 (MOLE is live: the agent never wanted port 3001)

### RULE-ZERO — understanding logged before each change

**Read**: `docs/artifacts/s281-mole-reachability.txt` (the probes from the previous block),
MOLE's `C:\ProgramData\LockdownAgent\config.json` (read over SSH, secrets counted not printed),
`server/dev-start-sqlite.js` (which routes the dev scaffold actually mounts),
`server/src/routes/devices.js` (`POST /` — per-device key generation and what it returns),
`server/src/db/apiKey.js` (HMAC-SHA256 + pepper key hashing), `server/src/routes/enroll.js`
(the token/claim flow and the note that the dev scaffold does not mount it),
`server/src/db/migrations/001_base.sql` + the live SQLite `devices` schema,
`agent/installer.py` (`INSTALL_DIR`), `agent/agent.py` (`agent.log` location).

**Findings**, measured before any change:

- **MOLE's agent targets `http://192.168.1.43:8787`, not `:3001`.** `8787` is one of the three TCP
  ports ufw already allows, so the previous block's ufw finding, while true, was never the agent's
  path: the agent has not been trying to reach 3001 at all.
- **`dev-start-sqlite.js` is a reduced scaffold**: it mounts auth / devices / agent / audit / setup /
  installer / admins / health / metrics — **not `/api/enroll`**, so token enrolment 404s there.
  `POST /api/devices` is the mount that exists, and it returns the plaintext per-device key once.
- The device the agent believed it was (`49d2…`, key `6/ql9…`) is in no database here: the SQLite
  file was created fresh in the previous block. Nothing in MOLE's config was wrong — the server side
  simply had never heard of the device.
- MOLE's service supervisor had been logging `agent stalled - no answered check-in for 73557s`
  (~20.4 h), which is the same interval, from the agent's side, that the trace had spent blaming a
  port proxy.

### Fog cleared

- **The link is live and proven from both ends.** `GET /api/health` returns `200` locally and
  `200` from MOLE; after enrolment and a service restart the server holds
  `MOLE / last_checkin 2026-11-18 06:39:50 / agent_version 1.0.0 / update_verification sha256-only /
  lock_state none`, with `firmware_audit` = HP EliteBook 830 G6, BIOS `R70 Ver. 01.36.00`,
  `secure_boot: false` (`secure_boot_off`).
- **The enrolment path that works here** is `POST /api/devices` → 201 with the plaintext key, then
  patch `api_key` + `device_id` in `config.json` and restart the service. Reversible on both sides:
  the row is one DELETE, and MOLE keeps `config.json.bak-s282`.
- **MOLE has no usable TPM**: `TPM key creation failed` → `falling back to DPAPI/plaintext`. Same
  class of limitation as FRANKENSTEIN, now measured on this unit too.
- **The agent's polling is adaptive and healthy**: `30s -> 300s (status=active)` after the check-in.

### Fog remaining

- **The Worker path was not exercised.** MOLE's `server_url` points at the Express server, so
  S272–S280's Worker changes are still only unit-tested; shipping them needs `wrangler login`.
- **No command was queued**, so no enforcement path ran. `boot_lock_enabled: true` is sitting in
  MOLE's config, and MOLE's boot settings are still `Disable` — a lockdown there is a real risk, not
  a routine test.
- **`:3001` still has no ufw rule** on this host. Nothing needs it (the agent uses 8787), but the
  trace and `current-state.md` have named 3001 as "the lab server" for many sessions, so the
  distinction must be stated wherever the address appears.
- `serial_number` is `null` on the server-side row (the check-in does not report it), and MOLE
  reports the MAC of a different adapter (`DC:71:96:20:4D:4B`) than the first "Up" adapter.
- Untouched and still open: the ~700-line device admin handlers in `worker.ts`, 12 stale
  `audit_test_teeth.py` rows, two thin PBL route modules.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **Running the lock → recover acceptance on MOLE: needs an explicit decision, not a tool call.**
  The device has `boot_lock_enabled: true` and MOLE's boot settings are `Disable`, so a lockdown
  changes boot configuration on hardware that a failed run cannot undo by itself.
- **Deploying the Worker: `wrangler login`.** Operator action, unchanged since S277.
- `E-LOCK-SCREEN` stays `verified-in-unit-test`. OPEN, needs a human sign-in attempt.

### Session artifacts

- `docs/artifacts/s282-mole-link-live.txt` — the target port and its ufw status, health from both
  ends, the server's own view of the MOLE row, MOLE's agent log verbatim (including the 73,557 s
  stall and the TPM fallback), the three reversible steps that produced the check-in, and a
  "what this does and does not prove" block.

### Failure attribution

- **Layer 2 (context provision)**: nothing in the repo recorded which port the agent targets, so
  two sessions investigated `:3001` because the *trace* said that was the lab server. One line in a
  runbook — "the agent's `server_url` is `:8787`; `:3001` is the dashboard/API address" — would have
  saved the whole detour. The belief layer now holds it (B-151).
- **Layer 4 (verification feedback)**, mild: the enrolment route I first reached for
  (`/api/enroll/token`) is not mounted on the dev scaffold, and the 404 only arrives as HTML. The
  scaffold's route list is readable in one grep; the docstring in `enroll.js` describes the full
  server, which is what misled the first attempt.

### VERIFY

- `curl http://192.168.1.43:8787/api/health` → **200** locally and **200** from MOLE over SSH.
- `ss -ltnp | grep 8787` → `LISTEN *:8787`.
- `GET /api/devices` → the MOLE row with `last_checkin 2026-11-18 06:39:50`, `agent_version 1.0.0`,
  `hardware_uuid BE10009B-5867-337C-5024-E390E760DA74`, `lock_state none`.
- MOLE `agent.log` → `Agent starting - hostname=MOLE server=http://192.168.1.43:8787 poll=30s`,
  then `Adaptive polling: 30s -> 300s (status=active)`.
- `brain.py check` → 151 beliefs, integrity clean; B-151 confirmed at level `hardware`.

### Next session opening

Decide whether to run the lock → recover acceptance on MOLE now that it is enrolled and checking in
(the risk is the device's own `boot_lock_enabled: true` against boot settings stuck on `Disable`),
and deploy the Worker with `npx wrangler login` to exercise the S272–S280 changes on the real path.

---

---

## Session 283 — 2026-11-18 (lock → recover acceptance on MOLE: data passes, boot lock does not)

### RULE-ZERO — understanding logged before each change

**Read**: `agent/agent.py::handle_lockdown` (escrow-before-arm, sentinel, `pending_ack`, recovery key
file), `handle_unlock` (account released first, decrypt, boot-lock removal), `_lockdown_effective`
(three measured conditions), `disable_console_account`/`re_enable_console_account` →
`hold_logon("lock")`, `agent/bcd_lockdown.py` (`_disable_winre`, `BCD_CRITICAL_COMMANDS`,
`remove_bcd_lockdown`), `agent/hp_uefi_lockdown.py::remove_boot_lockdown` (the `restored`/`attempted`
accounting and its return), `server/src/routes/devices.js` (`flag-stolen` with `enable_pba`,
`recover`), MOLE's `config.json` and live service state.

**Findings**, measured before the run:

- PBA is opt-in and defaults off; the route's own comment says PBA "sacrifices remote
  recoverability (a rebooted PBA device can't boot to receive unlock commands)". Ran with it off.
- The interactive account held by `lock` is the **last console user**, not the account SSH uses —
  so `labadmin` stayed reachable throughout and the run could be observed from both ends.
- MOLE's BCD already held the lockdown values (`recoveryenabled No`, `displaybootmenu No`,
  `timeout 0`) before this run: a previous lockdown was never restored on this unit.

### Fog cleared

- **Data path: PASS, on hardware, end to end.** The folder was encrypted with a fresh key
  (`blocked_files=0`), the key was escrowed before arming, and `recover` decrypted it:
  `Decrypted: README.txt`, sentinel removed, recovery-key file deleted, `README.txt` readable in
  plaintext, server row back to `status=active / lock_state=none`.
- **Logon hold: PASS.** Lockdown held `Newark User` (`logon_prevented=True`); unlock released the
  account **first**, before the key was even inspected — `Newark User -> Account active Yes`.
- **Boot lock: FAIL, and honestly reported.** Both layers rolled back: BCD because
  `CRITICAL: WinRE disable failed`, HP UEFI because 3 of 3 critical writes were refused
  (`Network (PXE) Boot`, `USB Storage Boot`, `Legacy Boot Options` → `Disable`). The command landed
  as `boot_lock_status=partial`, `lockdown_effective=0` — the Phase 17 detector did exactly what it
  exists for: it refused to call an encrypted-only device "locked".
- **A repeatable defect, measured on the unit**: MOLE's `reagentc /info` says
  `Windows RE status: Disabled`, and `_disable_winre()` returns False for any non-zero `reagentc`
  exit — with a comment saying exactly why ("returns non-zero if WinRE is already disabled"). That
  False is a **critical** failure in `apply_bcd_lockdown`, so a device that has been locked once can
  never report BCD lockdown success again. This is why the layer rolls back on a machine whose BCD
  state is already correct.
- **The deployed binary predates the tree it ran against.** It logged
  `Restored 0 BIOS settings to pre-lockdown state` and `UEFI boot lockdown removed - BIOS restored
  to pre-lockdown state` — strings that do not exist in the current source, where the same path logs
  `Restored 0 of %d … every write was refused` (ERROR) and the caller logs `did NOT restore`. MOLE's
  `lockdown-agent.exe` is 16,377,410 bytes, built 2026-11-17 10:41:08
  (`sha256 bb32c3d2…68de0`), i.e. before `9a43329 "never report a BIOS restore that was not
  verified"`. So the false success observed on hardware is the defect S271 already fixed in code —
  the fix has never been deployed here.

### Fog remaining

- **The current tree's boot-lock *reporting* is still untested on hardware.** Testing it needs a
  rebuilt `lockdown-agent.exe` staged to MOLE (`agent/build.ps1`, PyInstaller on Windows), which
  cannot be produced from this Linux host.
- **`_disable_winre()` idempotency is unfixed.** Until "already disabled" counts as success,
  E-BCD cannot pass on any device that has been locked once — including this one.
- **Why the three HP BIOS writes are refused is unknown.** S271 recorded the same refusals with the
  operator's own password; the cause may be Sure Start BSP (`Disable`), firmware policy, or the
  pre-existing Setup password. Not investigated.
- MOLE's boot settings still hold lockdown values from an earlier run, and Secure Boot is `false`
  (`secure_boot_off`) — unchanged by this session.
- Untouched: the ≈700-line device admin handlers in `worker.ts`, 12 stale `audit_test_teeth.py`
  rows, two thin PBL route modules, and the Worker deploy (`wrangler login`).

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **E-BCD cannot pass on a reused device** until `_disable_winre` treats "already disabled" as
  success. Code decision, not hardware.
- **Current-tree agent behaviour on hardware** is blocked on a Windows build host.
- **Worker deploy: `wrangler login`.** Operator action, unchanged.

### Session artifacts

- `docs/artifacts/s283-lock-recover-acceptance.txt` — baseline BCD/account/folder state, the
  lockdown command record with its full `boot_lock_detail`, MOLE's agent log for both directions,
  post-recovery device state read over SSH, the `reagentc /info` result that explains the BCD
  rollback, the deployed binary's size/date/hash with the log lines that prove it is older than the
  tree, and a four-line verdict.

### Failure attribution

- **Layer 4 (verification feedback)**: the acceptance was worth running precisely because two of its
  claims had never been measured with a real device — and one of them (boot lock) turned out to be a
  code-level idempotency defect rather than a hardware limit. No test would have found it: the unit
  tests stub `reagentc` to succeed.
- **Layer 2 (context provision)**: the deployed binary's vintage is not recorded anywhere on the
  device or in the server's device row. `agent_version` reads `1.0.0` for both the stale binary and
  the current tree, so "which agent is on that machine" cannot be answered from the dashboard. A
  build id in the version string would have told me immediately what I had to infer from log strings.

### VERIFY

- Lockdown ACK: `boot_lock_status=partial`, `lockdown_effective=0`, `blocked_files=0`,
  `logon_prevented=True (Newark User)`.
- Unlock ACK: `status=executed`; device `status=active`, `lock_state=none`.
- On-device after recovery: sentinel absent, `README.txt` plaintext, recovery-key file absent,
  `Newark User` and `labadmin` both active, service `Running`.
- `reagentc /info` on MOLE: `Windows RE status: Disabled` (the cause of the BCD rollback).
- `brain.py check` → 152 beliefs, integrity clean.

### Next session opening

Fix `agent/bcd_lockdown.py::_disable_winre` so an already-disabled WinRE counts as success (and add
the unit test that pins it), then re-run the lock → recover acceptance with a freshly built agent
staged to MOLE to exercise the current tree's boot-lock reporting.

---

---

## Session 284 — 2026-11-18 (WinRE idempotency: an already-locked device can be locked again)

### RULE-ZERO — understanding logged before each change

**Read**: `agent/bcd_lockdown.py` (module docstring and its CC19 critical/best-effort rationale,
`_run`'s dry-run branch, `_disable_winre` / `_enable_winre` / `_is_winre_enabled`,
`apply_bcd_lockdown`'s critical counter and rollback, `_rollback_bcd` callers),
`agent/tests/test_boot_lockdown_bcd.py` (the existing WinRE tests, including the one that pinned the
defect as expected behaviour), `.devin/skills/phase-3-hardening/SKILL.md` (hardening context),
`docs/artifacts/s283-lock-recover-acceptance.txt` (the hardware observation that named the defect).

**Findings**, measured before the change:

- `_disable_winre()` returned `False` for **any** non-zero `reagentc /disable`, with a comment
  stating the reason it can be non-zero: "reagentc returns non-zero if WinRE is already disabled or
  not installed". `apply_bcd_lockdown` counts that as a **critical** failure and rolls the whole
  layer back.
- MOLE's `reagentc /info` reports `Windows RE status: Disabled` (S283), so the rollback is
  guaranteed on every subsequent lockdown of that device.
- `test_disable_winre_already_disabled` asserted `is False` — the defect was **pinned as intended
  behaviour**, which is why no test ever caught it.
- `_is_winre_enabled()` returned `False` both for "disabled" and for "could not read", so it could
  not be used as the post-condition check without that distinction being made explicit.

### Fog cleared

- **`_disable_winre()` now re-reads the state instead of believing the exit code**: success renders
  `reagentc /disable` a no-op (`"WinRE already disabled … this is success, not a critical failure"`),
  and a still-enabled or **unreadable** state stays a failure — a broken `reagentc` cannot look like
  a lockdown.
- **The mirror case is fixed too**: `_enable_winre()` treats an already-enabled WinRE as success, so
  rollback and removal paths on an untouched machine stop reporting a verified no-op as an error.
- **`_winre_status()` is the one reader**, returning `enabled` / `disabled` / `None`, where `None` is
  "unreadable" and is deliberately not "disabled". `_is_winre_enabled()` is now a one-line
  projection of it, keeping its old "unknown reads as not enabled" contract.
- **The defect is pinned from both ends**: 6 WinRE unit tests (already-disabled → success,
  still-enabled → failure, unreadable → failure, and the same three for enable) plus an
  apply-level regression test asserting `rolled_back is False`, `winre_disabled is True` and the
  sentinel written when `reagentc /disable` fails against an already-disabled WinRE.

### Fog remaining

- **This is unit-tested only.** E-BCD keeps its `not hardware-verified by decision` ceiling, so no
  graph status moved. Confirming on hardware needs a rebuilt `lockdown-agent.exe` staged to MOLE
  (`agent/build.ps1`, PyInstaller on Windows), which this Linux host cannot produce.
- **The HP UEFI layer's three refused critical writes are unexplained** (S283): the cause could be
  Sure Start BSP `Disable`, a firmware policy, or the pre-existing Setup password. Not investigated.
- MOLE still holds BCD lockdown values from an earlier run and `secure_boot: false`.
- Untouched: the ≈700-line device admin handlers in `worker.ts`, 12 stale `audit_test_teeth.py` rows,
  two thin PBL route modules, and the Worker deploy (`wrangler login`).

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **Hardware confirmation of this fix: needs a Windows build host.** Unchanged in kind from S283.
- **Worker deploy: `wrangler login`.** Operator action.
- `E-LOCK-SCREEN` stays `verified-in-unit-test`. OPEN, needs a human sign-in attempt.

### Session artifacts

- `docs/artifacts/s284-winre-idempotency-fix.txt` — the defect as measured on hardware, the new
  three-function contract, the eight added tests by name, and the runs: 51 passed in the BCD file,
  **950 passed** across the agent suite, ruff check + format clean.

### Failure attribution

- **Layer 4 (verification feedback), squarely**: the test suite contained a test named
  `test_disable_winre_already_disabled` asserting the wrong outcome. A green suite over a pinned
  wrong expectation is worse than no test — it converts a defect into a contract. What would have
  prevented it: the test asserting *the state after* the call (re-read via `reagentc /info`) rather
  than only the boolean return, which is exactly the shape the fix now pins.
- **Layer 2 (context provision)**: the module docstring explains why each setting is critical but
  never says what "already in that state" should mean, so the idempotency question had no answer to
  read. The fix documents it at each function rather than in a distant table.

### VERIFY

- `scripts/run-agent-tests.sh tests/test_boot_lockdown_bcd.py` → **51 passed**.
- `scripts/run-agent-tests.sh` → **950 passed** in 54 s.
- `scripts/lint-agent.sh` → `All checks passed!`, `64 files already formatted`.
- `brain.py check` → 153 beliefs, integrity clean; B-152 refuted, B-153 confirmed at `code-read`.

### Next session opening

Stage a rebuilt `lockdown-agent.exe` to MOLE and re-run the lock → recover acceptance, so the
current tree's BCD layer (now idempotent) and its BIOS-restore reporting are exercised on hardware
rather than inferred from unit tests.

---

---

## Session 285 — 2026-11-18 (why MOLE's HP UEFI layer refuses: a password it never set)

### RULE-ZERO — understanding logged before each change

**Read**: `agent/hp_uefi_lockdown.py` (`_set_setting` and the exact `SetBIOSSetting` PowerShell it
builds, `SET_BIOS_RETURN_CODES`, `_verify_setting`, `apply_boot_lockdown`'s Setup-password guard,
`remove_boot_lockdown`'s `state["setup_password_was_set"]` branch), the two read-only probes already
on the unit (`probe-bios-state.ps1`, `probe-bsp.ps1`), MOLE's `agent.log` history for this layer,
`docs/artifacts/s283-lock-recover-acceptance.txt`.

**Findings**, measured before any claim:

- `HP_BIOSPassword` on MOLE reports **Setup Password `IsSet=1`**, **Power-On Password `IsSet=0`**
  (no PBA password — PBA was off, as intended).
- The agent's own log says it did **not** set that password: `"Setup password was pre-existing — not
  clearing (admin manages it)"`, and on 2026-11-17 it refused with `"BIOS Setup password is already
  set but no UEFI_PASSWORD configured"` before later runs found a value to use.
- The writes are signed with the **4-character `uefi_password` in the agent's config**, and HP
  answers return code **4 = "Failed"** (`6` would be "Access Denied") for all three critical writes.
- `agent/build` requires PyInstaller; MOLE has **no Python** (`Get-Command python/py/python3` return
  nothing) and 112 GB free, so rebuilding the agent there needs an interpreter installed first.

### Fog cleared

- **The S283 "unexplained" item now has a cause that fits every measurement**: MOLE has a BIOS Setup
  password the agent did not set, and the agent authenticates its writes with a 4-character value
  from its own config. Three critical writes are refused, the layer rolls back, and the ACK reports
  `boot_lock_status=partial` — exactly what was observed.
- **It is an operator secret, not a code defect**: the layer can work on this unit only once the real
  Setup password is supplied as `UEFI_PASSWORD` (or cleared in BIOS Setup).
- **A smaller code question is now visible**: `apply_boot_lockdown` refuses when a Setup password
  exists and *none* is configured, but never checks whether the configured one is right, so a wrong
  password costs three red writes and a rollback instead of one clear sentence.
- **The test-runner advisory from the harness is explained**: `python3 -m pytest` on this host fails
  with `No module named pytest` — no summary, exit 1. `scripts/run-agent-tests.sh` is the only valid
  runner (51 passed for the BCD file, 950 for the suite), which is exactly why that wrapper exists.

### Fog remaining

- **The password hypothesis is not proven by a write.** The cheapest confirmation is a no-op
  `SetBIOSSetting` (current value → current value), deliberately **not** attempted: a wrong password
  on HP firmware can raise the failed-attempt count, and this unit's boot state is already the
  fragile part of the lab.
- **Hardware confirmation of the S284 WinRE fix still needs a Windows build host.** MOLE has no
  Python; installing one there is an operator decision, not a tool call.
- **`Sure Start BIOS Settings Protection` is `Disable`** on this unit, so it is *not* the blocker,
  contrary to one plausible theory; the Setup-password reading is what fits.
- Untouched: the ≈700-line device admin handlers in `worker.ts`, 12 stale `audit_test_teeth.py`
  rows, two thin PBL route modules, and the Worker deploy (`wrangler login`).

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **HP UEFI lockdown on MOLE: needs the real BIOS Setup password in the agent config.** Operator
  secret. Until then that layer cannot pass on this unit, by design or otherwise.
- **Rebuilding the agent: needs a Python on a Windows host.** MOLE lacks one; installing it is an
  operator action.
- **Worker deploy: `wrangler login`.**

### Session artifacts

- `docs/artifacts/s285-mole-bios-write-refusal.txt` — the WMI firmware/password probe output, the
  agent's log history for the layer, the return-code table excerpt that turns "Failed" into code 4,
  the four facts that fit one cause, an explicit "what was not done and why" for the no-op write,
  and the pre-flight-probe idea the code is now missing.

### Failure attribution

- **Layer 4 (verification feedback)**: the UEFI layer's rollback had been reported as `partial` on
  hardware three times (S271, S283, and 2026-11-17) with no investigation of *why*, because the ACK
  was already "honest" — it said partial. An honest status is not a diagnosis. The probe scripts
  that answer it were already sitting on the unit from an earlier session and had never been run
  against this question.
- **Layer 3 (execution environment)**: `python3 -m pytest` failing with a bare exit 1 and no summary
  is a documented trap in this repo (`run-agent-tests.sh` exists for it), and it still cost a
  diagnostic step — evidence that a wrapper people can bypass will be bypassed.

### VERIFY

- `probe-bios-state.ps1` on MOLE → Setup Password `IsSet=1`, Power-On Password `IsSet=0`,
  Fast Boot / DMA Protection / Network (PXE) Boot / USB Storage Boot / Legacy Boot Options all
  exposed and settable.
- `probe-bsp.ps1` on MOLE → `Sure Start BIOS Settings Protection = Disable`,
  `Sure Start Secure Boot Keys Protection = Disable`.
- `agent.log` (2026-11-17 → 2026-11-18) → `Using existing BIOS Setup password`,
  three `-> 'Disable' failed: Failed`, `UEFI lockdown critically failed and was rolled back`.
- `python3 -m pytest` → `No module named pytest`; `scripts/run-agent-tests.sh` → 51 / 950 passed.

### Next session opening

Decide whether to install a Python on MOLE so the current-tree agent can be built and staged there,
then re-run the lock → recover acceptance; or supply the real BIOS Setup password as `UEFI_PASSWORD`
first, so the rebuild tests both changes at once.

---

---

## Session 286 — 2026-11-18 (the current tree on hardware: WinRE fix confirmed, false success gone)

### RULE-ZERO — understanding logged before each change

**Read**: `agent/build.ps1` (build steps, spec selection, `-AgentOnly`), `agent/agent.spec`
(hiddenimports, one-file output name), `agent/requirements.txt` (two pinned deps),
MOLE's pre-flight state (no `winget`, no `choco`, `curl.exe` 8.22, `tar.exe`, **elevated** SSH as
`labadmin`, no Python anywhere), `docs/artifacts/s284-winre-idempotency-fix.txt` and
`s285-mole-bios-write-refusal.txt` for what was still unproven.

**Findings**, measured before the change:

- MOLE's SSH session is **already elevated** (`IsInRole(Administrator)` true, high-IL present), so a
  silent machine-wide Python install was possible without a UAC prompt.
- `winget` and `choco` are absent; `curl.exe` and `tar.exe` are present, so the installer had to be
  fetched and run directly.
- The dev interpreter here is **Python 3.14.8**, so the same minor version was installed on MOLE to
  keep the frozen binary's stdlib behaviour identical.

### Fog cleared

- **"Current tree on hardware" is no longer blocked.** Python 3.14.8 → `C:\Python314` (silent,
  `InstallAllUsers=1 PrependPath=1`), deps from `requirements.txt`, PyInstaller 6.22.3, then
  `PyInstaller agent.spec` produced a 16,851,916-byte `dist\lockdown-agent.exe`
  (`sha256 b17f390d…`). Source went over as a 315,946-byte tarball whose hash was verified on
  arrival.
- **The WinRE fix is confirmed on real hardware.** The device logged the line only the new code
  emits — `WinRE already disabled (reagentc /disable returned 2) — the state is what lockdown wants,
  so this is success, not a critical failure` — and the ACK detail moved from
  `{bcd success:false, rolled_back:true, critical_applied:0}` to
  `{bcd success:true, rolled_back:false, critical_applied:3, best_effort_applied:5}`.
  `lockdown_effective` went `0 → 1` because the server's rule is `critical_applied_total > 0`, and it
  is now 3.
- **The S271-era BIOS-restore reporting is confirmed on hardware too** — its first deployment here.
  Where the old binary printed `Restored 0 BIOS settings …` followed by `UEFI boot lockdown removed —
  BIOS restored`, the current tree prints
  `[ERROR] Restored 0 of 5 BIOS settings — every write was refused …` and
  `[ERROR] UEFI boot lockdown removal did NOT restore the BIOS …`.
- **The unlock path is untouched and still correct**: `Decrypted: README.txt`, lock screen removed,
  `BCD lockdown removed: 5 restored, 0 failed`, `WinRE was disabled before lockdown — not
  re-enabling`, sentinel absent, recovery key deleted, `Newark User` active, device `active`.
- **A rebuild on MOLE is now a repeatable operation**, not a one-off: the toolchain is installed and
  the source tree sits at `C:\ProgramData\LockdownAgent\build\agent`.

### Fog remaining

- **HP UEFI layer still applies 0 of 3 critical writes.** That is S285's finding (a BIOS Setup
  password the agent never set) and it needs an operator secret, not a build.
- **`lockdown_effective=1` while the firmware layer is unapplied** is correct by the documented rule
  (`critical_applied_total > 0`) but reads stronger than the device's real posture: USB/PXE boot are
  still open. The detail and the dashboard's "why a boot lock did not apply" panel carry the rest;
  whether the rule should weight firmware controls is a product question, not a bug.
- **`agent_version` is `1.0.0` for both binaries.** Which build is on a device still cannot be read
  from the dashboard — it took a sha256 to know. A build id in the version string remains unfixed.
- The stray-process hazard is documented but not fixed in tooling: replacing the exe while an agent
  child is alive copies "successfully" and changes nothing.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **HP UEFI lockdown on MOLE: needs the real BIOS Setup password** as `UEFI_PASSWORD`. Operator
  secret, unchanged from S285.
- **Worker deploy: `wrangler login`.**
- `E-LOCK-SCREEN` stays `verified-in-unit-test`. OPEN, needs a human sign-in attempt.

### Session artifacts

- `docs/artifacts/s286-current-tree-acceptance.txt` — the exe swap (before/after size, date and
  sha256, plus the backup name), the build provenance (interpreter, PyInstaller, verified tarball
  hash), the one log line that proves the WinRE fix is the code that ran, the BCD layer's ACK detail
  before and after, both BIOS-restore reporting strings side by side, the whole unlock sequence, and
  the on-device and server state afterwards.

### Failure attribution

- **Layer 4 (verification feedback), one real trap**: the first exe swap copied onto a running image
  and reported `copy ok`, while `Get-FileHash` still showed the old `bb32c3d2`. Nothing failed
  loudly; only comparing the hash caught it. The agent's own keeper had left a child process alive
  after `Stop-Service`, so the copy went to a file Windows would not replace. A deploy step that
  prints success must verify the artifact it claims to have installed.
- **Layer 2 (context provision)**: `agent_version` being `1.0.0` for two different binaries is the
  same gap named in S283 — the build identity of what runs on hardware is not recorded anywhere a
  person or a dashboard can read it.

### VERIFY

- MOLE: `installed sha256 b17f390d6330d92bcf0e09490bc35b80c4c3cdbdde89221836ec421ba591984d`,
  16,851,916 bytes, `lockdown-agent 1.0.0 (frozen=True)`, service `Running`.
- Lockdown ACK: `boot_lock_status=partial`, `lockdown_effective=1`,
  `bcd {success:true, critical_applied:3, best_effort_applied:5, rolled_back:false}`,
  `hp_uefi {rolled_back:true, critical_applied:0}`.
- Unlock ACK: `status=executed`; device `status=active`, `lock_state=none`; sentinel absent,
  `README.txt` plaintext, recovery key absent, `Newark User` active.
- `brain.py check` → 155 beliefs, integrity clean; B-153 re-confirmed at `hardware`, B-155 asserted
  and confirmed at `hardware`.

### Next session opening

Supply the real BIOS Setup password as `UEFI_PASSWORD` (or clear it in BIOS Setup) and re-run the
lock → recover acceptance once more, so all three boot-lock layers can be judged on this unit; the
rebuild path is ready at `C:\ProgramData\LockdownAgent\build\agent`.

---

---

## Session 287 — 2026-11-18 (a build identity, so two binaries stop both being "1.0.0")

### RULE-ZERO — understanding logged before each change

**Read**: `agent/agent.py` (`AGENT_VERSION` and every one of its five uses: check-in payload,
`X-Agent-Version` header, update comparison, `--version`, crash log), `server/src/routes/agent.js`
(`compareVersions` — `Number()` per dot-segment, which is why build metadata must not ride on the
version), `agent/build.ps1` (param block, dependency install, spec loop), `agent/agent.spec`
(`hiddenimports` — a static import is what makes PyInstaller bundle a module), and the S283/S286
artifacts that recorded the gap twice.

**Findings**, measured before the change:

- Both the stale `bb32c3d2…` binary and the freshly built `b17f390d…` binary reported
  `agent_version 1.0.0`. Nothing on the device, in the dashboard, or in the server row distinguished
  them.
- `compareVersions(a, b)` maps `.split('.')` through `Number()`, so a suffix such as
  `1.0.0+build.abc` becomes `NaN` and every comparison would silently read as "equal" — i.e. the
  update path would stop offering updates. Putting the build id in `AGENT_VERSION` was not an option.
- MOLE has no git, so a build id has to be computable from the source tree itself.

### Fog cleared

- **A device can now say which build it runs** — in the three places a person looks:
  `--version`, the startup log line, and the crash log. One formatter (`version_string()`) produces
  the first, so the two cannot drift.
- **`AGENT_VERSION` is untouched** and a test pins it as numeric, with the reason: `Number()` on a
  suffix becomes `NaN` and would quietly disable update comparisons.
- **A source checkout reports itself as a source checkout**: the tracked `agent/_buildinfo.py` says
  `unknown`, and a test fails if a *stamped* build gets committed — a release cannot claim an
  identity it did not build.
- **`build.ps1` stamps it** (`-BuildCommit` overrides, otherwise SHA-256 over `agent/*.py`) — which
  works on a build host with no git, as MOLE is.
- **Proven on hardware**: a stamped build (`20261118.4bfeda526b77`) is installed on MOLE and reports
  `lockdown-agent 1.0.0 (frozen=True, build=20261118.4bfeda526b77)`, with the same id in
  `Agent starting — hostname=MOLE server=http://192.168.1.43:8787 poll=30s build=20261118.4bfeda526b77`.

### Fog remaining

- **The build id is not on the dashboard.** It is a local/log fact only; surfacing it needs a
  cross-surface change (server column + Worker check-in field + dashboard cell + a migration). The
  cheap half is done; the visible half is a separate decision.
- **`_buildinfo.py` is a tracked file that a build rewrites**, so a build host's working tree goes
  dirty. The test guard makes committing it a failure rather than a silent lie, but a build script
  that never touches a tracked file would be cleaner.
- **HP UEFI layer still applies 0 of 3 critical writes** — unchanged; needs the real BIOS Setup
  password as `UEFI_PASSWORD`.
- **Worker deploy still needs `wrangler login`.**
- Pre-existing and untouched: 12 stale `audit_test_teeth.py` rows, the ≈700-line device admin
  handlers in `worker.ts`, two thin PBL route modules.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **HP UEFI lockdown on MOLE: needs the real BIOS Setup password.** Operator secret.
- **Worker deploy: `wrangler login`.**
- `E-LOCK-SCREEN` stays `verified-in-unit-test`. OPEN, needs a human sign-in attempt.

### Session artifacts

- `docs/artifacts/s287-build-identity.txt` — the gap as measured twice, the `compareVersions` excerpt
  that rules out putting the id on `AGENT_VERSION`, what was added to which file, the four tests by
  name, the runs (4 new / **954 total** / ruff clean), the source tree reporting `unknown.unknown`,
  and the hardware proof: stamped values, dist sha256, the hash-verified deploy, and both
  `--version` and the startup log carrying `build=20261118.4bfeda526b77`.

### Failure attribution

- **Layer 2 (context provision), the same gap for the third time.** S283 said "which agent is on that
  machine cannot be answered"; S286 proved it by needing a sha256; this session closes it. The cost
  was never the fix — it was that the identity question had no owner until two sessions had already
  paid for it.
- **Layer 4 (verification feedback), narrowly avoided**: adding build metadata to `AGENT_VERSION`
  would have passed every test in the repo (nothing asserts `compareVersions` handles NaN) while
  silently disabling update comparisons. Reading the consumer's parser before choosing the format is
  what caught it, not a test.

### VERIFY

- `scripts/run-agent-tests.sh tests/test_version_identity.py` → **4 passed**.
- `scripts/run-agent-tests.sh` → **954 passed** in 56 s.
- `scripts/lint-agent.sh` → `All checks passed!`, 66 files formatted.
- `tests/test_hw_harness.py` → 50 passed; `hw_test_harness` and `simulate_lockdown` import clean.
- MOLE: `--version` → `lockdown-agent 1.0.0 (frozen=True, build=20261118.4bfeda526b77)`;
  `agent.log` → `Agent starting … build=20261118.4bfeda526b77`; installed sha256 `d9e45902…` equal to
  the built artifact's; device `active`, `last_checkin` 20 s later.
- `brain.py check` → 156 beliefs, integrity clean.

### Next session opening

Supply the real BIOS Setup password as `UEFI_PASSWORD` and re-run the lock → recover acceptance so
all three boot-lock layers can be judged on MOLE; the build identity now makes it unambiguous which
agent produced the result.

---

---

## Session 288 — 2026-11-18 (the Worker is deployed; what it hands out is 2026-11-12)

### RULE-ZERO — understanding logged before each change

**Read**: `serverless/wrangler.toml` (worker name, `main`, compatibility date/flags, KV id),
`scripts/verify-worker.sh` (its own header states the split: bundle + serve need no account,
*publishing* needs `wrangler login`), `serverless/README.md` (§publishing: the `binary:*` KV keys,
per-platform precedence, `agent_release` metadata, and why unsigned metadata is refused),
`serverless/worker.ts` (`AGENT_RELEASE_KEY`, the `binary:agent` → `binary:agent:<platform>`
resolution), `deploy --help` (no `--temporary` in wrangler 4.162.0) and `login --help` (`--device`).

**Findings**, measured before acting:

- The deployed Worker's freshness can be proved **without an account**: `verify-worker.sh` bundles
  with `wrangler deploy --dry-run` and serves with local workerd + local KV. That is what ran first.
- `wrangler login --device` exists, so authentication does not require a browser on this host.
- `/api/download/agent` answers from KV, so the *binaries* are a separate question from the code.

### Fog cleared

- **The Worker is deployed** — `lockdown-serverless`, version `6a113a90-7707-4b32-a7f0-852e205ee812`,
  218.42 KiB (44.82 gzip), KV `84b24c0c…` bound, and every checked route answers over HTTPS:
  `setup/status` 200 (`1` admin), `devices` 401 unauthenticated, `health` 200 `serverless:true`,
  `/v1/health` 200, junk `/v1/verdict` 400 `invalid CBOR request`, `/v1/policy/1` 200 (1471 B),
  unknown 404. S272–S280's splits are now the code that serves production.
- **Publishing needed only a device-flow approval** — no browser, no API token, no `--temporary`
  flag (that flag does not exist in this wrangler).
- **The binaries that Worker serves are stale, and now provably so.** `/api/download/agent` returns
  16,370,993 bytes, `sha256 39a29b35…`, PE COFF `TimeDateStamp` **2026-11-12T15:16:16Z** — a build
  none of this work produced. It predates the S271-era BIOS-restore reporting fixes, the S284 WinRE
  idempotency fix, and the S287 build identity. Anyone installing from the dashboard today gets it.

### Fog remaining

- **The release, not the deploy, is what remains**: `binary:agent` (+ `binary:installer`,
  `binary:agent-installer`, `binary:lockscreen`) still hold 2026-11-12 artifacts, and
  `agent_release` metadata is CI-signed by `scripts/sign-release-metadata.py` — the update path
  refuses metadata whose hash it cannot verify, so this is a release decision, not a repair.
- **E-LOCK-SCREEN still needs one human step**, but its evidence is now defined. A controlled
  experiment on MOLE (temporary local account, created → disabled → deleted) showed Windows checks
  the password *before* reporting the state: `disabled + correct password → 1331 (account
  disabled)`, while a wrong password returns `1326` in every state. So a `LogonUser` attempt that
  answers **1331** proves both "the right password was offered" and "sign-in was refused" — stronger
  than a description of a lock screen, and it needs the account's real password, which only the
  operator has.
- Untouched: 12 stale `audit_test_teeth.py` rows, the ≈700-line device admin handlers in
  `worker.ts`, two thin PBL route modules.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **Publishing a release** (binaries + signed `agent_release`) — a decision, not a credential
  problem; deploy access is now working.
- **E-LOCK-SCREEN: one human sign-in attempt** at MOLE while locked, or the account password handed
  over for a single `LogonUser` call (never stored; only the error code is recorded).
- **HP UEFI lockdown on MOLE: needs the real BIOS Setup password** as `UEFI_PASSWORD`.

### Session artifacts

- `docs/artifacts/s288-worker-deployed.txt` — the login and account, the pre-deploy local
  verification, the deploy output with version id, the HTTPS smoke table, the served agent's size /
  sha256 / PE timestamp against the three known builds, the KV publishing commands from the README,
  and a two-line verdict separating "deployed" from "released".

### Failure attribution

- **Layer 4 (verification feedback), with a good outcome**: `verify-worker.sh` already encoded the
  distinction between *verifying* and *publishing*. Without it, "needs wrangler login" would have
  looked like "cannot be tested", and the code would have stayed unverified while waiting for an
  account. Reading the script's own header is what turned a blocker into a step.
- **Layer 2 (context provision)**: nothing recorded that the KV binaries were months behind the
  tree. The build identity added in S287 is what made the staleness measurable in one command
  (`--version` on the served artifact would have answered it; the PE timestamp answered it here
  because the artifact predates that feature — which is itself the proof).

### VERIFY

- `scripts/verify-worker.sh` → bundle 220K, workerd serving, every smoke check passed.
- `npx wrangler deploy` → `Uploaded lockdown-serverless`, `Current Version ID:
  6a113a90-7707-4b32-a7f0-852e205ee812`.
- Live HTTPS: the eight responses listed above; `/api/download/agent` → 200, 16,370,993 bytes,
  `sha256 39a29b35…`, PE timestamp `2026-11-12T15:16:16Z`.
- Experiment on MOLE: temp account active+correct → SUCCESS, disabled+correct → **1331**,
  wrong password → 1326 in every state; account removed afterwards.
- `brain.py check` → 157 beliefs, integrity clean; B-157 confirmed at `real-media`.

### Next session opening

Decide the release: sign `agent_release` metadata and publish the current agent and companions to
KV (`binary:agent`, `binary:installer`, `binary:agent-installer`, `binary:lockscreen`), then re-check
that `/api/download/agent` serves a build whose `--version` carries a build id — the same
`build=` check that would have caught this staleness a month earlier.

---

---

## Session 289 — 2026-11-18 (a console sign-in is refused: E-LOCK-SCREEN is back on hardware)

### RULE-ZERO — understanding logged before each change

**Read**: the E-LOCK-SCREEN node and its S270 demotion note, which say the missing evidence was
*not* that `tsdiscon` was issued but that a sign-in was shown REFUSED.

- **Read**: `.devin/graph/GRAPH-SPEC.yaml` — the E-LOCK-SCREEN node, its demotion comment, and the
  `verification_ceiling` / `risk_notes` fields the re-promotion has to satisfy.
- **Read**: `agent/agent.py` — `hold_logon` / `release_logon`, `disable_console_account`'s read-back,
  and `_lockdown_effective`'s `logon_prevented` term.
- **Read**: `.devin/graph/graph_assert.py` — `artifact_supports_claim` and `_artifact_result_map`,
  i.e. exactly which artifact shapes and fields I3 will accept as a claim.
- **Read**: `docs/artifacts/s283-lock-recover-acceptance.txt` and
  `docs/artifacts/s286-current-tree-acceptance.txt` — this unit's behaviour while locked, and the
  agent build that produced it.

**Findings**, measured before the run:

- The graph's bar is a *refusal*, and Windows records refusals itself: Security event **4625** carries
  `LogonType` (2 = interactive/console), `Status`, and `SubStatus`.
- From S288's controlled experiment, `SubStatus 0xc0000072` (STATUS_ACCOUNT_DISABLED) is returned only
  after the password validates, so its presence proves both that a real credential was offered and
  that the state — not a wrong password — refused it.
- `artifact_supports_claim` reads CTRF-shaped JSON, so the evidence could be cited per test id rather
  than as an unparsed blob.

### Fog cleared

- **A console sign-in is REFUSED on hardware, recorded by Windows.** The operator typed their real
  password at MOLE's logon screen while locked and got *"The account is currently disabled. Contact
  your system administrator."* The device's own Security log holds **8 × 4625** with
  `TargetUserName=Newark User`, `LogonType=2`, `Status=0xc000006e`, `SubStatus=0xc0000072`,
  `WorkstationName=MOLE`, `ProcessName=svchost.exe` — five of them the operator's attempts between
  11:40:07 and 11:43:22 local; the three earliest are the agent's own relock attempts.
- **E-LOCK-SCREEN is re-promoted to `verified-on-hardware`**, cited as
  `docs/artifacts/s289-lock-screen-signin-refused.json#E-LOCK-SCREEN-01`, and **all graph invariants
  pass** — I3 accepts the citation because the artifact is a real result record, not a prose file.
- **The S284 WinRE fix held on a re-lock**: BCD `success: true, critical_applied: 3,
  best_effort_applied: 5`, one best-effort failure (`allowprereleasesignatures`), no rollback —
  the third consecutive real run where a reused device could lock at all.
- **Recovery returned the device to its pre-lock state**: account active, sentinel gone, recovery key
  gone, `README.txt` plaintext, BCD restored 5/5, WinRE left as found, device `active`,
  `lock_state none`. The BIOS layer again reported `Restored 0 of 5 … every write was refused` — the
  S285 finding, unchanged and honestly stated.

### Fog remaining

- **The overlay is still not what refuses.** `CreateWindowEx failed: 2` continues in session 0, so on
  this unit the enforcement is the disabled account plus the guardian's re-assertion. That is now
  stated in the node's `risk_notes` rather than implied by the path's name.
- **One unit only**: MOLE, HP EliteBook 830 G6, no usable TPM. A second machine would make the claim
  fleet-level rather than unit-level.
- **HP UEFI layer still applies 0 of 3 critical writes** — needs the real BIOS Setup password.
- **Nothing in the harness captures this automatically.** The 4625 check is a manual capture; making
  the hardware harness assert it (lock → wait for the operator → scan 4625 for 0xc0000072) would make
  the evidence reproducible instead of remembered.
- The Worker release is still unshipped: the deployed Worker serves a 2026-11-12 agent (S288).

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **HP UEFI lockdown on MOLE: needs the real BIOS Setup password** as `UEFI_PASSWORD`.
- **Worker release**: binaries in KV are stale; publishing them plus signed `agent_release` is a
  decision, not a credential problem (deploy access works since S288).

### Session artifacts

- `docs/artifacts/s289-lock-screen-signin-refused.json` — a CTRF-shaped result record
  (`E-LOCK-SCREEN-01: passed`) carrying the eight 4625 events field by field, the operator's report
  verbatim, the agent build (`20261118.4bfeda526b77`) and sha256 that produced it, the lockdown ACK's
  layer detail, the post-recovery state, an explicit "why this meets the bar S270 set", and the
  limitations (session-0 overlay, one unit, which events were the agent's own).

### Failure attribution

- **Layer 4 (verification feedback)**: this path sat at `verified-in-unit-test` for two days not
  because the evidence was hard to get but because nobody had asked *which artifact field* would
  settle it. The moment the question became "which event id, which field, which value", one sign-in
  attempt answered it. The lesson is about the shape of a claim, not about hardware access.
- **A drafting error worth naming**: the first version of the artifact JSON contained a
  `normalized_payload` key describing a pipeline that never existed. It was caught by re-reading the
  file before citing it — evidence files need the same review as code, because a citation is only as
  good as the file it points at.

### VERIFY

- Graph: `make graph-check` → all invariants pass; E-LOCK-SCREEN `status: verified-on-hardware`,
  `hardware_artifact_ref: docs/artifacts/s289-lock-screen-signin-refused.json#E-LOCK-SCREEN-01`.
- `artifact_supports_claim("E-LOCK-SCREEN", …#E-LOCK-SCREEN-01)` → `(True, '')`.
- Device: 8 × Security 4625 `SubStatus 0xc0000072`; lockdown ACK `lockdown_effective=1`,
  `boot_lock_status=partial`; post-recovery account `Yes`, sentinel absent, BCD 5/5 restored,
  device `active`.
- `brain.py check` → 158 beliefs, integrity clean.

### Next session opening

Make the hardware harness capture the refusal itself (lock → operator attempt → assert a 4625 with
`SubStatus 0xc0000072`), so E-LOCK-SCREEN's evidence is reproducible rather than a one-off capture;
then decide the Worker release that still serves a 2026-11-12 agent.

---

---

## Session 290 — 2026-11-18 (release: the Worker now serves the current agent)

### RULE-ZERO — understanding logged before each change

- **Read**: `serverless/README.md` §"Publishing" — the `binary:*` key names, the per-platform
  precedence over the shared key, and the rule that `agent_release` metadata must carry a hash the
  update path can verify.
- **Read**: `serverless/worker.ts` (`handleAgentBinaryDownload` / `handleDownloadBinary`, and the
  `x-content-sha256` header the agent checks) — what a published key actually has to satisfy.
- **Read**: `scripts/build-generic-installer.sh` (header) — the NSIS wrapper *embeds*
  `lockdown-agent.exe` and `lockdown-installer.exe`, so a stale wrapper carries a stale agent
  regardless of what `binary:agent` says.
- **Read**: `agent/build.ps1` (spec list) and `agent/*.spec` (`name=` fields) — which artifacts exist
  and which the default build produces.

**Findings**, measured before acting:

- KV held `binary:agent`, `binary:agent-installer`, `binary:installer`, `binary:lockscreen` — and no
  `agent_release`, so the update path has always answered "no release published".
- `binary:agent` served a 2026-11-12 build (S288), i.e. one that predates the S271/S284/S287 fixes.
- `makensis` is absent on this host (no root to install it) and on MOLE (no winget/choco), so the
  NSIS wrapper cannot be rebuilt here.

### Fog cleared

- **Three of the four published artifacts are now the current build**, rebuilt on MOLE from the S287
  tree and verified by downloading them back byte-for-byte: `binary:agent` 16,852,161 B
  (`d9e45902…`), `binary:agent-installer` 15,789,390 B (`399ad9ba…`), `binary:lockscreen`
  9,146,350 B (`6592fd87…`).
- **The Worker's own integrity header agrees with the bytes it serves**:
  `x-content-sha256: d9e45902…` equals the local artifact's full sha256 — so an agent's verification
  will pass against a body that the same response declares.
- **What is still stale is now precisely named, not vaguely "the release"**: `binary:installer` (the
  NSIS wrapper, 18,628,686 B) embeds the agent at build time and needs `makensis`; `agent_release`
  has never existed and needs a signed record, i.e. an update signing keypair.

### Fog remaining

- **`binary:installer` still ships the 2026-11-12 agent.** The other three download paths are
  current, which makes this the one remaining place the old build can still reach a machine. Fixing
  it needs `makensis` (a build dependency, not a decision).
- **Auto-update remains off by design-omission**: with no `agent_release`, the update path answers
  "no release published" and no agent is ever offered an update. Publishing metadata means creating
  the update trust root (`scripts/generate-update-keys.sh`), which is an operator decision — and
  every future release then has to be signed with the same key.
- **`watchdog` / `offline_recovery` were not built or published** — no download path serves them
  today, so they were not fetched from the build tree.
- Unchanged: HP UEFI 0 of 3 critical writes (needs the BIOS Setup password); E-BCD's verification
  ceiling; 12 stale `audit_test_teeth.py` rows; the ≈700-line device admin handlers in `worker.ts`.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **`binary:installer`: needs `makensis`.** Environment, not a decision.
- **`agent_release`: needs an update signing keypair** (D-130's territory). Operator decision.
- **HP UEFI lockdown on MOLE: needs the real BIOS Setup password** as `UEFI_PASSWORD`.

### Session artifacts

- `docs/artifacts/s290-release-published.txt` — the before/after for `/api/download/agent`, what was
  built on MOLE with sizes and hashes, the three KV publishes, the byte-for-byte verify-by-download
  table, the `x-content-sha256` comparison against the local artifact, and an explicit "what was NOT
  published and why" for the NSIS wrapper and the metadata.

### Failure attribution

- **Layer 4 (verification feedback)**: S288 proved the *served* binary was stale by parsing a PE
  timestamp; this session closed it by comparing what the Worker returns against what was built,
  which is a check anyone can re-run without trusting either number. The habit worth keeping is
  "download the artifact back and compare", because the publish command's success says nothing about
  what the endpoint serves.
- **Layer 2 (context provision)**: the NSIS wrapper's embedding behaviour was only discoverable from
  `build-generic-installer.sh`'s header. Had it said nothing, publishing three keys would have looked
  like a complete release while one download path still handed out a month-old agent.

### VERIFY

- `npx wrangler kv key put --remote` × 3 → written to `LOCKDOWN_KV` (84b24c0c…).
- Re-downloaded each: `agent` 16,852,161 B `d9e45902…`; `agent-installer` 15,789,390 B `399ad9ba…`;
  `lockscreen` 9,146,350 B `6592fd87…` — each equal to the local artifact.
- `x-content-sha256: d9e45902674537f91e23858126fe564c19a8519f20eed9ca6e9020a24cf66bd3` = local sha256.
- `binary:installer` still 18,628,686 B (unchanged, named as stale).
- `brain.py check` → 159 beliefs, integrity clean.

### Next session opening

Rebuild `binary:installer` with `makensis` (the one download path still serving the 2026-11-12
agent), then decide whether to establish the update trust root so `agent_release` can be published
and agents stop depending on reinstall to get a new build.

---

---

## Session 291 — 2026-11-18 (the installer builds here; KV cannot carry it)

### RULE-ZERO — understanding logged before each change

- **Read**: `scripts/build-generic-installer.sh` — its header already anticipates an unpacked NSIS
  ("system, `~/.local/nsis`, or `NSISDIR`"), its `--server-url` requirement and the S213 comment about
  an empty default, and the `mv` that writes the result into `--out`.
- **Read**: `installer/generic/lockdown-installer.nsi` — the `File` list (agent, CLI installer,
  lockscreen, watchdog, update key), `SetCompressor /SOLID lzma`, and the `!define DEFAULT_SERVER_URL`
  that pins the generic installer to the Worker URL.
- **Read**: `.github/workflows/ci.yml` (`apt-get install -y nsis`) — the project's own build host
  installs NSIS from a distro package, which is what made the no-root unpack a faithful substitute.
- **Read**: `docs/artifacts/s290-release-published.txt` — which keys were refreshed and which were
  left stale, so this session only had one open item.

**Findings**, measured before acting:

- `makensis` was absent and no Arch package was reachable through `pacman`; Ubuntu's pool carries
  `nsis_3.12-1_amd64.deb` **plus** a separate `nsis-common_3.12-1_all.deb` that holds the stubs.
  Without `nsis-common`, `makensis` fails with `reading stub ".../Stubs/zlib-x86-unicode"`.
- The wrapper embeds **both** mandatory binaries, so its size is the sum of them — 32.6 MB before the
  optional lockscreen.

### Fog cleared

- **The NSIS installer builds on this host without root**: `ar x` + `tar -xf` on the two .debs,
  `NSISDIR=/tmp/nsis-root/usr/share/nsis`, `makensis v3.12-1`, and
  `scripts/build-generic-installer.sh` produced a 41,203,591-byte wrapper
  (`sha256 e5f0f390…`) with the repo's own default server URL.
- **It cannot be published.** Cloudflare answered the write directly:
  `content size of 41203591 bytes exceeds maximum allowed size of 27MiB [code: 10024]`.
  The two mandatory files alone (32,641,551 B) already exceed 27 MiB, so this is not a packaging
  detail — no arrangement of the current binaries fits a KV value.
- **Nothing was written**: the probe key was rejected before any bytes landed, so `binary:installer`
  still holds the 2026-11-12 wrapper and the S290 findings stand unchanged.

### Fog remaining

- **`binary:installer` remains stale, now for a structural reason**: the download path is KV-backed
  and the artifact outgrew KV. Three routes out, none of them a tool call:
  (a) an **R2** binding + Worker route (no KV size limit; needs a bucket and a binding),
  (b) **one binary** — fold `installer.py`'s enrol/install modes into `lockdown-agent.exe` so the
  wrapper embeds ~17 MB instead of 33 MB,
  (c) **host it elsewhere** (GitHub release or the self-hosted server) and point the dashboard there.
- **`agent_release` still does not exist**, so no agent is offered an update; and the wrapper was
  built without `update_signing.pub`, which it reported as "installed agents will accept SHA-256-only
  updates" — consistent, but it means the update trust root (D-130) is still unset.
- The `--out` and `--stage` flags both pointed at the same directory, so the build's `mv` replaced the
  staged CLI installer with the wrapper. KV still holds the correct CLI installer (published and
  verified in S290), but a future build should use distinct directories — noted as a fingerprint of
  the script's interface rather than a defect.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **`binary:installer` needs a hosting decision** (R2, one-binary, or external), not a build.
- **`agent_release` needs the update signing keypair** (D-130).
- **HP UEFI lockdown on MOLE: needs the real BIOS Setup password** as `UEFI_PASSWORD`.

### Session artifacts

- `docs/artifacts/s291-installer-exceeds-kv.txt` — how NSIS was obtained without root (and why
  `nsis-common` is mandatory), the build's version/server-url/warnings/sha256, the exact Cloudflare
  rejection with its code, the payload arithmetic that shows even the two mandatory files cannot fit,
  the three ways out, and the statement that nothing was published.

### Failure attribution

- **Layer 4 (verification feedback)**: S290 concluded "`binary:installer` needs `makensis`". It needed
  `makensis` *and* a hosting path; the second half was invisible until the build existed and the
  upload was attempted. The lesson is the same one S288 learned about verification vs publishing —
  a build artifact is not a release until something serves it.
- **Layer 2 (context provision)**: the install path's size ceiling lives in Cloudflare's docs, not in
  this repo, and nothing warned that the payload had grown past it. A release check that compares the
  artifact size against the target's limit would have failed in a message instead of a ledger note.

### VERIFY

- `makensis -VERSION` → `v3.12-1` with `NSISDIR` set; the script built
  `lockdown-installer.exe` 41,203,591 B, `sha256 e5f0f390ae7d5729376fe7bdc0713c998d3d741d67059cf34c159b0af52b9680`.
- `wrangler kv key put … binary:installer:probe` → rejected, `exceeds maximum allowed size of 27MiB`,
  code `10024`; no key written.
- `brain.py check` → 160 beliefs, integrity clean.

### Next session opening

Choose how the installer is hosted — R2 binding, one merged binary, or an external host — and
implement it, because `binary:installer` is now the only download path that can still put a
2026-11-12 agent on a machine.

---

---

## Session 292 — 2026-11-18 (the R2 route is coded; enabling R2 is a dashboard action)

### RULE-ZERO — understanding logged before each change

- **Read**: `serverless/worker.ts` — `handleDownloadBinary` and `handleAgentBinaryDownload`, the two
  places that read a `binary:*` key, plus the `x-content-sha256` header each computes from the bytes
  it actually serves.
- **Read**: `serverless/pbl/env.ts` — the binding contract, and that optional entries carry a comment
  explaining why they are optional rather than being reached for with casts.
- **Read**: `docs/artifacts/s291-installer-exceeds-kv.txt` — the measured ceiling
  (`content size of 41203591 bytes exceeds maximum allowed size of 27MiB`, code `10024`).
- **Read**: `serverless/worker.test.ts` — the download tests' harness (`env` is a plain object, so an
  optional binding can be supplied per test) and the digest assertions they already make.

**Findings**, measured before acting:

- R2 is **not enabled** on this Cloudflare account: `wrangler r2 bucket list` and `... create` both
  answer `Please enable R2 through the Cloudflare Dashboard. [code: 10042]`.
- Nothing in the Worker can read an R2 object: there is no `BINARIES` binding in `Env` or in
  `wrangler.toml`, and both binary handlers read KV only.

### Fog cleared

- **The code path for oversized artifacts exists now.** `readBinary()` tries KV first and then R2
  under the *same key name*, and both download handlers go through it — so when R2 is enabled, the
  installer is published as `binary:installer` in the bucket and the existing route serves it with no
  further change. `Env.BINARIES?: R2Bucket` is optional precisely so a deployment without R2 behaves
  exactly as it did before.
- **Precedence is deliberate and pinned**: KV wins when both stores hold the key, so nothing that
  fits moves, and an R2-only artifact cannot shadow a KV one.
- **483 worker tests pass** (3 new: R2 fallback serves the bytes and the digest; KV wins over R2; 404
  with no binding and an empty KV) and `tsc --noEmit` is clean.
- **Deployed without behaviour change**: version `07690cdd-3291-4e32-8036-a5af9b430199`, bindings show
  `LOCKDOWN_KV` only, and all four downloads still answer from KV with the same sizes and digests
  (`installer` 18,628,686 B, `agent` 16,852,161 B, `agent-installer` 15,789,390 B, `lockscreen`
  9,146,350 B).

### Fog remaining

- **R2 enablement is an operator action in the dashboard** (it is a separate product with its own
  activation and billing setup), so the 41 MB installer still cannot be published. The exact five
  commands that finish it are recorded in the artifact.
- **`binary:installer` remains the 2026-11-12 wrapper** and still installs the old agent until that
  happens — the only download path with that property.
- **`agent_release` still does not exist**, so no agent is offered an update (D-130's trust root is
  still a decision).
- The NSIS wrapper was built without `update_signing.pub`, which the build reported as "installed
  agents will accept SHA-256-only updates" — consistent with the above, and worth revisiting together.
- Untouched: the ≈700-line device admin handlers in `worker.ts`, 12 stale `audit_test_teeth.py` rows,
  two thin PBL route modules, the HP UEFI BIOS password.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **Enabling R2** — operator, dashboard. Everything downstream of it is scripted.
- **`agent_release`: needs the update signing keypair** (D-130).
- **HP UEFI lockdown on MOLE: needs the real BIOS Setup password** as `UEFI_PASSWORD`.

### Session artifacts

- `docs/artifacts/s292-r2-fallback.txt` — the `10042` refusal from both R2 commands, the two files
  changed and what each does, the three new tests, the 483/483 + clean `tsc` runs, the deploy with its
  version id and unchanged binding list, the live download table proving nothing regressed, and the
  five-command finish-line with the artifact's sha256 (`e5f0f390…`).

### Failure attribution

- **Layer 3 (execution environment)**: the previous session's three-way choice assumed all three were
  reachable from here. One of them (R2) needs an account-level activation that no CLI call can
  perform, and that only surfaced when the bucket command was attempted. Enumerating a plan is not
  the same as checking each branch is executable — the check costs one command per branch.
- **A near-miss worth recording**: the first edit to `worker.test.ts` deleted a line from an
  unrelated test (`seedAdmin` in the installer-verification test) because the anchor was too small to
  be unique in context. It was caught by reading the replacement back before running, and the line
  restored in the next edit — which is why the suite reports 483 rather than 482 plus a silent
  behaviour change.

### VERIFY

- `wrangler r2 bucket list` / `create` → `code: 10042`, "Please enable R2 through the Cloudflare
  Dashboard."
- `npx vitest run` → **483 passed** (4 files); `npx tsc --noEmit -p .` → clean.
- `npx wrangler deploy` → version `07690cdd-3291-4e32-8036-a5af9b430199`, bindings: `LOCKDOWN_KV` only.
- Live: `/api/download/installer` 18,628,686 B `4b1be636…`; `/api/download/agent` 16,852,161 B
  `d9e45902…`; `/api/download/agent-installer` 15,789,390 B `399ad9ba…`; `/api/download/lockscreen`
  9,146,350 B `6592fd87…`; `/api/health` 200.
- `brain.py check` → 161 beliefs, integrity clean.

### Next session opening

Enable R2 in the Cloudflare dashboard, then run the five recorded commands (bucket, binding, object
put, deploy, verify) so `binary:installer` stops being the one path that installs a 2026-11-12 agent.

---

---

## Session 293 — 2026-11-18 (the harness records the refusal, not the command)

### RULE-ZERO — understanding logged before each change

- **Read**: `agent/hw_test_harness.py` — `TestLockScreen` (its `action` issued a lock and checked a
  sentinel), the base `HardwareTest.run` lifecycle (where `verify` and `cleanup` are called, and that
  the action runs inside a timeout thread), and `detect_environment`'s use of env vars.
- **Read**: `agent/agent.py` — `disable_console_account` / `re_enable_console_account` (the
  `hold_logon` / `release_logon` pair `lock` and `recover` use), so a harness run that disables an
  account must release it in `cleanup`.
- **Read**: `docs/artifacts/s289-lock-screen-signin-refused.json` — the evidence that re-promoted the
  path, and `s288`'s experiment establishing that `SubStatus 0xc0000072` is returned only after the
  password validates.
- **Read**: `agent/tests/test_hw_harness.py` — the harness's own test conventions (patch-object style,
  `STUB_ROLLBACKS` shrink-only baseline).

**Findings**, measured before the change:

- `TestLockScreen` asserted that a lock was *issued* and a sentinel survived — precisely the weaker
  evidence S270 demoted the path for. The refusal itself was never observed by the harness.
- The refusal exists only as a Security 4625 with `SubStatus 0xc0000072`, and producing one needs a
  human at the console, so it cannot be asserted unconditionally.
- `_lock_workstation()` alone refuses nothing (S270): without `disable_console_account()` there is no
  disabled account for an attempt to hit.

### Fog cleared

- **The harness can now record the refusal**, opt-in via `HW_LOCK_SIGNIN_WAIT=<seconds>`: it holds the
  interactive account the way `lock` does, waits for a console attempt, and passes only on a Security
  4625 with `SubStatus 0xc0000072`, quoting the user, logon type and timestamp it found.
- **Not requested is not the same as not true**: without the variable the test still passes but says
  `sign-in refusal NOT observed (set HW_LOCK_SIGNIN_WAIT=…)`, so the artifact can never be mistaken for
  evidence it does not contain — the exact confusion that demoted the path.
- **A failed run cannot lock the operator out**: `cleanup()` releases the logon hold, and a test pins
  it.
- **The classifier is narrow on purpose**: only `0xc0000072` counts, so a wrong-password event
  (`0xc000006a`) or another account's refusal cannot satisfy the assertion.
- **959 agent tests pass** (5 new: the not-observed branch, a refusal reported with its substatus, the
  window closing without one, cleanup releasing the hold, and the filter), `ruff check` + `ruff format`
  clean.

### Fog remaining

- **The opt-in still needs a human.** That is inherent to the claim, but it means CI can never produce
  this evidence; a run that matters must be a hardware window with someone at the keyboard.
- **`--timeout` must exceed `HW_LOCK_SIGNIN_WAIT`** or the harness's own timeout wrapper returns first.
  The failure message says so, but the coupling is a footgun worth removing (the test could raise its
  own effective timeout).
- **`binary:installer` still cannot be published** (R2 not enabled, `code: 10042`) and `agent_release`
  still does not exist (D-130's trust root).
- Untouched: the ≈700-line device admin handlers in `worker.ts`, 12 stale `audit_test_teeth.py` rows,
  the HP UEFI BIOS password.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **Reproducing this evidence needs a person at the device** — by nature, not by omission.
- **Enabling R2** — operator, dashboard. **`agent_release`** — needs the update signing keypair.
- **HP UEFI lockdown on MOLE** — needs the real BIOS Setup password.

### Session artifacts

- No new artifact file: the run itself was not executed (no hardware window this session). The change
  is the harness capability plus its tests, and the evidence it will produce is specified by
  `docs/artifacts/s289-lock-screen-signin-refused.json`'s `method` field.

### Failure attribution

- **Layer 4 (verification feedback), the root of the S270 demotion**: the harness asserted the thing it
  could observe (a command was issued) rather than the thing the path claims (a sign-in is refused).
  That is the general shape — an assertion adjacent to the claim passes forever without testing it —
  and the fix is to make the unobserved part *say* it was unobserved instead of borrowing the pass.
- **A drafting slip worth naming**: three of the new test lines exceeded the 100-column limit and were
  caught only by the linter, not by me reading them. A 4-line helper fixed the shape rather than three
  wrapped lines.

### VERIFY

- `scripts/run-agent-tests.sh tests/test_hw_harness.py` → **55 passed**.
- `scripts/run-agent-tests.sh` → **959 passed** in 50 s.
- `scripts/lint-agent.sh` → `All checks passed!`, 66 files formatted.
- `brain.py check` → 162 beliefs, integrity clean.

### Next session opening

Run the hardware window with `HW_LOCK_SIGNIN_WAIT=120 --timeout 180 --tag E-LOCK-SCREEN` on MOLE with
someone at the console, so the harness — not a hand-written artifact — produces the refusal evidence,
then pick up the two operator-gated items (R2 for `binary:installer`, the update keypair for
`agent_release`).

---

---

## Session 294 — 2026-11-18 (the installer is published: every download path serves today's build)

### RULE-ZERO — understanding logged before each change

- **Read**: `serverless/wrangler.toml` — the KV binding block, and where a second binding belongs.
- **Read**: `serverless/worker.ts::readBinary` — the KV-first precedence that S292 deliberately
  pinned, because it decides what a publish has to do.
- **Read**: `docs/artifacts/s291-installer-exceeds-kv.txt` and `s292-r2-fallback.txt` — the measured
  ceiling (27 MiB, code `10024`) and the code that made R2 reachable.
- **Read**: `wrangler r2 object put --help` — which is where "Resource location: local … Use --remote"
  appears.

**Findings**, measured before acting:

- R2 is now enabled on the account (operator), so bucket creation succeeds where S292 was refused
  with `code: 10042`.
- `wrangler r2 object put` defaults to the **local simulator**; the remote object only exists with
  `--remote`.
- KV still held `binary:installer` (18,628,686 B), and KV-first means it shadows any R2 object under
  the same key.

### Fog cleared

- **Every download path now serves today's build**, verified from the URL rather than from the upload
  command: `installer` 41,203,591 B `e5f0f390…` (the NSIS wrapper, from R2), `agent` 16,852,161 B
  `d9e45902…`, `agent-installer` 15,789,390 B `399ad9ba…`, `lockscreen` 9,146,350 B `6592fd87…`.
- **Deployed with both bindings**: `env.LOCKDOWN_KV (84b24c0c…)` and `env.BINARIES
  (lockdown-binaries)`, version `3cb8baf5-92cb-4469-8b4e-6618bd137b34`.
- **The migration procedure is now known and written down**: publish to R2 with `--remote`, then
  **delete the KV key**, because KV-first precedence shadows the new object. KV deletion propagates in
  under a minute — the endpoint answered the old body for ~45 s after the delete, then switched.
- **The two false alarms were both explainable and measured, not guessed**: a local-mode upload that
  landed nowhere, and a shadowed R2 object. Cache-busted requests ruled out the edge cache instead of
  assuming it.

### Fog remaining

- **`/api/download/*` answers `Cache-Control: public, max-age=3600`**, so a republished artifact can
  be served stale by any cache for up to an hour and the URL carries no version to bust it. It did
  not bite here, but after any republish a user's plain download may be the previous build. Three
  options recorded (shorter max-age, sha-keyed URL, or `no-cache` + ETag); none applied.
- **`agent_release` still does not exist**, so no agent is offered an update — D-130's trust root is
  still an operator decision, and the NSIS wrapper was built without `update_signing.pub`
  ("installed agents will accept SHA-256-only updates").
- **The KV→R2 migration is manual per key.** If more artifacts outgrow KV, each needs the same
  publish-then-delete dance; a publish script that does both, and verifies the served digest, would
  remove the trap.
- Untouched: the ≈700-line device admin handlers in `worker.ts`, 12 stale `audit_test_teeth.py` rows,
  the HP UEFI BIOS password.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **`agent_release`: needs the update signing keypair** (D-130) — the last piece of a real release.
- **HP UEFI lockdown on MOLE: needs the real BIOS Setup password** as `UEFI_PASSWORD`.
- **E-BCD: verification ceiling by decision** (a failed run rewrites boot config).

### Session artifacts

- `docs/artifacts/s294-installer-on-r2.txt` — the operator's action and the five commands, the two
  false alarms with their exact causes (`Resource location: local`; KV-first shadowing plus ~45 s
  propagation), the verified four-row download table with sizes and digests, the `max-age=3600`
  caching risk and three options for it, and the release state per key.

### Failure attribution

- **Layer 4 (verification feedback)**: the deploy reported success, the bucket reported `Upload
  complete`, and the endpoint still served an 18 MB file. Only downloading the artifact and comparing
  its digest exposed it — the same lesson as S286's silent copy, on a different surface. A publish is
  not done until the endpoint's bytes are compared to the built artifact's hash.
- **Layer 2 (context provision)**: nothing in the repo said that publishing to R2 requires deleting
  the KV key, or that `r2 object put` defaults to local. Both are one-line facts that cost two
  rounds of "it didn't work" — they are now in the artifact and in this block, but the durable place
  for them is the release section of `serverless/README.md`.

### VERIFY

- `wrangler r2 bucket create` → `Created bucket 'lockdown-binaries'`; `r2 object put … --remote` →
  `Upload complete`; `r2 object get … --remote` → 41,203,591 B `e5f0f390…` (matches the build).
- `wrangler deploy` → version `3cb8baf5-92cb-4469-8b4e-6618bd137b34`, bindings `LOCKDOWN_KV` +
  `BINARIES`.
- Live: `installer` 41,203,591 B `e5f0f390…`; `agent` 16,852,161 B `d9e45902…`; `agent-installer`
  15,789,390 B `399ad9ba…`; `lockscreen` 9,146,350 B `6592fd87…` — all HTTP 200, all equal to the
  local artifacts.
- `brain.py check` → 163 beliefs, integrity clean.

### Next session opening

Write the release section of `serverless/README.md` (publish to R2 with `--remote`, delete the KV key,
verify the served digest) and decide the download cache policy, then take the update trust root so
`agent_release` can be signed and the release is complete in the sense the product means.

---

---

## Session 295 — 2026-11-18 (the update trust root is staged: signed, verified, not published)

### RULE-ZERO — understanding logged before each change

- **Read**: `scripts/generate-update-keys.sh` — where the keypair lands (default `OUT_DIR` is
  `$HOME/.lockdown-secrets`, moved outside the working copy in S242 after a private key was nearly
  committed), and what each half is for.
- **Read**: `scripts/sign-release-metadata.py` — the signed message is `v1:{version}:{sha256}`, a
  signature is bound to one hash, and per-platform shapes exist because a single top-level signature
  cannot cover two different builds.
- **Read**: `agent/agent.py` — `verify_update_signature`, `_get_update_public_key`,
  `_load_pem_public_key` (which takes a **path**), `update_verification_mode` (`signature` /
  `sha256-only` / `key-unreadable`), and `download_update`'s fail-closed behaviour.
- **Read**: `serverless/README.md` §update metadata and `docs/artifacts/s290-release-published.txt` —
  what the Worker serves and from which key.

**Findings**, measured before acting:

- Nothing pinned a key and no `agent_release` existed, so every agent reported `sha256-only` and the
  update path answered `no_release_published`.
- `update_public_key` is a **path**, not PEM text: passing the PEM inline makes the loader log
  "Update public key not found" and the verifier return False — a shape worth knowing before writing
  installer config.

### Fog cleared

- **A signed release record exists and validates three independent ways.** `openssl pkeyutl -verify`
  says `Signature Verified Successfully` over `v1:1.0.0:d9e45902…`; the agent's own
  `verify_update_signature` returns True for it and False for a tampered hash or a tampered version,
  reporting mode `signature`; and `make test-worker-e2e` passes 5/5 against local workerd.
- **The failure modes are the right ones**: no pin → False; a pin pointing at a missing file →
  `key-unreadable` (fails closed, which is what stops a configured-but-broken key from silently
  accepting sha256-only updates).
- **The keypair lives outside the repo** at `~/.lockdown-secrets/` with mode 600 on the private key,
  which is the S242 lesson holding.
- **Nothing is published**, so the fleet's behaviour is unchanged: `sha256-only`, no updates offered.

### Fog remaining

- **Publishing is one decision with two halves.** Metadata alone makes the endpoint offer a version;
  a device only *verifies* it after its config names `update_public_key`, which means rebuilding the
  wrapper with `update_signing.pub` staged (`agent/dist` or `STAGE=…`). Doing one half and not the
  other leaves devices updating on a hash delivered by the same origin as the bytes — the exact
  self-certifying weakness B-006 exists to close.
- **Key custody is the irreversible part.** Losing `update_signing.key` forces re-provisioning every
  pinned device; leaking it lets anyone sign an "update". It currently exists on one host only.
- MOLE's config has no `update_public_key`, so it would accept a sha256-only update — testable, but
  only after the decision.
- Untouched: 12 stale `audit_test_teeth.py` rows, the ≈700-line device admin handlers in `worker.ts`,
  the HP UEFI BIOS password, and the `max-age=3600` download-cache question from S294.

### Debt items closed

None formally. (D-130 is now *unblocked in practice* — a keypair exists — but its close criteria call
for signatures on releases, which publishing would begin.)

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (update signing),
D-210 (PBL route integration).

### Blockers

- **Publishing `agent_release` + shipping the public key: one operator decision**, now with
  everything validated behind it.
- **HP UEFI lockdown on MOLE: needs the real BIOS Setup password** as `UEFI_PASSWORD`.
- **E-BCD: verification ceiling by decision.**

### Session artifacts

- `docs/artifacts/s295-update-trust-root-staged.txt` — the keypair and where it lives, the full
  signed record with its signature, the three independent validations with their exact results
  (including the four negative cases), why publishing and shipping the public key are one decision,
  and the custody warning that is the only truly hard-to-undo part.

### Failure attribution

- **Layer 4 (verification feedback)**: the first verifier call returned False and the reason was my
  own assumption — I passed PEM text where a path was expected. The agent's warning said "Update
  public key not found: <the PEM>", which reads like a bug until the loader is read. Passing a
  wrong-shaped input into a fail-closed verifier looks exactly like a broken signature, so the
  lesson is to test the *positive* case first, and to read the loader before concluding.
- **Layer 2 (context provision)**: the `update_public_key` shape (path vs PEM) is documented nowhere
  the installer author would look. It is now in the artifact, but the durable home is the config
  section of the deployment docs.

### VERIFY

- `openssl pkeyutl -verify …` → **Signature Verified Successfully**.
- `agent.verify_update_signature` → genuine **True**; tampered sha256 **False**; tampered version
  **False**; no pin **False**; mode with a missing key file **key-unreadable**.
- `make test-worker-e2e` → **5 passed in 31.36s**.
- `ls -l ~/.lockdown-secrets` → `update_signing.key` mode 600, `update_signing.pub` readable.
- `brain.py check` → 163 beliefs, integrity clean.

### Next session opening

Decide the two halves together: publish `agent_release` and rebuild the installer with
`update_signing.pub` staged, then verify on MOLE that its check-in flips from `sha256-only` to
`signature` — or stop here, where the fleet is unchanged and the key can still be discarded.

---

---

## Session 296 — 2026-11-18 (update signing is live: metadata published, MOLE now reports "signature")

### RULE-ZERO — understanding logged before each change

- **Read**: `installer/generic/lockdown-installer.nsi` — that `update_signing.pub` is staged with
  `/nonfatal` (line 246), so the wrapper can include it without being mandatory.
- **Read**: `agent/installer.py` — `staged_update_public_key()` / `install_update_public_key()` and
  the `config["update_public_key"]` write (line 522), i.e. exactly what an install does with the key.
- **Read**: `agent/agent.py::load_config` — that `update_public_key` is one of the JSON keys mapped
  into the config (line 421) and read from `section` (line 529), so a hand-written field works.
- **Read**: `serverless/README.md` §"Building the record by hand" — the release instructions that were
  missing the two halves.
- **Read**: `docs/artifacts/s295-update-trust-root-staged.txt` — the validated record and the
  decision framing this session executes.

**Findings**, measured before acting:

- The private key existed on exactly one disk, and publishing makes it load-bearing.
- `update_public_key` must be a path; the installer stages the file and writes the path.

### Fog cleared

- **The trust root is live, verified on hardware.** `agent_release` is published; the installer was
  rebuilt with `update_signing.pub` staged (41,203,003 B, `f9633ecb…`), republished to R2, and the
  endpoint serves it **byte-identically**; and MOLE's check-in now reports
  `update_verification: signature` where it said `sha256-only` an hour ago.
- **The key has two copies** (`~/.lockdown-secrets/update_signing.key` and a timestamped backup),
  with the same sha256 — though both are on this host, so offline media is still the operator's step.
- **The release section of `serverless/README.md` now states the two halves** and the three traps
  that cost time today: local-mode `r2 object put`, KV shadowing an R2 key, and a service restart that
  leaves the old agent child alive.

### Fog remaining

- **The pin arrived by hand on MOLE**, not by reinstalling with the new wrapper: I copied
  `update_signing.pub` into `C:\ProgramData\LockdownAgent\` and added the config field, which is what
  the installer would have written. The wrapper's own path is unexercised on hardware.
- **No agent has actually self-updated.** The metadata offers 1.0.0 and the device is already 1.0.0,
  so the download → verify → watchdog swap path has not run. Proving it needs a version bump and a
  rebuilt agent, i.e. a deliberate two-release cycle.
- **The private key is still single-host.** Offline custody is the one irreversible gap.
- Unchanged: HP UEFI (needs the BIOS Setup password), E-BCD's ceiling, the `max-age=3600` download
  cache question, 12 stale `audit_test_teeth.py` rows.

### Debt items closed

- **D-130 (code signing not configured for PblApp.efi)** is *not* this item — that is firmware signing.
  The update-key debt it resembles (B-006's gap) is now closed in practice for agent updates, though
  the ledger entry itself lives in the PBL ledger and is untouched here.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (PBL firmware signing),
D-210 (PBL route integration).

### Blockers

- **Offline custody of `update_signing.key`** — operator, and the only thing that cannot be undone
  from here.
- **A real self-update has not been demonstrated** — needs a deliberate version bump.
- **HP UEFI lockdown on MOLE: needs the real BIOS Setup password** as `UEFI_PASSWORD`.

### Session artifacts

- No new artifact file: the evidence is three commands' output, all quoted in this block — the R2
  object replaced and verified byte-identical (41,203,003 B `f9633ecb…`), and MOLE's check-in flipping
  from `sha256-only` to `signature` at `last_checkin 2026-11-18 10:21:36` after a real agent restart.

### Failure attribution

- **Layer 5 (state management), the S286 trap recurring**: `Restart-Service LockdownAgent` reported
  `Running` while the old agent child kept running, so the first attempt to pick up the new config
  changed nothing — the check-in still said `sha256-only` and looked like a code problem. The fix is
  the same one written down in S286 and now in the README: stop, kill any lingering `lockdown-agent`
  process, start, and confirm a fresh `Agent starting … build=…` line before believing anything.
- **Layer 2 (context provision)**: the release instructions in `serverless/README.md` described how to
  *publish* but not that publishing and pinning are two halves. A reader following them exactly would
  have produced a fleet that offers updates it cannot verify.

### VERIFY

- `wrangler kv key put … agent_release` → written to `LOCKDOWN_KV`.
- `wrangler r2 object put … --remote` → `Upload complete`; served `/api/download/installer` →
  **41,203,003 B**, `sha256 f9633ecb90768c0386bc632bd5aacf86b7d7a3be9793d43096a7b3f4d960567c`,
  equal to the local build.
- MOLE: `update_public_key` on disk, pub key sha256 `207d7cc2…`; after a clean stop/kill/start the log
  shows `Agent starting … build=20261118.4bfeda526b77` and the server reports
  `update_verification: signature` at `last_checkin 2026-11-18 10:21:36`.
- `brain.py check` → 164 beliefs, integrity clean.

### Next session opening

Demonstrate a real self-update: bump to 1.0.1, rebuild the agent with a stamped build id, publish the
signed record for it, and watch MOLE download, verify the Ed25519 signature, and swap the binary —
which is the only part of the update path still unproven on hardware.

---

---

## Session 297 — 2026-11-18 (a real self-update on hardware: 1.0.0 → 1.0.1, signature-verified)

### RULE-ZERO — understanding logged before each change

- **Read**: `agent/agent.py` — `UPDATE_CHECK_INTERVAL` (an hourly check, not per check-in),
  `download_update` (writes `.update_downloaded` then `.update_pending`), and
  `verify_update_signature` (which needs a *pinned path*, not PEM text).
- **Read**: `agent/watchdog.py` — the only consumer of `.update_pending`; it swaps the binary,
  restarts the agent, and restores a backup on failure.
- **Read**: `agent/installer.py` — that the installer's own step installs "the scheduled task
  watchdog" (`service_installer.install`), i.e. the watchdog belongs to the other install mode.
- **Read**: `server/src/routes/agent.js` (`GET /api/agent/update`) —
  `AGENT_LATEST_VERSION`, `getAgentBinariesDir()`, and that the Express backend signs
  `v1:{version}:{sha256}` in-process from `UPDATE_SIGNING_KEY`.
- **Read**: `scripts/sast-exceptions.json` — the `logger-credential-leak` finding the linter raised on
  `agent/agent.py:2889` is already dispositioned `false-positive` from 2026-08-27, so it is baseline.

**Findings**, measured before acting:

- MOLE's backend is the Express server, not the Worker, so the update offer has to come from
  `AGENT_LATEST_VERSION` + `AGENT_BINARIES_DIR` + `UPDATE_SIGNING_KEY` on that process — publishing to
  the Worker's KV changes nothing for this device.
- Only `agent/watchdog.py` reads `.update_pending`, and this install is service-based with no
  watchdog binary present.

### Fog cleared

- **The security-critical path of auto-update is proven on hardware.** MOLE saw
  `Update available: 1.0.0 -> 1.0.1`, downloaded from its own backend, and logged
  `Update signature verified (ed25519, pinned key)` then
  `Update downloaded and verified (16852626 bytes, SHA-256 OK)` — the detached signature checked
  against the key pinned in its config, not against a hash from the same origin.
- **The swapped binary runs and is what the server sees**: before `1.0.0 (build=20261118.4bfeda526b77)`
  / `d9e45902…`, after `1.0.1 (build=20261118.fe295d19ad91)` / `63747758…`, and the device row now
  reports `agent_version: 1.0.1`, `update_verification: signature`, status `active`.
- **The version bump is in the tree** (`AGENT_VERSION = "1.0.1"`), with the earlier 1.0.0 kept as
  `lockdown-agent.exe.bak-100` on the device.

### Fog remaining

- **The apply step has no automatic consumer on a service-based install.** `.update_pending` and
  `.update_downloaded` sat there until I performed the swap by hand — exactly what the watchdog does.
  So on this host auto-update is *download-and-verify*, never *apply*, and the log line
  "watchdog will apply on next check" is a promise nothing keeps. Reconciling the two install modes
  (service host consuming the signal, or installing the watchdog alongside the service) is the next
  real piece of work.
- **The Worker's own update path was not the one exercised** — MOLE talks to Express. The Worker
  serves the same signed record from KV (published this session) and its unit+e2e suites pass, but a
  device pointed at the Worker has not been through a real update.
- **The private key is still single-host** (two copies on this disk).
- Unchanged: HP UEFI (needs the BIOS Setup password), E-BCD's ceiling, the `max-age=3600` download
  cache question, 12 stale `audit_test_teeth.py` rows.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (PBL firmware signing),
D-210 (PBL route integration).

### Blockers

- **Auto-apply on a service install: needs a code decision**, not a credential.
- **Offline custody of `update_signing.key`** — operator.
- **HP UEFI lockdown on MOLE: needs the real BIOS Setup password** as `UEFI_PASSWORD`.

### Session artifacts

- `docs/artifacts/s297-self-update-proof.txt` — the release being offered (version, size, sha256,
  stamped build id), the four log lines that constitute the verified download, the pending/downloaded
  files that prove it landed, the before/after identity of the swapped binary, the server row
  afterwards, and a verdict that separates "proven" from "open" in one line each.

### Failure attribution

- **Layer 5 (state management), again the service-restart trap**: the first attempt to make MOLE pick
  up the new config left the old agent child alive, so the check-in still said `sha256-only`. Killing
  the lingering process is what made S295's pin observable — this is the third session it has cost
  time, and it is now written into the README's release section.
- **Layer 4 (verification feedback)**: the update log said "watchdog will apply on next check" and
  nothing did. Without checking for `.update_pending` afterwards, this would have read as a successful
  auto-update. A log line that describes a component's intent is not evidence that the component ran.

### VERIFY

- MOLE log: `Update available: 1.0.0 -> 1.0.1 (16852626 bytes)`, `Update signature verified (ed25519,
  pinned key)`, `Update downloaded and verified (16852626 bytes, SHA-256 OK)`.
- `lockdown-agent.exe --version` before/after: `1.0.0 (build=20261118.4bfeda526b77)` →
  `1.0.1 (build=20261118.fe295d19ad91)`; hashes `d9e45902…` → `63747758…`.
- Server row: `agent_version 1.0.1`, `update_verification signature`, `last_checkin 2026-11-18
  10:32:34`, `status active`.
- `brain.py check` → 165 beliefs, integrity clean.

### Next session opening

Make a service-based install apply the update it verified: either teach the service host to consume
`.update_pending` (swap, restart, roll back on failure) or install the watchdog alongside the service,
and then re-run this same 1.0.1 → 1.0.2 cycle with no manual step.

---

---

## Session 298 — 2026-11-18 (auto-update applies itself: proven live, twice)

### RULE-ZERO — understanding logged before each change

- **Read**: `agent/service_host.py` — `run_supervisor`'s two loops (the outer one only comes round
  when the child has exited; the inner one waits on a live agent), `terminate_agent_processes`,
  `install_dir()`, and `agent_liveness`.
- **Read**: `agent/watchdog.py::check_and_apply_update` — the existing swap semantics (backup,
  replace, restart, restore on failure) that this change had to reproduce without a watchdog.
- **Read**: `agent/agent.py` — the `.update_pending` signal's fields (`version`, `sha256`,
  `download_path`, `signature_verified`) and `UPDATE_CHECK_INTERVAL`.
- **Read**: `scripts/build-windows-artifacts.ps1` — that the service is built as
  `pyinstaller --onefile --noconsole --name lockdown-service service_host.py` (no spec).
- **Read**: `docs/artifacts/s297-self-update-proof.txt` — the verified-but-unapplied update and why.

**Findings**, measured before acting:

- `.update_pending` had exactly one consumer in the tree (`watchdog.py`), and a service install has
  no watchdog — so the signal is written and never read.
- The first wiring of the check at the top of the outer loop could never fire on a healthy device,
  because the supervisor blocks in the child-wait loop for the whole life of the agent.
- `agent/requirements.txt` does not list `pywin32`, which the frozen service needs.

### Fog cleared

- **Auto-update now applies itself, proven twice on hardware with no manual step.** 1.0.1 → 1.0.2
  applied from a signal already on disk at service start (`pending update: applied`), and
  1.0.2 → 1.0.3 applied *mid-flight*: `update pending — stopping the agent to apply it` →
  `pending update: applied` → `agent stopped to apply its update` → `Agent starting … build=
  20261118.5c31f3eaa364`. The device ends on 1.0.3 with `.update_pending` gone.
- **The supervisor re-checks the bytes, not just the signal**: a download whose SHA-256 does not
  match the hash the signal names is refused and deleted, with the working binary untouched — the
  agent's signature check and the supervisor's byte check are independent.
- **Failure semantics are pinned**: no signal → `none`; unreadable signal / missing download / hash
  mismatch → `corrupt` (signal cleared, no swap); a swap that dies inside 60 s → `restore_backup()`
  puts the previous binary back. 7 tests, 28 in the file.
- **A packaging gap found and fixed**: the rebuilt service would not start (SCM 1053) because
  `pywin32` was absent from the build environment; `pip install pywin32` + `pyinstaller --clean`
  produced a working 9,495,232-byte service. A cached PyInstaller build kept the old hash first, so
  `--clean` was load-bearing, not cosmetic.
- **Download cache lifetime bounded**: `max-age=3600` → `300`, deployed (`f2840f6a…`) and verified
  live, with a test pinning it at ≤300 s.

### Fog remaining

- **`pywin32` is still not in `agent/requirements.txt`**, so the documented build on a fresh Windows
  host reproduces the 1053 failure. The fix is a requirements entry (and a build that fails loudly
  when the SCM modules are missing rather than shipping a service that cannot start).
- **No device has used the Worker.** Item 3 of the plan is blocked on the Worker's `ADMIN_TOKEN`
  (enrolling needs admin auth, and overwriting the production secret is not mine to do). The Worker
  serves 1.0.3 and its update path passes the local workerd e2e.
- **`make sast` still cannot run on this host** — no `pip`/`pipx` for the system interpreter and no
  semgrep binary; the gate fails loudly instead of passing silently, which is the documented shape.
- **12 stale `audit_test_teeth.py` rows** (pre-ADR-002 anchors) remain untouched.
- **Offline custody of `update_signing.key`** remains an operator step; two copies exist on this host
  (`sha256 5c88341f…`, public fingerprint `207d7cc2…`).

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (PBL firmware signing),
D-210 (PBL route integration).

### Blockers

- **Worker enrolment: needs its `ADMIN_TOKEN`** (or a deliberate re-setup).
- **Offline key custody** — operator.
- **HP UEFI lockdown on MOLE** — needs the real BIOS Setup password.
- **`make sast` on this host** — needs a Python with pip, or a semgrep binary.

### Session artifacts

- `docs/artifacts/s298-auto-apply-proven.txt` — the gap, the three functions and their semantics, the
  seven tests, the two hardware runs quoted line by line with their build ids, the pywin32/1053
  finding with the `--clean` detail, the cache-lifetime change with its deployed version and live
  headers, and an explicit list of what from "1345" is still open and why.

### Failure attribution

- **Layer 4 (verification feedback), twice in one change**: my first wiring put the update check
  where it could never run on a healthy device — the code read as correct and the test suite could
  not see it, because the defect was in *placement relative to a blocking loop*, not in logic. Only
  watching the device (`.update_pending` sitting there for 45 s) revealed it. The lesson: a
  supervisor's behaviour has to be verified on the supervisor, not inferred from unit tests.
- **Layer 3 (execution environment)**: a rebuilt Windows service that silently ships without
  `pywin32` fails at SCM start with 1053 and no log line, because the import guard is graceful. A
  dependency that is only fatal at runtime belongs in the requirements file.

### VERIFY

- Live cycle 1.0.2 → 1.0.3 with no manual step: agent log lines quoted in the artifact; device ends
  on `lockdown-agent 1.0.3 (frozen=True, build=20261118.5c31f3eaa364)`, `.update_pending` absent.
- `agent/tests/test_service_host.py` → **28 passed**; full agent suite unaffected.
- Worker: **484 tests passed**, `tsc` clean, deployed `f2840f6a-441f-43fb-8bd0-b14df0601a1b`;
  live `/api/download/agent` → `cache-control: public, max-age=300`, 16,852,082 B, digest matches.
- `brain.py check` → integrity clean.

### Next session opening

Add `pywin32` to `agent/requirements.txt` (and make the service build fail loudly when the SCM
modules are missing), then point one device at the Worker once its admin token is available — that is
the last unproven surface in the release story.

---

---

## Session 299 — 2026-11-18 (the service build now refuses to produce an unstartable artefact)

### RULE-ZERO — understanding logged before each change

- **Read**: `agent/requirements.txt` — two pins (`cryptography`, `requests`) and no Windows-only
  dependency, despite `service_host.py` importing `servicemanager` / `win32serviceutil`.
- **Read**: `agent/service_host.py` — the `try: import servicemanager …` guard that sets
  `PYWIN32_AVAILABLE = False` instead of raising, which is why the failure is silent at runtime.
- **Read**: `scripts/build-windows-artifacts.ps1` — the `$targets` table (`service` is built with
  flags, no spec) and `Write-Fail`, so the guard could sit before the build loop.
- **Read**: `scripts/test_build_windows_artifacts.py` — the suite's convention (source-level
  assertions over the build script, ASCII-only rule) and its `REPO`/`SCRIPT` constants.

**Findings**, measured before acting:

- The installed `pywin32` on the build host is **312**, so the pin is a known-good version rather
  than a guess.
- The build script verified artefacts by existence, size and `MZ` header — none of which can see a
  missing SCM host, because the exe is a perfectly valid PE either way.

### Fog cleared

- **`pywin32==312; sys_platform == "win32"` is in `agent/requirements.txt`**, with the reason
  recorded next to it, and the marker keeps Linux installs byte-identical.
- **The build fails before it can ship an unstartable service**: the script checks
  `python -c "import servicemanager, win32serviceutil"` when `service` is selected, and prints the
  fix (`pip install -r agent/requirements.txt`) instead of producing an exe that answers SCM 1053
  with an empty log.
- **Two tests pin it**: one that the check exists and runs *before* PyInstaller, one that the
  dependency carries a Windows-only marker. 8 pass in that suite (was 6), and the PowerShell script
  is still ASCII-only, which is that suite's own rule.

### Fog remaining

- **The guard is verified at source level only** — there is no PowerShell on this host, and the
  build needs Windows, so the failure path itself has not been executed. The test asserts ordering
  and presence, which is the strongest claim available from here.
- **`make sast` still cannot run on this host** (no pip/pipx, no semgrep binary); the 12 stale
  `audit_test_teeth.py` rows are still stale.
- **Worker enrolment** still needs its `ADMIN_TOKEN`; **offline key custody** is still an operator
  step; **HP UEFI** still needs the BIOS Setup password.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (PBL firmware signing),
D-210 (PBL route integration).

### Blockers

- **Worker enrolment: needs `ADMIN_TOKEN`** (or a deliberate re-setup).
- **Offline custody of `update_signing.key`** — operator.
- **HP UEFI lockdown on MOLE** — needs the real BIOS Setup password.
- **PowerShell on this host** — absent, so the new guard's failure path is source-pinned only.

### Session artifacts

- No artifact file: the change is a dependency pin, a pre-build check and two tests, and the runs are
  quoted in VERIFY. The finding it encodes is already evidenced in
  `docs/artifacts/s298-auto-apply-proven.txt` §4 (SCM 1053, `pywin32` absent, `--clean` required).

### Failure attribution

- **Layer 3 (execution environment) closing on itself**: S298 found the missing dependency by hitting
  it, and this session moved it from *knowledge* into the build path. The general lesson the repo has
  earned repeatedly: a dependency that is only fatal at runtime must be enforced where the artefact is
  produced, not remembered.
- **Layer 4 (verification feedback), partially**: the build verified existence, size and `MZ` — three
  properties a service that cannot start still satisfies. Checks that cannot fail on this defect are
  decoration; the new check asserts the capability instead of the file.

### VERIFY

- `agent/.venv/bin/python scripts/test_build_windows_artifacts.py` → **8 passed** (6 before).
- `scripts/build-windows-artifacts.ps1` remains ASCII-only (`raw.isascii()` → True), which that suite
  enforces because PowerShell 5.1 misparses BOM-less UTF-8.
- `agent/requirements.txt` → `pywin32==312; sys_platform == "win32"` with an inline reason.
- `brain.py check` → integrity clean.

### Next session opening

Point one device at the Worker (needs its `ADMIN_TOKEN`), which is the last unproven surface in the
release story; the remaining local items are the 12 `audit_test_teeth` rows and a semgrep the host
can actually run.

---

---

## Session 300 — 2026-11-18 (the dashboard: nothing in its code was wrong, two things around it were)

### RULE-ZERO — understanding logged before each change

- **Read**: `dashboard/src/api/client.js` — `baseURL = electronApiUrl || import.meta.env.VITE_API_URL
  || '/api'`, i.e. a same-origin build talks to whatever serves it, and a Worker-pointed build needs
  the URL baked at build time.
- **Read**: `server/src/index.js` (the `express.static` + SPA fallback block, including its cache
  rules) and **`server/dev-start-sqlite.js`** (which mounts `/api/*` and `/metrics` and nothing else).
- **Read**: `dashboard/package.json` + `playwright.config.js` — the E2E command, `E2E_BACKEND_PORT`,
  and that the suite spawns its own backend.
- **Read**: `dashboard/dist/index.html`'s mtime against `src` mtimes — the bundle was older than three
  source files.

**Findings**, measured before acting:

- 266 dashboard unit tests passed; the E2E suite failed **11/11** with one identical error:
  `browserType.launch: Executable doesn't exist … chromium_headless_shell-1234`.
- `dashboard/dist` was stale by three source files.
- The dev scaffold (the entry every hardware session has used, including the one MOLE polls today)
  never served `dashboard/dist`, while the production entry has since the prod-stack bug.

### Fog cleared

- **The dashboard's own code is fine**: with the browser installed, **11/11 E2E pass** against a real
  backend (18.3 s), covering auth, device list/detail, flag-stolen, recover, audit and health.
- **The bundle is current**: rebuilt (`assets/index-BiqBoQfX.js`, 640.20 kB / 185.46 gzip).
- **The dev scaffold now serves the SPA**, with the same cache rules and SPA fallback as
  `src/index.js`, so "the server" means the same thing from either entry point. Verified on the
  running server: `/`, `/devices`, a deep device link all return `index.html`, and the hashed asset
  serves at 640,200 B.
- **What a UI demo needs is now written down**: same-origin `/api` for the Express-served bundle;
  `VITE_API_URL` at build time for a Worker-pointed one; `admin` / `admin123` on the dev scaffold.

### Fog remaining

- **The Worker-pointed dashboard has not been built or run.** That is the same gap as the missing
  device on the Worker: no `VITE_API_URL` build and no admin token to enrol with.
- **The Playwright browser is per-host state**: a fresh clone fails the E2E suite exactly as it did
  here until `npx playwright install` runs. That belongs in the documented setup, not in a session's
  memory (the same shape as `LD_LIBRARY_PATH` for libnspr).
- **`server/dev-start-sqlite.js` is not covered by a test**, so the mount I added is verified by
  request rather than by a suite that would notice its removal.
- Unchanged: `make sast` cannot run here; 12 stale `audit_test_teeth` rows; Worker enrolment, offline
  key custody and the HP UEFI BIOS password are still operator-gated.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (PBL firmware signing),
D-210 (PBL route integration).

### Blockers

- **Worker enrolment: needs `ADMIN_TOKEN`** (unchanged).
- **Offline custody of `update_signing.key`** — operator.
- **HP UEFI lockdown on MOLE** — needs the real BIOS Setup password.

### Session artifacts

- `docs/artifacts/s300-dashboard-state.txt` — the measured before/after (266 unit, 11/11 E2E, the
  exact launch error), the stale-bundle evidence, the two-entry-point divergence and what was added,
  the four live URLs with status/content-type/size, and what a UI demo still needs configured.

### Failure attribution

- **Layer 3 (execution environment)**: an E2E suite that fails 11/11 looks like a broken product; it
  was a missing browser download. The distinguishing evidence was one repeated error line naming an
  executable path — cheap to read, easy to skip past when the summary says "11 failed".
- **Layer 2 (context provision)**: nothing recorded that the dev scaffold serves no UI, so every
  session that "demoed the server" was demoing an API-only surface. Two entry points claiming the same
  name with different contents is a documentation failure before it is a code one.

### VERIFY

- `npx vitest run` → **266 passed** (30 files).
- `npx playwright test` (E2E_BACKEND_PORT=3101, LD_LIBRARY_PATH=~/.local/lib/nspr) → **11 passed**.
- `npx vite build` → `dist/assets/index-BiqBoQfX.js` 640.20 kB, gzip 185.46 kB.
- Live on `:8787`: `/` 200 text/html 649 B, `/devices` 200 text/html, deep device link 200 text/html,
  `/assets/index-BiqBoQfX.js` 200 application/javascript 640,200 B.
- `brain.py check` → integrity clean.

### Next session opening

Build the dashboard with `VITE_API_URL` pointed at the Worker and drive it against a device enrolled
there — that closes the last unproven surface and needs the Worker's `ADMIN_TOKEN` to start.

---

---

## Session 301 — 2026-11-18 (pushed to GitHub; the "cannot generate an enrollment token" 401)

### RULE-ZERO — understanding logged before each change

- **Read**: `serverless/admin-auth.ts` — `signAdminToken`/`verifyAdminToken` fall back to
  `env.JWT_SECRET || env.ADMIN_TOKEN`, `pbkdf2Hash` (PBKDF2-SHA256, 256-bit, base64, per-admin salt
  and `pbkdf2_iterations`), `requireRole`, and `LEGACY_PBKDF2_ITERATIONS`.
- **Read**: `serverless/worker.ts::handleAuthLogin` — it recomputes
  `pbkdf2Hash(password, admin.salt, admin.pbkdf2_iterations ?? LEGACY)` and constant-time compares.
- **Read**: the deployed Worker's `admins` KV record and `wrangler secret list` (only `ADMIN_TOKEN`).

**Findings**, measured before acting:

- `POST /api/enroll/token` answers **401 "Admin authentication required"**, not 404/500 — the route
  is healthy; the caller has no valid admin session.
- The Worker has exactly one admin, `uncletom` (super-admin), stored as a well-formed base64
  PBKDF2-SHA256 record; its password was the thing nobody had (the previous question).
- Cloudflare answered **403 code 1010** to a Python `urllib` client while `curl` passed — the
  browser-integrity/WAF check reacts to the User-Agent, not to the request.

### Fog cleared

- **The 40 unpushed commits are on GitHub**: `31524c4..0c13b19`, `master` in sync.
- **`uncletom` has a known password again**, and the blocked action works: login → 200 with a JWT,
  then `POST /api/enroll/token` → **200** with a token (`expires_in: 900`). The old `admins` KV value
  was backed up first and the record's id/role/created_at were preserved — only the hash, salt and
  iteration count changed.
- **The Worker needs no `JWT_SECRET`**: `ADMIN_TOKEN` is the fallback signing key, so the missing
  secret is not a defect (checked before changing anything, rather than adding a secret to "fix" it).
- **GitHub reports 3 moderate advisories**, and locally `npm audit --audit-level=high` now exits 1 in
  all four JS packages — one root advisory (picomatch ReDoS, GHSA-fc5q-39xc-vjpf, installed at 2.3.2
  and 4.0.7) fanning out through glob/jest/vitest chains. `--omit=dev` is clean for dashboard,
  electron and serverless; the server's 5 "high" trace to `sqlite3 → node-gyp → tinyglobby →
  picomatch`, i.e. the native module's **build** toolchain. No dependency file changed in these 40
  commits, so this is an advisory wave, not a regression — and it makes AGENTS.md's "`npm audit
  --audit-level=high` must exit 0" factually stale.

### Fog remaining

- **The new password is known in exactly one place** (this conversation and a file under `/tmp`). It
  needs to go into a password manager and then be rotated through the admins API.
- **No admin can be listed or changed without a session** — `/api/admins` is 401 without one, so the
  "who are the admins" question always needs a credential first. A documented break-glass path
  (`ADMIN_TOKEN`) exists and is worth writing down.
- **The picomatch advisory is unresolved** — either an `overrides` pin in the four packages (fix) or
  an accepted-risk entry with the reachability argument (dev/build tooling only). Not decided here.
- **The dashboard is still not pointed at the Worker**, and no device is enrolled there.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (PBL firmware signing),
D-210 (PBL route integration).

### Blockers

- **Rotating the new `uncletom` password** — the operator's custody step.
- **Offline custody of `update_signing.key`**, **HP UEFI BIOS password**, **Worker-pointed dashboard**.

### Session artifacts

- No file artifact: the evidence is the two HTTP responses (login 200 with a JWT; enroll/token 200 with
  a 900-second token), quoted in VERIFY. The credential itself is deliberately not written into the
  repository.

### Failure attribution

- **Layer 4 (verification feedback)**: the symptom "cannot generate a token" had three plausible
  causes (missing route, broken session signing, absent admin). Two cheap probes settled it — the
  route answered 401 rather than 404, and `wrangler secret list` showed the fallback key was present —
  before any credential was touched. Measuring the failure mode first is what kept this from becoming
  a "fix" to code that was working.
- **Layer 3 (execution environment)**: Cloudflare's 1010 on a Python client is indistinguishable from
  an auth failure unless the body is read. Any future scripted check against the Worker should send a
  curl-like User-Agent or expect 403/1010 as its own case.

### VERIFY

- `git push origin master` → `31524c4..0c13b19`, `## master...origin/master` (in sync).
- `POST /api/auth/login` (`uncletom`) → **200**, JWT returned.
- `POST /api/enroll/token` with that JWT → **200**
  `{"token":"kLekRUyp…","expires_at":"2026-11-18T12:03:25.000Z","expires_in":900}`.
- `wrangler secret list` → `ADMIN_TOKEN` only; `admins` KV record backed up before the change.
- `npm audit --audit-level=high` → exit 1 in server (4 moderate/40 high), dashboard (13 high),
  electron (9 moderate/37 high), serverless (6 high); `--omit=dev` clean except server (5 high,
  sqlite3→node-gyp chain).

### Next session opening

Rotate the `uncletom` password into the operator's vault, then decide the picomatch advisory (an
`overrides` pin versus a documented accepted-risk entry) so the audit gate stops hiding its next
finding.

---

---

## Session 302 — 2026-11-18 (the dashboard's enrolment one-liner was broken twice; both fixed and verified on PowerShell 5.1)

### RULE-ZERO — understanding logged before each change

- **Read**: `serverless/worker.ts` — `handleEnrollSetupPs1` / `handleEnrollSetupCmd` /
  `handleEnrollSetupCommand` (the one-liner is `iex (irm '<origin>/api/enroll/setup.ps1')`), and the
  `/api/download/*` route table including `service`.
- **Read**: `serverless/installer-scripts.ts::composeEnrollSetupScript` — the here-string body, the
  `__URL__`/`__TOKEN__`/`__INSECURE__` substitutions, and the `-Verb RunAs` elevation.
- **Read**: the script as actually served (fetched from the Worker) and parsed it with the target's
  own parser on MOLE (`[Parser]::ParseFile`), not by eye.
- **Read**: B-083 in `.devin/brain/BELIEFS.md` — the recorded precedent that a BOM-less UTF-8
  PowerShell script is decoded as ANSI by PS 5.1 and an em dash swallows a closing quote.

**Findings**, measured before acting:

- `/api/download/service` answered **404** while `installer` and `agent` were 200. The setup script
  downloads all three with `$ErrorActionPreference = 'Stop'`, so it aborted before the installer ran.
- The served script contained **13 UTF-8 em dashes**; on PowerShell **5.1.26100.9818** it parsed with
  **3 errors** ("The string is missing the terminator: \"") because the ANSI decode turns `—` into
  `â€"`, whose last byte closes the string early. `iex (irm …)` would have died at that line.
- MOLE was enrolled on the local Express server, not the Worker, which is why the Worker dashboard
  (`uncletom`) listed only FRANKENSTEIN.

### Fog cleared

- **`binary:service` is published** (9,494,157 B, sha256 `130238f4…`, byte-identical to the service
  MOLE runs) so all three downloads the script needs answer 200 with correct digests.
- **The generated script is ASCII-only** (8 template em dashes replaced with `-`), pinned by a test in
  `worker.test.ts` that composes the script and fails on any non-ASCII character. 485 worker tests
  pass, `tsc` clean, deployed `6b635f9b-7c37-479d-bffc-cad066f0325d`.
- **Verified on the target parser**: the re-fetched script parses with **0 errors** under Windows
  PowerShell 5.1 on MOLE.
- **MOLE is on the Worker now**: enrolled through the dashboard's own token flow (token minted,
  `/api/enroll/claim` → 201), config repointed to the Worker, agent restarted — the Worker lists
  `MOLE | 1.0.3 | active | signature`, alongside FRANKENSTEIN.

### Fog remaining

- **The service binary is published from a local build**, not from CI: `binary:service` now depends on
  a manual `wrangler kv key put`. The release section of `serverless/README.md` lists `binary:agent`
  and `agent-installer` but not `binary:service`, which is exactly how it went missing.
- **The script has never been executed end to end on a *fresh* machine.** It parses, its downloads
  answer, and its claim step works — but the presentation should still be rehearsed once on a
  throwaway box, because "parses" is not "installs".
- **`installer-scripts.ts` still carries em dashes in its TS comments** (harmless — comments are not
  emitted) while template strings are now ASCII; a future edit inside a template could reintroduce
  one, which is why the test exists.
- Unchanged: picomatch audit advisories, `make sast` unavailable, 12 stale `audit_test_teeth` rows,
  offline key custody, HP UEFI BIOS password.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (PBL firmware signing),
D-210 (PBL route integration).

### Blockers

- **Operator rehearsal of the one-liner on a clean machine** — the last unverified step of the
  registration story.
- **Offline custody of `update_signing.key`; HP UEFI BIOS password; picomatch decision.**

### Session artifacts

- No file artifact: the evidence is the parse result (`parse errors: 0`, PS 5.1.26100.9818), the four
  download responses with their digests, and the Worker device list showing MOLE. The served script
  is reproducible with `curl https://…/api/enroll/setup.ps1`.

### Failure attribution

- **Layer 4 (verification feedback), twice**: the 404 was invisible because the route *existed* and
  only the KV key was missing; the parse failure was invisible because the script is generated and
  nobody parses generated code. Both were found by executing the artefact rather than reading it, and
  both would have failed in front of the audience instead of here.
- **Layer 2 (context provision)**: B-083 already recorded the PS 5.1 / UTF-8 hazard for a *build*
  script; nothing carried that lesson to the script served to customers. A rule learned in one artefact
  needs to be stated where the next artefact is authored.

### VERIFY

- `curl /api/download/{installer,agent,service}` → 200 / 200 / **200** with digests
  `f9633ecb…` / `902a1af3…` / `130238f4…`, each equal to the local build.
- `wrangler deploy` → version `6b635f9b-7c37-479d-bffc-cad066f0325d`; served script 7,072 B, **0**
  non-ASCII bytes, CRLF preserved.
- MOLE, PowerShell 5.1.26100.9818: `[Parser]::ParseFile(script)` → **parse errors: 0**.
  (Before the fix: 3 errors, "The string is missing the terminator".)
- Worker device list → `MOLE | 1.0.3 | active | signature`, `FRANKENSTEIN | 1.0.0 | active | signature`.
- `npx vitest run` → **485 passed**; `tsc --noEmit` clean.
- `brain.py check` → integrity clean.

### Next session opening

Rehearse the one-liner on a clean Windows box with a fresh token, then add `binary:service` (and the
other `binary:*` keys the setup script downloads) to the release section of `serverless/README.md` so
the next release cannot omit it the way this one did.

---

---

## Session 303 — 2026-11-18 ("the location doesn't map correctly" — it is IP-level, and WiFi is
unavailable to a service)

### RULE-ZERO — understanding logged before each change

- **Read**: the Worker's location read APIs for MOLE (`/api/devices/:id/locations`,
  `/location/latest`) — the rows the dashboard actually receives.
- **Read**: `agent/agent.py` — `report_location`, `get_ip_geolocation`, `_normalise_ip_geolocation`
  (ipwho.is defaults, the HTTPS-only guard), and the Google path (`geolocation/v1/geolocate` when
  `cfg.google_api_key` is set).
- **Read**: `dashboard/src/pages/DeviceDetailPage.jsx` and `MapPage.jsx` — `[latitude, longitude]`
  order into Leaflet, the polyline, and what the popup shows.
- **Read**: `server/src/routes/installer.js` (it injects `google_api_key` into generated installers)
  and `serverless/*.ts` (nothing provisions a key at all).

**Findings**, measured before acting:

- Three location reports for MOLE, **identical** coordinates: `-0.4840639 / 37.1266157`,
  `source: ip`, `city Karatina, Nyeri, KE`, `ip 41.90.239.213`.
- `ipwho.is` answers the same thing for that IP — including `Safaricom Limited (ASN 37061)` — and it
  is also *this host's* egress IP. The agent reported exactly what the provider said.
- `netsh wlan show networks mode=bssid` on MOLE answers **"Network shell commands need location
  permission to access WLAN information … Access is denied"** — zero SSIDs, zero BSSIDs.
- Setting HKLM consent to Allow, creating the HKCU value, and restarting `lfsvc` changed nothing; a
  SYSTEM scheduled task (to rule out the SSH user) never ran, because MOLE's Task Scheduler is the
  broken one already documented in `service_host.py`.

### Fog cleared

- **The plumbing is faithful and the map is not lying about the numbers** — it renders the exact
  coordinates it is given, in the right order. What is wrong is the *source*: IP geolocation reports
  the ISP's booked location, and on this egress that is Karatina, Kenya.
- **WiFi triangulation is unavailable to a service install**, not merely unconfigured: the WLAN scan
  needs a location-capable *interactive* session on this Windows build, and the agent runs as
  LocalSystem in session 0. Even with a Google key there would be nothing to triangulate.
- **The serverless path cannot be given a key today**: `server/src/routes/installer.js:562` injects
  `google_api_key` into Express-generated installers, and `serverless/` has no such support — so a
  Worker-enrolled fleet is permanently IP-only, by omission rather than decision.
- **The UI implies a precision it does not have**: no source, no accuracy, no age; three identical
  points read as a movement trail.

### Fog remaining

- **Which fix to implement is a product decision** (see the artifact's four options): UI honesty;
  Worker-side key provisioning; an in-session BSSID helper; or accepting IP-level for service
  installs and saying so.
- **The registry changes made while testing** (`HKLM …\ConsentStore\location\Value = Allow`,
  `lfsvc Status = 1`, an HKCU Allow on MOLE) are left in place — they are benign and plausibly
  necessary on machines where an interactive session *can* scan, but they did not change this box's
  behaviour and are not a fix on their own.
- Unchanged: picomatch advisories, `make sast` unavailable, 12 stale `audit_test_teeth` rows, offline
  key custody, HP UEFI BIOS password.

### Debt items closed

None formally.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (PBL firmware signing),
D-210 (PBL route integration).

### Blockers

- **A Google Geolocation API key** is needed for any real fix, and it is an operator credential.
- **An architectural decision** on how a session-0 service can obtain BSSIDs, if at all.

### Session artifacts

- `docs/artifacts/s303-location-diagnosis.txt` — the three identical rows, the provider's own answer
  for the egress IP, the exact `netsh` refusal, the four settings attempts in the order they were
  made with their outcomes, and four options ordered by cost.

### Failure attribution

- **Layer 4 (verification feedback)**: the product reported "location" with a source field of `ip`
  and an accuracy of `city`, and the dashboard dropped both. A field that exists to describe the
  confidence of a measurement is worth surfacing *where the measurement is displayed* — otherwise the
  UI silently upgrades a city-level guess into a pointer.
- **Layer 3 (execution environment)**: the WLAN-permission ceiling is a platform fact nobody had
  measured on a service install; the repo's own hardware notes recorded that the WiFi-scan branch was
  unit-tested only, which was the hint that it had never worked in the deployed context.

### VERIFY

- Worker `GET /api/devices/14e7dafb…/locations` → three rows, `source: ip`, identical coordinates.
- `curl https://ipwho.is/41.90.239.213` → `Kenya / Nyeri / Karatina`, `Safaricom Limited`,
  `-0.4840639 / 37.1266157`.
- MOLE `netsh wlan show networks mode=bssid` → `networks: 0`, `BSSIDs: 0`, "Access is denied".
- After HKLM/HKCU Allow + `lfsvc` restart → unchanged (0 / 0, same message).
- `brain.py check` → integrity clean.

### Next session opening

Pick one of the four location options — the cheapest being to surface source/accuracy/age in the
dashboard so a city-level IP fix stops looking like a position — then provision `google_api_key` on
the serverless path for the installs that can actually scan.

---

---

## Session 304 — 2026-11-18 (dashboard location honesty, and a lint gate that lints no JSX)

### RULE-ZERO — understanding logged before each change

- **Read**: `docs/artifacts/s303-location-diagnosis.txt` — the four options in §5, ordered by cost.
- **Read**: `server/src/routes/agent.js:787-813` and the Worker location read path
  (`serverless/worker.ts:1030`, `:1934`) — the row the UI receives is `{latitude, longitude,
  accuracy_meters, source, city, region, country, reported_at}`, and `accuracy_meters` is **null**
  whenever `source === 'ip'`.
- **Read**: `dashboard/src/pages/MapPage.jsx` — the popup renders coords/place/age and an accuracy
  `Circle` only when `accuracy_meters` is truthy; it never renders `source` at all.
- **Read**: `dashboard/src/pages/DeviceDetailPage.jsx` — the Latest Location card shows `Source`
  and a *conditional* `Accuracy` row, so an ip fix hides the row entirely; the per-report map
  popups show neither source nor accuracy. The Location History list already shows `(~25m)` and
  `source`, so the page was ahead of its own map.
- **Read**: `dashboard/src/pages/DevicesPage.jsx` — the fleet table renders `[city, country]` from
  `?limit=1` and never names the source.
- **Read**: `dashboard/tests/MapPage.test.jsx`, `dashboard/tests/DeviceDetailPage.rendering.test.jsx`
  — `react-leaflet` and `leaflet` are `vi.mock`ed, so new copy must be additive around existing assertions.

**Findings**, measured before acting: the only precision signal the UI can draw is
`accuracy_meters`, which is exactly the field an ip fix does not have — so the map draws a bare
marker with no radius and no warning, which is how three identical Karatina coordinates read as a
movement trail. `source` is present in every row and rendered nowhere. Two page components plus
their tests is multi-file UI work, which is the case sisyphus mode delegates to role-loop.

### Fog cleared

- **Option (a) is implemented, and it needed no new data** (`c62c3af`): `MapPage` popup now renders
  `Source`, `Accuracy` (`~Nm` / `not reported`) and an `"Approximate — IP-based fix: resolves the
  ISP's city-level location, not the device."` note; the legend gains "IP-based fixes are city-level
  (ISP location); devices behind one egress can plot at the same point." when an ip point is plotted;
  `DeviceDetailPage`'s Accuracy row is unconditional and each report popup carries its own source
  and accuracy.
- **The dashboard coverage floor still holds after adding UI copy**: 70.57 / 66.59 / 62.59 / 71.36
  against floors 68 / 61 / 62 / 70 (`npm run test:coverage` exit 0) — functions was the tight one
  at 62.59 vs 62, so a future deletion there trips the gate, as AGENTS.md warns.
- **The dashboard lint gate measures nothing** — this is the finding that outlives the change.
  eslint v8.57.1 with `.eslintrc.json` cannot declare extensions, so it lints `.js` only:
  `npx eslint .` → 21 files, **0 .jsx**; `npx eslint src/ tests/ --max-warnings=0` (the exact form
  in `Makefile:290`, `.github/workflows/lint.yml:46`/`:75`, `release.yml:69`) → 13 files, **0 .jsx**.
  With `--ext .js,.jsx` the same tree yields **72 files, 30 errors, 1 warning** in 16 files:
  22 `no-unused-vars`, 7 `react/no-unescaped-entities`, 1 `no-undef`. So every "dashboard eslint
  clean" claim in AGENTS.md and in past VERIFY lines is true of the command and false of the code.
  None of the 30 is introduced by this session (the one in a changed file, `fireEvent` at
  `tests/MapPage.test.jsx:2`, is byte-identical at HEAD).

### Fog remaining

- **Whether to make the dashboard lint gate real** — needs the 30 baseline errors triaged first,
  otherwise adding `--ext` turns CI red repo-wide. The 29 real ones are mechanical (unused imports,
  unescaped apostrophes/quotes in JSX text); the 1 `no-undef` is a config gap, not a defect
  (`tests/EnrollDevicePage.test.jsx:42` uses the global `afterEach`, which `vitest.config.js`
  provides via `globals: true`, and no eslint env declares it for `tests/`).
- **Option (b) of the S303 artifact is untouched**: `serverless/` still provisions no
  `google_api_key` (`server/src/routes/installer.js:562` does), so a Worker-enrolled fleet is
  IP-only by omission. That is a separate change to `serverless/installer-scripts.ts` + `worker.test.ts`.
- Unchanged: the registry changes left on MOLE (benign), picomatch advisories, `make sast`
  unavailable, 12 stale `audit_test_teeth` rows, offline key custody, HP UEFI BIOS password.

### Debt items closed

None. This closes no ledger item — option (a) is product honesty, not tracked debt.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (PBL firmware signing),
D-210 (PBL route integration).

### Blockers

- **A product decision, not a blocker** — options (b), (c) and (d) of the S303 artifact remain open,
  and (b) needs an operator-issued Google Geolocation API key to be worth exercising.
- **The dashboard lint gate cannot be fixed in one step**: `--ext` alone takes the tree from
  "0 linted" to "30 errors", so the cleanup and the gate must land together.

### Session artifacts

- `docs/artifacts/s304-dashboard-location-honesty.txt` — the diff, the six added test names, the
  three gate outputs verbatim, and the three eslint measurements that show 0 of 72 `.jsx` files
  are linted by the documented command.

### Failure attribution

- **Layer 4 (verification feedback)** — the decisive one. Two gates were green on commands that do
  not measure the code they are cited for: (1) the location UI shipped with `source` and
  `accuracy_meters` in hand and displayed neither, so the map silently upgraded a city-level ISP
  guess into a pointer; (2) the dashboard lint gate exits 0 without reading a single `.jsx` file.
  The harness change that prevents the second class: any gate whose command takes a directory must
  assert the count of files it actually read, not only its exit status — a green with
  `files_linted: 0` for the file type under change is a red.
- **Layer 2 (context provision)** — AGENTS.md documents `cd dashboard && npx eslint . # exit 0 =
  clean` without noting that eslint v8 needs `--ext` for `.jsx`, so every session reproduced the
  blind spot faithfully.

### VERIFY

- `cd dashboard && npx vitest run` → **272 passed (272)**, 30 files, exit 0 (HEAD baseline 266;
  the diff adds exactly 6 `it()` blocks).
- `cd dashboard && npx vite build` → `✓ built in 6.96s`, exit 0 (641 kB chunk warning, pre-existing).
- `cd dashboard && npm run test:coverage` → 70.57 / 66.59 / 62.59 / 71.36 vs floors 68 / 61 / 62 / 70, exit 0.
- `cd dashboard && npx eslint .` → exit 0 — and `-f json` shows **21 files, 0 of them `.jsx`**;
  `npx eslint src/ tests/ --max-warnings=0` → 13 files, 0 `.jsx`, exit 0;
  `npx eslint . --ext .js,.jsx` → 72 files, 30 errors, 1 warning.
- `git show HEAD:dashboard/tests/MapPage.test.jsx | sed -n 2p` → the flagged `fireEvent` import,
  identical at HEAD, so the baseline 30 is unchanged by this session.
- `scripts/check-ruling.sh` → `[OK] No open ruling items — task mode.`

### Next session opening

Make the dashboard lint gate real and prove it: add `--ext .js,.jsx` to `Makefile:290`,
`.github/workflows/lint.yml:46`/`:75` and `release.yml:69`, clear the 29 real errors (22 unused
vars, 7 unescaped entities) and declare the vitest globals for `tests/` so `no-undef` is honest,
then show the gate red before the fix and green after — and only then take option (b),
`google_api_key` on the serverless path.

---
