# AGENTS.md — Remote Lockdown System

Project-specific guidance for AI agents working in this repo.

## Project Layout

- `server/` — Node.js / Express API + PostgreSQL/SQLite (CommonJS, Jest)
- `dashboard/` — React + Vite + Tailwind admin UI (ESM, Vitest)
- `agent/` — Python background agent (pytest, ruff)
- `electron/` — Electron desktop app bundling server + dashboard + agent
- `scripts/` — single source of truth for build/verify logic (wrapped by Makefile)
- `.devin/skills/phase-N-*` — knowledge base for the 17 production-readiness phases
- `.devin/skills/memory/` — **memory harness skill** (5-stage persistent agent memory)
- `.devin/memory/` — **memory storage** (raw/, consolidated/, decayed/, index.md)
- `.devin/graph/` — **the node graph** (center and heart of the project)
- `docs/adr/` — architecture decision records + debt ledger

## The Node Graph (mandatory read at session start)

The node graph is the center and heart of this project. Every agent session,
every phase transition, every verification gate, and every enforcement path
validation flows through the graph. The graph defines what work exists, what
order it must be done in, and what evidence is required to call something "done."

**Mandatory reads at session start, before any work:**

1. `.devin/graph/GRAPH-SPEC.yaml` — all nodes, edges, and invariants
2. `.devin/graph/current-state.md` — compact session state (latest status,
   open items, next session opening). Read this FIRST — it's a GENERATED
   artifact (~200 lines), produced by `make gen-state` from trace.md + the
   graph spec. Do NOT edit by hand. Read `.devin/graph/trace.md` on demand
   for full session history. Old sessions are archived to
   `.devin/graph/trace-archive-*.md` by `make archive-trace`.
3. `docs/adr/DEBT-LEDGER.md` — open debt items and close criteria
4. `docs/adr/GRAPH-SPEC.md` — human-readable ADR for the graph

**Mandatory node types (a node of each type MUST exist in the graph):**

| Type | Purpose | Example nodes |
|------|---------|---------------|
| SESSION | Lifecycle nodes framing each agent session | SESSION-START, IMPLEMENT, CLOSE-DEBT |
| GATE | Mandatory checkpoints | RULE-ZERO, VERIFY |
| PHASE | Production-readiness phases (P0-P16) | 17 phase nodes |
| VERIFY | Verification gates (tests, lint, build) | V-SERVER, V-AGENT, V-DASHBOARD, ... |
| ENFORCE | Enforcement paths (the lockdown features) | E-ENCRYPT, E-BCD, E-HP-UEFI, ... |
| COMPONENT | Buildable components | C-SERVER, C-DASHBOARD, C-AGENT, C-ELECTRON |
| EVIDENCE | Run artifacts proving execution | ARTIFACT |

**Session lifecycle (the only allowed path — no shortcuts):**

```
SESSION-START → RULE-ZERO → IMPLEMENT → VERIFY → ARTIFACT → CLOSE-DEBT
                                                              │
                                                              ▼
                                                         SESSION-START (next session)
```

**Graph invariants (enforced by graph_assert.py):**

- I1: No phase runs before its dependencies are COMPLETE
- I2: No debt item CLOSED without commit_ref + artifact_ref
- I3: No enforcement path marked "verified-on-hardware" without real hardware artifact
- I4: No session close without trace.md status block update
- I5: No code changes before RULE-ZERO is complete
- I6: Orchestrator must know about ALL 17 phases (resolved — D-001 CLOSED, all 17 phases present)
- I7: Every COMPLETE phase has non-empty artifact reference (resolved — D-002 CLOSED, all .complete files populated)

**Rule Zero (read before you code):**

Before writing a single line of code for any work item:
1. Read the relevant skill file(s) in `.devin/skills/`
2. Read the source code that will be changed
3. Read any ADRs in `docs/adr/` related to the work
4. Log your understanding to `.devin/graph/trace.md`
5. Only then open any source file for editing

Code written before Rule Zero is complete will be wrong in ways that are hard
to find later. This is not optional.

**Run artifacts (the only acceptable proof of completion):**

A passing test is NOT a close. A description of what code does is NOT a close.
A printed log from actual execution IS a close. "No setup detected" with
condition values printed IS an artifact. A timeout with no output is NOT.

**Session-end status block (mandatory at session close):**

Every session must end by appending a session-end block to
`.devin/graph/trace.md` (full history), then running `make gen-state` to
regenerate `.devin/graph/current-state.md` (compact summary) automatically.
The block must include:
- RULE-ZERO — Understanding logged before code changes (with `**Read**:` and `**Finding**:` lines)
- Fog cleared this session (with source citations)
- Fog remaining (genuinely not in source, with files checked listed)
- Debt items closed (commit refs + artifacts)
- Debt items still open
- Blockers named and status
- Next session opening — one sentence, specific, no ambiguity

