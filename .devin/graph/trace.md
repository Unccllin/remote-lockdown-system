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
  `{"token":"<redacted — S311>","expires_at":"2026-11-18T12:03:25.000Z","expires_in":900}`.
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

---

## Session 305 — 2026-11-19 (the dashboard lint gate lints the dashboard, and the 30 errors it found are gone)

### RULE-ZERO — understanding logged before each change

- **Read**: `.github/workflows/lint.yml:46`/`:75` and `release.yml:69` — two of those lines are the
  *server* job (`src/ tests/`, all `.js`) and two are the dashboard job; only the dashboard ones
  needed `--ext`.
- **Read**: `Makefile:258`/`:290` — the same split, server vs dashboard.
- **Read**: measured the server: 102 eslint-visible files, all `.js`, **0 `.cjs`, 0 `.jsx`**, 0 errors
  with or without `--ext`, so its gate already reads everything it owns and must not be touched.
- **Read**: `dashboard/.eslintrc.json` — eslintrc format (`root`, `env`, `extends`, `ignorePatterns`),
  no `overrides`, no vitest env; and `vitest.config.js` — `globals: true`, which is why `afterEach`
  resolved at runtime but not to eslint.
- **Read**: `dashboard/src/pages/PblPolicyPage.jsx:65-110` — a mount-once `useEffect(() => loadData(),
  [])` over a function declared below it; the warning is `react-hooks/exhaustive-deps`.
- **Read**: `dashboard/tests/EnrollPage.test.jsx:25-32` — `mockClick` and `originalCreateElement`
  defined and never referenced.
- **Read**: the 30 findings live with `npx eslint . --ext .js,.jsx -f json` (72 files, 51 `.jsx`):
  22 `no-unused-vars`, 7 `react/no-unescaped-entities`, 1 `no-undef`, 1 warning.

**Findings**: the blind spot is structural, not a mistake in one command — eslint v8 resolves file
extensions from `--ext` only (eslintrc cannot declare them), so every directory-taking invocation in
this repo linted `.js` only. The gate and the cleanup therefore have to land in one change: adding
`--ext` alone takes the tree from "0 files, green" to "72 files, 30 red".

### Fog cleared

- **The dashboard gate is real and green on real files**: `npx eslint src/ tests/ --ext .js,.jsx
  --max-warnings=0` → **72 files, 51 of them `.jsx`, 0 errors, 0 warnings, exit 0** (`Makefile:290`,
  `lint.yml:75`, `release.yml:69`, and the AGENTS.md command all carry the fix; the three server
  lines are untouched).
- **All 30 findings are resolved per finding, none silenced**: 22 unused vars removed (dead `React`
  default imports under the automatic JSX runtime, dead named specifiers, two dead test consts),
  7 raw apostrophes/quotes became `&apos;`/`&quot;` in JSX text — character-identical on render,
  which is why the existing assertions pass unchanged — and the single `no-undef` was fixed in
  config, because `afterEach` is a real vitest global (`overrides` for `tests/**/*.{js,jsx}`, nine
  readonly globals, no plugin, no repo-wide globals).
- **The one warning got the real fix, not a disable**: `loadPolicyVersions` and `loadData` became
  `useCallback` hoisted above the effect, the effect depends on the stable `loadData`, so the fetch
  still happens once on mount. `grep -c eslint-disable` over the diff = 0.
- **A dated claim in AGENTS.md was repaired**: three paragraphs dated 2026-11-13/17 stated the
  dashboard test count; the figure now says re-measured 2026-11-19 (S305). The 260 that had been
  there was itself stale — 266 was the real HEAD baseline before S304's six cases.
- **Belief B-172 was refuted with a replacement (B-173)** rather than left standing as a true
  statement about a state that no longer exists.

### Fog remaining

- **Option (b) of the S303 artifact is still untouched**: `serverless/` provisions no
  `google_api_key` (`server/src/routes/installer.js:562` does), so a Worker-enrolled fleet stays
  IP-only by omission. It needs an operator-issued key to be worth exercising.
- **`make full-verify` has not been re-run end to end since the lint gate changed.** The dashboard
  gates were measured individually (eslint/vitest/coverage/build) and `lint-dashboard`,
  `lint-server`, `lint-workflows` all exit 0, but the whole-tree sweep's own numbers (843/866/272/
  429/30, E2E 14, verify-env) are from earlier sessions.
- Unchanged: the registry changes left on MOLE (benign), picomatch advisories, `make sast`
  unavailable, 12 stale `audit_test_teeth` rows, offline key custody, HP UEFI BIOS password.

### Debt items closed

None. This closes no ledger item — it makes a documented gate honest.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (PBL firmware signing),
D-210 (PBL route integration).

### Blockers

- **Not blocked.** The remaining location work (option b) needs an operator Google Geolocation key,
  and the remaining ledger items need hardware time or a signing decision.

### Session artifacts

- `docs/artifacts/s305-dashboard-lint-gate.txt` — before/after file counts and error counts from the
  same binary, the four gate surfaces, the 30-finding resolution table, the ten gate outputs measured
  by the parent session, and the workflow's own mistake (dropped Makefile TAB) with how it was caught.

### Failure attribution

- **Layer 4 (verification feedback), twice, and the second time the harness held.** The worker's first
  pass dropped the recipe TAB on `Makefile:290`, breaking `make` for *every* target, and its report
  said "make lint-workflows not re-run here but YAML valid" — it substituted a check for a different
  failure mode than the one the change could cause. The oracle blocked on the actual command, a fix
  round restored the TAB, and re-review approved. Harness change this argues for: an acceptance check
  must name the command *and* the failure it would catch; "not run, but X is valid" is a skipped
  check, not a passed one.
- **Layer 2 (context provision)** — the root cause was never a wrong command, it was documentation
  that presented a green exit code as proof. The AGENTS.md line now carries the reason (`--ext`), so
  the next session cannot reproduce the blind spot by copying it faithfully.

### VERIFY

- `cd dashboard && npx eslint src/ tests/ --ext .js,.jsx --max-warnings=0` → exit 0
- `cd dashboard && npx eslint . --ext .js,.jsx -f json` → **72 files, 51 `.jsx`, 0 errors, 0 warnings**
- `cd dashboard && npm run test` → **272 passed (272)**, 30 files, exit 0
- `cd dashboard && npx vite build` → `✓ built in 5.06s`, exit 0
- `cd dashboard && npm run test:coverage` → 70.62 / 66.59 / 62.59 / 71.40 vs floors 68 / 61 / 62 / 70
- `make lint-dashboard` exit 0 · `make lint-server` exit 0 · `make lint-workflows` exit 0
  (actionlint 1.7.12 + shellcheck present) · both edited workflows parse as YAML
- `sed -n 290p Makefile | cat -A` → `^I@cd dashboard && npx eslint src/ tests/ --ext .js,.jsx --max-warnings=0$`
- `git diff | grep -c eslint-disable` → 0 · `git diff --name-only | grep -c package` → 0
- `python3 scripts/brain.py check` → 173 beliefs, integrity clean

### Next session opening

Take option (b) of the S303 artifact now that the gate is honest: provision `google_api_key` through
`serverless/installer-scripts.ts` so a Worker-enrolled fleet can triangulate where BSSIDs are
obtainable, pin it with `serverless/worker.test.ts`, and be explicit in the README that a session-0
service install still cannot scan and stays IP-level.

---

---

## Session 306 — 2026-11-19 (the geolocation key reaches a token install — on both surfaces, not just the Worker)

### RULE-ZERO — understanding logged before each change

- **Read**: `serverless/installer-scripts.ts` in full — the served `setup.ps1` is a token-free
  PowerShell template that carries **no config**: it checks reachability, downloads
  `lockdown-setup.exe`, and passes `--server-url/--token/--silent`. A key placed here would live in
  a cacheable text artifact the Worker serves (B-070 forbids exactly that).
- **Read**: `server/src/routes/installer.js:515-575` — `buildDeviceConfig` is the *only* path that
  puts `google_api_key` into an agent config today, and it omits the property when
  `process.env.GOOGLE_API_KEY` is unset.
- **Read**: `agent/installer.py:375-420, 489-560, 1170-1260` — the token flow enrols via
  `POST /api/enroll/claim`, then `build_config`/`write_config` write 12 keys and **no
  `google_api_key`**; `build_config`'s own docstring calls itself "the single definition of a
  provisioned config.json".
- **Read**: `agent/installer_gui.py:288-340, 1003-1020, 1370-1395` — a **duplicated** config builder
  and two call sites (`SetupWizard`, `run_headless`), both fed by the enrolment response.
- **Read**: all six enrolment success responses — `devices.js:369` (Express admin enrol; `enroll.js`
  has no admin enrol route at all), `enroll.js:271` + `:304` (claim 200/201), `worker.ts:397`,
  `:432`, `:581`, `:616` (handleEnroll and handleEnrollClaim, 200 and 201 each).
- **Read**: `serverless/pbl/env.ts` (the Worker `Env` type), `docs/API.md:228-236` (documented enrol
  response), `serverless/README.md:13-36` (bindings/secrets), `docs/adr/ADR-006` (ADR format).

**Findings**: the instruction "provision `google_api_key` on the serverless path" named the wrong
file and understated the gap. The token flow installs **without a key on both surfaces** — the
Worker is not uniquely guilty — and the only correct channel is the per-device enrolment response,
which already carries `api_key` over TLS. S303 also bounds the payoff: a session-0 service install
cannot scan BSSIDs at all, so the key only helps interactive installs. That is a delivery-channel
decision with a security consequence (a shared operator credential baked into every device config),
so it went to the user as a ruling instead of being implemented on my own description.

### Fog cleared

- **The key now reaches a token-flow install on both surfaces** (`e844fd5`): `POST /api/devices` and
  `POST /api/enroll/claim` on Express and `handleEnroll`/`handleEnrollClaim` on the Worker add a
  top-level `google_api_key` **only when** the operator configured the key — omitted entirely
  otherwise, never `null` and never `""`. `installer.py::build_config`/`write_config` and
  `installer_gui.py::write_config` accept it and set it only when non-empty; both agent call sites
  thread it from the enrolment response; the `--config-file` baked path adds nothing.
- **`installer-scripts.ts` is untouched, and a test pins that it stays that way**: the served
  `setup.ps1` output contains neither the configured key value nor the string `google_api_key`
  (B-070).
- **The no-key path is provably unchanged**: every addition is a conditional spread, and each suite
  asserts property **absence** (`'google_api_key' in body === false`, `assert not in config`), not
  falsiness — so an install with no key configured is byte-identical to yesterday's.
- **The decision is durable in an ADR, not only in a chat**: `docs/adr/ADR-008-geolocation-key-delivery.md`
  records ruling C, the shared-credential consequence ("rotation requires reinstall"), the rejected
  served-script channel, and check-in refresh as the tracked follow-up.
- **The gate that used to be decorative now guards a real contract**: a new parity test in
  `scripts/test_cross_surface_contract.py` pins that Express and the Worker read the same env name,
  that `installer.py` carries the field, and that `installer-scripts.ts` never mentions it.

### Fog remaining

- **The key cannot be rotated without reinstalling the fleet** (ADR-008 §Consequences). Check-in
  refresh is recorded in the ADR but in **no debt ledger** — deliberately, because the ledger feeds
  the graph's convergence count (60/64) and a new OPEN item there is a graph change to decide, not a
  byproduct of this feature.
- **`make full-verify` has not been swept end to end since S305 changed the lint gate.** Its own
  numbers (843/866/272/429/30, E2E 14, verify-env 56) are older than three sessions' changes.
  Individual component gates are green (below), which is not the same claim.
- **Options (c) and (d) of the S303 artifact are still open**: an in-session BSSID helper (an
  architectural decision about how a session-0 service could ever obtain BSSIDs) and "accept
  IP-level and say so in the README". Nothing has been chosen.
- The `installer.py` / `installer_gui.py` config-builder duplication is now duplicated in two more
  parameters. That is pre-existing debt, worsened in surface area, and still untracked.
- Unchanged: the registry changes left on MOLE (benign), picomatch advisories, `make sast`
  unavailable, 12 stale `audit_test_teeth` rows, offline key custody, HP UEFI BIOS password.

### Debt items closed

None. This closes no ledger item.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (PBL firmware signing),
D-210 (PBL route integration).

### Blockers

- **Not blocked.** Option (c) needs a design decision; option (d) needs a product decision; the
  rotation follow-up needs an authenticated settings endpoint on two surfaces.

### Session artifacts

- `docs/artifacts/s306-geolocation-key-delivery.txt` — what the read changed about the requested
  mechanism, the three ruling options and the one chosen, the 15-file change map, the nine gate
  outputs measured by the parent, and both oracle blocks with what they caught.
- `docs/adr/ADR-008-geolocation-key-delivery.md` — the decision of record.

### Failure attribution

- **Layer 4 (verification feedback)** — the workflow's first pass had every acceptance gate green
  while most of the plan's required tests were unwritten, and the shipped ADR **listed those
  non-existent tests as verification**. A green suite cannot detect a missing test; only a reviewer
  diffing plan-against-diff can. The oracle did, twice (round 1: missing tests + false ADR claim;
  round 2: the new `docs/API.md` sentence had been inserted *between* the 201 row and the 400/409
  rows, splitting the markdown table). Harness change: an ADR's Verification section must be diffed
  against the test names that actually exist before commit — a shipped false claim is worse than an
  empty section.
- **Layer 5 (state management)** — the parent's uncommitted `PENDING-RULING.md` edit was **reverted**
  during the workflow: after the children ran, the file was back at HEAD (494 lines, no geolocation
  section, `git status` clean for it) even though `check-ruling.sh` had read the open item minutes
  earlier. Nothing else in the working tree was lost (all 15 changed files and both new documents
  survived), so this was not a blanket reset. Harness change: a ruling must be committed — or
  written into the artifact/trace — **before** children are launched, because a child's toolset can
  rewrite `.devin/` files the parent is holding in memory. The ruling text is therefore reproduced
  in this block and in the artifact's §2, and ADR-008 now cites those instead of the live ruling
  file.

### VERIFY

- `cd server && npm test` → **882 passed, 52 suites**, exit 0 (876 + 6 new cases)
- `cd server && npx eslint .` → exit 0
- `cd serverless && npm test` → **490 passed, 4 files**, exit 0 (485 + 5 new cases)
- `cd serverless && npx tsc --noEmit -p .` → exit 0
- `scripts/run-agent-tests.sh -q` → exit 0, **976 collected** (10 new test functions in this diff)
- `scripts/lint-agent.sh` → ruff check + format clean
- `agent/.venv/bin/python scripts/test_cross_surface_contract.py` → **24 passed**, exit 0
- `node --check server/src/routes/devices.js` and `enroll.js` → exit 0
- Property absence, not falsiness, is what the new tests assert: `'google_api_key' in body === false`
  (Worker + Express) and `"google_api_key" not in config` (both agent builders)
- `scripts/check-ruling.sh` → `[OK] No open ruling items — task mode.`

### Next session opening

Sweep `make full-verify` end to end before anything else — three sessions have changed the lint gate
and two surfaces since its recorded numbers were taken, and component-green is not sweep-green —
then decide option (c) versus (d) of `docs/artifacts/s303-location-diagnosis.txt` §5 with that
result in hand.

---

---

## Session 307 — 2026-11-19 (`make full-verify` end to end, and a red that was my environment, not the code)

### RULE-ZERO — understanding logged before each change

This was a verification session; the only code change came out of what it found, and it was made
after the measurement, not before it.

- **Read**: `Makefile:338` — `full-verify: graph-check lint test test-e2e verify-env check-artifacts`,
  and each sub-target (`test` = six suites, `lint` = eight checks, `test-e2e` =
  `scripts/run-e2e.sh --agent-integration`). Read so a failure could be attributed to a target
  instead of to "the sweep".
- **Read**: `AGENTS.md`'s own known-red note — `scripts/test_tls_floor.py` needs a readable
  `/var/run/docker.sock` — so that a red of exactly that shape would be judged against the record
  rather than "fixed" by softening it.
- **Read**: `dashboard/playwright.config.js` and `e2e/fixtures.js` — `webServer.command = npm run dev`,
  `url = localhost:5173`, `reuseExistingServer: !process.env.CI`, `env: { VITE_API_URL: '' }`; and
  `fixtures.js` booting the API on `E2E_BACKEND_PORT` and logging in itself before the tests run.
- **Read**: `vite.config.js:8-11` — the `/api` proxy target is
  `http://localhost:${process.env.E2E_BACKEND_PORT ?? 3001}`, resolved **when the dev server
  starts**, which is the fact that decides everything below.

**Findings** before acting: `make full-verify` does not include the Playwright dashboard suite at
all, and any single failure aborts the chain, so "the sweep passed" and "every suite passed" are
different claims even when the first is true.

### Fog cleared

- **Every component suite is green on today's HEAD**: server **882** (52 suites), agent **976**,
  dashboard **272** (30 files), worker **490** (4 files), electron **30** (3 suites), API/agent E2E
  **14** (4 suites), verify-env **56 PASS / 0 FAIL / 5 SKIP**, check-artifacts all present. The
  numbers AGENTS.md carried (843/866/429/447) were three sessions stale; it now says these, dated.
- **The one red is the documented one and cannot be fixed from this session**: `test_tls_floor.py`
  fails at `docker run` with `permission denied … //var/run/docker.sock`; the socket is
  `root:docker 0660`, `id -nG` contains zero docker groups, and `sudo -n` needs a password. Measured,
  not assumed. It stays a **failure**, not a SKIP — the repo's rule, and this block does not call it
  green.
- **`full-verify`'s abort hides three steps**: `test-e2e`, `verify-env` and `check-artifacts` never
  ran. Run by hand: **14/14 E2E**, **56/0/5 env**, artifacts all present.
- **The Playwright red was a stale server, and my first conclusion was wrong.** 7 failed / 4 passed
  looked like dead login. `ps -o lstart` dated the squatter precisely:
  `npm exec vite --port 5173` started **Wed Nov 18 14:29** — S303. `reuseExistingServer: !CI` made
  Playwright drive that day-old server, whose `/api` proxy had been resolved **without** this run's
  `E2E_BACKEND_PORT` (so the browser talked to an unrelated backend on 3001) while the fixture's own
  axios login reached the right one on 3101. That is why `bootBackend()` never threw "login failed"
  and the failures appeared as missing elements. Same commit, port freed: **11 passed, 15.4 s**.
- **Reuse is now opt-in** (`PLAYWRIGHT_REUSE_DEV_SERVER=1`) instead of the default, so the failure
  mode is one loud line rather than seven misleading ones — proven by putting a dummy listener on
  5173 and watching it exit 1 in about a second with `http://localhost:5173 is already used`, and by
  a clean run afterwards (11 passed, no listeners left behind).

### Fog remaining

- **Four gates were not re-measured today** and keep their older dates in AGENTS.md: `make pg-smoke`
  (real PostgreSQL 16), `make sast` (semgrep absent on this host), `make firmware-host-tests`, and
  `make test-coverage` across all five components (only the dashboard floor was re-run).
- **`make full-verify` still cannot be green on this host** until the login session belongs to the
  `docker` group — an operator action (add the group, start a new login session), not a code change.
- **The sweep's own coverage gap is unclosed**: `test-e2e-dashboard` is not in the chain, so
  "full-verify passed" would still never have exercised the dashboard E2E suite. Adding it is a
  Makefile change with a 5173 precondition — worth doing, not done here.
- **S303 left a dev server running for a day** and nothing noticed. Process hygiene across sessions
  has no owner; the Playwright reuse defect made that invisible, and it is now at least loud for
  that one port.
- Unchanged: the rotation follow-up from ADR-008, S303 options (c)/(d), the `installer.py` /
  `installer_gui.py` config duplication, picomatch advisories, 12 stale `audit_test_teeth` rows,
  offline key custody, HP UEFI BIOS password.

### Debt items closed

None.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (PBL firmware signing),
D-210 (PBL route integration).

### Blockers

- **`/var/run/docker.sock` is unreadable from this login session** (root:docker 0660, no docker
  group, `sudo -n` needs a password). This is the only reason `make full-verify` cannot be green
  here, and it is not a code defect.

### Session artifacts

- `docs/artifacts/s307-full-verify.txt` — every target's result, the tls-floor evidence chain
  (socket mode, group membership, `sudo -n`, `docker ps`), the three hand-run steps, the stale-server
  attribution with its `lstart` timestamp, and the before/after proof of the reuse fix.
- `dashboard/playwright.config.js` — reuse is opt-in, with the date and mechanism in the comment.
- `AGENTS.md` — sweep results re-dated and split into *re-measured today*, *cannot pass here (and
  what the abort skipped)*, and *not re-measured* with their older dates.

### Failure attribution

- **Layer 4 (verification feedback), and it was mine.** I reported "a genuine red, not a flake" from
  the test output alone, without checking the environment the suite ran in — the exact shortcut the
  repo's own AGENTS.md warns about for this suite ("presenting as 'login is broken', not as
  misconfiguration"). Harness change this argues for: **any red must be attributed to a cause before
  it is reported**, and for a browser suite that means `ss`/`ps` on the port the harness claims to own.
- **Layer 3 (execution environment)**: the docker socket is the one gate the host cannot run. It was
  documented, and this session confirmed *why* rather than repeating the claim.
- **Layer 5 (state management)**: S303's leftover dev server survived a full session boundary and
  silently changed the meaning of another session's test run. Nothing in the harness required it to
  be cleaned up.
- **My own tooling**: `bg_run` reported exit 0 for a suite that failed, because the command ended in
  an `echo` that masked `PIPESTATUS`. The log's `make: *** Error 1` was the truth. Fixed in the
  follow-up runs by ending with `exit $rc`.

### VERIFY

- `make full-verify` → **exit 1**, and the single failure is
  `scripts/test_tls_floor.py::test_the_terminator_refuses_tls1_0_and_1_1_at_the_protocol_layer`
  (`1 failed, 1 passed`); every target before `test-scripts` passed.
- `cd server && npm test` → 882 passed / 52 suites · `cd serverless && npm test` → 490 / 4 ·
  `cd dashboard && npx vitest run` → 272 / 30 · `cd electron && npm test` → 30 / 3 ·
  `scripts/run-agent-tests.sh -q` → exit 0, 976 collected
- `make test-e2e` → **14 passed, 4 suites**, `RESULT: PASS (all E2E tests succeeded)`
- `make verify-env` → **56 PASS / 0 FAIL / 5 SKIP** · `make check-artifacts` → all artifacts present
- `docker ps` → exit 1 · `ls -l /var/run/docker.sock` → `srw-rw---- root docker` ·
  `id -nG | grep -c docker` → 0 · `sudo -n true` → "a password is required"
