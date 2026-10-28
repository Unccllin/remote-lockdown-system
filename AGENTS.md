# AGENTS.md — Remote Lockdown System

Project-specific guidance for AI agents working in this repo.

## Project Layout

- `server/` — Node.js / Express API + PostgreSQL/SQLite (CommonJS, Jest)
- `dashboard/` — React + Vite + Tailwind admin UI (ESM, Vitest)
- `agent/` — Python background agent (pytest, ruff)
- `electron/` — Electron desktop serverless shell: serves the built dashboard
  and points the UI at a Cloudflare Worker (no local database, no bundled server)
- `scripts/` — single source of truth for build/verify logic (wrapped by Makefile)
- `.devin/skills/phase-N-*` — knowledge base for the 17 production-readiness phases
- `.devin/skills/memory/` — **memory harness skill** (5-stage persistent agent memory)
- `.devin/memory/` — **memory storage** (raw/, consolidated/, decayed/, index.md)
- `.devin/graph/` — **the node graph** (center and heart of the project)
- `docs/adr/` — architecture decision records + debt ledger
- `docs/research/STUDY-INDEX.md` — master cross-reference for the nine PBL technical-study notes (UEFI, EDK II, TPM, Intel, Windows, bootkits, academic, talks, blogs/EDK II pitfalls)

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
3. `docs/adr/DEBT-LEDGER.md` — legacy debt items (D-001..D-021, all CLOSED)
4. `docs/adr/PBL-DEBT-LEDGER.md` — PBL debt items (D-100..D-211, 37 OPEN)
5. `docs/adr/GRAPH-SPEC.md` — human-readable ADR for the graph

**CRITICAL: The debt ledger can be stale.** Before treating any debt item's
"Blocker" text as ground truth, verify the actual codebase state. Multiple
sessions have "discovered" that code was already implemented when the ledger
said it wasn't. Always check: `wc -l <file>` for stub vs. real implementation,
`grep -c` for route/function existence, and `grep -c "it(" <test>` for test
coverage. Update stale ledger entries during RULE-ZERO, not after.

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

**What current-state.md contains, and why it stays short.** The generator copies
only the latest session's *state* sections — `Fog cleared`, `Fog remaining`,
`Debt items closed`, `Debt items still open`, `Blockers`, `Session artifacts`,
`Failure attribution`, `VERIFY`, `Next session opening`. RULE-ZERO reading lists
and IMPLEMENT changelogs stay in `trace.md`, because they are history: a session
block may now be as long as the work warrants without inflating this file.

If even the state sections would breach the compactness limit (260 lines of body,
300 for the file), the generator drops the optional ones first
(`Session artifacts` → `Failure attribution` → `VERIFY`), then truncates, always
leaving an explicit pointer to `trace.md` and naming what was dropped. So the I4
compactness invariant can no longer be broken by authoring — and there is no
reason to split a session block by hand to satisfy it. `scripts/test_graph_session.py`
locks this behaviour (11 tests, auto-discovered: a hand-maintained call list was
silently skipping new tests, the same failure mode as `test_memory.py` having no
runner at all).
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

**Every 5 sessions — CONSOLIDATE (automated):**
Consolidate runs automatically when `close-session` detects the raw session
count is a multiple of 5. You can also run it manually:
```bash
python3 scripts/memory.py consolidate
```

**Every 10 sessions — DECAY (automated):**
Decay runs automatically when `close-session` detects the raw session count
is a multiple of 10. You can also run it manually:
```bash
python3 scripts/memory.py decay
```

**During session — RECONCILE (opportunistic):**
```bash
python3 scripts/memory.py reconcile --id m-001 --status confirmed
python3 scripts/memory.py reconcile --id m-001 --status wrong --replacement "corrected"
```

See `.devin/skills/memory/SKILL.md` for full documentation.

## Brain — Belief Layer (mandatory at session start)

`.devin/brain/` is the project's semantic memory: atomic beliefs with evidence
levels and supersession history. Where memory records what *happened*, the
brain records what is *believed true* and why.

**Mandatory at session start — before asserting or building on any non-trivial
claim:**
```bash
python3 scripts/brain.py retrieve --query "<keywords from the task>"
```
Check for `KILLED` tags — refuted beliefs return with their corrections. A
claim not in the store is `assumed` until verified.

