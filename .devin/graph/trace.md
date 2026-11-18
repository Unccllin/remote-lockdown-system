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