- Playwright: **7 failed / 4 passed** with S303's server on 5173, **11 passed (15.4 s)** after
  killing it, **11 passed (16.2 s)** with the new config, and with a dummy listener on 5173 the run
  exits 1 in ~1 s with `http://localhost:5173 is already used`.

### Next session opening

Pick option (c) or (d) of `docs/artifacts/s303-location-diagnosis.txt` §5 — the fleet's map
precision is the last open product question in this line of work — and before writing code for (c),
settle how a session-0 service could obtain BSSIDs at all, because S303 measured that this Windows
build refuses the WLAN scan without a location-capable interactive session.

---

---

## Session 308 — 2026-11-19 (can a session-0 service get BSSIDs? no — and that is now written down)

### RULE-ZERO — understanding logged before each change

Ruling first, code never: this session answered a platform question and changed documentation only.

- **Read**: `docs/artifacts/s303-location-diagnosis.txt` §3 and §5 — the measured refusals on MOLE
  (`netsh wlan … mode=bssid` → "need location permission … Access is denied", 0 SSIDs, 0 BSSIDs;
  HKLM `ConsentStore\location\Allow` → still denied; HKCU Allow → still denied; `lfsvc` restart →
  still denied; the SYSTEM-context control never ran because MOLE's Task Scheduler is broken, B-073).
- **Read**: `agent/agent.py:1100-1180, 1289-1300` — `scan_wifi_networks()` shells out to
  `netsh wlan show networks mode=bssid`, parses BSSID blocks, and already falls back to IP when the
  call raises; `_wifi_points()` turns the scan into the API's `wifiAccessPoints`.
- **Read**: Microsoft, *Changes to API behavior for Wi-Fi access and location* (Win32/nativewifi,
  ms.date 2025-05-30, fetched 2026-11-19) — the consent rule, the four affected calls, the prompt
  condition, and Microsoft's own recommendation to use Geolocation instead of Wi-Fi scans.
- **Read**: `docs/PRIVACY_POLICY.md` §1.2 and `serverless/README.md`'s `GOOGLE_API_KEY` row — both
  described Wi-Fi access-point collection without qualification.

**Findings**: the question "can a session-0 service obtain BSSIDs?" is **not** answered by "services
cannot"; the platform says consent *can* be device-level, which is a genuine foothold. What the
platform does settle is that the prompt only appears "within the user's context and outside of
`C:\Windows\System32`" — a `LocalSystem` service is neither — and that the only route left
(device-level consent) was measured on MOLE and still refused. So option (c) as specified is not a
matter of design; it is unproven, and the repo had never measured it in either direction. That went
to the user as a ruling rather than becoming code on my say-so.

### Fog cleared

- **The platform rule is now cited, not folklore**: the four BSSID-returning calls
  (`WlanGetAvailableNetworkList`, `WlanGetNetworkBssList`, `WlanScan`, `WlanQueryInterface` with
  `wlan_intf_opcode_current_connection`) return `ERROR_ACCESS_DENIED` without precise-location
  consent; consent can be device-, user- or app-level; the prompt requires a user context outside
  `System32`. `docs/artifacts/s308-session0-bssid-feasibility.txt` §1 quotes it.
- **The ruling is (d)**, recorded in `docs/adr/ADR-009-location-precision-by-install-type.md`: a
  Windows service install reports `source: 'ip'` by platform design, and the product says so.
- **The claim now appears where an operator and a data subject will meet it**: a new
  **Location Reporting** section in `README.md` (install type → source → precision, the rule, the
  citation), `docs/PRIVACY_POLICY.md` §1.2 rewritten, `serverless/README.md` pointing at ADR-009, and
  a paragraph in `AGENTS.md` beside the FRANKENSTEIN notes.
- **A privacy policy was over-claiming collection**, which is the kind of false statement that reads
  as harmless and is not: it listed "Wi-Fi access points — nearby SSIDs/signal strengths" as
  collected data when a service install collects none. It now says "only where the operating system
  permits a scan", and that an `ip` fix carries no accuracy radius.
- **Two paths are recorded as unproven, not as rejected**: an in-session helper (a per-user process at
  logon writing a file the service reads) and `Geolocator` called from the service (Microsoft's own
  recommended replacement, and it would need no Google key). Neither has ever been measured here; the
  evidence ladder puts both at `spec-checked`, and §5 of the artifact is the three-call probe that
  would settle them (interactive admin, `LocalSystem`-via-service, `LocalSystem` `Geolocator`;
  consent on and off).

### Fog remaining

- **Session-0 `LocalSystem` + device-level consent has still never been measured.** The probe needs
  hardware time and a way to run as `LocalSystem` that does not use Task Scheduler (broken on MOLE,
  B-073) — `psexec -s` or a temporary service. Until it runs, ADR-009's sentence is `spec-checked`
  plus S303's user-context refusals, not a hardware result.
- **The map stays city-level for service installs.** That is now product state rather than a defect,
  but it does not put a stolen laptop on a street.
- **The ADR-008 rotation follow-up is still open** (a shared key baked into each config; rotation
  needs reinstall).
- Unchanged: `installer.py`/`installer_gui.py` config duplication, picomatch advisories, 12 stale
  `audit_test_teeth` rows, offline key custody, HP UEFI BIOS password, D-120/D-129/D-130/D-134/D-210.

### Debt items closed

None. This closes no ledger item.

### Debt items still open

D-120 (BitLocker real media), D-129/D-134 (firmware hardware time), D-130 (PBL firmware signing),
D-210 (PBL route integration).

### Blockers

- **The probe needs a hardware window and a non-scheduler path to `LocalSystem`.** Nothing else in
  this decision is blocked; the documentation half is done.

### Session artifacts

- `docs/artifacts/s308-session0-bssid-feasibility.txt` — the quoted platform rule, what this repo has
  measured, the three surviving routes with costs, and the probe procedure.
- `docs/adr/ADR-009-location-precision-by-install-type.md` — the decision of record.

### Failure attribution

- **Layer 2 (context provision)**: the repo knew "WiFi triangulation is unavailable to a service
  install" but carried no citation and no boundary, so the question was re-openable by reasoning from
  the docs ("consent can be device-level") without anyone measuring. A decision recorded with its
  source and its measured/unmeasured boundary cannot be re-litigated by mood.
- **Layer 4 (verification feedback)**: `docs/PRIVACY_POLICY.md` asserted collection of Wi-Fi access
  points that no service install can perform, and nothing checked policy against capability. The
  product now states in three places what the platform will and will not deliver.
- **A note on process**: this session wrote no code at all, by design — the ruling gate was open, so
  "proceed" meant research and a decision request, not an implementation. The ruling section was
  deleted from `.devin/PENDING-RULING.md` once ADR-009 existed, per that file's own charter (live
  state, not a log).

### VERIFY

- `scripts/check-ruling.sh` → `[OK] No open ruling items — task mode.` (blocked while Q1 was open, as
  designed; reopened after the answer was recorded in ADR-009)
- `git diff --stat` before commit → docs only: `AGENTS.md`, `README.md`, `docs/PRIVACY_POLICY.md`,
  `serverless/README.md`, plus `docs/adr/ADR-009-…md` and `docs/artifacts/s308-…txt` (new). **No
  source file changed**, so no suite was run and no suite result is claimed for this session.
- Microsoft page fetched and quoted verbatim in artifact §1 (URL, `ms.date`, three sentences).
- `.devin/PENDING-RULING.md` returned to 494 lines, 0 unchecked items.
- `python3 scripts/brain.py check` → 176 beliefs, integrity clean.

### Next session opening

Decide whether to spend a hardware window on the §5 probe — it is the only thing that can change
ADR-009 — and if not, take the ADR-008 rotation follow-up, which needs no hardware: an authenticated
settings endpoint on both surfaces plus an agent cache, so the geolocation key can rotate without
reinstalling the fleet.

---

---

## Session 309 — 2026-11-19 (the geolocation key rotates through the check-in — ADR-008's follow-up closes)

### RULE-ZERO — understanding logged before each change

- **Read**: `agent/agent.py:1276` and `:1790` — the key was read inline in two places, both
  `os.environ.get("GOOGLE_API_KEY") or cfg.get("google_api_key")`; two read sites is a drift risk, so
  the change had to funnel them through one helper.
- **Read**: `agent/agent.py:1463` `checkin()` and its call site at `:4653` — the agent already polls
  `POST /api/agent/checkin` every `poll_interval`, signed with `agentAuth` + HMAC, and already
  consumes the response body. That makes the check-in the natural rotation channel: no new endpoint,
  no new credential, no served script (B-070).
- **Read**: `server/src/routes/agent.js:335-455` and `serverless/agent-routes.ts:86-215` — Express has
  one `res.json`, the Worker has **two** branches (with and without a pending command); both need the
  field or the rotation silently stops working on whichever branch a device happens to hit.
- **Read**: `agent/agent.py:315-334` (`_STATE_DIR`, `.pending_ack`, `.deadman`) and
  `agent/installer.py`'s ACL handling — `config.json` is ACL-protected by the installer, so the
  override must live in the state directory the agent is already proven to write.
- **Read**: `docs/adr/ADR-008` §Consequences — "rotation requires reinstall" was the tracked gap this
  session had to close without pretending the remaining limits away.