`current-state.md` is a GENERATED artifact — do NOT edit it by hand. It is
derived from `trace.md` + `GRAPH-SPEC.yaml` by `scripts/graph_session.py`.
Graph invariant I4 enforces that both files have the session-end status block,
and the compactness invariant enforces that `current-state.md` has no
"Previous session" blocks and stays under 300 lines.

**Session lifecycle tooling:**
- `make gen-state` — regenerate current-state.md from trace.md + graph spec
- `make archive-trace` — rotate old sessions from trace.md to archive files
  (when trace.md exceeds 3000 lines, keeps latest 5 sessions)
- `python3 scripts/graph_session.py close-session --block-file <file>` —
  append a session block to trace.md AND regenerate current-state.md in one step

## Memory Harness (mandatory at session start and end)

The memory harness is a 5-stage file-based persistent memory system in
`.devin/memory/`. It lets the agent remember across sessions.

**Mandatory at session start — RETRIEVE:**
```bash
python3 scripts/memory.py retrieve --query "keywords from user request"
```
Load relevant memories before taking any action. Acknowledge loaded
memories in your first response. Working without memory is working blind.

**Mandatory at session end — CAPTURE:**
```bash
python3 scripts/memory.py capture \
  --task "what was asked" \
  --learnings "- learning 1" \
  --mistakes "- mistake: correction" \
  --files "- path/to/file"
```
A session without a capture is a lost session. File references are mandatory.

**Every 5 sessions — CONSOLIDATE:**
```bash
python3 scripts/memory.py consolidate
```

**Every 10 sessions — DECAY:**
```bash
python3 scripts/memory.py decay
```

**During session — RECONCILE (opportunistic):**
```bash
python3 scripts/memory.py reconcile --id m-001 --status confirmed
python3 scripts/memory.py reconcile --id m-001 --status wrong --replacement "corrected"
```

See `.devin/skills/memory/SKILL.md` for full documentation.

## Environment

- Node.js lives at `~/.local/node/bin` (NOT on default PATH). Prefix commands with
  `export PATH="/home/cllin/.local/node/bin:$PATH"` or add it to your shell rc.
- Python 3.14 is the interpreter (`python3`). Agent dev deps live in `agent/.venv`.
- Docker is NOT installed in this environment — docker-compose configs are validated
  structurally only (via `scripts/validate-docker.sh`).

## Verification Commands (clean sweep)

```bash
# Everything (unified runner): server Jest + agent pytest
export PATH="/home/cllin/.local/node/bin:$PATH"
npm test

# Per-component
cd server   && npm test                       # 368 Jest tests
cd agent    && python3 -m pytest tests/ -q    # 344 pytest tests
cd dashboard && npx vitest run                # 41 Vitest tests

# Lint
cd server    && npx eslint .                  # exit 0 = clean
cd dashboard && npx eslint .                  # exit 0 = clean
cd agent     && python3 -m ruff check .       # exit 0 = clean
cd agent     && python3 -m ruff format --check .

# Build
cd dashboard && npx vite build                # outputs dashboard/dist
cd electron  && node --check main.js preload.js setup-preload.js setup-wizard.js server-starter.js config.js updater.js

# Syntax sweep of all .js (not .jsx — JSX needs vite/vitest to validate)
find server/src electron -name '*.js' | grep -v node_modules | xargs -I{} node --check {}

# Shell scripts
bash -n scripts/*.sh

# Full environment + artifact verification (56 checks)
make verify-env
make check-structure      # non-fatal; electron/dist-electron is expected missing locally

# Graph session lifecycle (keeps trace.md and current-state.md compact)
make gen-state            # regenerate current-state.md from trace.md + graph spec
make archive-trace        # rotate old sessions to trace-archive-*.md when trace.md > 3000 lines
python3 scripts/test_graph_session.py  # test the session lifecycle tooling

# Full build (dashboard + agent + electron) — slow, needs PyInstaller + electron-builder
make build
```

## Known Local-Only Skip (not a failure)

- `installer-windows-execpolicy` — by design. The PS1 script intentionally does
  not set `ExecutionPolicy` internally; the caller invokes it with
  `-ExecutionPolicy Bypass`. Hardcoding `Set-ExecutionPolicy` inside an installer
  is bad practice. The script's PowerShell syntax is validated separately and passes.

## Docker (installed on this machine)

- Docker 29.1.3 + compose v2.40.3 installed via apt (`docker.io`, `docker-compose-v2`).
- The `docker` group was added to user `cllin`, but a new login session is needed
  for it to take effect. Until then, `sudo chmod 666 /var/run/docker.sock` grants
  socket access for the session (resets on reboot).