**During session:**
- New finding → `brain.py assert`
- Verified → `brain.py confirm` (requires evidence level + provenance)
- Found wrong → `brain.py refute` (requires a replacement; dependents auto-demote)

**At session end** — `brain.py gen-view` if beliefs changed; `brain.py check`.

Evidence ladder: `assumed < code-read < spec-checked < emulated < real-media <
hardware`. Never cite a belief above its evidence level — emulated is not
hardware-verified. `.devin/brain/BELIEFS.md` is GENERATED — do not edit by hand.

See `.devin/skills/brain/SKILL.md` for full documentation.

## Mode Discipline (guardrail — mandatory)

Two failure modes have been observed repeatedly: (a) implementing code while a
design ruling/grilling is still open, (b) interpreting "proceed"/"go"/"continue"
as an execution license during a discussion.

**The gate:** `.devin/PENDING-RULING.md` holds the user's open questions as
`- [ ]` checkboxes. While any `- [ ]` item exists, the session is in
**DISCUSSION MODE**:

- **No code edits.** Read, research, plan — do not modify source files.
- Ambiguous imperatives mean **continue the ruling** — present the next
  question or the recommended answer, never start implementing.
- Code resumes only when no `- [ ]` items remain **or** the user names a
  concrete task explicitly (e.g., "fix Mor.c", "take NG-T4").

**Run the check before any code edit:**
```bash
scripts/check-ruling.sh   # exits 1 while ruling items are open
```

**Maintaining the file:** when you open questions for the user (grillings,
rulings, multi-option decisions), add them as `- [ ]` items. When the user
answers, mark `[x]` with a one-word outcome note. Delete answered sections as
they close — the file is live state, not a log.

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
cd server   && npm test                       # 663 Jest tests
scripts/run-agent-tests.sh -q                 # 689 pytest tests (uses agent/.venv)
cd dashboard && npx vitest run                # 197 Vitest tests
cd electron  && npm test                      # 30 Jest tests
cd serverless && npm test                     # 331 Vitest tests

# Coverage gate (all 5 components; floors declared per component, dated 2026-10-27)
make test-coverage

# Dependency advisories: the CI audit gate (npm audit --audit-level=high) covers
# server + dashboard; the agent is audited with pip-audit. vitest 4 requires the
# dashboard/serverless configs to be ESM (serverless uses vitest.config.mts).
cd server && npm audit --audit-level=high      # must exit 0
cd dashboard && ../scripts/audit-with-exceptions.sh

# Static analysis (Semgrep p/default; gates on ERROR severity only)
make sast

# Docker: both images run as the unprivileged `node` user. SQLite mode needs a
# writable /data (an empty named volume inherits ownership from the image; a host
# bind mount must be chowned). Each build context needs its OWN .dockerignore —
# Docker only reads it from the context root, so the repo-root file does not apply
# to `context: ./server`, and the host's node_modules leaked in and broke the
# image with a glibc mismatch.

# Load harness smoke: starts a throwaway server, seeds HMAC-keyed devices and runs
# a small signed k6 scenario (needs k6 on PATH, or K6_BIN=/path/to/k6)
make load-smoke

# NOTE: pytest must run through scripts/run-agent-tests.sh, which picks
# agent/.venv/bin/python. A bare `python3 -m pytest` fails on machines whose
# system Python lacks pytest-timeout (pyproject sets --timeout=30).

# Lint
cd server    && npx eslint .                  # exit 0 = clean
cd dashboard && npx eslint .                  # exit 0 = clean
cd agent     && python3 -m ruff check .       # exit 0 = clean
cd agent     && python3 -m ruff format --check .

# Workflow lint — must match CI. CI runs actionlint v1.7.12 through
# raven-actions/actionlint, which BUNDLES shellcheck, so CI also lints the shell
# inside every `run:` block. A box without shellcheck makes actionlint skip
# those checks and print green: that asymmetry let five SC2155 findings in
# pbl-ci.yml sit in a red "Lint Workflows" job while `actionlint` was clean
# locally (2026-10-28). `make lint-workflows` therefore fails when either tool
# is missing instead of silently linting less than CI does.
make lint-workflows                           # actionlint + shellcheck, exit 0 = clean