**Findings**: the channel is authenticated and already polled; the only genuine design questions were
where the override is persisted (state dir, not the ACL'd config) and how to express "stop
overriding" distinctly from "no opinion", because a missing env var must not silently clear a key.

### Fog cleared

- **Rotation no longer needs a reinstall** (`23e70f8`): the check-in response may carry
  `settings: { google_api_key: string | null, revision }`, present **only** when the surface's
  `GOOGLE_API_KEY` is defined. Defined-but-empty is `null` — an explicit "stop overriding". Undefined
  means no `settings` key at all, so a response from a surface with no opinion is byte-identical to
  the pre-ADR-010 shape and an older agent is unaffected.
- **The write is cheap and safe**: `revision` (sha256 prefix of the payload) gates it, so a 30 s poll
  does not rewrite a file 2,880 times a day; it lands in `_STATE_DIR/.runtime_settings` via
  temp-file + `os.replace`, and a persist failure logs a key-free warning instead of breaking
  check-in.
- **One helper resolves precedence** (`_effective_google_key`: env > override > `cfg`), replacing both
  inline reads, and the reconcile hook sits **before** `resolve_pending_wifi_scans`, so a rotated key
  applies to scans drained on the same tick.
- **The backward-compatible direction is tested by name**: a response with no `settings` leaves the
  override untouched (mtime asserted), because that is the direction that would fail silently.
- **Both surfaces trim the key** before delivering it — found by the oracle, not by a test: an env var
  with a trailing newline produced a key the Google API would reject.

### Fog remaining

- **`null` does not erase an install-time key** — it removes the override and falls back to whatever
  `config.json` was installed with. ADR-010 states that plainly; erasing still needs a reinstall,
  because that means writing to an ACL-protected file, which is the exact fight this change avoids.
- **Keys are still shared per fleet, not per device**, and the key now transits every check-in. On a
  plain-HTTP lab deployment that is the same exposure class ADR-008 accepted, and it is now on a
  30-second cadence rather than one install. Recorded, not mitigated.
- **No test asserts the end-to-end path on hardware** — the rotation has never been exercised against
  a real device: unit and route tests only. That needs a lab window like the BSSID probe does.
- Unchanged: the §5 BSSID probe (the only thing that can change ADR-009), D-120 (BitLocker real
  media), D-129/D-134 (firmware hardware time), D-130 (signing), D-210 (PBL route integration),
  `installer.py`/`installer_gui.py` config duplication, picomatch advisories, 12 stale
  `audit_test_teeth` rows, offline key custody, HP UEFI BIOS password.

### Debt items closed

None formally — this closes ADR-008's recorded follow-up, which was never a ledger item.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- **Not blocked.** The remaining rotation limits are design boundaries recorded in ADR-010, not work
  items; the only unproven piece is a real-device exercise of the rotation.

### Session artifacts

- `docs/adr/ADR-010-geolocation-key-rotation.md` — the decision, the `null` semantics, what is NOT
  solved, and a Verification section that names only tests which exist.
- `docs/artifacts/s309-key-rotation.txt` — the channel rationale, the contract table, the 8-file
  change map, the nine gate outputs measured by the parent, and both oracle blocks.

### Failure attribution

- **Layer 4 (verification feedback), the same defect class for the third session running.** Round 0
  passed every gate while three of four required test groups did not exist; the tell was the counts
  (server 882→882, worker 490→490, agent 976→976 — only the contract moved 24→25). Round 1 added the
  agent tests but left the server and worker tests unwritten, and the worker's own report
  **reclassified them as "optional"**. Both rounds were needed because a green suite cannot detect a
  missing test and a worker report is not evidence. Harness change already adopted in practice:
  compare test counts before/after in the oracle brief, not just gate colour.
- **Layer 2 (context provision)**: the `trim()` defect came from the environment, not the plan — an
  operator pasting a key into `wrangler secret put` can easily include a newline, and nothing in the
  ADR said the surfaces must normalise it. Now both do.

### VERIFY

- `cd server && npm test` → **885 passed, 52 suites**, exit 0 (882 + 3 new)
- `cd server && npx eslint .` → exit 0
- `cd serverless && npm test` → **495 passed, 4 files**, exit 0 (490 + 5 new)
- `cd serverless && npx tsc --noEmit -p .` → exit 0
- `scripts/run-agent-tests.sh -q` → exit 0, **983 collected** (976 + 7 new in
  `agent/tests/test_runtime_settings.py`)
- `scripts/lint-agent.sh` → ruff check + format clean
- `agent/.venv/bin/python scripts/test_cross_surface_contract.py` → **25 passed**, exit 0
- `git diff | grep -E "log\.|console\.|audit|kv.put"` filtered to key-bearing lines → none added
- `git diff --stat` → 8 files +242/−4, plus the two new documents; `installer.py` /
  `installer_gui.py` / `installer-scripts.ts` absent from the diff

### Next session opening

Exercise the rotation on a real device: set `GOOGLE_API_KEY` on the lab Worker, confirm the next
check-in writes `.runtime_settings` on MOLE, then change the value and confirm the agent picks it up
without a restart — the only part of ADR-010 that is still unit-tested only.

---

---

## Session 310 — 2026-11-19 (the rotation runs for real here — 13/13 — and what that still is not)

### RULE-ZERO — understanding logged before each change

No product code changed: this session exercised S309's rotation against a real server and the real
agent modules, which required reading how the server boots before it could be aimed at a throwaway DB.

- **Read**: `server/src/db/pool.js:24` — SQLite mode is selected by `USE_SQLITE=true` and *only* that;
  `SQLITE_PATH` alone leaves the pool on Postgres and even warns that `DATABASE_URL` will be ignored.
- **Read**: `server/src/index.js:293,328-345` — `PORT`, then `runMigrations()` and only afterwards
  `startServer()`; a failed migration in non-production logs "Starting anyway" and serves an API whose
  tables do not exist. That is the state the first two probe attempts hit.
- **Read**: `server/src/config/env.js:120-180` — placeholders are rejected even outside production, and
  `JWT_SECRET`, `AGENT_KEY_PEPPER`, `FIELD_ENCRYPTION_KEY`, `LOCATION_FIELD_KEY` each need ≥32
  characters; `ALLOW_NON_PROD=1` is required when `NODE_ENV !== production`.
- **Read**: `server/src/routes/setup.js` and the E2E fixtures' bootstrap — first admin via
  `POST /api/setup/create-admin`, JWT via `POST /api/auth/login`, per-device key via
  `POST /api/devices`; that is the only path to a key the agent can authenticate with.
- **Read**: `agent/agent.py` `checkin()`, `_reconcile_runtime_settings()`, `_effective_google_key()`,
  and `hmacAuth`'s `REQUIRE_HMAC` default — the probe could run unsigned (HMAC is opt-in), which keeps
  the probe about rotation rather than about signing.

**Findings**: nothing in the repo tells a caller that SQLite needs `USE_SQLITE=true`; the failure mode
is actively misleading (health answers 200, `/api/setup/status` says "Database not initialized", and
the log shows Postgres `ECONNREFUSED` on :5432). Recorded, not fixed — it is harness ergonomics.

### Fog cleared

- **The rotation is observed, not argued** (`d756729`): the real Express server plus the real
  `checkin()`/`_reconcile_runtime_settings()`/`_effective_google_key()` drive all four contract states
  in **13/13 assertions PASS** — key A arrives and is persisted; the same revision is **not**
  rewritten (mtime asserted, so a 30 s poll cannot churn the file); key B rotates the value **with no
  restart**; defined-but-empty delivers `null`, clears the override and the install-time key becomes
  effective again; and an unset env produces a response with **no** `settings` object that leaves an
  existing override byte-identical.
- **The `null` semantic is now a measured behaviour**, not a paragraph in an ADR: after the `null`
  phase the override file holds `{"google_api_key": null, "revision": "5e4fdbd5ebc2a0be"}` and the
  effective key is `INSTALL-TIME-KEY` again.
- **The deployed Worker is inert for this feature**: `wrangler secret list` on `lockdown-serverless`
  returns exactly one secret — `ADMIN_TOKEN`. No `GOOGLE_API_KEY`, so no device in production can be
  receiving a `settings` object today. That is the correct safe state and it is now a measured fact
  rather than an assumption.
- **Cleanup verified**: no probe server left listening on 3311/3411 and no stray `node src/index.js`.

### Fog remaining

- **MOLE has not run this.** The probe uses this Linux host with the real server and agent modules —
  `emulated` on the evidence ladder, one step below `hardware`. A Windows service install writing
  `.runtime_settings` under its ACL'd state directory is still unobserved.
- **Restart survival is untested**: the probe reuses one agent process, so it proves "no restart
  needed for the in-memory value" (the claim) but not that a restarted agent reads the file back.
- **The Worker path is untested end to end** for the same reason the channel is inert: no admin token
  and no key value here. Its response shapes are covered by `worker.test.ts` on both check-in branches.
- **The `USE_SQLITE` trap is still a trap** — record only, no documentation change made.
- Unchanged: the §5 BSSID probe (the only thing that can change ADR-009), D-120, D-129/D-130/D-134,
  D-210, the `installer.py`/`installer_gui.py` config duplication, picomatch advisories, 12 stale
  `audit_test_teeth` rows, offline key custody, HP UEFI BIOS password.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- **Two operator-held values** gate the remaining two steps: a Google API key to set on the Worker, and
  an admin token to observe MOLE's check-in. Neither is something this session can supply, and pushing
  a throwaway value into a deployed Worker would change production state for a test.

### Session artifacts

- `docs/artifacts/s310-rotation-live-probe.txt` — the driver's description, the 13 PASS lines verbatim,
  the final on-disk override, what is proven versus not, and the `USE_SQLITE` trap.
- `/tmp/probe_rotation.py` — the throwaway driver (deliberately not added to the repo: it boots a
  server with throwaway secrets and would be a liability if anyone pointed it at real data).

### Failure attribution

- **Layer 3 (execution environment), twice**: the first two probe attempts died on configuration the
  repo does not state in one place — `ALLOW_NON_PROD` plus four ≥32-character secrets, then
  `USE_SQLITE=true`. Neither failure was a product defect, and both cost a run.
- **Layer 4 (verification feedback)**: `GET /api/health` answering 200 while the process is dialling a
  Postgres that does not exist is a false-green by construction. A readiness probe that does not check
  the data path cannot tell "up" from "up and useless", and this session was fooled by it for two runs.
- **A tooling lesson of my own**: `pkill -f "node src/index.js"` matched the shell command that was
  running it and killed my own turn (exit 143). Killing by captured PID is the correct pattern.

### VERIFY

- 13/13 `PASS` lines from the live probe, ending `RESULT: PASS (0 failure(s))` — key A persisted,
  same-revision no-write (mtime), key B rotated with no restart, `null` clears and falls back to
  `INSTALL-TIME-KEY`, unset leaves the override untouched.
- Final override file: `{"google_api_key": null, "revision": "5e4fdbd5ebc2a0be"}`.
- `ss -ltnp | grep -E ":(3311|3411) "` → nothing listening; no leftover `node src/index.js`.
- `npx wrangler secret list` → `[{"name":"ADMIN_TOKEN","type":"secret_text"}]` for `lockdown-serverless`.
- No source file changed this session; the platform suite numbers from S309 stand (server 885/52,
  worker 495/4, agent 983, contract 25).

### Next session opening

Ask the operator for the two values the last step needs — a Google API key for the Worker secret and an
admin token for the lab API — and then watch MOLE's check-in write `.runtime_settings` and pick the key
up without a restart; if those values are not available, stop treating the rotation as pending work and
record it as `emulated`-verified until a hardware window exists.

---

---

## Session 311 — 2026-11-19 (rotation verified on MOLE, 1.0.3 → 1.0.4, and the gap I had claimed was unbridgeable)

### RULE-ZERO — understanding logged before each change

- **Read**: `docs/artifacts/s281-mole-reachability.txt` and memory `m-1341` **after** getting this
  wrong once: the route is `ssh -i ~/.ssh/lockdown_lab_ed25519 labadmin@192.168.1.249`. I had grepped
  for an `ssh` config alias, found none, and told the user I had no access — while the answer was in
  the memory I had already loaded and in a repo artifact.
- **Read**: `agent/build.ps1` — it stamps `_buildinfo.py` by hashing the source files, so a device
  with no git can still produce an identifiable build; `-AgentOnly -Install` is the minimal path.
- **Read**: `server/src/…` service registration and `sc query LockdownAgent` — the service is
  `STOPPABLE, NOT_PAUSABLE, IGNORES_SHUTDOWN`.
- **Read**: `npx wrangler deployments list` / `versions list` — the newest entry was
  `Source: Secret Change`, which is a *version*, not a code deployment.
- **Read**: `ADR-010` §What is NOT solved and §Verification — the two claims that were still marked
  unmeasured (a real device, restart survival).

**Findings**: the chain had **two** stale halves, not one. The agent was 1.0.3 (pre-`23e70f8`), and the
Worker's code was older still, so even a fresh agent would have received no `settings` at all. Only the
agent half was visible from the repo; the Worker half needed the deployment list.

### Fog cleared

- **The rotation is verified on hardware** (`208d145`, `f3a6b70`): MOLE now runs
  `lockdown-agent 1.0.4 (frozen=True, build=20261119.32849efe4235)`, built **on MOLE itself** with
  `build.ps1 -AgentOnly -Install` from a tar of `agent/`.
  - first check-in → `.runtime_settings` written in the same second as `.last_checkin_ok`
    (`key_len 39`, `revision 3f11ee4980d2a049`);
  - rotated → `key_len 19`, `revision d8bf5ae6ff123fc3`, written **six minutes into the same
    process's life** — rotation with no restart;
  - restored → `key_len 39`, `revision 3f11ee4980d2a049` — the identical digest, which also
    demonstrates revision stability for an unchanged value.
- **Restart survival closed with an observable, not an inference**: service restarted at 13:03:22,
  successful check-in at 13:04:43, file mtime **unchanged at 13:01:18**. The agent rewrites only when
  the stored revision differs from the one the surface sent, so a `LocalSystem` process unable to read
  the file would have rewritten it. It did not — so the restarted agent read what the previous process
  wrote, in the ACL'd state directory.
- **The secret was never handled by a human twice**: the restore used
  `wrangler rollback 0ad0ff6a…` to the version that held the real key, and the revision returning to
  the identical digest is independent proof the key is the same one.
- **Two environment facts that will bite any future upgrade**, both now in the artifact:
  `LockdownAgent` is `IGNORES_SHUTDOWN`, so `Stop-Service` reports Stopped while the process keeps
  running and holds the image — the first swap failed exactly there and needed an explicit
  `Stop-Process`; and a `wrangler secret put` is a **Secret Change version, not a code deploy**.
- **`AGENT_VERSION` was bumped** (`f00a980`) after discovering that the rotation shipped without it,
  which is why the version column could not distinguish builds at all.

### Fog remaining

- **The key does not make MOLE precise.** ADR-009 stands: a session-0 service install cannot obtain
  BSSIDs, so MOLE is still IP-level. This session verified the *plumbing*, not the precision, and
  nobody should read `key_len 39` as "MOLE now resolves wifi".
- **The wizard was not exercised.** `scripts/verify-key-rotation-wizard.sh` remains untested in anger;
  the hardware evidence came from direct SSH automation instead. Its resume path and its
  restore-before-continue preflight have still never run.
- **Left on MOLE**: `lockdown-agent.exe.bak-1.0.3` (deliberate rollback copy) and
  `C:\Users\labadmin\agentbuild\` (source + PyInstaller tree, ~hundreds of MB).
- **Unpushed**: 22 local commits (S304→S311) are still only on this host; the Windows build on CI was
  avoided deliberately by building on MOLE.
- Unchanged: the §5 BSSID probe, D-120, D-129/D-130/D-134, D-210, `installer.py`/`installer_gui.py`
  config duplication, picomatch advisories, 12 stale `audit_test_teeth` rows, offline key custody.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- **None.** The rotation thread is closed on hardware; what remains is deliberately out of scope
  (precision is ADR-009's decision, not a defect).

### Session artifacts

- `docs/artifacts/s311-rotation-hardware.txt` — the before/after builds, why the Worker had to be
  redeployed, the `IGNORES_SHUTDOWN` finding, the three measurements, the restart invariant, and what
  was left on the device.
- `docs/adr/ADR-010-geolocation-key-rotation.md` — §Verified on real hardware, and its last "still
  unproven" paragraph replaced with the restart result.

### Failure attribution

- **Layer 5 (state management), mine.** I declared "no SSH access to MOLE" from an empty `ssh` config
  while `docs/artifacts/s281-mole-reachability.txt`, `trace.md`, and memory `m-1341` all carried the
  exact command. The user had to correct me with four words. Harness change: when about to say "no
  access", grep the artifacts and memory first — an access route is a fact this repo writes down.
- **Layer 4 (verification feedback), the environment half.** The Worker's `settings` field was
  invisible for a day because a secret change *looks* like a deploy in `versions list`. Anything that
  depends on a code path needs a deploy check that reads `Source:`, not a date.
- **Layer 3 (execution environment).** `IGNORES_SHUTDOWN` made a documented upgrade step
  (`Stop-Service` then replace) silently ineffective; only reading the error message revealed it.
- **My own tooling, again**: a `brain.py refute` statement passed in double quotes let the shell
  execute its backticks, storing `"and a  is a Secret Change VERSION"`. Caught by reading the stored
  belief back, and corrected by refuting it with a properly quoted call (B-180).

### VERIFY

- Version before/after: `1.0.3 (build=20261118.5c31f3eaa364)` → `1.0.4 (build=20261119.32849efe4235)`,
  built on MOLE; service `Running`, two processes (PyInstaller parent + child, B-079).
- `.runtime_settings`: `39 / 3f11ee4980d2a049 @12:57:41` → `19 / d8bf5ae6ff123fc3 @13:00:06` →
  `39 / 3f11ee4980d2a049 @13:01:18`; agent process start 12:53:53 throughout the first two.
- Restart: process start 13:03:22, `.last_checkin_ok` 13:04:43, file mtime **13:01:18 unchanged**.
- Worker: deployed `0ad0ff6a-345c-48a1-9df1-8a6eb5b57e06`; rollback target `a0e811ec-…` recorded and
  used to restore the key.
- Key material never printed: every read reported `key_len` and `revision` only.
- `brain.py check` → 180 beliefs, integrity clean. `git log` → `208d145`, `f3a6b70` plus state.

### Next session opening

Push the 22 local commits — the Windows-artifacts and lint workflows have never seen S304→S311 — and
then decide whether the wizard still earns its place now that the hardware path is automated over SSH.

---

---

## Session 312 — 2026-11-19 (23 commits meet CI: one finding mine, two older than my work, and a gate that never ran locally)

### RULE-ZERO — understanding logged before each change

- **Read**: `.github/workflows/lint.yml` job list and `Makefile:205-212` — eight lint jobs, of which
  `SAST (Semgrep)` shells out to a binary that is not installed on this host; `make sast` exits 2
  rather than reporting anything, which is how a red gate stayed invisible.
- **Read**: `scripts/sast-gate.py` and `scripts/sast-exceptions.json` — the exception key is
  `(rule, path, the flagged source line, occurrence)` read from disk, so a near-miss in `match`
  converts "unclassified finding" into "stale exception". That decided the order of work: verify with
  the real binary before pushing.
- **Read**: each flagged site in full before writing its disposition — `agent/service_host.py:210-232`
  and `:330-345`, `scripts/acceptance_lifecycle.py:640-660`, `agent/hw_test_harness.py:2772`.
- **Read**: `scripts/prepush_secrets.py` behaviour and the CI log for the failing job, then
  `git show 4c43b58` to find which pasted value tripped it.
- **Read**: `agent/agent.py`'s version block — the S286 note that "a version that cannot distinguish
  two builds is not an identity", which is the argument S311 used to justify the 1.0.4 bump.

**Findings**: the first push in twelve sessions ran seven workflows over code history had never
exposed. Two failures were pre-existing and one was a real credential-shaped value from S301. None of
them were caused by S304→S311.

### Fog cleared

- **Master is green** (`f96f7ef`): Lint run 44505246648 — all eight jobs success, including
  `SAST (Semgrep)` and `Secret scan (publish range)`; plus `CI` (full suite) success and `CodeQL`
  success. First fully green run since 2026-11-18.
- **The dashboard lint gate now works in the machine that counts**: the CI `Lint Dashboard (ESLint)`
  job runs `--ext .js,.jsx --max-warnings=0`, so the 51 `.jsx` files that were silently skipped before
  S305 are linted on every push.
- **The secret-scan finding was real and is fixed forward**: S301's block quoted a token response body
  (`{"token":"<redacted>"}`); the token was single-use with a 900 s TTL minted 2026-11-18T12:03:25Z, so
  dead 16 hours before publication. Redacted to `<redacted — S311>` with the shape and TTL preserved.
  `Secret scan` → success on `c330b3f`.
- **The SAST baseline is triaged, not suppressed**: three findings carry dispositions that cite the
  guard in the code (two scheme checks a few lines above the call; one intentional `chmod 0o755` on an
  executable), and the stale `hw_test_harness.py` entry was **deleted** because its `match` text still
  exists at line 2772 while Semgrep no longer raises the finding — the gate's own definition of stale.
  Verified locally with semgrep 1.182.1: 48 findings, 0 ERROR, exit 0.
- **AGENTS.md's `make sast 45 findings` claim was corrected** to 48 / 0 ERROR / all dispositioned
  (S312), and the section now carries the venv recipe so the gate can actually be run here.

### Fog remaining

- **One CI red remains unattributed.** `CI` failed on `0c13b19` (master before the push) with Server
  Tests and Dashboard Tests failing, and passes on `c330b3f` without any reproduction. Recorded as
  pre-existing / not reproduced / attribution unknown — the two documented flaky classes in that area
  (SQLite teardown race S267, dev server squatting 5173 S307) are candidate causes, not conclusions.
- **Semgrep is still not installed on this host**; it was run from a throwaway `/tmp/sgvenv`. Until it
  is installed persistingly (pipx), the local gate remains a no-op between CI runs.
- **S312 caught me repeating the mistake it documents**: the AGENTS.md guardrail example reproduced the
  token fragment and the scanner flagged it (`WARN assigned-secret in fixture/example`). Fixed by
  amending the unpushed commit; the rule now shows the shape only.
- Unchanged: the §5 BSSID probe (now cheap, because MOLE is reachable over SSH), D-120,
  D-129/D-130/D-134, D-210, `installer.py`/`installer_gui.py` config duplication, 12 stale
  `audit_test_teeth` rows, offline key custody, HP UEFI password.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- **None.** Two of the four SAST items were false positives, one was intentional, one was stale.

### Session artifacts

- `docs/artifacts/s312-ci-green.txt` — the push, the secret finding with its TTL and redaction, the
  four SAST dispositions with their code evidence, the local and CI verification, and the one
  unattributed red.
- `scripts/sast-exceptions.json` — 46 → 48 entries, `reviewed: S312`.

### Failure attribution

- **Layer 4 (verification feedback), and it is structural.** A gate whose tool is absent on the
  developer host does not fail loudly — `make sast` exits 2, nobody reads it, and the documentation
  keeps asserting a number it can no longer produce. CI was the only measurement for a day, and CI's
  red was invisible because nothing was being pushed. The actual fix is the one applied: install the
  binary in a venv, run the real gate, and write the recipe into AGENTS.md.
- **Layer 2 (context provision)**: the publish-range secret scan exists precisely because session
  blocks quote API responses; there was no rule against pasting a token *value*, so S301 pasted one.
  There is now, in the same paragraph that describes the session-end block.
- **A near-miss worth naming**: the first draft of that new rule contained the very fragment it
  forbade, and the scanner caught it before the push. That is the guard working one layer earlier
  than usual.

### VERIFY

- `PATH=/tmp/sgvenv/bin:$PATH make sast` → `Semgrep findings: 48`, `[OK] every finding is either
  fixed or carries a reviewed reason`, exit 0.
- CI on `f96f7ef` — Lint run 44505246648: Agent ruff · Secret scan · tsc · Server ESLint · Dashboard
  ESLint · actionlint · OpenAPI · SAST → **all success**; `CI` success; `CodeQL` success.
- `python3 scripts/prepush_secrets.py --base 9ff542c --head c330b3f` → no findings.
- `python3 scripts/brain.py check` → 181 beliefs, integrity clean (B-181 asserted at code-read).
- Pushed: `272b7fa` → `c330b3f` → `f96f7ef`; working tree clean.

### Next session opening

Run the §5 BSSID probe on MOLE — three calls now that SSH is known and the device is on 1.0.4: an
interactive `WlanGetNetworkBssList`, the same call from `LocalSystem` via a temporary service, and
`LocalSystem` `Geolocator`, with device-level location consent on and off. It is the only measurement
that can change ADR-009, and until today it looked like it needed someone at a keyboard.

---

---

## Session 313 — 2026-11-19 (a generated index that shifted every row, and the test that failed on its own fix)

### RULE-ZERO — understanding logged before each change

- **Read**: `scripts/memory.py:1040-1160` (`stage_index`) — three row builders interpolate `title`,
  `tags`, `impact`, `reason` and `superseded_by` straight into markdown table cells.
- **Read**: `scripts/test_memory.py` index tests — they assert content (`"m-001" in index_text`,
  `"| 0 |" in index_text`) but never the row's shape, which is why nothing caught this.
- **Read**: the pi-lens advisory that raised it — "0 actionable warnings · 50 quality issues" with
  `MD056 table-column-count [Expected: 8; Actual: 10]` inside the list, on `.devin/memory/index.md`.
- **Read**: the offending row (`m-1430`, title `Client base URL is electronApiUrl || VITE_API_URL`) and
  counted its pipes — 11 where the table wants 9.

**Findings**: not a markdown style complaint. An unescaped `|` in generated content adds table cells,
so every column after the title is displaced — the index was quietly lying about which confidence,
date and score belonged to which memory. Six rows were affected, and the cause was my own captures:
`||` in a shell command, and `|` in `git diff | grep` style text.

### Fog cleared

- **`_md_cell()` escapes `|` and flattens newlines**, and the three row builders use it (`3bec4a7`).
- **The index is regenerated and measured**: 1457 active / 20 decayed, and an independent delimiter
  count over the whole file finds **0 ragged rows** (it was 6).
- **The escaping is pinned by a test** that asserts *delimiters*, not raw pipes — the first draft of my
  own test failed on the fix itself (`count("|") == 11`), because an escaped `\|` is still a `|`
  character. Corrected to a negative-lookbehind count; 45 memory tests pass.
- **The advisory was worth reading.** "0 actionable warnings" described severity, not table integrity;
  the item was sitting in the "quality issues" tail. This is the third time in two sessions that a
  dismissed-looking advisory held a real defect.

### Fog remaining

- **`MASTER-INDEX`/`STUDY-INDEX` and the ADR tables were not checked for the same class.** The fix is in
  the generator that produced this one; any hand-authored table with a `|` in a cell has the same
  failure and no test.
- **Pyright still resolves `pytest` against the system interpreter** in `scripts/*.py`
  (`reportMissingImports`), which is the documented advisory class, not a defect.
- Unchanged: the §5 BSSID probe on MOLE (now cheap), D-120, D-129/D-130/D-134, D-210, 12 stale
  `audit_test_teeth` rows, offline key custody, HP UEFI password.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- None.

### Session artifacts

- `.devin/memory/index.md` (regenerated), `scripts/memory.py`, `scripts/test_memory.py` — commit
  `3bec4a7`. No separate artifact file: the evidence is the delimiter count (6 → 0) and the test.

### Failure attribution

- **Layer 4 (verification feedback)**: the index had tests but none on its *shape*, so a generator bug
  that displaced every column survived 1400+ entries. A table test that asserts content and not
  column count is half a test.
- **Layer 2 (context provision)**: nothing told memory authors that `|` is table-significant when the
  index renders their text, so the input that broke it (shell pipelines in titles) is the normal case.

### VERIFY

- `agent/.venv/bin/python scripts/test_memory.py` → **45 passed** (was 44; the new case is the 45th).
- Independent check over `.devin/memory/index.md`: every row's unescaped-pipe count equals its table
  header's → **0 ragged rows** (was 6).
- `grep m-1430 .devin/memory/index.md` → `electronApiUrl \|\| VITE_API_URL`, escaped and inside one cell.
- `python3 scripts/memory.py index` → `Index rebuilt: 1457 active, 0 superseded, 20 decayed`.

### Next session opening

Run the §5 BSSID probe on MOLE over SSH — interactive `WlanGetNetworkBssList`, the same call from
`LocalSystem` via a temporary service, and `LocalSystem` `Geolocator`, consent on and off — because it
is the only measurement that can change ADR-009 and it no longer needs a human at the keyboard.

---

---

## Session 314 — 2026-11-19 (I pushed a range my own scanner had failed, and the rule that was missing)

### RULE-ZERO — understanding logged before each change

- **Read**: `scripts/prepush_secrets.py`'s CLI contract (`--base`/`--head`, exit 1 on findings) — it was
  already correct; the defect was in how I invoked it.
- **Read**: the CI job list for `91a17ea` after the fact — *only* `Secret scan (publish range)` failed,
  which located the failure precisely rather than as "CI is red".
- **Read**: `.devin/graph/trace.md` and `docs/artifacts/s312-ci-green.txt` to find every live occurrence
  of the fragment (two), rather than trusting the scanner's file list alone.

**Findings**: the guardrail I wrote in S312 forbade pasting a credential value, and I pasted it twice
more while writing about the rule. The missing half was not advice but mechanism: the scan and the push
were chained with `;`, so the check could not stop the action it existed to protect.

### Fog cleared

- **Both live occurrences are redacted** (`d93fb32`): `trace.md` (my S312 block) and the S312 artifact.
  `grep -r kLekRUyp .devin/graph/trace.md docs/artifacts/` → 0.
- **AGENTS.md gained the mechanical half**: "gate the push on the scan, not next to it" — `… && git push`,
  because "a verification whose failure does not stop the action is a log line, not a check".
- **CI is green on the corrected push**: `d93fb32` → Lint run 44506991536 with **all eight jobs
  success**, including `Secret scan (publish range)` and `SAST (Semgrep)`; plus `CI` and `CodeQL`.
- **The bad push is recorded as red, not hidden**: on `91a17ea` the only failing job was
  `Secret scan (publish range)`. The gate worked; the operator did not.

### Fog remaining

- **`ca6d953` remains on the remote containing the fragment's first eight characters.** The token is
  single-use, had a 900 s TTL and expired 2026-11-18T12:03Z+15m — rewriting published history for that
  is disproportionate, and this file says so rather than implying the exposure is zero.
- **The pattern behind three separate incidents is not yet a test.** S305's lint gate that linted no
  `.jsx`, S307's Playwright reuse of a stale dev server, and now a scan chained with `;` are all
  "checks that watch without blocking". Two were fixed at their own layer; the general shape has no
  guard.
- Unchanged: the §5 BSSID probe on MOLE (still the cheapest next measurement), D-120,
  D-129/D-130/D-134, D-210, 12 stale `audit_test_teeth` rows, offline key custody, HP UEFI password.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- None.

### Session artifacts

- `AGENTS.md` (the gating rule), `.devin/graph/trace.md`, `docs/artifacts/s312-ci-green.txt` — `d93fb32`.

### Failure attribution

- **Layer 4 (verification feedback), and self-inflicted twice over.** The check ran, printed `[FAIL]`,
  and the push proceeded because of `;`; then I asserted cleanliness in the same breath as reading the
  failure. A check that cannot block is decorative — the same defect class this repo fixed for lint
  (S305) and for test-environment setup (S307), which is presumably why it keeps recurring in new forms.
- **Layer 5 (state management)**: publishing is irreversible, and the irreversible action was placed
  after a reversible check without a fail-fast link. `&&` is the whole fix, and it is now written down.

### VERIFY

- `python3 scripts/prepush_secrets.py --base 91a17ea --head HEAD` → clean, then `&& git push` published
  `d93fb32`.
- CI `d93fb32` — Lint 44506991536: ruff · Secret scan · tsc · Server ESLint · Dashboard ESLint ·
  actionlint · OpenAPI · SAST → **all success**; `CI` success; `CodeQL` success.
- CI `91a17ea` — failing job: `Secret scan (publish range)`, and nothing else.
- `grep -r kLekRUyp .devin/graph/trace.md docs/artifacts/` → **0**.
- `python3 scripts/brain.py check` → 182 beliefs, integrity clean (B-182 asserted).

### Next session opening

Run the §5 BSSID probe on MOLE over SSH — interactive `WlanGetNetworkBssList`, the same call from
`LocalSystem` via a temporary service, and `LocalSystem` `Geolocator`, consent on and off — since it is
the only measurement that can change ADR-009 and it needs nobody at a keyboard.

---

---

## Session 315 — 2026-11-19 (the BSSID probe, run on MOLE: services cannot, and neither can Geolocator)

### RULE-ZERO — understanding logged before each change

- **Read**: `docs/artifacts/s308-session0-bssid-feasibility.txt` §5 — the three-call probe this session
  executes, and §1's quoted Microsoft rule it was written to test.
- **Read**: `docs/adr/ADR-009` §Consequences and §Alternatives — the two claims marked "unproven" that
  the probe could now settle.
- **Read**: the WLAN API contracts (`WlanOpenHandle`, `WlanEnumInterfaces`, `WlanGetNetworkBssList`) and
  WinRT `Geolocator.GetGeopositionAsync` — enough to P/Invoke them and read return codes rather than
  parse prose from `netsh`.
- **Read**: MOLE's actual state before measuring — `qwinsta` (console session 1 Active, user "Newark
  User"), HKLM location consent (`Allow`), my session id (0) and elevation (True).

**Findings**: the probe is only meaningful if consent is at its most permissive and a
location-capable session exists, and both were true — so a denial could only be about the *caller*.

### Fog cleared

- **A LocalSystem service cannot obtain BSSIDs, measured** (`docs/artifacts/s315-bssid-probe-hardware.txt`):
  from a temporary service running as `NT AUTHORITY\SYSTEM` in session 0 with consent `Allow`,
  `WlanOpenHandle` and `WlanEnumInterfaces` return **0** (one interface) and
  `WlanGetNetworkBssList` returns **5 = ERROR_ACCESS_DENIED** — identical to the elevated-admin control.
- **Geolocator fails from a service too**, which kills the hope ADR-009 had left open: the WinRT types
  load and instantiate under SYSTEM, and `GetGeopositionAsync` faults with **0x80070005 E_ACCESSDENIED**.
  Option (c2) is now rejected on hardware evidence, not on reasoning.
- **ADR-009's sentence is now measured**: "a service install reports `source: 'ip'` by platform design"
  is a hardware result with the strongest possible consent setting, not a reading of documentation.
- **AGENTS.md now carries the result** so the BSSID question is not re-opened by argument: the three
  refusals, the two return codes, and the one route that remains unmeasured.
- **Method facts worth keeping**: `powershell.exe` as a service `binPath` never produced a process
  (8 polls over 40 s) while `cmd.exe /c powershell -File …` started every time; and under SCM a batch's
  `whoami`/`netsh` output vanished while the file was written — which is why the evidence is an API
  return code and not a `netsh` exit status.

### Fog remaining

- **(c1), the in-session helper, is still untested** — neither confirmed nor excluded. Running it means
  code execution inside session 1, and MOLE's Task Scheduler is broken (B-073), so it needs
  `CreateProcessAsUser` + `WTSQueryUserToken`. It would also only help while a user is logged on,
  which is why it was never the recommended path.
- **MOLE remains IP-level in practice**, and now nobody can claim the key or the platform might change
  that: `google_api_key` is provisioned (S311) and inert for this device by design.
- **Consent-off was not run** — deliberately: consent-on already denied the call, so the stricter state
  could only add nothing.
- Unchanged: D-120, D-129/D-130/D-134, D-210, 12 stale `audit_test_teeth` rows, offline key custody,
  HP UEFI password, the `installer.py`/`installer_gui.py` config duplication.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- **(c1) needs a session-1 execution mechanism**, which is a small piece of engineering rather than a
  measurement anyone can take with a shell.

### Session artifacts

- `docs/artifacts/s315-bssid-probe-hardware.txt` — the environment, the three refusals with numeric
  codes, what is settled, and the two method traps.
- `docs/adr/ADR-009-location-precision-by-install-type.md` — hardware results table, and (c2) rejected
  on evidence.

### Failure attribution

- **Layer 4 (verification feedback), in the probe's own plumbing.** Three attempts produced
  "no output", "exit 1" and "One or more errors occurred" — each of which *looks* like a denial and
  none of which distinguishes denial from a broken harness. The fix was to stop reading `netsh` prose
  and SCM redirection and switch to P/Invoke return codes: 5 and 0x80070005 are unambiguous. A probe
  that cannot separate "denied" from "did not run" is not a measurement.
- **Layer 3 (execution environment)**: `powershell.exe` as a service binary silently never started;
  the `cmd.exe /c` wrapper did. Recorded so the next probe does not repeat the 40 seconds.

### VERIFY

- **Environment**: `qwinsta` → session 1 Active ("Newark User"); HKLM consent → `Allow`; probe session 0,
  elevated True.
- **(a) control**, elevated admin session 0: `netsh` → "need location permission"; API →
  `WlanOpenHandle rc=0 | WlanEnumInterfaces rc=0 interfaces=1 | WlanGetNetworkBssList rc=5`.
- **(b) SYSTEM** via `sc create … cmd.exe /c powershell -File …`: caller `NT AUTHORITY\SYSTEM`,
  session 0, consent Allow, same three return codes — **rc=5** on the BSS list.
- **(c) SYSTEM Geolocator**: types resolved (`Geolocator`, `Geoposition`), then
  "Your App does not have permission to access location data." with **hresult = 0x80070005**.
- Cleanup: all temporary services deleted (`PblBssidProbe`, `PblWlanProbe`, `PblGeoProbe`).
- `python3 scripts/brain.py check` → 183 beliefs, integrity clean (B-183 asserted at hardware level).

### Next session opening

Build the (c1) in-session helper probe — `CreateProcessAsUser` with `WTSQueryUserToken` to run the same
`WlanGetNetworkBssList` inside session 1 — because it is the only BSSID route left untested, and if it
works the honest product statement becomes "IP-level for service installs, wifi for logged-on ones"
rather than "IP-level, always".

---

---

## Session 316 — 2026-11-19 (option (c1) measured: an in-session helper is denied too, and why)

### RULE-ZERO — understanding logged before each change

- **Read**: `docs/artifacts/s308-session0-bssid-feasibility.txt` §1 — the sentence I had quoted twice
  without testing its second half: the consent prompt appears only when the process is "within the
  user's context **and outside of the C:\Windows\System32 folder**".
- **Read**: `docs/adr/ADR-009` §Verified on hardware — the one route S315 left unmeasured, and the
  exact claim ("only helps while a user is logged on") this session could now test.
- **Read**: `qwinsta` on MOLE — session 1 Active, user "Newark User" — and the Win32 sequence a helper
  must use when Task Scheduler is unavailable (B-073): `WTSGetActiveConsoleSessionId` →
  `WTSQueryUserToken` → `DuplicateTokenEx` → `CreateProcessAsUser` with `winsta0\default`.

**Findings**: the probe had to satisfy two conditions to mean anything — a real interactive session,
and a child binary outside `System32`. The first attempt satisfied only the first, which is exactly the
shape of a confounded measurement.

### Fog cleared

- **A real in-session helper was created and it is denied too** (`docs/artifacts/s316-in-session-helper-probe.txt`):
  a SYSTEM launcher created the child on the interactive desktop of session 1
  (`launched session 1 pid=… (waited)`), and the child reported `caller: MOLE\Newark User`,
  `session: 1`, `interactive: True` — then `WlanGetNetworkBssList` returned **rc=5**.
- **Re-run from a non-System32 binary to remove the documented confounder**: same launcher, child
  `C:\Python314\python.exe` running a ctypes P/Invoke — **rc=5** again. So the "outside System32"
  condition was not the blocker.
- **The real precondition is per-app precise-location consent**, which Windows grants only through an
  explicit `RequestAccessAsync` prompt a human accepts. Nothing in this product calls it, so **no
  install type obtains BSSIDs today** — not the service (S315), not an interactive session (S316).
- **ADR-009's product statement is now sharper**: an interactive install is IP-level too unless that
  consent has been granted; `GOOGLE_API_KEY` is necessary but not sufficient, because without consent
  there are no BSSIDs to send. Requesting consent means a modal dialog per device for a capability only
  some installs can use — a product decision, recorded as such.
- **AGENTS.md carries the result**, so the BSSID question is now closed on measurements from three
  contexts rather than two.

### Fog remaining

- **`RequestAccessAsync` itself is untested, deliberately**: it raises a modal prompt on the console
  desktop and blocks until a human answers. It needs a person at the machine — which is the very
  precondition it establishes. Anyone testing it must plan for a human, not a timeout.
- **Whether "Newark User" was actually present at that console is unknown.** The session was Active and
  the child was interactive, so the measurement stands, but nobody confirmed a human was watching.
- **The product has not decided** whether to request consent at install time. That is now an explicit
  open question rather than an implied one.
- Unchanged: D-120, D-129/D-130/D-134, D-210, 12 stale `audit_test_teeth` rows, offline key custody,
  HP UEFI password, the `installer.py`/`installer_gui.py` config duplication.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- **Consent needs a human at the console**, and this repo has no mechanism to ask for it — that is the
  product decision named above, not a technical blocker.

### Session artifacts

- `docs/artifacts/s316-in-session-helper-probe.txt` — the launcher mechanism, both children's results,
  the per-app-consent conclusion, what remains untested, and three method traps.
- `docs/adr/ADR-009-location-precision-by-install-type.md` — (c1) measured, §Consequences sharpened.

### Failure attribution

- **Layer 4 (verification feedback), and it nearly produced a wrong answer.** My first child was
  `System32\...\powershell.exe`, which Microsoft's own rule disqualifies from the consent prompt. Had I
  stopped there I would have written "in-session helpers are denied" for the wrong reason — the session
  would have been blamed instead of per-app consent. Re-running from `C:\Python314\python.exe` is what
  turned a confounded result into a conclusion.
- **Layer 3 (execution environment)**: two silent failures cost a cycle each — a `binPath` containing
  `>` is rejected before the process starts, and a child script in `C:\Users\labadmin` is unreadable to
  the console user ("Newark User"), which produced no report at all rather than an error.

### VERIFY

- Launcher (SYSTEM, session 0): `launched session 1 pid=20760 (waited)`, later `pid=16888`, `pid=21172`.
- Child #1 (`System32\WindowsPowerShell\v1.0\powershell.exe`): `caller: MOLE\Newark User`,
  `session: 1`, `interactive: True`, `WlanOpenHandle rc=0 | WlanEnumInterfaces rc=0 interfaces=1 |
  WlanGetNetworkBssList rc=5`.
- Child #2 (`C:\Python314\python.exe`, ctypes, outside System32): `exe path: C:\Python314\python.exe`,
  `is 32-bit: False`, `WlanOpenHandle rc=0`, `WlanEnumInterfaces rc=0`, `interfaces=1`,
  `WlanGetNetworkBssList rc=5`.
- Cleanup: temporary service `PblSession1Probe` deleted; probe scripts left in `C:\Users\Public` and
  `C:\Users\labadmin` as evidence.
- `python3 scripts/brain.py check` → 184 beliefs, integrity clean (B-184 asserted at hardware level).

### Next session opening

Decide the product question the measurements created: does the installer request precise-location
consent (`RequestAccessAsync`) at first run so an interactive install can actually triangulate, or does
the documentation state that no install type is precise without a manual consent step? Either answer is
one ADR line; guessing is what ADR-009 now forbids.

---

---

## Session 317 — 2026-11-19 (ruling A: document the truth, and the guard that already existed was never installed)

### RULE-ZERO — understanding logged before each change

- **Read**: `docs/adr/ADR-009` (as S316 left it) and the user-facing claims it constrains —
  `README.md` §Location Reporting, `docs/PRIVACY_POLICY.md` §1.2, `serverless/README.md` — to find every
  place the product still implied an interactive install gets wifi fixes.
- **Read**: MOLE's consent store —
  `HKLM\…\CapabilityAccessManager\ConsentStore\location` and its `NonPackaged` subtree — which returns
  **no subkeys at all**: no desktop app on the machine holds a location-consent record. That is the
  state every probe in S315/S316 was denied under.
- **Ran** a `source_check` for "consent is keyed per executable path": result **missing-evidence**
  (confidence 0.20, no passages retrieved). Recorded as unverified rather than asserted, because it
  decides whether asking consent from the installer would help the agent.
- **Read**: `scripts/pre-push-check.sh` and its usage — `--install` writes `.git/hooks/pre-push`, and
  `ls .git/hooks` showed **no pre-push hook was installed**.

**Findings**: two things were true at once — the docs over-claimed what an interactive install can do,
and the mechanical guard for "checks that do not block" (B-182) already existed but had never been
switched on in this clone.

### Fog cleared

- **Ruling A is recorded**: the product does **not** request precise-location consent. ADR-009 gains a
  "Decision on consent" section with the reasoning and the two rejected options — (B) asking from the
  agent (real scope, needs a human click, value depends on unverified keying) and (C) asking from the
  installer (a different binary from the scanner, so under the likely per-executable keying it would
  grant consent to itself and leave the agent denied — worse than not asking, because it looks like a
  capability).
- **The README's over-claim is gone**: the table now says what was measured — city-level for every
  install type, with `wifi` only when consent has *already* been granted to the agent's own executable,
  and a row naming the case this installer actually produces. `GOOGLE_API_KEY` is described as
  necessary but not sufficient, because without consent there are no BSSIDs to send.
- **`docs/PRIVACY_POLICY.md` §1.2 now matches reality**: no access points are collected in practice,
  because the application does not request the consent that scanning requires; location derives from
  the IP address.
- **`serverless/README.md`** no longer implies the key changes anything on its own.
- **The missing guard is installed**: `scripts/pre-push-check.sh --install` → `.git/hooks/pre-push`
  (497 B, executable), which runs the publish-range secret scan and the fast-forward check on every
  push. It is **per clone** — a hook lives in `.git/` and is never committed — which is precisely how
  S314's `;`-chained push got through. AGENTS.md now says to install it once per clone.
- **A render defect I introduced was caught and fixed**: the first version of the new README row wrapped
  across two lines, which ends the row in markdown and turns the continuation into a stray paragraph.
  Every row now carries 4 pipes (3 columns).

### Fog remaining

- **Whether consent is keyed per executable is still unverified.** The `source_check` returned
  missing-evidence and MOLE has no records to inspect. It is recorded as unverified in the ADR, not
  resolved by argument — and it is the one fact that would make option (C) evaluable.
- **`RequestAccessAsync` remains untested** (a modal prompt needs a person at the console).
- **The hook is per-clone state, not repository state.** A fresh clone still has no pre-push hook; CI
  covers the published range, but a developer's local push is only gated if they ran `--install`.
- Unchanged: D-120, D-129/D-130/D-134, D-210, 12 stale `audit_test_teeth` rows, offline key custody,
  HP UEFI password, the `installer.py`/`installer_gui.py` config duplication.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- **Consent keying needs a human click** to observe; nothing on this host can settle it.

### Session artifacts

- `docs/adr/ADR-009-location-precision-by-install-type.md` — the consent decision and the rejected
  options.
- `README.md`, `docs/PRIVACY_POLICY.md`, `serverless/README.md`, `AGENTS.md` — claims aligned to the
  measurements.
- `.git/hooks/pre-push` — installed from `scripts/pre-push-check.sh` (per-clone, not committed).

### Failure attribution

- **Layer 2 (context provision), and it was mine.** S308 wrote "interactive + `GOOGLE_API_KEY` → `wifi`,
  tens of metres" into the README before anything had measured consent. That is the exact over-claim
  this repo keeps finding in documentation, authored this time by the session that was documenting
  honesty. The guard is now the measured table plus the artifact citations.
- **Layer 4 (verification feedback)**: `source_check` returned missing-evidence, and the temptation was
  to write the plausible sentence about per-executable keying anyway. It is recorded as unverified
  instead, with the specific consequence ("this decides whether option C helps the agent").
- **Layer 5 (state management)**: the pre-push guard existed since S140 and was never installed on this
  clone, so three separate "check that does not block" incidents had no mechanical backstop. Fixed for
  this clone, documented for the next.

### VERIFY

- MOLE consent store: `Get-ChildItem …\ConsentStore\location` → **no subkeys**; `NonPackaged` has none.
- `scripts/pre-push-check.sh` → `[OK] no credential-shaped content in origin/master..HEAD`.
- `scripts/pre-push-check.sh --install` → `[OK] installed .git/hooks/pre-push`; `ls -la` → 497 B,
  executable; the wrapper passes `--base <upstream>` and deliberately does not forward git's own
  positional args (a previous form blocked every tag push).
- README table: every row reports **4 pipes** (3 columns) — no wrapped rows.
- `scripts/check-ruling.sh` → `[OK] No open ruling items — task mode`; the answered section was deleted
  from `PENDING-RULING.md` (494 lines, decision lives in ADR-009).
- `python3 scripts/brain.py check` → integrity clean.

### Next session opening

Ask a person at MOLE's console to approve the location prompt once for the installer binary and once for
`lockdown-agent.exe` — that settles per-executable keying, the only fact ADR-009 still marks unverified;
if nobody is available, take D-210 (PBL route integration) from the ledger instead.

---

---

## Session 318 — 2026-11-19 (installing the guard found the hole inside the guard)

### RULE-ZERO — understanding logged before each change

- **Read**: `.git/hooks/pre-push` (the wrapper S317 installed) and `scripts/prepush_secrets.py` — the
  wrapper passes `--base <upstream>`, and the CLI turns `--base` into `<base>..<head>` without checking
  the base exists.
- **Read**: `.github/workflows/lint.yml`'s own handling of the same problem — it falls back to the full
  history when the base is unreachable ("No usable base commit — scanning the full history"), which is
  the behaviour the CLI lacked.
- **Read**: `scripts/test_prepush_secrets.py` — a hand-rolled `check()` suite with a `make_repo` helper
  and a `scan()` subprocess wrapper, which is where the regression belongs.

**Findings**: the guard S317 installed had a silent no-op for the exact push it exists to protect — a
first push, where the upstream ref does not exist yet.

### Fog cleared

- **The hole is real and was observed, not theorised**: on a scratch repo whose first push created
  `origin/master`, the hook's range was empty, so the scanner printed `[OK] no credential-shaped
  content` while a credential-shaped commit went to the remote.
- **Fixed** (`a069eb6`): the CLI now resolves the base with `git rev-parse --verify`; if it does not
  resolve it warns on stderr and scans `--all`, matching CI instead of being weaker than it.
- **Pinned by a test**: `test_an_unresolvable_base_scans_everything_instead_of_nothing` — a repo with no
  remotes and a planted AWS-shaped key now exits 1 with the finding named; before the fix it exited 0.
  The whole `test_prepush_secrets.py` suite passes.
- **The guard now runs visibly**: the push of `a069eb6` printed `publish range: origin/master..HEAD`,
  `fast-forward (1 commit(s) to publish)`, `no credential-shaped content` — the hook doing its job inside
  a real push rather than in theory.

### Fog remaining

- **The hook is per-clone state.** It lives in `.git/hooks/`, is never committed, and a fresh clone has
  none until someone runs `scripts/pre-push-check.sh --install`. AGENTS.md now says so, but nothing
  enforces it.
- **The "empty input ⇒ pass" pattern deserves a sweep of its own.** This session found it inside a
  scanner; the repo has other gates where zero items scanned could look like success — the script test
  suites are the known example (AGENTS.md records a suite that imported its tests, ran none, and exited
  0 for months).
- Unchanged: D-120, D-129/D-130/D-134, D-210, 12 stale `audit_test_teeth` rows, offline key custody,
  HP UEFI password, per-executable consent keying (unverified), `RequestAccessAsync` (untested).

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- None.

### Session artifacts

- `scripts/prepush_secrets.py` (base resolution), `scripts/test_prepush_secrets.py` (new case) — `a069eb6`.

### Failure attribution

- **Layer 4 (verification feedback), twice in one session.** First: the guard I installed in S317 passed
  on a repo with an empty range — a check whose scope was zero. Second: my own attempt to verify the fix
  was invalid, because the scratch repo had already been pushed so the base resolved and the empty range
  was legitimate; caught by reading the output rather than the exit code, and redone against a repo with
  no remote at all.
- **Layer 5 (state management)**: the hook is per-clone and therefore not part of the repository's
  state — a property worth remembering whenever a guard is described as "installed".

### VERIFY

- Before: `python3 scripts/prepush_secrets.py --base origin/master --head HEAD` in a repo with no
  remotes and a planted key → exit **0**, no finding (the defect).
- After: same command → `[WARN] base 'origin/master' does not resolve — scanning the full history
  instead of an empty range`, **1 finding**, exit **1**.
- `python3 scripts/test_prepush_secrets.py` → all checks passed, including the new case.
- `git push` of `a069eb6` → hook output present: `publish range: origin/master..HEAD`,
  `fast-forward (1 commit(s) to publish)`, `no credential-shaped content in origin/master..HEAD`.

### Next session opening

Sweep the repo's own gates for the same shape this session found — a check whose input is empty and
therefore passes — starting with the `scripts/test_*.py` suites (assert a non-zero count of executed
checks per file) and `check-artifacts`, since AGENTS.md already records one suite that ran zero tests
and exited 0 for months.

---

---

## Session 319 — 2026-11-19 (sweeping the "empty input ⇒ pass" class through the script suites)

### RULE-ZERO — understanding logged before each change

- **Read**: `scripts/script_test_runner.py` — the shared runner, and why it exists (two suites lost real
  coverage to a missing `__main__`).
- **Read**: the `__main__` block of every `scripts/test_*.py` suite, and classified each by runner type:
  **12** go through `script_test_runner` (pytest), **1** calls `pytest.main` directly, **2** are
  hand-rolled runners.
- **Read**: `scripts/test_check_firmware_todos.py::test_every_script_test_suite_has_a_runner` — the
  existing meta-test, which enforces the runner but not what the runner reports.

**Findings**: pytest protects its suites for free — zero collected tests is exit **5**, not 0 — so the
hole was narrower than "all suites". Exactly two hand-rolled runners exit on `if FAILED` alone, so a
discovery bug that finds nothing prints `0 failed` and exits 0: the same shape S318 found in the secret
scanner, in the place AGENTS.md already records two historical occurrences.

### Fog cleared

- **Both hand-rolled suites now refuse to report success on zero discovery** (`2dcd211`):
  `test_graph_session.py` and `test_prepush_secrets.py` print
  `NO TESTS DISCOVERED — discovery is broken; refusing to report success` and exit 1.
- **Proven by breaking discovery on purpose**: each suite was copied with `def test_` renamed to
  `def _disabled_`; both copies exit **1** with that message, and both originals still report normally
  (40 passed / all checks passed).
- **The rule is enforced, not remembered**: `test_every_hand_rolled_suite_refuses_a_zero_discovery_run`
  enumerates every suite that uses neither the shared runner nor `pytest.main` and asserts each carries
  the guard — so a future hand-rolled suite cannot land without it. 31 firmware-TODO tests pass (30 before).
- **Classification first, patch second**: twelve suites needed nothing because pytest's `NO_TESTS_COLLECTED`
  already covers them. That is the difference between a sweep and a rewrite.

### Fog remaining

- **`check-artifacts` and `verify-env` were not swept for the same shape** — this session stopped at the
  script suites, which is where the documented precedent was. Both report counts ("all artifacts
  present", "56 PASS / 0 FAIL / 5 SKIP") without asserting the count is non-zero.
- **The ast-grep runner reported a blocking finding for `test_graph_session.py` while its output was
  deferred**, and the LSP probe reported the same file clean. Unresolved, but no finding was ever shown,
  so nothing can be fixed on that basis — recorded rather than chased.
- Unchanged: D-120, D-129/D-130/D-134, D-210, 12 stale `audit_test_teeth` rows, offline key custody,
  HP UEFI password, per-executable consent keying (unverified), `RequestAccessAsync` (untested), the
  pre-push hook being per-clone state.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- None.

### Session artifacts

- `scripts/test_graph_session.py`, `scripts/test_prepush_secrets.py` (guards),
  `scripts/test_check_firmware_todos.py` (the rule) — `2dcd211`.

### Failure attribution

- **Layer 4 (verification feedback), in its purest form**: a suite whose only exit condition is "no
  failures" cannot distinguish "everything passed" from "nothing ran". The fix is the same sentence as
  S318's — a check must assert what it examined, not only what it found — and it now has a meta-test so
  the assertion is not a convention.
- **A near-miss worth naming**: I first assumed the whole suite set was affected. Classifying by runner
  type first turned a twelve-file rewrite into a two-file fix.

### VERIFY

- `python3 scripts/test_graph_session.py` → `40 passed, 0 failed`.
- `python3 scripts/test_prepush_secrets.py` → `all checks passed`.
- Copies with `def test_` renamed → both exit **1** and print the guard message (the proof the guard
  works, not merely that it exists).
- `agent/.venv/bin/python scripts/test_check_firmware_todos.py` → **31 passed** (30 before the rule).
- Push of `2dcd211` → pre-push hook ran: `publish range: origin/master..HEAD`, `fast-forward`,
  `no credential-shaped content`.
- `python3 scripts/brain.py check` → 185 beliefs, integrity clean (B-185).

### Next session opening

Finish the sweep in the two gates it did not reach: `scripts/check-artifacts.py --verify` and
`scripts/verify-environment.sh` both print counts without asserting the count is non-zero, so an empty
artifact manifest or a zero-check run would read as PASS.

---

---

## Session 320 — 2026-11-19 (the last two gates that answered "pass" to empty input)

### RULE-ZERO — understanding logged before each change

- **Read**: `scripts/check-artifacts.sh` — `EXPECTED_DIRS` / `EXPECTED_FILES` are hardcoded arrays, and
  `verify()` loops over them; `EXIT_CODE` starts at 0 and is only raised by a missing or empty file.
- **Read**: `scripts/verify-environment.sh` — `print_summary` exits 0 whenever `FAIL` is 0, and the
  success line is literally "All checks passed (or skipped due to missing tools)".
- **Read**: the two failure modes already fixed in this class — S318's unresolvable scan base and
  S319's zero-discovery suites — so the new guards use the same words and the same shape.

**Findings**: both gates depend on their own scope being non-empty and neither asserts it. One needs a
deliberate edit to reach zero (emptying the arrays); the other reaches it naturally, whenever every tool
is missing on a host — an all-SKIP run currently reads as a pass.

### Fog cleared

- **`check-artifacts.sh` refuses an empty expectation list** (`5493d44`): both `verify()` and
  `check_structure()` exit **3** with "No artifacts are declared to verify — refusing to report
  success." Proven by running a copy with the three dirs and four files removed from the arrays.
- **`verify-environment.sh` refuses an all-SKIP run**: `print_summary` now fails when `PASS` is 0, with
  "No check ran successfully (N skipped)". Proven by a copy whose `pass()` recounts everything as SKIP —
  it printed `PASS: 0 FAIL: 0 SKIP: 61` and exited **1**.
- **All four guards are pinned in one place**: `scripts/test_gate_guards.py` (4 cases) covers S318's
  unresolvable base, S319's zero-discovery suites, and this session's two gates. Each test is labelled
  **BEHAVIOURAL** (it re-runs a scope-emptied copy of the real script) or **SOURCE** (a grep, used only
  where running the real thing costs minutes) so a weak assertion cannot masquerade as a strong one.
- **`make test-scripts` is green apart from the known docker red**: every suite passes including the new
  4 cases; `test_tls_floor.py` still fails for the missing docker socket.

### Fog remaining

- **The all-SKIP case for `verify-environment.sh` is behaviourally proven once, by hand, and guarded
  from then on by grep.** Re-proving it automatically would mean running the whole toolchain twice in CI.
- **Other gates were not swept**: `make graph-check` (invariants over an empty spec would pass),
  `scripts/graph_session.py`'s generators, and the dashboard/serverless coverage floors are unexamined
  for the same shape. The class is now visible; the sweep is not exhaustive.
- Unchanged: D-120, D-129/D-130/D-134, D-210, 12 stale `audit_test_teeth` rows, offline key custody,
  HP UEFI password, per-executable consent keying (unverified), `RequestAccessAsync` (untested), the
  pre-push hook being per-clone state, and the documented docker-socket red.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- None.

### Session artifacts

- `scripts/check-artifacts.sh`, `scripts/verify-environment.sh` (guards) and
  `scripts/test_gate_guards.py` (pins) — `5493d44`.

### Failure attribution

- **Layer 4 (verification feedback), three sessions running.** S318: a scanner whose empty range was a
  pass. S319: two suites whose "0 failed" was a pass. S320: two gates whose empty scope was a pass. The
  common defect is that each reported on *what it found* and never on *what it examined*; every fix in
  this arc is the same sentence, applied at a different layer.
- **A weakness I am not hiding**: one of the two new tests is a grep rather than an execution, because
  `verify-environment.sh` costs minutes. It is labelled SOURCE in its docstring with the manual proof
  recorded, so nobody mistakes it for behaviour.

### VERIFY

- Empty expectation lists → `bash <emptied-copy> --verify` → exit **3**, "No artifacts are declared to
  verify — refusing to report success."
- All checks recounted as SKIP → `PASS: 0  FAIL: 0  SKIP: 61` then "No check ran successfully (61
  skipped)", exit **1**.
- `agent/.venv/bin/python scripts/test_gate_guards.py` → **4 passed**.
- `make test-scripts` → every suite passes (graph 40, memory 45, prepush all checks, sast 24, sign 18,
  hw-preflight 21, generic-installer 18, gate-guards 4); the only failure is `test_tls_floor.py`.
- LSP on the new suite → 0 diagnostics.
- Push of `5493d44` → pre-push hook ran and passed.

### Next session opening

Continue the sweep into `make graph-check` — `graph_assert.py` validates invariants over whatever the
spec declares, and an empty `nodes` list would satisfy every invariant vacuously; assert a non-zero node
count and a non-zero count of checked invariants before it can report "All invariants pass".

---

---

## Session 321 — 2026-11-19 (graph-check could pass by examining nothing)

### RULE-ZERO — understanding logged before each change

- **Read**: `.devin/graph/graph_assert.py:806-895` — `assert_all_invariants()` loops over
  `get_phase_nodes(graph)` and `get_debt_items(graph)`, and I3-I7 each run only if the file they read
  exists. Nothing asserts that any list is non-empty.
- **Read**: `Makefile:426` — `graph-check` is just `python3 .devin/graph/graph_assert.py`, the gate the
  whole session lifecycle hangs off.
- **Read**: `agent/tests/test_graph_assertions.py` — the established home for invariant tests, which
  imports the module through a `sys.path.insert` of `.devin/graph`.
- **Read**: the three prior fixes in this class (S318 empty scan range, S319 zero discovered tests,
  S320 empty gate scope) so the wording and the shape match.

**Findings**: an empty spec satisfies all seven invariants by examining nothing — I1 and I2 iterate over
empty lists, and I3-I7 are file-conditional. The quietest instance of the defect in the whole arc,
because this is the gate every session close depends on.

### Fog cleared

- **The counts are asserted before any invariant runs** (`183c2b1`), and the loops reuse those counted
  lists so a future invariant cannot forget to look. Three messages, one per node family: phase nodes
  (I1), debt items (I2), enforcement paths (I3).
- **Verified in both directions, which is the only way this guard is worth anything**:
  `assert_all_invariants({"nodes": [], "enforcement_paths": []})` now returns exactly **3 vacuity
  violations** instead of a pass, while the real spec still reports `✓ All invariants pass` (17 phases,
  64 debt items, 13 enforcement paths).
- **Pinned by two tests, not one**: `agent/tests/test_graph_assertions.py` gains a case asserting the
  three messages on an empty graph **and** a case asserting the guard does *not* fire on the
  repository's own spec — a guard that fires on everything is as useless as one that fires on nothing.
  50 tests pass (48 before).
- **AGENTS.md records it** beside the existing sentence about invariant coverage, so the next session
  reads a rule rather than discovering the hole.

### Fog remaining

- **Vacuity was not swept exhaustively.** `scripts/graph_session.py`'s generators, the dashboard and
  worker coverage floors, and `make load-smoke` were not examined for the same shape. The class is now
  visible and has a vocabulary; the sweep is three files deep, not repo-deep.
- **The ast-grep runner reported "blocking findings" three times this session with nothing attributable**
  (an `MD024 ×45` on a file with five unique headings; a finding on `test_graph_session.py`; four on this
  session's test file) while the LSP probe called those same files clean. A count without a finding is
  not evidence, and it is recorded here as a tooling observation rather than a dismissal.
- **Pyright cannot resolve `graph_assert`** in `agent/tests/test_graph_assertions.py` (two
  `reportMissingImports`, both predating this session's edit) because the module is reached through a
  runtime `sys.path.insert`. The runtime resolves it — 50 tests pass — and this is the documented
  advisory class, so it was not "fixed" by adding a pragma to code I did not otherwise change.
- Unchanged: D-120, D-129/D-130/D-134, D-210, 12 stale `audit_test_teeth` rows, offline key custody,
  HP UEFI password, per-executable consent keying (unverified), `RequestAccessAsync` (untested), the
  pre-push hook being per-clone state, the docker-socket red for `test_tls_floor.py`.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- None.

### Session artifacts

- `.devin/graph/graph_assert.py` (the guard), `agent/tests/test_graph_assertions.py` (both directions),
  `AGENTS.md` (the rule) — `183c2b1`.

### Failure attribution

- **Layer 4 (verification feedback), fourth session in this arc.** S318 empty scan range → S319 zero
  discovered tests → S320 empty gate scope → S321 empty graph. Every one reported on *what it found*
  and never on *what it examined*, and every fix is the same sentence at a different layer. The reusable
  part is not the four patches; it is the habit of asking "what did this examine?" before believing a
  pass — which is now recorded in AGENTS.md for the two gates most likely to recur.

### VERIFY

- `python3 .devin/graph/graph_assert.py` → `✓ All invariants pass` (real spec).
- `assert_all_invariants({"nodes": [], "enforcement_paths": []})` → **3** violations, all naming
  vacuity ("…satisfied vacuously — an empty graph is not a passing graph", "…examines nothing").
- `agent/.venv/bin/python -m pytest agent/tests/test_graph_assertions.py -q` → **50 passed** (48 before).
- `make graph-check` → all invariants pass; `make gen-state` unaffected.
- `git push` of `183c2b1` → pre-push hook ran and passed.

### Next session opening

Clear the 12 stale `audit_test_teeth` rows that `current-state.md` has carried since S303 — they need no
hardware and no operator credential, and they have now been listed as "unchanged" in eleven consecutive
session blocks.

---

---

## Session 322 — 2026-11-19 (the mutation audit counted table rows as kills)

### RULE-ZERO — understanding logged before each change

- **Read**: `scripts/audit_test_teeth.py`'s docstring — KILLED/SURVIVED/SKIPPED, and the promise that a
  row answers "would this suite notice a regression?".
- **Read**: `main()` — skipped rows `continue` without being collected, and the closing line prints
  `len(table)` as "killed".
- **Read**: `.devin/graph/trace.md:1300-1312` — the twelve rows named there as stale, last triaged at
  S182 and carried as "unchanged" through eleven session blocks.
- **Read**: `serverless/worker.ts` and `serverless/agent-routes.ts` — the ACK path moved in S280, and
  `artifact_json` is now `_artifact_json`, which is why twelve anchors matched nothing.

**Findings**: this is the fifth instance of the arc's one defect — a check reporting on what it found
and never on what it examined — but here it was worse than vacuous: the arithmetic was wrong. Twelve
rows had not run for over a hundred sessions while the summary claimed every audited suite has teeth.

### Fog cleared

- **The accounting is fixed** (`14b5c26`): skipped rows print `UNVERIFIED`, are collected, are listed
  with the behaviour they stand for, and make the audit **exit 1**. The closing line counts kills, not
  table rows.
- **All twelve rows are re-anchored to current code** and the audit is back to a real 55/55:
  `all 55 mutations killed — every audited suite has teeth`, exit 0, 0 unverified, 0 survived.
- **Two re-anchors were findings, not chores**: `uninstall-authz`'s anchor matched **twice** (both
  uninstall handlers) so it could never have been a single mutation — it now includes the function
  signature; and my first `recover-unlock` mutation ("never mark the key released") **SURVIVED**, which
  means the suite does not assert that, so it now mutates the escrowed key itself and is killed by
  "releases encryption key for unlock commands".
- **AGENTS.md records the semantics**: a row that cannot run is `UNVERIFIED` and fails the audit.

### Fog remaining

- **The audit is not in any gate.** `make full-verify` does not run it (it takes minutes and mutates
  source in a `finally`-restored way), so nothing prevents the same drift from accumulating again. A
  periodic or pre-release run is the obvious answer and is not wired up.
- **`recover-unlock`'s first mutation surviving is itself information**: the suite does not assert that
  a released key is recorded as released. Not a mutation to add — a test gap to consider, left recorded.
- Unchanged: D-120, D-129/D-130/D-134, D-210, offline key custody, HP UEFI password, per-executable
  consent keying (unverified), `RequestAccessAsync` (untested), the pre-push hook being per-clone state,
  the docker-socket red for `test_tls_floor.py`.
- **Removed from this list** after eleven sessions: "12 stale `audit_test_teeth` rows".

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- None.

### Session artifacts

- `scripts/audit_test_teeth.py` (accounting + 12 re-anchors), `AGENTS.md` (the rule) — `14b5c26`.

### Failure attribution

- **Layer 4 (verification feedback), fifth in the arc and the most misleading yet.** The gap was not
  merely unexamined — it was double-counted in the summary's own arithmetic, so the report was not just
  silent about twelve behaviours, it asserted a number that could not have been true. The fix is the
  same sentence again ("report what you examined"), and this time the audit now does it for itself.
- **Layer 2 (context provision)**: nothing tied the mutation rows to the file moves they depend on, so a
  refactor could silently orphan anchors. The re-anchor table names the move in a comment, which is
  the closest thing to a durable link this file can carry.

### VERIFY

- Before: `all 55 mutations killed`, exit **0**, with 12 rows `SKIPPED`.
- After the accounting fix: `43 of 55 mutations killed; 12 unverified`, exit **1**.
- After the re-anchors: `all 55 mutations killed — every audited suite has teeth`, exit **0**,
  `UNVERIFIED —` count **0**, `SURVIVED` count **0**.
- Two intermediate single-row runs proved the difficult cases: `worker/uninstall-authz` KILLED by
  "rejects a request with no credentials"; `worker/recover-unlock` KILLED by "releases encryption key for
  unlock commands".
- `git push` of `14b5c26` → pre-push hook ran and passed.

### Next session opening

Wire `scripts/audit_test_teeth.py` into a gate — a `make audit-teeth` target plus a weekly CI job — so
the anchors cannot drift for a hundred sessions again, and so the SURVIVED/SURVIVED-none distinction is
checked by something other than a session that happens to open the file.

---

---

## Session 323 — 2026-11-19 (the audit gets a gate, and the gate takes five runs to trust)

### RULE-ZERO — understanding logged before each change

- **Read**: `scripts/audit_test_teeth.py` `run_suite()` — how each of the three runners is invoked, and
  what each returns; `main()`'s baseline loop, which aborts when a baseline cannot be judged.
- **Read**: `.github/workflows/ci.yml` and `windows-artifacts.yml` — pinned action SHAs, cache blocks and
  the dependency-install steps to reuse, so the new job matches the repo's CI conventions rather than
  inventing them.
- **Read**: `serverless/vitest.config.mts` — no `passWithNoTests`, so a zero-test run cannot masquerade
  as success there; and `Makefile:426` for where a target belongs.

**Findings**: the audit needs all three runners (vitest 39 rows, pytest 13, jest 3), so a gate for it must
install three dependency sets. Nothing was running it, which is how 12 anchors stayed orphaned for a
hundred sessions.

### Fog cleared

- **The audit has a gate** (`dd24599`): `make audit-teeth`, plus `.github/workflows/audit-teeth.yml` —
  Mondays 06:00 UTC and manual dispatch, installing serverless + server + agent dependencies, and a
  final step that fails if any **tracked** file still differs afterwards (a mutation left applied is the
  worst outcome a safety mechanism can have). Validated with the repo's own bar: `make lint-workflows`
  exit 0, YAML parses, `make audit-teeth` 55/55 locally.
- **CI is green on the gate** (`697ea9b` → `f89d0e9` → …): run 44537671873 reports
  `all 55 mutations killed — every audited suite has teeth` and the restore check passes.
- **Two real defects in the audit's own runner were found by running it in CI**, and both were needed:
  - **piped capture truncated the suite**: `capture_output=True` produced 72 lines with **no tally**
    where a shell redirect produced 107 lines including `Test Files 4 passed`. Output now goes to a
    temp file (`_run_captured`).
  - **ANSI escapes made the tally unparseable**: vitest writes
    `\x1b[2m      Tests \x1b[22m … 495 passed`, so `strip().startswith("Tests")` was false. Verified on
    those exact bytes (`False` before `_strip_ansi`, `True` after).
- **Its diagnostics were made honest on the way**: an INVALID verdict now carries the exit code, dumps
  the run's head and tail, and never quotes a single line as if it were a verdict. That change is what
  turned a 10-minute guessing loop into a readable diagnosis.

### Fog remaining

- **The scheduled path is unexercised.** Every run so far was `workflow_dispatch`; the Monday `cron:`
  entry has never fired. Worth one glance after the first scheduled run rather than assuming.
- **The diagnostic step should now be retired.** `Diagnostic — the exact vitest command the audit runs`
  served its purpose (it produced the pipe/file evidence) and costs ~3 minutes per run; it should go
  once the scheduled run is seen.
- **Five CI runs to reach green, and three of the four theories were mine to discard**: a broken commit
  (excluded — 495/495 locally and in `ci.yml`), a CI reporter change (excluded — `CI=true` locally
  green), and ANSI (true, but "disproved" by a test that piped vitest through `grep`, which disables
  colour and removed the evidence).
- Unchanged: D-120, D-129/D-130/D-134, D-210, offline key custody, HP UEFI password, per-executable
  consent keying (unverified), `RequestAccessAsync` (untested), the pre-push hook being per-clone state,
  the docker-socket red for `test_tls_floor.py`.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134, D-210.

### Blockers

- None.

### Session artifacts

- `.github/workflows/audit-teeth.yml`, `Makefile` (`audit-teeth`), `scripts/audit_test_teeth.py`
  (`_run_captured`, `_strip_ansi`, `_dump_invalid`, exit codes in verdicts) — through `f89d0e9`.
- CI evidence: run 44537671873, conclusion **success**.

### Failure attribution

- **Layer 4 (verification feedback), and the sharpest case in this arc because the bad check was mine.**
  I tested "does ANSI hide the tally?" with a command that disabled colour, then relied on the negative
  result for two further CI rounds. A verification whose apparatus changes the thing under test is worse
  than no verification — it produces confidence with the same shape as evidence. The fix is procedural:
  when a test says "not present", check that the test could have seen it present.
- **Layer 3 (execution environment)**: the pipe-versus-file difference is real and was invisible until
  the audit's own command was run two ways in the same job. That diagnostic step should exist from the
  start for any gate whose verdict depends on parsing another tool's human-readable output.

### VERIFY

- `make audit-teeth` → `all 55 mutations killed`, exit 0, 0 unverified, 0 survived.
- `make lint-workflows` → exit 0 (actionlint 1.7.12 + shellcheck); workflow YAML parses.
- CI run 44537671873 → **success**: `all 55 mutations killed — every audited suite has teeth`, then
  `no tracked file differs — every mutation was restored`.
- `_strip_ansi` on the exact CI byte sequence → `False` before, `True` after (the parse is proven on the
  bytes that failed, not on a paraphrase).
- `git push` of each commit → pre-push hook ran and passed.

### Next session opening

Retire the diagnostic step from `audit-teeth.yml` now that it has produced its evidence, and confirm the
first scheduled Monday run — then take D-210 (PBL route integration) from the ledger, which needs no
hardware and no operator credential.

---

---

## Session 324 — 2026-11-19 (D-210 is closed, and I had been saying it was open for twenty sessions)

### RULE-ZERO — understanding logged before each change

- **Read**: `docs/adr/PBL-DEBT-LEDGER.md:2034-2100` — the D-210 entry I was about to take as work:
  `**Status**: CLOSED (commit 9612fbb, artifact: 579 server tests + 305 serverless tests pass)`, with the
  full route inventory and its tests listed underneath.
- **Read**: `.devin/graph/orphaned-commit-refs.txt:29` — `9612fbb` **is** in the baseline of refs orphaned
  by S149's history rewrite, so the unresolvable hash is grandfathered, not a live I2 violation.
- **Read**: `.devin/graph/current-state.md`'s convergence table — `Debt items 60 / 64`, whose open four
  are D-120, D-129, D-130, D-134.
- **Read**: the ledger's own status lines — D-120 OPEN, D-129 OPEN, D-134 OPEN, D-210 CLOSED.

**Findings**: the next opening I had written into S323 ("take D-210") was wrong, and the error was mine
and old: every session block since S303 has listed `D-210 (PBL route integration)` under open debt. It
was closed long before that, with its commit grandfathered by the S149 rewrite. I repeated an inherited
line twenty times without once checking the ledger it came from — in a repo whose AGENTS.md warns in the
first screen that the debt ledger goes stale.

### Fog cleared

- **D-210 is CLOSED and always was**: 14 `/v1/*` routes, CORS, per-device and IP rate limiting, the
  Express equivalent with WAF guards, and 52 server-side PBL tests. Nothing to take.
- **The open set is measured, not copied**: D-120 (OPEN), D-129 (OPEN), D-134 (OPEN), and D-130 by the
  convergence table's count of 60/64 — **all four need hardware or an operator credential**, which is why
  they have stayed open through this arc.
- **The advisory situation is measured too**: 19 moderate, **0 high, 0 critical**, all in the jest/babel
  toolchain; `npm audit --audit-level=high` exits 0, so the CI gate is honestly green rather than being
  ignored. The "picomatch advisories" phrase carried in this record refers to part of that set.

### Fog remaining

- **The debt list in my session blocks was wrong for ~20 sessions.** Corrected here; the earlier blocks
  are history and stay as they are, but `current-state.md` now carries the measured set.
- **Nothing in the open four is actionable on this host**: D-120 needs real BitLocker media, D-129/D-134
  need firmware hardware time, D-130 needs the owner's signing PFX. Recording that is more useful than
  proposing work that cannot be done.
- **The weekly audit's `cron` path is still unexercised** (every run was dispatch), and its diagnostic
  step is retired as of this session.
- Unchanged: offline key custody, HP UEFI BIOS password, per-executable consent keying (unverified),
  `RequestAccessAsync` (untested), the pre-push hook being per-clone state, the docker-socket red for
  `test_tls_floor.py`.

### Debt items closed

None — D-210 was already closed before this session, which is the finding.

### Debt items still open

D-120 (BitLocker lock state on real media), D-129 (no real hardware validation for PBL), D-130 (no code
signing for PblApp.efi), D-134 (PBL TPM NV indices under the platform hierarchy).

### Blockers

- **All four open items are blocked on hardware or an operator credential**, not on code.

### Session artifacts

- No code change. The artifact is the correction itself: this block and the regenerated
  `current-state.md`, plus the retired diagnostic step committed at the start of the session.

### Failure attribution

- **Layer 5 (state management), and it is the clean case.** A stale line was copied forward from block to
  block, so twenty sessions inherited an open item that had been closed before the first of them. Nothing
  failed loudly because nothing checked: the block format asks for "debt items still open" and any string
  satisfies it. The harness change is the same one this arc keeps landing — a list that must be *derived*
  from the ledger rather than retyped: `graph_assert.py` already knows the count (60/64), so a future
  block could be checked against it.
- **Layer 4 (verification feedback)**: the next-opening sentence inherited the same error, so the session
  started work on an item that did not exist. Reading the ledger entry took one command.

### VERIFY

- `docs/adr/PBL-DEBT-LEDGER.md:2035` → `**Status**: CLOSED (commit 9612fbb, …)`.
- `git rev-parse --verify 9612fbb` → no such commit; `grep -n 9612fbb .devin/graph/orphaned-commit-refs.txt`
  → line **29**, i.e. grandfathered by the S149 rewrite baseline.
- Ledger status lines → D-120 OPEN · D-129 OPEN · D-134 OPEN · D-210 CLOSED; convergence table `60/64`.
- `cd server && npm audit --audit-level=high` → exit **0**; `npm audit --json` → 19 moderate, 0 high,
  0 critical, all in the jest/babel chain.
- `make lint-workflows` → exit 0 after retiring the diagnostic step; workflow YAML parses (8 steps).

### Next session opening

Clear the 19 moderate dev-dependency advisories by bumping the jest/babel chain, and prove it with
`cd server && npm test` (885 tests), `npm audit --audit-level=high` still exit 0, and the dashboard's
`audit-with-exceptions.sh` — a dependency change needs no hardware and no credential, which is the only
kind of work left in this repo's ledger.

---

---

## Session 325 — 2026-11-19 (19 advisories cleared by overrides, and CI caught the lint I skipped)

### RULE-ZERO — understanding logged before each change

- **Read**: `npm audit --json` and `npm audit fix --dry-run` — 19 moderate, 0 high, 0 critical, all through
  jest's reporting chain, and `fixAvailable` reporting
  `{isSemVerMajor: true, name: jest, version: 29.7.0}` for 18 of them.
- **Read**: `npm ls minimatch glob --all` and the two advisories' own data (GitHub Advisory API):
  glob vulnerable `>=9.0.0 <=14.0.1`, first patched **14.0.2**; minimatch vulnerable `>=7.0.0 <11.0.1`,
  first patched **11.0.1**. Installed: glob 13.0.6, minimatch 10.2.6.
- **Read**: `jest dist-tags` — latest 30.5.2, no newer major, so no upgrade path exists.
- **Read**: the consumers' declared ranges — `@jest/reporters` wants `glob ^13.0.6`, `test-exclude` wants
  `minimatch ^10.2.2` — to know exactly what an override would be forcing.

**Findings**: npm's only remedy was a semver-major *downgrade* of the test runner for two moderate
advisories in development tooling, while the actual CI gate (`--audit-level=high`) was already green.
The advisories were fixable in place with `overrides`, which is a smaller and more honest change — but
only the suites can say whether forcing those majors is safe.

### Fog cleared

- **The 19 moderate advisories are cleared** (`4fd8313`):
  `overrides: { glob: ^14.0.2, minimatch: ^11.0.1 }` → `npm audit --json` reports **0** (was 19),
  `--audit-level=high` exit 0, dashboard `audit-with-exceptions.sh` clean.
- **The trade was measured, not asserted**: `cd server && npm test` → **885 passed, 52 suites** with the
  forced majors in place, and `npm ci` from the committed lockfile installs 545 packages cleanly — which
  matters because CI uses `ci`, not `install`.
- **CI is green on the result** (`3f0c3b9`): `CI`, `Lint` and `CodeQL` all success; the agent suite also
  re-run locally through `scripts/run-agent-tests.sh` (exit 0).
- **Two defects CI caught were mine, from S321** (`3f0c3b9`): a **101-character docstring line** (`E501`)
  and `assert_all_invariants` imported **out of alphabetical order** (`I001`). I had run that file's
  pytest after writing it and never ran `scripts/lint-agent.sh` — the gate the repo provides for exactly
  this, and the one CI runs unconditionally.

### Fog remaining

- **The pipeline-masking mistake recurred for the third time**, and the pattern is now unmistakable:
  `;` before `git push` (S314), `grep` after a scan (S318), `tail` after a lint (this session). In each
  case the exit status read came from something other than the verification. Every instance was caught
  only because CI or a second look disagreed.
- **Pyright still cannot resolve `graph_assert`** at `agent/tests/test_graph_assertions.py:20,518`
  (`reportMissingImports`) — a module reached through a runtime `sys.path.insert`. Advisory by policy,
  resolved at runtime, and not "fixed" with pragmas on lines this session did not otherwise change.
- **The weekly audit's `cron` path is still unexercised** (all runs were dispatch); its diagnostic step is
  retired.
- Unchanged: offline key custody, HP UEFI BIOS password, per-executable consent keying (unverified),
  `RequestAccessAsync` (untested), the pre-push hook being per-clone state, the docker-socket red for
  `test_tls_floor.py`.

### Debt items closed

None. The four open items are unchanged and all blocked on hardware or an operator credential.

### Debt items still open

D-120 (BitLocker lock state on real media), D-129 (no real hardware validation for PBL), D-130 (no code
signing for PblApp.efi), D-134 (PBL TPM NV indices under the platform hierarchy).

### Blockers

- None for this session's work; the four open ledger items remain blocked on hardware or credentials.

### Session artifacts

- `server/package.json` + `server/package-lock.json` (overrides) — `4fd8313`.
- `agent/tests/test_graph_assertions.py` (E501 + I001) — `3f0c3b9`.
- CI evidence: run on `3f0c3b9` → CI success, Lint success, CodeQL success.

### Failure attribution

- **Layer 4 (verification feedback), twice over.** First, the two lint defects shipped because I ran the
  test file and not the lint gate: selecting a subset of the gates that apply to a change is a quiet way
  to be wrong, and CI is the backstop rather than the plan. Second, the exit-status masking — taking a
  pipeline's status instead of the command's — is the same defect the arc keeps finding in *code*
  (S318–S321), now in my own shell usage: a check whose outcome is read from the wrong place has not
  been read.
- **Layer 2 (context provision)**: nothing in the block format requires a lint run to be named, so
  "verified locally" can mean "ran one thing". CI's job list is the actual contract.

### VERIFY

- `npm audit --json` → `{info:0, low:0, moderate:0, high:0, critical:0, total:0}`; was 19 moderate.
- `npm audit --audit-level=high` → exit 0 · dashboard `audit-with-exceptions.sh` → no vulnerabilities.
- `cd server && npm test` → **885 passed, 52 suites**, exit 0.
- `npm ci` in a clean temp dir from the committed lockfile → 545 packages, exit 0.
- `scripts/lint-agent.sh` → **exit 0**, "All checks passed!", 67 files already formatted.
- `scripts/run-agent-tests.sh -q` → exit 0.
- CI on `3f0c3b9` → **CI success · Lint success · CodeQL success**.

### Next session opening

Make the session block's open-debt list derived rather than retyped: `graph_assert.py` already computes
`60/64` and the ledger knows each status, so a check that the block's list matches the ledger would have
caught D-210 being called open for twenty sessions — the same class as S318–S321, in the process instead
of the code.

---

---

## Session 326 — 2026-11-19 (the open-debt list is now derived from the ledgers, not retyped)

### RULE-ZERO — understanding logged before each change

- **Read**: `docs/adr/PBL-DEBT-LEDGER.md` — the heading/status shape (`### D-nnn — title` followed by
  `- **Status**: OPEN|CLOSED`), and that D-130 carries a later dated `**Update (...)**` line, so the
  *first* status line has to decide.
- **Read**: `.devin/graph/graph_assert.py:453` (`assert_session_end_quality`) — how an existing invariant
  slices the newest session block, so the new parser follows the same approach rather than inventing one.
- **Read**: the block format in AGENTS.md — the six required sections, of which "Debt items still open"
  was the one with no machine check behind it.
- **Read**: S324's own finding (D-210 listed open for twenty sessions) so the invariant's failure message
  could cite the case that motivated it.

**Findings**: the ledger is the source of truth for debt status, and the block is a *restatement* of it.
A restatement can drift silently, and this one had — twenty times — because the format accepts any string.

### Fog cleared

- **`assert_open_debt_list_matches_ledger()` is in the invariant sweep** (`8824de4`): it parses both
  ledgers, parses the newest block's list, and fails on the symmetric difference, naming both directions
  (`listed but CLOSED` / `OPEN but unlisted`). Wired into `assert_all_invariants`, so `make graph-check`
  fails rather than printing a clean sweep.
- **Verified in both directions, on the real artefact and on the historical failure**:
  the repository's graph passes (S325's block lists exactly D-120/D-129/D-130/D-134); a synthetic block
  listing **D-210** against a ledger that has it CLOSED raises `GraphViolationError` naming D-210 — the
  precise text every block since S303 carried.
- **Two tests added** (52 in the file, was 50), and the agent lint gate was run **before** the commit:
  `lint-agent.sh` exit 0, check + format clean.
- **CI is green** on `8824de4`: `CI`, `Lint`, `CodeQL` all success.

### Fog remaining

- **Only the newest block is checked.** Older trace history still contains the wrong D-210 line, which is
  correct: it is a record of what those sessions believed, not a claim to repair.
- **The ledger's own heading for D-210 still reads "not implemented"** while its status is CLOSED. That
  is cosmetic and historical, but it is the kind of thing a reader trusts over a status line — noted, not
  changed, because rewriting a closed item's title is not this session's to do.
- **The invariant checks a list of ids, not prose.** A block could still write "D-120 (BitLocker) is
  effectively done" beside the id and the check would pass; status semantics remain a human read.
- **The weekly audit's `cron` path is still unexercised** (all runs were dispatch).
- Unchanged: offline key custody, HP UEFI BIOS password, per-executable consent keying (unverified),
  `RequestAccessAsync` (untested), the pre-push hook being per-clone state, the docker-socket red for
  `test_tls_floor.py`, and the pyright `reportMissingImports` pair on the runtime `sys.path` import.

### Debt items closed

None.

### Debt items still open

D-120 (BitLocker lock state on real media), D-129 (no real hardware validation for PBL), D-130 (no code
signing for PblApp.efi), D-134 (PBL TPM NV indices under the platform hierarchy).

### Blockers

- None. All four open items remain blocked on hardware or an operator credential, not on code.

### Session artifacts

- `.devin/graph/graph_assert.py` (the invariant), `agent/tests/test_graph_assertions.py` (both
  directions) — `8824de4`. CI evidence: `CI`, `Lint`, `CodeQL` success.

### Failure attribution

- **Layer 5 (state management), the case this whole arc has been circling.** A list was copied forward
  from block to block, so twenty sessions inherited a stale fact and one of them wrote its next-opening
  sentence from it. Nothing failed loudly because a restatement has no verifier. The fix is the same
  shape as S318–S321 — derive it, don't restate it — applied to the process instead of the code.
- **Layer 4 (verification feedback), mine again**: my first attempt at the tests shipped the same trio
  S321 shipped (out-of-order import, 101-character line, missing `import pytest`). Running
  `scripts/lint-agent.sh` before the commit rather than after CI is the whole difference, and it was
  written down last session as a lesson.

### VERIFY

- `python3 .devin/graph/graph_assert.py` → `✓ All invariants pass` (the real spec: 17 phases, 64 debt
  items, 13 enforcement paths, and now an open-debt list that matches the ledgers).
- Synthetic: block listing `D-120, D-210` against a ledger with D-210 CLOSED → `GraphViolationError`
  naming **D-210**; the corrected list → no violation.
- `agent/.venv/bin/python -m pytest agent/tests/test_graph_assertions.py -q` → **52 passed**.
- `scripts/lint-agent.sh` → exit 0, `[OK] ruff check + format clean`, 67 files formatted.
- CI on `8824de4` → **CI success · Lint success · CodeQL success**.

### Next session opening

Extend the same check to the other half of the block: "Debt items closed" currently accepts any id, so a
session could claim a closure the ledger does not record — assert that every id listed there is CLOSED in
the ledger, and that its cited commit and artifact resolve, which the ledger already demands of itself.

---

---

## Session 327 — 2026-11-19 (a claimed closure must be a real one, and my own guard was examining nothing)

### RULE-ZERO — understanding logged before each change

- **Read**: `.devin/graph/graph_assert.py` (the S326 helpers) — `_ledger_open_ids` already parsed both
  ledgers, so the CLOSED side could reuse the same heading/first-status-line rule rather than a second
  parser.
- **Read**: the archived blocks that actually claim closures — `- **D-132 — CLOSED** (commit_ref
  b760e30)`, `- **D-200 — CLOSED**, on its ledger criteria` — to learn the form rather than invent one.
- **Read**: `.devin/graph/trace.md:119` — "None. This session fixed live defects (D-119/D-120-adjacent
  behaviour)": two ids, zero closures. That is why an id-scanning check would be wrong.
- **Read**: `.devin/graph/orphaned-commit-refs.txt` — the S149 rewrite baseline, which S324 had already
  used to explain why `9612fbb` cannot resolve and is nevertheless legitimate.

**Findings**: "Debt items closed" was the mirror of S326's problem. The open list drifted because
nothing compared it to the ledger; the closed list could *invent* a closure for the same reason — no
comparison at all.

### Fog cleared

- **`assert_claimed_closures_are_real()` is in the sweep** (`ad45008`): an explicit
  `- **D-nnn — CLOSED**` claim must have its ledger status CLOSED, every cited hash resolving (or in the
  orphan baseline) and every cited path existing. Prose is not scanned, deliberately.
- **Three bugs in my own implementation were caught by the tests before CI**:
  1. the extractor returned the regex **match** rather than the line, so the cited commit and artifact
     were invisible and the guard verified nothing — the test reported "DID NOT RAISE", which is exactly
     what a guard with no evidence should do;
  2. the path pattern swallowed the sentence's full stop (`docs/adr/x.md.`), which would have failed a
     real artifact on punctuation;
  3. the fixture created its directory without `exist_ok` and wrote its artifact into the **wrong
     helper**, so the pass case failed for fixture reasons rather than logic.
- **Both halves of the session block are now derived from the ledgers** — open list (S326) and claimed
  closures (S327) — and AGENTS.md documents the claim form so a future session writes something the
  check can read instead of discovering the requirement by failing.
- **CI is green** on `ad45008`: `CI`, `Lint`, `CodeQL` all success. `make graph-check` clean. 55 tests in
  the file (was 52).

### Fog remaining

- **Only the newest block is checked.** That is deliberate — history records what sessions believed — but
  it means the invariants protect the next block, not the existing ones.
- **The check verifies ids and refs, not meaning.** A block could claim a closure whose ledger criteria
  were never met; `assert_debt_close_has_evidence` covers the ledger side, and the block side has no
  equivalent.
- **`.devin/graph/graph_assert.py` is outside every lint gate this repo runs** (ruff governs `agent/`,
  eslint the JS components, `tsc` the worker). The 11 findings on it are pre-existing and none are on
  lines this session added — but the file that enforces the invariants is itself unlinted, which is worth
  a decision rather than an omission.
- **The weekly audit's `cron` path is still unexercised**, and the pyright `reportMissingImports` pair on
  the runtime `sys.path` import remains an advisory.

### Debt items closed

None.

### Debt items still open

D-120 (BitLocker lock state on real media), D-129 (no real hardware validation for PBL), D-130 (no code
signing for PblApp.efi), D-134 (PBL TPM NV indices under the platform hierarchy).

### Blockers

- None. The four open items remain blocked on hardware or an operator credential.

### Session artifacts

- `.devin/graph/graph_assert.py` (the invariant), `agent/tests/test_graph_assertions.py` (three tests),
  `AGENTS.md` (the claim form) — `ad45008`. CI evidence: `CI`, `Lint`, `CodeQL` success.

### Failure attribution

- **Layer 4 (verification feedback), and the guard was the culprit for the fifth time.** The extractor bug
  meant the new invariant checked nothing, and only the *test's* "did not raise" exposed it. That is the
  same shape as S318 (empty scan range), S319 (zero discovered tests), S320 (empty gate scope), S321
  (empty graph) and S326 (a restated list): a check whose scope collapsed to nothing reports success.
  The runnable rule this arc keeps producing: **when a check passes, ask what it examined.**
- **Layer 2 (context provision)**: nothing documented the claim form, so the first thing a future session
  would do is write prose the check cannot read. AGENTS.md now carries it, in the same paragraph as the
  session-end requirements.

### VERIFY

- `agent/.venv/bin/python -m pytest agent/tests/test_graph_assertions.py -q` → **55 passed**
  (`/usr/bin/python3 -m pytest` → "No module named pytest", the documented bare-invocation trap).
- `scripts/lint-agent.sh` → exit 0, check + format clean, 67 files formatted.
- `python3 .devin/graph/graph_assert.py` → `✓ All invariants pass` (open list + claimed closures both
  checked against the ledgers).
- Synthetic proofs: an unrecorded closure raises naming the id; a cited dead hash raises unless it is a
  known orphan; the prose-only block passes.
- CI on `ad45008` → **CI success · Lint success · CodeQL success**.

### Next session opening

Decide whether `.devin/graph/*.py` should be covered by a lint gate: it is the code that enforces every
graph invariant, it carries 11 pre-existing findings, and no gate in the repo reads it — the same
"who checks the checker" question this arc has asked five times.

---

---

## Session 328 — 2026-11-19 (the invariant engine is now linted, and two wiring bugs proved the gate runs)

### RULE-ZERO — understanding logged before each change

- **Read**: `scripts/lint-agent.sh` — how the interpreter is selected (venv → PATH → python3) and why a
  missing tool must fail loudly (S271: `python3 -m ruff` on a host without it aborted a sweep mid-way).
- **Read**: `agent/ruff.toml` — `select = ["E","W","F","I","B","S","UP"]` with per-file ignores tuned for
  shipped code, which is what an unconditional reuse would import into a build-time script.
- **Read**: `.github/workflows/lint.yml`'s ruff job — `defaults.run.working-directory` and the pinned ruff
  version (`requirements-dev.txt: ruff==0.17.5`), i.e. the two things that would decide whether a step
  written here behaves the same in CI.
- **Read**: `ruff check .devin/graph/graph_assert.py --statistics` under both rule sets — 15 findings with
  defaults, 17 with the agent config, 20 with the chosen `E,W,F,I,UP` — before deciding which bar is right.

**Findings**: the file that decides whether I1-I7 pass was the one file in the tree no gate read. ruff
governed `agent/`, eslint the JS components, `tsc` the worker; `.devin/graph/` was in none of them.

### Fog cleared

- **The invariant engine is linted** (`f6dd19a`): `scripts/lint-graph.sh`, `make lint-graph` added to
  `make lint`, and a step in CI's ruff job. Rule set deliberately narrow — `E,W,F,I,UP` at line-length
  100 — because `agent/ruff.toml` selects `S` and per-file ignores for code shipped to a device, and this
  is a build-time script. The chosen set cannot change behaviour by construction.
- **20 findings fixed**: 12 by autofix (5 unused imports, 2 `datetime.UTC`, an f-string, import order, an
  unused `noqa`), 8 by hand (6 lines over 100 chars, an `endswith` tuple, a collapsible nested `if`).
- **Behaviour verified unchanged**: `--assert-phase-deps P3` exit 0, full sweep exit 0 with
  `All invariants pass`, `--convergence` exit 0, `scripts/test_graph_session.py` 40/40,
  `agent/tests/test_graph_assertions.py` 55/55.
- **CI is green on the result** (`94ac0f6`): `CI`, `Lint`, `CodeQL`, `Dependency Graph` all success.
- **The gate proved it actually runs, twice, by failing on my wiring**:
  1. `run: scripts/lint-graph.sh` → `No such file or directory` (exit 127), because that job sets
     `working-directory: agent`; fixed with `working-directory: ${{ github.workspace }}` (`7420059`);
  2. `ruff --fix` had removed an unused `import os` from **both** `.devin/graph` files and I staged only
     the four paths I remembered, so `make lint-graph` was green against an uncommitted tree while CI
     found `F401 graph_loader.py:18` on the committed one (`94ac0f6`).
- **A stale fork was found and left as a decision**: `harness-template/graph_assert.py` is **640 lines**
  against the live engine's **1299**, and nothing in the repo references `harness-template/` — not the
  Makefile, CI, a script or a doc.

### Fog remaining

- **`harness-template/graph_assert.py` is a second copy of the invariant engine**, missing everything
  since it was forked (the S326/S327 ledger checks included). A reader would take it for the engine.
  Deleting something named "template" is the owner's call; marking it as a scaffold with a pointer to the
  live file is the cheap alternative. Not acted on.
- **`Dependabot Updates` failed on this push**, with `write access to the repository is required` — the
  same text as the run on **2026-11-12**, before this session's `overrides` existed, so it is a
  repository/permission condition rather than a dependency change of mine. Recorded, not chased.
- **The weekly audit's `cron` path is still unexercised** (every run so far was dispatch).
- **The pyright `reportMissingImports` pair** on the runtime `sys.path` import remains an advisory.
- Unchanged: offline key custody, HP UEFI BIOS password, per-executable consent keying (unverified),
  `RequestAccessAsync` (untested), the pre-push hook being per-clone state, the docker-socket red for
  `test_tls_floor.py`.

### Debt items closed

None.

### Debt items still open

D-120 (BitLocker lock state on real media), D-129 (no real hardware validation for PBL), D-130 (no code
signing for PblApp.efi), D-134 (PBL TPM NV indices under the platform hierarchy).

### Blockers

- None. The four open items remain blocked on hardware or an operator credential.

### Session artifacts

- `scripts/lint-graph.sh`, `Makefile` (`lint-graph`), `.github/workflows/lint.yml` (step),
  `.devin/graph/graph_assert.py` (findings), `.devin/graph/graph_loader.py` (unused import) —
  `f6dd19a`, `7420059`, `94ac0f6`. CI evidence: `CI`, `Lint`, `CodeQL` success.

### Failure attribution

- **Layer 4 (verification feedback), in its third distinct shape.** S314: a check whose failure could not
  stop the action (`;` before `git push`). S318: a check run on the wrong output (`grep` after a scan).
  S328: **a correct check run on the wrong tree** — `make lint-graph` was green because the working tree
  held an autofix I had not staged. All three are "the verification ran and its subject was not what
  shipped"; the countermeasure is mechanical, not attentional: after an autofix over a directory, stage
  the directory.
- **Layer 2 (context provision)**: the job's `working-directory: agent` is three lines above the step I
  edited and I did not read it. A workflow step is not self-contained — it inherits a default path, and
  the file that declares it is the file being edited.

### VERIFY

- `make lint-graph` → `All checks passed!`, `[OK] ruff check clean`, exit 0.
- `make lint-workflows` → exit 0 (actionlint + shellcheck); `lint.yml` parses.
- `python3 .devin/graph/graph_assert.py` → `✓ All invariants pass`; `--assert-phase-deps P3` exit 0;
  `--convergence` exit 0.
- `scripts/test_graph_session.py` → 40 passed, 0 failed.
- `agent/.venv/bin/python -m pytest agent/tests/test_graph_assertions.py -q` → 55 passed.
- CI on `94ac0f6` → **CI · Lint · CodeQL · Dependency Graph success**; `Dependabot Updates` failure
  reproduces the 2026-11-12 text and is not attributable to this session.

### Next session opening

Decide the `harness-template/graph_assert.py` fork: delete it, or mark it as a scaffold with a one-line
pointer to `.devin/graph/graph_assert.py` and a note that it predates the S326/S327 ledger checks — a
640-line copy of the engine that nothing references is the next thing a reader will mistake for the truth.

---

---

## Session 329 — 2026-11-19 (a stale fork documented, and a worktree I left behind)

### RULE-ZERO — understanding logged before each change

- **Read**: `harness-template/`'s contents and their live counterparts — `graph_assert.py` 640 vs 1314
  lines, `graph_loader.py` 197 vs 192, `GRAPH-SPEC.yaml` 396 vs 1595.
- **Read**: every reference to `harness-template` in the repository — none outside `.git/`, so nothing
  runs it: not the Makefile, CI, a script or a doc.
- **Read**: the template engine for the checks added since S326 — `assert_open_debt_list_matches_ledger`
  and `assert_claimed_closures_are_real` are both **absent**, so the fork predates the ledger checks.
- **Read**: `git worktree list` — one live worktree plus `/tmp/pre304` (detached at `25df83e`), which S307
  registered while attributing a Playwright failure and never removed.

**Findings**: two pieces of state had outlived their purpose and neither announced itself. A stale copy of
the invariant engine is the more dangerous of the two because it reads as authoritative.

### Fog cleared

- **`harness-template/` now says what it is** (`7c7db09`): a scaffold, not the engine; nothing here runs
  it; a table of its three files against their live counterparts; the consequence of the drift (missing
  S326/S327 ledger checks); and the two honest options — delete it, or re-sync it when it is actually used
  to bootstrap a project. Deleting something named "template" is the owner's call, so the note is the
  action and the choice stays open.
- **The orphaned worktree is gone**: `git worktree remove /tmp/pre304 --force` + `git worktree prune`;
  `git worktree list` shows one worktree and `.git/worktrees/` is empty.
- **CI is green** on `7c7db09`: `CI`, `Lint`, `CodeQL` all success. Tree clean, local == remote.

### Fog remaining

- **The fork still exists.** It is documented, not resolved: either delete `harness-template/` or re-sync
  it from `.devin/graph/` the first time it bootstraps a project. A template that tracks its source needs
  no disclaimer, which is why the README names that end state.
- **`Dependabot Updates` fails with `write access to the repository is required`** — the same text as the
  2026-11-12 run, before this session's dependency overrides, so it is a repository/permission condition
  and not a change of mine. It is a setting only the owner can change.
- **The weekly audit's `cron` path is still unexercised** (every run so far was dispatch).
- **The pyright `reportMissingImports` pair** on the runtime `sys.path` import remains an advisory.
- Unchanged: offline key custody, HP UEFI BIOS password, per-executable consent keying (unverified),
  `RequestAccessAsync` (untested), the pre-push hook being per-clone state, the docker-socket red for
  `test_tls_floor.py`.

### Debt items closed

None.

### Debt items still open

D-120 (BitLocker lock state on real media), D-129 (no real hardware validation for PBL), D-130 (no code
signing for PblApp.efi), D-134 (PBL TPM NV indices under the platform hierarchy).

### Blockers

- None. The four open items remain blocked on hardware or an operator credential.

### Session artifacts

- `harness-template/README.md` (the drift table and the two options) — `7c7db09`. Plus the removal of the
  `/tmp/pre304` worktree registration (repo state, not a commit).

### Failure attribution

- **Layer 5 (state management), twice, and both mine.** The `pre304` worktree was registered in S307 for a
  one-off attribution, answered nothing, and stayed registered for twenty sessions; the template fork was
  created before this arc began and drifted silently. Neither failed a gate, because neither is the kind
  of thing a gate looks at — which is exactly why the sweep has to include "what did I leave behind" as
  well as "what does the code say".
- **A note on restraint**: the tempting move was to delete `harness-template/` because it is unreferenced.
  That is an owner decision about a scaffold that may bootstrap another repo, and the evidence for deletion
  (`grep` finds nothing) is weaker than the evidence against it (the name says "template"). Documenting the
  drift and naming both options is the action that cannot be wrong.

### VERIFY

- `grep -rn harness-template` (excluding the directory itself) → nothing outside `.git/`; the statement in
  the new README is itself checkable.
- `harness-template/graph_assert.py` vs `.devin/graph/graph_assert.py` → **640 vs 1314** lines;
  `assert_open_debt_list_matches_ledger` and `assert_claimed_closures_are_real` absent from the fork.
- `git worktree list` → one worktree (`e0dc669 [master]`); `.git/worktrees/` → empty.
- `make graph-check` → `✓ All invariants pass`; tree clean; local == remote before and after.
- CI on `7c7db09` → **CI success · Lint success · CodeQL success**.

### Next session opening

Re-run `make full-verify` end to end: twenty sessions have added or changed gates (`lint-graph` is now in
`make lint`, the SAST exceptions changed, the dependency overrides landed, the audit gained a weekly job),
and the sweep's recorded numbers predate all of it — with the known docker-socket red for
`test_tls_floor.py` as the one expected failure.

---

---

## Session 330 — 2026-11-19 (the sweep re-measured, and the one-command story is not one command)

### RULE-ZERO — understanding logged before each change

- **Read**: `Makefile`'s `full-verify` chain (`graph-check lint test test-e2e verify-env check-artifacts`)
  and the documented expectation that `scripts/test_tls_floor.py` fails here because `/var/run/docker.sock`
  is unreadable from this login session.
- **Read**: AGENTS.md's sweep paragraph — dated S307 and carrying server 882 / agent 976 / worker 490,
  which twenty sessions of gate changes had made stale.
- **Read**: the S307 lesson in this repo's own record: `make` aborts at the failing target, so three steps
  never ran and had to be run by hand.

**Findings**: the sweep is not a single command in practice on this host, and its recorded numbers were
three sessions behind even before this arc's gate work.

### Fog cleared

- **The whole tree was re-measured** (log: `/tmp/full-verify-s330.log`): graph-check ✓ ·
  `make lint` ✓ **including the new `lint-graph`** (`All checks passed! / [OK] ruff check clean`) ·
  server **885** (52 suites) · dashboard **272** (30 files) · worker **495** (4 files) ·
  electron **30** (3 suites) · agent **990** collected · **16 script suites** (15 green; `test_tls_floor`
  1 failed/1 passed; `worker_update` 5 skipped).
- **The three steps the abort skipped were run by hand and pass**: `test-e2e` **14/14** with
  `RESULT: PASS`, `verify-env` **56 PASS / 0 FAIL / 5 SKIP**, `check-artifacts` all present.
- **AGENTS.md now carries these numbers** (dated S330) instead of the S307 figures, and states plainly
  that the chain stops at `test-scripts` on the tls-floor red, so those three ran separately.
- **`make -k full-verify` is documented as the one-run option, and the claim was tested** rather than
  assumed: on a throwaway Makefile, `make all` stops at the failing prerequisite while `make -k all` runs
  the rest and reports "Target 'all' not remade because of errors".

### Fog remaining

- **The only red is environmental and unchanged**: `test_tls_floor.py` needs a readable
  `/var/run/docker.sock`; the socket is `root:docker 0660`, this login session is in no docker group, and
  `sudo -n` needs a password. Fixing it is an operator action (add the group, start a new session).
- **Four gates were not re-measured**: `make pg-smoke` (real PostgreSQL), `make sast` (semgrep absent
  locally), `make firmware-host-tests`, and `make test-coverage` across all five components. They keep
  their older dates in AGENTS.md.
- **`Dependabot Updates` still fails** with `write access to the repository is required` (same text as
  2026-11-12) — a repository setting, not a code change.
- **The weekly audit's `cron` path is still unexercised**, and the pyright `reportMissingImports` pair on
  the runtime `sys.path` import remains an advisory.
- Unchanged: offline key custody, HP UEFI BIOS password, per-executable consent keying (unverified),
  `RequestAccessAsync` (untested), the pre-push hook being per-clone state, and the `harness-template/`
  fork left as the owner's decision (S329).

### Debt items closed

None.

### Debt items still open

D-120 (BitLocker lock state on real media), D-129 (no real hardware validation for PBL), D-130 (no code
signing for PblApp.efi), D-134 (PBL TPM NV indices under the platform hierarchy).

### Blockers

- **`/var/run/docker.sock` is unreadable from this login session**, so one gate cannot run and the sweep
  cannot complete in one command here. Not a code defect.

### Session artifacts

- `AGENTS.md` sweep paragraph re-dated to S330 with the measured figures and the `-k` note.
- `/tmp/full-verify-s330.log` (full sweep), `/tmp/e2e-s330.log`, `/tmp/env-s330.log`, `/tmp/art-s330.log`.
- CI evidence: the `-k` behaviour was proven on a throwaway Makefile, not asserted.

### Failure attribution

- **Layer 4 (verification feedback) — the sweep's own documentation was the defect.** "Run `make
  full-verify`" reads as one complete report; on this host it stops one target in and silently omits
  three steps, which is the same shape as S318–S321 applied to a *command* rather than a check: the
  report described less than it appeared to. The fix is the two-line paragraph: state what the chain does
  on this host, and give `-k` as the alternative that actually reports everything.
- **Layer 3 (execution environment)**: the docker socket is the single environmental limit, and it is
  re-stated with the evidence (`root:docker 0660`, no group membership, `sudo -n` unavailable) rather
  than as folklore.

### VERIFY

- `make full-verify` → `make: *** [test-scripts] Error 1`, `FULL_VERIFY_EXIT=2` (make's code for a failed
  recipe); every target before it passed.
- `make test-e2e` → **14 passed, 14 total**, `RESULT: PASS (all E2E tests succeeded)`, exit 0.
- `make verify-env` → **56 PASS / 0 FAIL / 5 SKIP**, exit 0 · `make check-artifacts` → all present, exit 0.
- `scripts/run-agent-tests.sh --collect-only` → **990** collected.
- `make -k` proven on a synthetic Makefile: without it the second target never runs; with it, it does.
- `make graph-check` → `✓ All invariants pass`; tree clean before and after.

### Next session opening

Run `make -k full-verify` once, end to end, so the sweep produces a single complete report in this
environment — confirming in practice what S330 documented, and leaving only the docker-socket red.

---

---

## Session 331 — 2026-11-19 (`make -k full-verify` confirmed in practice: one pass, one red)

### RULE-ZERO — understanding logged before each change

- **Read**: S330's block and the AGENTS.md paragraph it wrote — the claim "use `make -k full-verify` when
  you want one run to report everything instead of stopping at the known red", which had been proven only
  on a throwaway Makefile, not on this target.
- **Read**: `/tmp/full-verify-s330.log` — the un-`-k` run that stopped at `test-scripts` with
  `Error 1` and left `test-e2e`, `verify-env` and `check-artifacts` unexecuted.

**Findings**: the `-k` claim was a reasonable extrapolation, which is exactly the kind of statement this
arc keeps finding unverified. Running it costs ten minutes; asserting it costs a later session.

### Fog cleared

- **`make -k full-verify` completes in one pass** (log `/tmp/full-verify-k-s331.log`): every target ran and
  reported — graph-check `✓ All invariants pass` · lint `All checks passed!` (both the agent and the new
  graph lint) · server **885** · electron **30** (3 suites) · `test-e2e` **RESULT: PASS** · `verify-env`
  **56 PASS / 0 FAIL / 5 SKIP** · check-artifacts `All artifacts present`.
- **The only failure is the documented one**: `test-scripts` → `scripts/test_tls_floor.py`
  (`1 failed, 1 passed`), followed by `make: Target 'full-verify' not remade because of errors` and exit 2.
  So `-k` does what the documentation now says, and the exit code still reports the failure honestly rather
  than being swallowed.
- **The two-run story is retired**: previously a sweep meant one aborted run plus three hand-run targets;
  now it is one command whose single red is the environment, and the numbers match S330's measurement.

### Fog remaining

- **The red itself is unchanged and is an operator action**: `/var/run/docker.sock` is `root:docker 0660`,
  this login session is in no docker group, and `sudo -n` needs a password. Adding the user to `docker`
  and starting a new login session is the only way to make this sweep fully green here.
- **Four gates were still not re-measured**: `make pg-smoke`, `make sast` (semgrep absent locally),
  `make firmware-host-tests`, and the five-component `make test-coverage`.
- **`Dependabot Updates`** still fails with `write access to the repository is required` (same text as
  2026-11-12) — a repository setting, not code.
- **The weekly audit's `cron` path is still unexercised**; the pyright `reportMissingImports` pair remains
  an advisory; `harness-template/` remains documented drift awaiting the owner's decision (S329).
- Unchanged: offline key custody, HP UEFI BIOS password, per-executable consent keying (unverified),
  `RequestAccessAsync` (untested), the pre-push hook being per-clone state.

### Debt items closed

None.

### Debt items still open

D-120 (BitLocker lock state on real media), D-129 (no real hardware validation for PBL), D-130 (no code
signing for PblApp.efi), D-134 (PBL TPM NV indices under the platform hierarchy).

### Blockers

- **`/var/run/docker.sock` unreadable from this login session** — the sweep's only red, and not a code defect.

### Session artifacts

- `/tmp/full-verify-k-s331.log` — one-pass sweep with every target's output and `MAKE_K_EXIT=2`.
- No repo change beyond this record: the claim under test was already written in AGENTS.md (S330).

### Failure attribution

- **Layer 4 (verification feedback), on myself**: S330 documented `-k` from a synthetic Makefile and
  called it "proven", which proved the *mechanism* and not the *target*. This session closed that gap —
  and the distinction is worth keeping: a mechanism demonstrated on a toy is evidence about the mechanism,
  never about the real command.

### VERIFY

- `make -k full-verify` → every target reported; `make: *** [Makefile:132: test-scripts] Error 1`;
  `make: Target 'full-verify' not remade because of errors.`; `MAKE_K_EXIT=2`.
- Per-target evidence in that log: `✓ All invariants pass` (1) · `All checks passed!` (2) ·
  `Tests: 885 passed` · `Tests: 30 passed` (electron) · `RESULT: PASS (all E2E tests succeeded)` ·
  `PASS: 56 FAIL: 0 SKIP: 5` · `All artifacts present and non-empty`.
- `make graph-check` → `✓ All invariants pass`; tree clean before and after.

### Next session opening

Ask the operator to add this login session to the `docker` group (then re-login) so
`scripts/test_tls_floor.py` can run — that is the only thing between this tree and a fully green
`make -k full-verify`, and everything else in the sweep is measured.

---

---

## Session 332 — 2026-11-19 (two "not re-measured" gates closed; one shown to be unrunnable here)

### RULE-ZERO — understanding logged before each change

- **Read**: AGENTS.md's sweep paragraph — the sentence that lists `sast`, `firmware-host-tests`,
  `pg-smoke` and five-component coverage as NOT re-measured, with the reason each was skipped.
- **Read**: `Makefile:205-212` (sast) and `Makefile:222` (pg-smoke) — what each target actually invokes, so
  "could not run" would be a measurement rather than an assumption.
- **Checked**: semgrep 1.182.1 is present in the `/tmp/sgvenv` from S312; `cc`/`gcc` are on PATH;
  `pg_isready -h localhost -p 5432` → no response and `docker ps` → exit 1.

**Findings**: three of the four stale figures were reachable without a hardware window or a credential —
two by running them, one by proving it cannot run here.

### Fog cleared

- **`make sast` re-measured** (`/tmp/sast-s332.log`): **48 findings, 0 ERROR**, `[OK] every finding is
  either fixed or carries a reviewed reason`, exit 0 — the S312 figure holds, with the S312 exceptions in
  place.
- **`make firmware-host-tests` re-measured** (`/tmp/fw-s332.log`): **195 checks, 0 failures, 35 cases**
  (CBOR 97 checks/19 cases, TPM 86/8, COSE 12/8), exit 0 — the recorded figure exactly.
- **`make pg-smoke` shown to be unrunnable on this host, with evidence rather than recollection**: no
  PostgreSQL on `localhost:5432` (`pg_isready` → "no response") and no usable docker (`docker ps` → exit
  1), which is the same socket condition as the sweep's one red.
- **AGENTS.md updated**: the "not re-measured" sentence now records sast and firmware as re-measured in
  S332 and names the concrete reason pg-smoke cannot run, instead of listing all four as merely stale.

### Fog remaining

- **`make test-coverage` across all five components was not re-run** (the longest gate, and the context
  budget for this session); only the dashboard floor has a recent number.
- **The docker socket remains the single environmental blocker** — it costs both `test_tls_floor.py` and
  `pg-smoke`, and needs an operator (add to the `docker` group, re-login).
- **`Dependabot Updates`** still fails with `write access to the repository is required`; the weekly
  audit's `cron` path is still unexercised; the pyright `reportMissingImports` pair stands as advisory;
  `harness-template/` remains documented drift awaiting the owner's decision (S329).
- Unchanged: offline key custody, HP UEFI BIOS password, per-executable consent keying (unverified),
  `RequestAccessAsync` (untested), the pre-push hook being per-clone state.

### Debt items closed

None.

### Debt items still open

D-120 (BitLocker lock state on real media), D-129 (no real hardware validation for PBL), D-130 (no code
signing for PblApp.efi), D-134 (PBL TPM NV indices under the platform hierarchy).

### Blockers

- **No PostgreSQL and no usable docker on this host** — `pg-smoke` and `test_tls_floor` are the two gates
  that cannot run here, and both for the same reason (no docker socket, no local PG).

### Session artifacts

- `AGENTS.md` (sast + firmware re-dated; pg-smoke's blocker named).
- Logs: `/tmp/sast-s332.log`, `/tmp/fw-s332.log`.

### Failure attribution

- **Layer 3 (execution environment), now measured instead of assumed.** `pg-smoke` had been carried as
  "needs real PostgreSQL 16" for two hundred sessions; the actual condition on this host (nothing
  listening on 5432, docker unusable) is a one-command check that nobody had run. A deferral that names
  its prerequisite is better than one that names a category.
- **Layer 4 (verification feedback)**: the sweep's "not re-measured" list was itself a claim without a
  date, so it read as "these might be broken". Two of the four were green the whole time.

### VERIFY

- `PATH=/tmp/sgvenv/bin:$PATH make sast` → `Semgrep findings: 48`, `[OK] every finding is either fixed or
  carries a reviewed reason`, exit 0.
- `make firmware-host-tests` → `97 checks, 0 failures across 19 cases` · `86 checks, 0 failures across 8
  cases` · `12 checks, 0 failures across 8 cases`; exit 0.
- `pg_isready -h localhost -p 5432` → `no response`; `docker ps` → exit 1.
- `make graph-check` → `✓ All invariants pass`; tree clean before and after.

### Next session opening

Run `make test-coverage` across all five components — the last gate with no recent number — and record
which floors are tight (the dashboard's functions floor sat at 62.59 against 62 in S305).

---

---

## Session 333 — 2026-11-19 (the last stale gate: five-component coverage, measured)

### RULE-ZERO — understanding logged before each change

- **Read**: `make test-coverage` and each component's own floor — server `jest.config.js`
  (66/62/70/67), dashboard `vitest.config.js` (68/61/62/70), worker `vitest.config.mts` (82/75/86/83),
  electron `jest.config.js` (37/45/29/37), agent `pyproject.toml` `fail_under = 59`.
- **Read**: AGENTS.md's note that the dashboard functions floor was the tight one (62.59 vs 62 in S305),
  so the comparison is per-component and per-metric rather than an aggregate.

**Findings**: coverage was the last gate with no recent number, and its floors live in five different
files — an aggregate figure would hide exactly the component that is closest to failing.

### Fog cleared

- **All five components pass their own floors** (`/tmp/coverage-s333.log`, exit 0):

  | component | statements | branches | functions | lines | floor |
  |---|---|---|---|---|---|
  | server | 74.86 | 71.63 | 80.28 | 75.70 | 66/62/70/67 |
  | dashboard | 70.62 | 66.59 | **62.59** | 71.40 | 68/61/62/70 |
  | worker | 86.46 | 83.00 | 95.06 | 88.60 | 82/75/86/83 |
  | electron | 39.40 | 47.36 | **30.95** | 39.30 | 37/45/29/37 |
  | agent | — | — | — | 66.01 | 59 (`fail_under`) |

- **The tightest margins are `functions`**: dashboard **+0.59** and electron **+1.95**. A small deletion
  trips either, which is now written where the numbers are.
- **AGENTS.md's sweep paragraph is fully current**: every one of its figures is either re-measured today
  or carries a named reason it cannot be (pg-smoke: no PostgreSQL on :5432, no usable docker).

### Fog remaining

- **`make pg-smoke` remains the only gate that cannot run on this host**, for the same docker/PG reason as
  `test_tls_floor.py` — one operator action (docker group + re-login) would unblock both.
- **`Dependabot Updates`** still fails with `write access to the repository is required`; the weekly
  audit's `cron` path is still unexercised; the pyright `reportMissingImports` pair is an advisory;
  `harness-template/` remains documented drift awaiting the owner's decision (S329).
- Unchanged: offline key custody, HP UEFI BIOS password, per-executable consent keying (unverified),
  `RequestAccessAsync` (untested), the pre-push hook being per-clone state.

### Debt items closed

None.

### Debt items still open

D-120 (BitLocker lock state on real media), D-129 (no real hardware validation for PBL), D-130 (no code
signing for PblApp.efi), D-134 (PBL TPM NV indices under the platform hierarchy).

### Blockers

- **No docker socket and no local PostgreSQL** — the two gates that cannot run here, one cause.

### Session artifacts

- `AGENTS.md` (coverage re-dated with all five components and their margins), `/tmp/coverage-s333.log`.

### Failure attribution

- **Layer 4 (verification feedback)**: coverage had been reported as "all five components above floor"
  without a date or a figure since S305, which is a claim that cannot be re-checked. It is now five
  numbers against five declared floors, with the two tight ones called out — the difference between
  "green" and "green with 0.59 to spare" is the difference between a fact and a mood.

### VERIFY

- `make test-coverage` → exit **0**; per-component numbers above, each compared to its own config floor.
- `make graph-check` → `✓ All invariants pass`; tree clean before and after.
- `COVERAGE_EXIT=0` recorded in the log.

### Next session opening

Ask the operator for docker group membership (then re-login) so `test_tls_floor.py` and `pg-smoke` can
run — the last two gates in this repository that are blocked on the environment rather than on code.

---

---

## Session 334 — 2026-11-19 (the stale engine fork is gone)

### RULE-ZERO — understanding logged before each change

- **Read**: every reference to `harness-template` in the tree — the only hits are this repo's own trace
  entries recording the S329 decision, plus the README S329 added. No Makefile target, CI workflow,
  script or document consumes it.
- **Read**: the drift itself — `graph_assert.py` 640 lines vs the live 1314, `graph_loader.py` 197 vs 192,
  `GRAPH-SPEC.yaml` 396 vs 1595, and both S326/S327 ledger checks absent from the fork.

**Findings**: the confusion risk is asymmetric. A stale engine that reads as authoritative is worse than
no engine, because anyone bootstrapping a harness from it starts without the checks this repo now relies
on — and would not know to miss them.

### Fog cleared

- **`harness-template/` is deleted** (owner's decision, my recommendation): three files that nothing
  references, carrying a fork of the engine that predates every check added since S326. Git history keeps
  it recoverable, so the cost of being wrong is one `git revert`.
- **Nothing broke**: `make graph-check` → `✓ All invariants pass`; `scripts/test_graph_session.py` →
  40 passed, 0 failed. The deletion removed no import, no path, no target.
- **The record is preserved where it belongs**: the S329 trace entries state the fork's line counts and why
  it was left as a decision, so a reader can reconstruct what was removed and why.

### Fog remaining

- **Two gates remain blocked on docker** (`test_tls_floor.py`, `pg-smoke`): `sudo usermod -aG docker $USER`
  plus a new login session is the operator action; `sudo -n` needs a password, so nothing in-session can
  do it.
- **`Dependabot Updates`** still fails with `write access to the repository is required` — a repository
  setting.
- **The weekly audit's `cron` path is still unexercised**; the pyright `reportMissingImports` pair remains
  an advisory.
- Unchanged: offline key custody, HP UEFI BIOS password, per-executable consent keying (unverified),
  `RequestAccessAsync` (untested), the pre-push hook being per-clone state.

### Debt items closed

None.

### Debt items still open

D-120 (BitLocker lock state on real media), D-129 (no real hardware validation for PBL), D-130 (no code
signing for PblApp.efi), D-134 (PBL TPM NV indices under the platform hierarchy).

### Blockers

- **Docker socket and Dependabot write access** — both outside the repository, both named above.

### Session artifacts

- Deletion of `harness-template/` (3 files: `graph_assert.py`, `graph_loader.py`, `GRAPH-SPEC.yaml` and the
  S329 README).

### Failure attribution

- **Layer 5 (state management)**: a fork created before this arc drifted for a hundred sessions without
  anything noticing, and once noticed it took a second session to resolve because the right answer
  (deletion) was the owner's call rather than mine. The durable rule: a copy of the invariant engine that
  is not the engine should not exist, and if it must, it should carry its provenance in its first line.

### VERIFY

- `grep -rn harness-template` → no consumer remains (only this repo's trace history).
- `make graph-check` → `✓ All invariants pass`.
- `python3 scripts/test_graph_session.py` → 40 passed, 0 failed.
- `git status` clean afterwards; push passes the pre-push hook.

### Next session opening

Ask the operator for docker group membership (then re-login) so `test_tls_floor.py` and `pg-smoke` can run
— the only two gates in this repository still blocked on the environment rather than on code.

---

---

## Session 335 — 2026-11-19 (PR #3, pytest 9.0.3: verified, rebased, green — awaiting a UI merge)

### RULE-ZERO — understanding logged before each change

- **Read**: `agent/requirements-dev.txt` — `pytest==8.2.0`, `pytest-cov==5.0.0`, `pytest-timeout==2.3.1`,
  and the installed venv (8.2.0), before changing anything.
- **Read**: PR #3 — it bumps **only** `pytest` to 9.0.3 and leaves both plugins, so plugin compatibility
  with a major pytest bump was the question worth testing rather than the version number.
- **Read**: `scripts/run-agent-tests.sh` — which interpreter the documented runner picks, so "the suite
  passed on 9.0.3" would be a fact about the right interpreter (`run-agent-tests.sh --version` →
  `pytest 9.0.3`).

**Findings**: the risk in this PR is not pytest itself but two old plugins against it, and the only
credible check is the suite.

### Fog cleared

- **pytest 9.0.3 works with the existing plugins, measured**: collection exit 0 with no plugin errors,
  full suite **990 tests / 0 failures**, and the coverage gate **66.01% vs `fail_under` 59** — all on
  9.0.3 while `pytest-cov 5.0.0` and `pytest-timeout 2.3.1` stayed put.
- **The venv was restored to the pinned 8.2.0** afterwards, so local matches `requirements-dev.txt` until
  the PR actually lands — leaving 9.0.3 in place would have made local and CI disagree.
- **PR #3's only failing check was unrelated to pytest**: `SAST (Semgrep)` failed with
  `47 findings … 2 unclassified, 1 stale exception`, dated **2026-11-17** — the pre-S312 baseline whose
  exceptions S312 fixed on master. `gh pr update-branch 3` updated the branch and every check now passes,
  including SAST, PostgreSQL Smoke and Load Smoke. `mergeable=MERGEABLE`.
- **Why it cannot be merged from here**: one active branch ruleset (**"EFFORT"**) requires linear history,
  signatures, CodeQL alert thresholds and coverage; **auto-merge is disabled repository-wide**
  (`enablePullRequestAutoMerge`), and the only CLI remedies are `--auto` (unavailable) or `--admin`
  (a bypass). The owner is merging it in the UI.

### Fog remaining

- **PR #3 is open and green**, awaiting that UI merge. After it lands the local venv must move to 9.0.3 to
  keep local == pinned, and the next CI run on master should be watched for the `Lint Agent (ruff)` job,
  which installs from that same file.
- **`pytest-cov` (5.0.0 vs 7.1.0) and `pytest-timeout` (2.3.1 vs 2.4.0) are behind**, and were only proven
  at their old versions. They deserve their own bump, separately — three bumps in one PR make a failure
  ambiguous.
- **The ruleset's CodeQL/signature requirements mean a CLI merge will keep being blocked** for anyone but
  the owner; that is a repository setting, not a defect.
- Unchanged: the two docker-blocked gates (`test_tls_floor.py`, `pg-smoke`), `Dependabot Updates` write
  access, the weekly audit's unexercised `cron`, the pyright advisory pair, and the four open ledger items.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134 — all blocked on hardware or an operator credential.

### Blockers

- **A UI merge by the owner** for PR #3; **docker group membership** for the two blocked gates.

### Session artifacts

- Logs: `/tmp/pt9-collect.txt`, `/tmp/pt9-run.txt` (990 tests on 9.0.3), `/tmp/pt9-cov.txt` (66.01%).
- No repo change: the venv was restored to 8.2.0 and the tree is clean.

### Failure attribution

- **Layer 2 (context provision)**: the PR looked like a routine bump, and the two things that actually
  mattered — a stale SAST baseline on the branch and a ruleset that blocks non-owner merges — were only
  visible by running the checks and reading the protection rules. A dependency PR's review is incomplete
  without "what else does this branch carry" and "what does the branch policy require".

### VERIFY

- `scripts/run-agent-tests.sh --version` → `pytest 9.0.3` (the interpreter the suite actually used).
- Full suite on 9.0.3 → 990 passed, 0 failures, exit 0; collection exit 0.
- `pytest --cov --cov-fail-under=59` → `66.01%`, exit 0.
- `gh pr checks 3` after the update → all pass, including SAST (which failed pre-rebase with the
  2026-11-17 baseline); `gh pr view 3` → `mergeable=MERGEABLE`, `mergeStateStatus=BLOCKED` (ruleset).
- `agent/.venv/bin/python -m pytest --version` → `pytest 8.2.0` (restored); `git status` clean.

### Next session opening

After PR #3 is merged in the UI, install `pytest==9.0.3` into `agent/.venv` so local matches the new pin,
watch the first `CI`/`Lint` run on master, and only then take `pytest-cov` and `pytest-timeout` as their
own PR so a failure points at one bump.

---

---

## Session 336 — 2026-11-20 (pytest 9.0.3 landed with a scoped admin bypass; ruleset verified intact)

### RULE-ZERO — understanding logged before each change

- **Read**: PR #3's state and the `EFFORT` ruleset (10 rules: linear history, signatures, CodeQL
  thresholds, coverage, deletion, non-fast-forward) before choosing how to land it.
- **Read**: `agent/requirements-dev.txt` on `master` before and after the merge, so the local venv could be
  aligned to the *new* pin rather than to what I had tested in a scratch run.
- **Read**: `scripts/run-agent-tests.sh --version` — the documented runner's interpreter — because
  "the suite passed on 9.0.3" is only a fact if the runner actually used 9.0.3.

**Findings**: the owner authorised a bypass of the EFFORT ruleset for this one merge, with the condition
that the protection is back in place at the end.

### Fog cleared

- **PR #3 merged** as **`4afd409`** (`state=MERGED`, squashed, dependabot branch deleted) using
  `gh pr merge --admin`. That flag is a *per-merge* admin bypass: it neither disables nor edits the
  ruleset, which is why nothing had to be restored.
- **The protection is verified still enforcing**: `EFFORT enforcement=active target=branch`, **10 rules**
  listed after the merge. Checked rather than assumed, because "bypass" reads like "disabled".
- **Local aligned to the merged pin**: pulled to `4afd409`, `pytest==9.0.3` in
  `requirements-dev.txt`, `pip install -r` run, and both `agent/.venv/bin/python -m pytest --version`
  and `scripts/run-agent-tests.sh --version` report **9.0.3**.
- **The gates pass on the merged pin**, not just on the pre-merge experiment: **990 tests, 0 failures**
  and **coverage 66.01% vs `fail_under` 59**.
- **CI is green on `4afd409`**: `CI`, `Lint`, `CodeQL`, `Dependency Graph` all success — and `Lint`
  includes `Lint Agent (ruff)`, which installs from the same `requirements-dev.txt`, so the pin is proven
  in a clean environment rather than only in this venv.

### Fog remaining

- **`pytest-cov` (5.0.0 vs 7.1.0) and `pytest-timeout` (2.3.1 vs 2.4.0) remain behind** and were only
  proven at their old versions. Each deserves its own PR so a failure names one change.
- **The two docker-blocked gates are unchanged**: `test_tls_floor.py` and `pg-smoke` need
  `sudo usermod -aG docker $USER` plus a fresh login session.
- **`Dependabot Updates`** still fails with `write access to the repository is required`; the weekly
  audit's `cron` path is still unexercised; the pyright `reportMissingImports` pair remains advisory.
- Unchanged: offline key custody, HP UEFI BIOS password, per-executable consent keying (unverified),
  `RequestAccessAsync` (untested), the pre-push hook being per-clone state.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134 — all blocked on hardware or an operator credential.

### Blockers

- **Docker group membership** for the two environment-blocked gates.

### Session artifacts

- Merge commit **`4afd409`**; `/tmp/post-merge-suite.txt` (990 on 9.0.3), `/tmp/post-merge-cov.txt`
  (66.01%), `/tmp/pt9-*` (the pre-merge verification).

### Failure attribution

- **Layer 5 (state management), on the one thing that could have gone quietly wrong**: a bypass that
  leaves protection disabled is invisible until the next PR lands unreviewed. The ruleset was re-checked
  after the merge (`enforcement=active`, 10 rules) rather than trusted, and the local venv was aligned to
  the merged pin rather than left on the version tested before it.

### VERIFY

- `gh pr view 3` → `state=MERGED`, `mergeCommit=4afd409`; local `git rev-parse` → `4afd409`.
- `agent/requirements-dev.txt:4` → `pytest==9.0.3`.
- `agent/.venv/bin/python -m pytest --version` → `pytest 9.0.3`;
  `scripts/run-agent-tests.sh --version` → `pytest 9.0.3`.
- `scripts/run-agent-tests.sh -q` → 990 passed, exit 0; `--cov --cov-fail-under=59` → 66.01%, exit 0.
- `gh api …/rulesets` → `EFFORT enforcement=active target=branch`, rule count **10**.
- CI on `4afd409` → **CI success · Lint success · CodeQL success · Dependency Graph success**.

### Next session opening

Bump `pytest-cov` to 7.x as its own PR — the largest remaining version gap in the agent toolchain — with
the suite and the coverage gate as its evidence, then `pytest-timeout` likewise.

---

---

## Session 337 — 2026-11-20 (pytest-cov 5.0.0 → 7.1.0: two majors, identical numbers)

### RULE-ZERO — understanding logged before each change

- **Read**: `agent/requirements-dev.txt` (pytest 9.0.3, pytest-cov 5.0.0, pytest-timeout 2.3.1) and the
  S333 coverage baseline (66.01%, `6575` statements, `2235` missed) so a plugin upgrade could be judged by
  a *number* rather than by an exit code.
- **Read**: the plugin's declared requirements (`coverage, pluggy, pytest`) — the `coverage` dependency is
  why CI's clean install, not this venv, is the real proof.

**Findings**: a coverage-plugin major bump has exactly one meaningful question — does the measurement move?

### Fog cleared

- **pytest-cov 7.1.0 measures identically**: `TOTAL 6575 / 2235 / 66%`
  (`Required test coverage of 59% reached. Total coverage: 66.01%`), 990 tests passing, exit 0 — the same
  figures as 5.0.0, to the statement count.
- **`agent/requirements-dev.txt` now pins `pytest-cov==7.1.0`** (`0565105`), a clean
  `pip install -r` reports 7.1.0, and `scripts/lint-agent.sh` is green.
- **CI is green on `0565105`**: `CI`, `Lint`, `CodeQL`, `Dependency Graph` — `Lint` includes
  `Lint Agent (ruff)`, which installs from this file, so the bump is proven in a clean environment.

### Fog remaining

- **`pytest-timeout` 2.3.1 → 2.4.0 is the last of the three toolchain bumps** and is deliberately not
  bundled: one bump per commit keeps a failure unambiguous.
- **The two docker-blocked gates** (`test_tls_floor.py`, `pg-smoke`) still need
  `sudo usermod -aG docker $USER` plus a fresh login.
- **`Dependabot Updates`** still fails with `write access to the repository is required`; PRs #1/#2 were
  checked this session and are **already closed/superseded** (electron's pin is `^42.11.18`, installed
  42.11.18, past their proposed 42.11.16), so there is nothing to merge there.
- Unchanged: the weekly audit's unexercised `cron`, the pyright advisory pair, offline key custody,
  HP UEFI BIOS password, per-executable consent keying, `RequestAccessAsync`, and the four open items.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134 — blocked on hardware or an operator credential.

### Blockers

- **Docker group membership** for the two environment-blocked gates.

### Session artifacts

- `agent/requirements-dev.txt` (pytest-cov 7.1.0) — `0565105`; log `/tmp/cov71.txt`.

### Failure attribution

- **Layer 4 (verification feedback), applied correctly this time**: the bump was accepted on identical
  measurements rather than on a green exit code, and the check that could still differ (CI's clean
  `coverage` install) was run rather than assumed from the local venv.

### VERIFY

- `pytest --cov --cov-fail-under=59` on pytest 9.0.3 + pytest-cov 7.1.0 → `66.01%`, `6575/2235`, exit 0.
- `pip install -r agent/requirements-dev.txt` → `pytest-cov 7.1.0`; `scripts/lint-agent.sh` → exit 0.
- CI on `0565105` → **CI · Lint · CodeQL · Dependency Graph all success**.
- `gh pr list --state open` → empty; PRs #1/#2 → `CLOSED`; `electron/package.json` → `^42.11.18`.

### Next session opening

Bump `pytest-timeout` to 2.4.0 in its own commit — the last of the three agent-toolchain bumps — and
confirm the suite still finishes under the `--timeout=30` addopts rather than hanging on a slow test.

---

---

## Session 338 — 2026-11-20 (pytest-timeout 2.4.0: the last of the three toolchain bumps)

### RULE-ZERO — understanding logged before each change

- **Read**: `agent/pyproject.toml:3` — `addopts = "-q --timeout=30"`, because a timeout plugin's failure
  mode is the opposite of a coverage plugin's: not a number moving, but a slow test being cut off, or the
  addopts failing to bind against the new plugin.
- **Read**: `agent/requirements-dev.txt` after S336/S337 — pytest 9.0.3, pytest-cov 7.1.0, pytest-timeout
  2.3.1 — so this is the last of the three and can land alone.

**Findings**: the evidence for a timeout bump is a suite that finishes under a bound, not an exit code.

### Fog cleared

- **pytest-timeout 2.4.0 passes under `--timeout=30`**: full suite exit 0, **no timeout warnings**, and a
  clean `pip install -r` reports 2.4.0 (`dac0c19`).
- **`agent/requirements-dev.txt` is current on all three**: `pytest==9.0.3`, `pytest-cov==7.1.0`,
  `pytest-timeout==2.4.0`; `scripts/lint-agent.sh` exit 0.
- **CI is green on `dac0c19`**: `CI`, `Lint`, `CodeQL`, `Dependency Graph` — `Agent Tests` runs in the
  same `--timeout=30` configuration, so a silently cut-off test would have surfaced there.

### Fog remaining

- **The agent toolchain thread is finished**; nothing in it is outstanding.
- **Two gates remain un-runnable on this host**: `test_tls_floor.py` and `pg-smoke`, both needing docker
  group membership (`sudo usermod -aG docker $USER`) plus a fresh login.
- **`Dependabot Updates`** still fails with `write access to the repository is required` and will keep
  producing stale PRs until that setting changes (PRs #1/#2 were already closed/superseded, S337).
- **The weekly audit's `cron` path is still unexercised**; the pyright `advisory` pair stands; the four
  open ledger items need hardware or an operator credential.

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134.

### Blockers

- **Docker group membership** (two gates) and **repository settings** (Dependabot write access).

### Session artifacts

- `agent/requirements-dev.txt` (pytest-timeout 2.4.0) — `dac0c19`; log `/tmp/to24.txt`.

### Failure attribution

- No failure this session. Worth naming why: the three bumps were each verified by the measure that
  actually moves in that plugin (coverage number for cov, bound-and-finish for timeout), which is the
  practice S333–S337 were building.

### VERIFY

- `scripts/run-agent-tests.sh -q` → exit 0, no timeout warnings; `pip show pytest-timeout` → 2.4.0.
- `agent/requirements-dev.txt` → 9.0.3 / 7.1.0 / 2.4.0; `scripts/lint-agent.sh` → exit 0.
- CI on `dac0c19` → **CI · Lint · CodeQL · Dependency Graph all success**.
- `make graph-check` → `✓ All invariants pass`; tree clean.

### Next session opening

Add this login session to the `docker` group (`sudo usermod -aG docker $USER`, then re-login) and run
`make -k full-verify` — that unblocks `test_tls_floor.py` and `pg-smoke`, the last two gates in the
repository that cannot run here.

---

---

## Session 339 — 2026-11-20 (docker access landed: both blocked gates green, sweep fully green)

### RULE-ZERO — understanding logged before each change

- **Read**: `getent group docker` (`docker:x:968:unccllin`), the socket (`root:docker 0660`) and
  `sudo -n` — to separate "the group change did not land" from "this process has not re-read it".
- **Read**: `scripts/run-pg-smoke.sh` — `docker run … -p 55432:5432 postgres:16-alpine`, `pg_isready`
  inside the container, then `node src/db/migrate.js` with `DB_SSL=false` — before diagnosing the first
  `pg-smoke` failure as a migration problem.
- **Read**: `scripts/test_tls_floor.py:61` — the skip condition is `shutil.which("docker") and
  which("openssl")`, which is why a *present CLI with an unreachable daemon* fails rather than skips.

**Findings**: the operator had run `usermod`; the change was real, and the only thing standing between the
tree and a green sweep was that no process of mine had re-read the group database.

### Fog cleared

- **The group change is real and the process boundary is the reason `docker ps` still failed**:
  `getent group docker` lists the user, `id -nG` in the inherited shell does not. `sg` is not packaged on
  this host; `newgrp docker` is, and `printf 'docker ps\nexit\n' | newgrp docker` proved `DOCKER_USABLE`.
- **`test_tls_floor.py` is green for the first time in this arc**: **2 passed** — the static Caddyfile
  range check *and* a real TLS terminator refusing 1.0/1.1.
- **`pg-smoke` passes: 66 PASS / 0 FAIL.** Its first run failed with
  `migrations failed — Connection terminated unexpectedly`; that was **not** accepted as a fluke: the
  migrations were reproduced against a hand-started `postgres:16` on another port (**19/19 applied, exit
  0**), which isolated the failure to the container's first start, and the real target then passed.
- **The whole sweep is green**: `make -k full-verify` under `newgrp docker` → **FV_EXIT=0**, with
  `verify-env` now **57 PASS / 0 FAIL / 4 SKIP** (the docker check moved from SKIP to PASS) and every
  script suite green including `test_tls_floor` 2/2.
- **AGENTS.md corrected**: the paragraph that documented "the sweep's only red is the docker socket" now
  records the green result, states that `pg-smoke` is *not* part of `full-verify`, and gives the
  `newgrp docker` recipe — including why `usermod` alone does not help an existing process.

### Fog remaining

- **A fresh login session is still the durable fix**; `newgrp` is the per-command workaround. Until the
  next login, every docker-dependent command must be wrapped, and anything spawned from an old session
  still sees the old group set.
- **`Dependabot Updates`** still fails with `write access to the repository is required` (PRs #1/#2 went
  stale because of it).
- **The weekly audit's `cron` path is still unexercised**; the pyright advisory pair stands.
- Unchanged: offline key custody, HP UEFI BIOS password, per-executable consent keying (unverified),
  `RequestAccessAsync` (untested), the pre-push hook being per-clone state, and the four ledger items
  (all hardware- or credential-blocked).

### Debt items closed

None.

### Debt items still open

D-120, D-129, D-130, D-134.

### Blockers

- **None in the environment any more** — the docker group is the user's; `newgrp` bridges the session.

### Session artifacts

- `AGENTS.md` (green sweep result, `newgrp` recipe, pg-smoke's independence); logs
  `/tmp/fv-all-green.log`, `/tmp/pgsmoke2.txt`, `/tmp/repro.sh` (the migration isolation).

### Failure attribution

- **Layer 3 (execution environment), diagnosed rather than assumed.** Two failures had the same surface
  ("permission denied", "connection terminated") and neither was about the code: one was a group set
  frozen at process start, the other a container's first start. Both were separated from code defects by
  reproducing the inner step in isolation — the migrations on a hand-started PG — which is the difference
  between "it failed" and "it failed because of X".

### VERIFY

- `getent group docker` → `docker:x:968:unccllin`; `id -nG` in the inherited shell → no docker (expected).
- `printf 'docker ps\nexit\n' | newgrp docker` → `IN_GROUP` + `DOCKER_USABLE`.
- `agent/.venv/bin/python -m pytest scripts/test_tls_floor.py -q` under newgrp → **2 passed**.
- `make pg-smoke` under newgrp → **66 PASS / 0 FAIL**, `[OK] pg-smoke passed`.
- `make -k full-verify` under newgrp → **FV_EXIT=0**, `✓ All invariants pass`, `RESULT: PASS (all E2E
  tests succeeded)`, `PASS: 57 FAIL: 0 SKIP: 4`, `All artifacts present and non-empty`.

### Next session opening

Confirm the first CI-style sweep from a genuinely fresh login session (not `newgrp`) so the group is in
the session itself, then fix `Dependabot Updates`' write access so the three open dependency PRs stop
going stale.

---