- The prod stack is started with `--env-file .env.prod` (required — Docker Compose
  only auto-loads `.env`, not `.env.prod`):
  ```bash
  docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
  ```

## Conventions

- Server is CommonJS (`require`/`module.exports`); dashboard is ESM (`"type": "module"`).
- **Frontend + backend are merged** — the server serves both the API (`/api/*`)
  and the built dashboard (static files + SPA fallback) from one Express process.
  CORS is only enabled when `CORS_ORIGIN` is set (dev with Vite on :5173).
- Agent Python is ruff-governed (`agent/ruff.toml`); 108 lint errors were previously
  driven to 0 — keep it that way.
- Do not duplicate build logic in the Makefile — delegate to `scripts/`.
- PS1 files are PowerShell, not bash — do not `bash -n` them (use `pwsh -NoProfile`
  if available; `verify-environment.sh` already does this).
- Caddyfile and `Dockerfile.server` are NOT YAML — do not YAML-validate them.
- `server/lockdown.db` is a dev artifact — never commit it (in `.gitignore`).
- Agent Python uses inline `# D-XXX:` comments to trace code to debt ledger entries
  (see `docs/adr/DEBT-LEDGER.md`). This is an established convention (26 instances
  across 5 agent files) — matching it is expected, not a violation.
- **Failure attribution convention**: When a failure occurs during a session
  (a test fails, a build breaks, an invariant is violated), the session-end
  trace block must include a "Failure attribution" subsection that names
  which of the 5 harness layers caused the failure and what harness change
  would prevent it. The 5 layers (from the WalkingLabs Harness Engineering
  course, Lecture 01):
  1. **Task specification** — requirements were vague or ambiguous
  2. **Context provision** — implicit conventions not written down
  3. **Execution environment** — incomplete setup, missing dependencies
  4. **Verification feedback** — no tests, no lint, or verification not communicated
  5. **State management** — cross-session state loss, no progress tracking
  This is a convention (guidance), not an enforced invariant — no graph_assert.py
  check. The convention prepares for future failures without backfilling a
  failure log with no data.

## Diagnostic Sweep Results (2026-08-04, updated 2026-08-11)

All green: 368 server tests, 344 agent tests, 41 dashboard tests, eslint clean on
server + dashboard, ruff clean + formatted on agent, vite build OK, all shell scripts
`bash -n` OK, all YAML configs valid, all local imports resolve, git tree clean.
`verify-environment.sh` final: **61 PASS / 0 FAIL / 1 SKIP** (the 1 skip is the
intentional `installer-windows-execpolicy` by-design skip).

Hardware test harness (D-003): `make hw-test-dry` runs the harness in dry-run mode.
`make hw-test` runs real enforcement path tests on Windows/HP hardware.

### Bugs found and fixed during the sweep

1. **`verify-environment.sh` nsis-compile guard bug** — `has node` (PATH-based
   `command -v`) ran before the `~/.local/node/bin/node` fallback, making the
   fallback unreachable. Fixed: guard now accepts either PATH node or the fallback.
2. **Docker Compose `.env.prod` not loaded** — `docker-compose.prod.yml` uses
   `${POSTGRES_PASSWORD}` interpolation, but Docker Compose only auto-loads `.env`,
   not `.env.prod`. The README and `validate-docker.sh` were missing `--env-file
   .env.prod`, so `docker compose up` failed with "superuser password not specified".
   Fixed: added `--env-file .env.prod` to both `README.md` and `validate-docker.sh`.
3. **`DB_SSL_VERIFY=false` still negotiated SSL** — `server/src/db/pool.js` treated
   `DB_SSL_VERIFY=false` as "use SSL but don't verify certs", but the docker-compose
   internal network has no SSL at all. The `pg` driver still tried to negotiate SSL
   and failed with "The server does not support SSL connections". Fixed: added a
   `DB_SSL` env var (`DB_SSL=false` disables SSL entirely); updated
   `docker-compose.prod.yml` to use `DB_SSL: "false"`.
4. **`verify-environment.sh` docker-live pipe race** — the live check used
   `"$validate_script" --live 2>&1 | grep -qi "pass|ok|healthy"`, but the large
   Docker build output on stderr caused a pipe race where grep sometimes missed
   the PASS line. Fixed: capture output to a variable first, then grep.
5. **Prod stack dashboard not served** — `Dockerfile.server` built and copied
   `dashboard/dist` into the image, but `server/src/index.js` had no
   `express.static` middleware. The dashboard was inaccessible in production.
   Fixed: added static serving + SPA fallback with proper cache headers
   (immutable for hashed assets, no-cache for index.html). Also made CORS
   conditional (only when `CORS_ORIGIN` is set) and added a 404 JSON handler
   for unmatched `/api/*` routes.