# Build
cd dashboard && npx vite build                # outputs dashboard/dist
cd electron  && node --check main.js preload.js setup-preload.js setup-wizard.js server-starter.js config.js updater.js

# Syntax sweep of all .js and .cjs (not .jsx — JSX needs vite/vitest to validate)
find server/src electron -name '*.js' -o -name '*.cjs' | grep -v node_modules | xargs -I{} node --check {}

# Shell scripts
bash -n scripts/*.sh && bash -n .devin/orchestration/orchestrator.sh

# Full environment + artifact verification (61 checks)
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

## Diagnostic Sweep Results (2026-08-04, updated 2026-10-27)

All green: 663 server tests (41 suites), 689 agent tests, 197 dashboard tests,
30 electron tests, 331 serverless tests, 10 API E2E tests, 71 script-harness tests
(27 graph-session + 44 memory), eslint clean on server + dashboard, ruff clean + formatted on
agent, vite build OK, all shell scripts `bash -n` OK, all YAML configs valid, all
local imports resolve, git tree clean. Also green: `make pg-smoke` 65/65 on real
PostgreSQL 16, API+agent E2E 10/10, `actionlint` 1.7.12 clean on all 5 workflows.
Not runnable on this host: Playwright + Electron (missing `libnspr4.so`).
**`make full-verify` now covers all five component suites** (server, agent,
dashboard, worker, electron) plus the script-level harness tests, E2E, env and
artifact checks — it previously ran only three of the five while its own comment
claimed "all 5 test suites". Current measured totals: server 663 (41 suites),
agent 689, dashboard 197, worker 331, electron 30, API E2E 10, script harness 71.

The script-level harness tests are **auto-discovered** (`scripts/test_*.py`, run
by `make test-scripts` and the CI `script-tests` job): 11 graph-session tests
(40 checks), 44 memory tests, 10 secret-scanner tests (19 checks).

Invariant coverage is now complete: I1 (phase deps), I2 (no debt closed without
commit + artifact), I4, I5, I6 (orchestrator knows every phase) and I7 all have
tests in `agent/tests/test_graph_assertions.py`; I3 gained 15 earlier.

Two harness bugs found while completing this (both fixed):
1. `scripts/test_memory.py` had 44 pytest tests and **no `__main__` block**, so
   `python3 scripts/test_memory.py` imported them, ran none, and exited 0 — which
   is exactly how the CI `script-tests` job invoked it. That job had never run a
   single memory test. It now has a runner, and CI installs pytest (it only
   installed pyyaml, so the suite could not have run there either).
2. The server suite had no test for the boot order or for the load-test HMAC
   signing contract; both were verified by hand. Now
   `server/tests/bootOrder.test.js` spawns the real entry point against a fresh
   SQLite DB (verified to fail when the bug is reintroduced) and
   `server/tests/loadSigning.test.js` locks the signing scheme in 11 tests.

`verify-environment.sh` final: **60 PASS / 0 FAIL / 2 SKIP** (the skips are the
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

## Hardware Test Harness v2.0 (implemented 2026-08-28)

Redesigned from v1.0 with 12 patterns borrowed from established HIL frameworks.
The harness is at `agent/hw_test_harness.py` (v2.0).

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

### Current harness gaps (v1.0 — ALL FIXED in v2.0)
- ~~Only 5 of 12+ enforcement paths tested~~ → 12 tests now
- ~~No tests for duress, hidden trigger, tamper, TPM, enrollment, hardware IDs~~ → all added
- ~~No agent↔server integration test~~ → E-INTEGRATION test added
- ~~No recovery/unlock test~~ → E-INTEGRATION covers recover
- ~~No ACK verification~~ → E-INTEGRATION covers command lifecycle
- ~~Lock-screen test is fire-and-forget~~ → sentinel verification added
- ~~Guardian test doesn't verify re-lock~~ → verify phase added
- ~~No artifact upload to server~~ → --upload flag added
- ~~Single --only flag~~ → --tag flag for multiple tests
- ~~No timeout protection~~ → per-test timeout with threading
- ~~No test for covert tracking (E-TRACK)~~ → tracked via E-INTEGRATION

### Hardware testing status (as of 2026-08-28)
- HP machine (DESKTOP-RUDJGI6) successfully enrolled via one-click installer
- Hardware UUID: B1198844-32B1-419B-B6BB-07371BE2DDD0, MAC: 74:70:FD:17:B7:67
- Lockdown command received and executed on real hardware (status: locked)
- Recovery command received and executed (screen unlocked, files decrypted)
- Agent now runs windowless (console=False) with file logging
- Windows Defender exclusion auto-added by installer
- TODO: re-test on HP with windowless agent + Defender exclusion
- TODO: test duress code, hidden file trigger, tamper protection on hardware

## Complete Harness Audit (2026-08-28)

Audited all 21 harnesses/subsystems in the project. Findings and improvement
opportunities recorded below. This is the baseline for the harness evolution
work — pick up here tomorrow.

### Harness inventory (21 total)

| # | Harness | Tests/Items | Framework | Coverage |
|---|---------|------------|-----------|----------|
| 1 | Server unit/API | 368 | Jest 30 | None |
| 2 | Agent unit/integration | ~463 | pytest 8 | None |
| 3 | Dashboard unit | 84 | Vitest 3.2 | None |
| 4 | Serverless Worker | 54 | Vitest 2 | None |
| 5 | Electron | 30 | Jest 30 | None |
| 6 | E2E (API + Playwright) | 14 | Jest + Playwright | N/A |
| 7 | Memory | 129 memories | Custom Python | None |
| 8 | Hardware (HIL) | 5 paths | Custom Python | N/A |
| 9 | CI/CD | 4 workflows | GitHub Actions | N/A |
| 10 | Load testing | 3 scenarios | k6 | N/A |
| 11 | Docker test compose | 1 stack | Docker Compose | N/A |
| 12 | Graph assertion | 7 invariants | Custom Python | None |
| 13 | PostgreSQL smoke | 1 flow | Custom Node | N/A |
| 14 | Code review skill | N/A | Agent skill | N/A |
| 15 | Firmware/UEFI | 6 test scripts | QEMU/OVMF + swtpm | N/A |
| 16 | Phase orchestrator | 17 phases | Bash + configs | N/A |
| 17 | Harness template | Template | Python | N/A |
| 18 | Wayfinder hardening | 4 tickets | Markdown | N/A |
| 19 | Manual boot lockdown | 8 commands | Python CLI | N/A |
| 20 | Electron simulation | 1 script | Node + Express | N/A |
| 21 | Clean-state checklist | 5 conditions | Markdown | N/A |

### Improvements by harness

#### 1. Server (368 tests) — 7 improvements
- ~~No coverage reporting~~ — **DONE 2026-10-27**: `npm run test:coverage` gates at 66/62/70/67
  (stmt/branch/func/line) in `jest.config.js`; CI runs it in place of `npm test`.
- No shared fixtures/factories (DEVICE, adminToken duplicated inline)
- Fragile SQL substring matching in mockPool.setResult()
- No __mocks__ directory (manual require in every file)
- No global setup/teardown (migrations + env cleanup duplicated)
- maxWorkers=1 forced due to PGlite singleton (slow CI)
- No serverless/worker integration tests

#### 2. Agent (~463 tests) — 9 improvements
- No conftest.py (cfg, tmp_folder, tmp_sentinel duplicated across 3+ files) — **largely
  addressed**: `tests/conftest.py` exists with those three fixtures.
- No pytest.ini or pyproject.toml (no markers, addopts, timeouts)
- No pytest.mark.parametrize anywhere (0 occurrences)
- No coverage reporting (no pytest-cov, .coveragerc) — **DONE 2026-10-27**:
  `fail_under = 59` in `pyproject.toml`; `make test-coverage` passes
  `--cov-fail-under=59` (pytest-cov decides on the flag, not on `fail_under`).
- test_boot_lockdown.py is 3,056 lines (split into BCD + HP UEFI)
- test_tamper_protection.py skips on Windows (backwards skip logic)
- No tests for watchdog.py, offline_recovery.py, diagnose_boot_lockdown.py
- Hardware harness only has unit tests (real paths not in CI)
- No timeout protection (hanging test hangs forever)

#### 3. Dashboard (84 tests) — 7 improvements
- ~~No coverage reporting~~ — **DONE 2026-10-27**: thresholds 58/68/50/58 in
  `vitest.config.js`; the coverage script raises `--testTimeout` to 60s because
  v8 instrumentation roughly doubles render cost.
- No renderWithRouter helper (each test redefines MemoryRouter)
- @testing-library/user-event installed but unused (all use fireEvent)
- Download buttons not tested (download-installer-btn, download-agent-btn)
- EnrollPage.jsx has no test file (download logic untested)
- No MSW (API mocked via vi.mock, no contract testing)
- No negative-state tests (loading, 404, network error, malformed JWT)

#### 4. Worker (54 tests) — 5 improvements
- Not tested against real Workers runtime (plain Vitest, not Miniflare)
- All 54 tests in one 1,273-line file
- Import path mismatch risk (imports ./worker.js, source is worker.ts)
- Several endpoints not tested (uninstall-auth, command-ack edge cases)
- No deployed/Wrangler integration test

#### 5. Electron (30 tests) — 6 improvements
- Main process (main.js) not tested (BrowserWindow, single-instance, lifecycle)
- IPC completely untested (preload.js, setup-preload.js contextBridge)
- Setup wizard not tested end-to-end (only validateWorkerUrl helper)
- Updater logic not tested (updater.js has no test file)
- No Electron-runtime tests (runs Jest in Node, not electron.launch)
- No E2E smoke test for built app

#### 6. E2E (14 tests) — 8 improvements
- No make test-e2e target (E2E orphaned from main workflow)
- Playwright is Chromium-only (no Firefox/WebKit)
- No E2E for enrollment, map, admins, duress flow
- Agent E2E doesn't test HMAC, offline queue, deadman, tracking, auto-update, tamper
- run-e2e.sh doesn't run Playwright (two separate harnesses)
- No screenshot/video artifacts on API/agent E2E failure
- No CI wiring for Playwright
- Agent E2E kills+relaunches agent before each command (hack, not realistic)

#### 7. Memory (129 memories) — 9 improvements
- "Every 5/10 sessions" not enforced (consolidate/decay are manual)
- No file locking or atomic writes (race conditions in ID generation)
- Floating-point confidence artifacts (0.6000000000000001 in files)
- Deduplication brittle (first 5 words only — false positives/negatives)
- Retrieve is keyword-only (no stemming, stopwords, semantic, typo tolerance)
- reconcile creates fake session IDs (provenance chain broken)
- No corruption handling (malformed files crash stage_index)
- No size cap on raw/ (captures never deleted, grow indefinitely)
- No CLI-level tests (tests use fake argparse, never run memory.py as subprocess)

#### 8. Hardware HIL (5 paths) — 12 improvements (covered in harness redesign plan above)

#### 9. CI/CD (4 workflows) — 6 improvements
- No graph-check in release.yml (tag can release with violations)
- Duplicated lint paths (lint.yml vs release.yml inline different commands)
- No ruff format --check in lint.yml (only ruff check)
- No shellcheck for scripts/*.sh (only bash -n)
- No SLSA/SBOM/provenance in release pipeline
- No concurrency block in release.yml (multiple tags can race)

#### 10. Load testing (3 scenarios) — 5 improvements
- Not wired to CI or scheduled (manual only)
- No HMAC signing in k6 scripts (will break when REQUIRE_HMAC=true)
- No result persistence (stdout only, no regression tracking)
- No make load-test target
- No server-side metrics (CPU, memory, DB pool)

#### 11. Docker test compose — 3 improvements
- Never actually run in CI (only structural validation)
- Weak test secrets committed in file
- No integration with E2E or load testing

#### 12. Graph assertion — 4 improvements
- Doesn't verify cited files exist (RULE-ZERO refs, hardware_artifact_ref)
- No self-tests (no test_graph_assert.py with known good/bad fixtures)
- Structural checks can be gamed (any / counts as file reference)
- Failure attribution convention not enforced

#### 13. PostgreSQL smoke — 3 improvements
- Not in CI (manual only, requires real Postgres)
- 480 lines in one file with no test framework structure
- No scheduled run (should be nightly with Postgres service container)

#### 14. Code review skill — 2 improvements
- Not integrated with GitHub PR checks (manual only)
- Wrong directory (.agents/skills/ not .devin/skills/)

#### 15. Firmware/UEFI — 5 improvements
- No CI integration (QEMU/swtpm tests are manual)
- No test result artifacts (stdout only)
- No regression tracking
- DNS tunnel tests have no assertions (manual verification only)
- UEFI variable round-trip test requires real hardware (no QEMU-only path)

#### 16. Phase orchestrator — 2 improvements
- No test coverage for orchestrator.sh itself
- Task queue files not cleaned up after completion

#### 17-21. Template, Wayfinder, Manual boot lockdown, Electron sim, Clean-state
- These are documentation/convention artifacts, not test harnesses
- Wayfinder tickets T1-T3 are CLOSED but Q1 (Goodhart) should be verified
- Clean-state checklist exists but is not enforced by any tooling

### Code scanning (verified 2026-10-28)

`codeql.yml` cannot run here: code scanning on a **private** repository requires
GitHub Code Security, and without it the SARIF upload returns
`403: GitHub Code Security or GitHub Advanced Security is not enabled`. The job is
therefore gated on the repository variable `CODE_SECURITY_ENABLED` so it skips
instead of failing every push. The equivalent coverage comes from **Semgrep**
(`sast-semgrep` job, `make sast`), plus the existing eslint-plugin-security
(server + dashboard), ruff `S` rules (agent) and cppcheck (firmware).

### Cross-cutting themes (apply to ALL harnesses)
1. ~~No coverage reporting anywhere~~ — **DONE 2026-10-27 for all 5 components**
   (server, dashboard, agent, electron, serverless): floors live in each
   component's config, `make test-coverage` enforces them locally, and the CI
   jobs run the same scripts in place of the plain test commands.
2. No shared fixtures (every harness duplicates setup code)
3. New features untested (download, duress, enrollment, tamper have gaps)
4. No timeout protection (agent, server, memory tests can hang)
5. No parametrize (agent has 0 parametrized tests)
6. E2E is orphaned (not in Makefile, not in CI, not in verify-env) — **stale**:
   `make test-e2e` / `make test-e2e-dashboard` exist and Playwright runs in
   `ci.yml`.
7. Large files not split (test_boot_lockdown.py 3056 lines, worker.test.ts 1273, test_agent.py 2027, memory.py 1360)
8. No concurrency protection (memory harness has race conditions)
9. Manual processes that should be automated (consolidate/decay, E2E, convergence)
10. Firmware/UEFI tests entirely outside CI

### Priority ranking for improvements

P0 (low effort, benefit all):
- ~~Add coverage reporting to all 7 test harnesses~~ — done for the 5 code
  components; the remaining harnesses (graph, memory, firmware) still have none
- Add conftest.py / shared fixtures (agent, server, dashboard)
- Add make full-verify + make test-e2e
- Automate memory consolidate/decay (hook into session close)

P1 (medium effort, high impact):
- Test new features (download, duress, enrollment, tamper)
- Add timeout protection (agent, server, memory)
- Fix memory race conditions (atomic writes, file locking)
- Split mega test files (agent, worker, memory)
- Fix backwards skip logic in test_tamper_protection.py
- Round confidence values in memory harness
- Add graph-check to release.yml
- Add ruff format --check to lint.yml

P2 (medium-high effort):
- Add pytest.mark.parametrize to agent
- Switch dashboard from fireEvent to user-event
- Add Electron runtime tests (IPC, main process)
- Add Miniflare for Worker
- Add MSW for dashboard contract testing
- Improve memory retrieve (stemming, stopwords)
- Fix memory reconcile provenance (fake session IDs)
- Add corruption handling to memory harness
- Wire firmware/UEFI tests into CI (QEMU + swtpm service)
- Add HMAC signing to k6 load tests

P3 (low effort, nice to have):
- Enable Firefox/WebKit in Playwright
- Convert test_graph_session.py to pytest
- Add convergence gate to verify-env
- Add size cap/rotation for raw/ captures
- Add shellcheck to lint.yml
- Add PostgreSQL smoke to nightly CI
- Add make load-test target
- Add graph_assert.py self-tests
