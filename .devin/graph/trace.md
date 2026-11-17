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