## Hardware Test Harness Redesign (planned, not yet implemented)

Research completed 2026-08-28. Decision: borrow patterns from existing frameworks rather than adopt a heavy dependency. Will redesign `agent/hw_test_harness.py` to v2.0.

### Frameworks evaluated (30+)
- OpenHTF (Google) — best HIL framework, phase/measurement/plug model, Apache-2.0
- bench-vv — binds test reports to firmware SHA-256, MIT
- f0_library — EDR testing with VHD isolation for destructive tests, Apache-2.0
- FleetDM osquery-perf — MDM command lifecycle simulator (Pending→Fetched→Acked→Error), MIT
- Windows-Red-Teaming — tri-mode (dry-run/check/simulate) with cleanup, MIT
- pytest-timeout, pytest-rerunfailures — timeout + retry for flaky network tests
- Allure + JUnit XML + CTRF — reporting standards
- Prey, Computrace, Jamf, Intune — no public HIL test harnesses found
- Robot Framework, pytest-embedded, LabGrid — good but overkill for our use case

### Patterns to borrow (12)
1. Phase lifecycle (OpenHTF): precondition → action → verify → cleanup
2. Service gating (pytest-embedded): --services hp,tpm,server,defender
3. Tri-mode (Windows-Red-Teaming): dry-run → check → simulate
4. Hash binding (bench-vv): record agent binary SHA-256 in every artifact
5. VHD isolation (f0_library): destructive tests target VHD, not real disk
6. Command lifecycle (FleetDM): test Pending → Fetched → Acked → Error → Canceled
7. Timeout protection (pytest-timeout): per-test timeout, default 60s
8. Retry logic (pytest-rerunfailures): retry network tests up to N times
9. CTRF JSON format: standardized test report with summary, tests[], extra
10. Tag-based filtering: --tag E-ENCRYPT,E-DURESS
11. Evidence capture (macOSLab): before/after state snapshots
12. Rollback (GhostWall): capture prior state, restore after destructive test

### Proposed v2.0 structure
- Environment detection (existing + TPM, Defender, agent binary hash)
- TestResult v2 (CTRF-compatible + evidence + rollback state)
- Test base class with phase lifecycle
- Timeout wrapper (per-test, default 60s)
- Retry wrapper (configurable, default 2 retries for network tests)
- Tri-mode execution (dry-run → check → simulate)
- Service gating (--services hp,tpm,server,defender)
- Tag-based filtering (--tag E-ENCRYPT,E-DURESS)
- 12 enforcement path tests:
  - E-ENCRYPT (enhanced with VHD isolation)
  - E-LOCK-SCREEN (enhanced with sentinel verification)
  - E-GUARDIAN (enhanced with re-lock verification)
  - E-BCD (enhanced with VHD isolation + rollback)
  - E-HP-UEFI (enhanced with rollback)
  - E-DURESS (new — fake unlock + re-lock after 5 min)
  - E-HIDDEN-FILE (new — file trigger → lockdown)
  - E-TAMPER (new — agent binary modification detection)
  - E-TPM (new — TPM sealing of state files)
  - E-ENROLL (new — token enrollment flow)
  - E-HWID (new — hardware ID collection)
  - E-INTEGRATION (new — full cycle: enroll → flag → lockdown → recover)
- Artifact generation (CTRF JSON + JUnit XML + agent binary hash)
- Artifact upload (POST to server for dashboard display)

### Current harness gaps (v1.0)
- Only 5 of 12+ enforcement paths tested
- No tests for duress, hidden trigger, tamper, TPM, enrollment, hardware IDs
- No agent↔server integration test
- No recovery/unlock test
- No ACK verification
- Lock-screen test is fire-and-forget (no sentinel verification)
- Guardian test doesn't verify re-lock
- No artifact upload to server
- Single --only flag (can't run multiple tests)
- No timeout protection
- No test for covert tracking (E-TRACK)

### Hardware testing status (as of 2026-08-28)
- HP machine (DESKTOP-RUDJGI6) successfully enrolled via one-click installer
- Hardware UUID: B1198844-32B1-419B-B6BB-07371BE2DDD0, MAC: 74:70:FD:17:B7:67
- Lockdown command received and executed on real hardware (status: locked)
- Recovery command received and executed (screen unlocked, files decrypted)
- Agent now runs windowless (console=False) with file logging
- Windows Defender exclusion auto-added by installer
- TODO: re-test on HP with windowless agent + Defender exclusion
- TODO: test duress code, hidden file trigger, tamper protection on hardware
