---
name: codebase-navigation
description: Navigate the project's graph structure, phases, enforcement paths, and debt ledger. Use at session start or when exploring unfamiliar parts of the codebase.
---

# Skill: Codebase Navigation

## When to use this skill

- **At session start** — to orient yourself before any work.
- **When exploring the codebase** — to find where things live and how they
  connect.
- **When looking for specific things** — "what work is left?", "what does
  phase N do?", "what enforcement paths exist?", "what debt is open?"
- **When you are lost** — the graph structure is the map. Start here.

## Project layout

```
remote-lockdown-system/
  server/          — Node.js / Express API + PostgreSQL/SQLite (CommonJS, Jest)
  dashboard/       — React + Vite + Tailwind admin UI (ESM, Vitest)
  agent/           — Python background agent (pytest, ruff)
  electron/        — Electron desktop app bundling server + dashboard + agent
  serverless/      — Cloudflare Worker for offline command queue
  scripts/         — single source of truth for build/verify logic (wrapped by Makefile)
  tests/e2e/       — API-level E2E tests (Jest + Supertest)
  tests/load/      — k6 load test scenarios
  docs/adr/        — architecture decision records + debt ledger
  .devin/graph/    — the node graph (center and heart of the project)
  .devin/skills/   — knowledge base (phase skills, harness skills, this skill)
  .devin/memory/   — 5-stage persistent agent memory storage
  .devin/orchestration/ — phase orchestrator + configs
  .github/workflows/ — CI pipeline (4 workflow files)
```

### Component details

| Component | Path | Language | Test framework | Build tool |
|-----------|------|----------|---------------|------------|
| Server | `server/` | JavaScript (CommonJS) | Jest 30 | npm (no build — runs directly) |
| Dashboard | `dashboard/` | JavaScript (ESM) | Vitest 3.2 | Vite |
| Agent | `agent/` | Python 3.14 | pytest 8 | PyInstaller |
| Electron | `electron/` | JavaScript | Jest 30 | electron-builder |
| Worker | `serverless/` | TypeScript | Vitest 2 | Wrangler |
| E2E | `tests/e2e/` | JavaScript | Jest + Supertest | — |
| Dashboard E2E | `dashboard/e2e/` | JavaScript | Playwright | — |

## The graph: .devin/graph/

The node graph is the center and heart of this project. Every agent session,
every phase transition, every verification gate, and every enforcement path
validation flows through the graph.

| File | Purpose | Read when |
|------|---------|-----------|
| `GRAPH-SPEC.yaml` | All nodes, edges, invariants, phases, enforcement paths, debt items | Session start (mandatory) |
| `current-state.md` | Generated compact session state (~100 lines) | Session start — **read this FIRST** |
| `trace.md` | Full session history (all session-end blocks) | On demand, for context |
| `trace-archive-*.md` | Rotated old sessions (when trace.md > 3000 lines) | Rarely — historical research |
| `graph_assert.py` | Invariant assertion engine (I1-I7) | Run via `make graph-check` |
| `graph_loader.py` | Graph spec parser (used by graph_session.py) | Internal — not usually read directly |
| `clean-state-checklist.md` | 5-condition clean state checklist | Run via `make clean-state` |

**Important**: `current-state.md` is a GENERATED artifact. Do NOT edit it
by hand. It is derived from `trace.md` + `GRAPH-SPEC.yaml` by
`scripts/graph_session.py`. To update it, append a session block to
`trace.md` and run `make gen-state`.

### Node types in the graph

| Type | Purpose | Example nodes |
|------|---------|---------------|
| SESSION | Lifecycle nodes framing each agent session | SESSION-START, IMPLEMENT, CLOSE-DEBT |
| GATE | Mandatory checkpoints | RULE-ZERO, VERIFY |
| PHASE | Production-readiness phases (P0-P16) | 17 phase nodes |
| VERIFY | Verification gates (tests, lint, build) | V-SERVER, V-AGENT, V-DASHBOARD, ... |
| ENFORCE | Enforcement paths (the lockdown features) | E-ENCRYPT, E-BCD, E-HP-UEFI, ... |
| COMPONENT | Buildable components | C-SERVER, C-DASHBOARD, C-AGENT, C-ELECTRON |
| EVIDENCE | Run artifacts proving execution | ARTIFACT |
| DEBT | Debt items tracked in DEBT-LEDGER.md | D-001 through D-021 |

### Graph invariants (enforced by graph_assert.py)

| ID | Rule |
|----|------|
| I1 | No phase runs before its dependencies are COMPLETE |
| I2 | No debt item CLOSED without commit_ref + artifact_ref |
| I3 | No enforcement path marked verified-on-hardware without real hardware artifact |
| I4 | No session close without trace.md status block update |
| I5 | No code changes before RULE-ZERO is complete |
| I6 | Orchestrator must know about ALL 17 phases (resolved) |
| I7 | Every COMPLETE phase has non-empty artifact reference (resolved) |

## The 17 phases: .devin/skills/phase-N-*/SKILL.md

Each phase has a skill file with context, research findings, reasoning
questions, and implementation guidelines.

| Phase | Name | Skill file | Status | Key deps |
|-------|------|-----------|--------|----------|
| P0 | build-foundation | `phase-0-build-foundation/SKILL.md` | COMPLETE | — |
| P1 | secrets-config | `phase-1-secrets-config/SKILL.md` | COMPLETE | — |
| P2 | platform-services | `phase-2-platform-services/SKILL.md` | COMPLETE | — |
| P3 | hardening | `phase-3-hardening/SKILL.md` | COMPLETE | P0, P1, P2 |
| P4 | cicd | `phase-4-cicd/SKILL.md` | COMPLETE | P0-P3 |
| P5 | signing-autoupdate | `phase-5-signing-autoupdate/SKILL.md` | COMPLETE | P4 |
| P6 | monitoring | `phase-6-monitoring/SKILL.md` | COMPLETE | P3 |
| P7 | e2e-testing | `phase-7-e2e-testing/SKILL.md` | COMPLETE | P0-P6 |
| P8 | deps-sast | `phase-8-deps-sast/SKILL.md` | COMPLETE | P4 |
| P9 | agent-e2e | `phase-9-agent-e2e/SKILL.md` | COMPLETE | P7 |
| P10 | dashboard-e2e | `phase-10-dashboard-e2e/SKILL.md` | COMPLETE | P7 |
| P11 | postgres | `phase-11-postgres/SKILL.md` | COMPLETE | P7 |
| P12 | docker | `phase-12-docker/SKILL.md` | COMPLETE | P11 |
| P13 | notifications-metrics | `phase-13-notifications-metrics/SKILL.md` | COMPLETE | P6 |
| P14 | backup-restore | `phase-14-backup-restore/SKILL.md` | COMPLETE | P11 |
| P15 | load-testing | `phase-15-load-testing/SKILL.md` | COMPLETE | P13 |
| P16 | rbac | `phase-16-rbac/SKILL.md` | COMPLETE | P3 |

All 17 phases are COMPLETE. The remaining work is enforcement path
hardware verification (see convergence table in current-state.md).

## The 13 enforcement paths

Defined in `GRAPH-SPEC.yaml` under `enforcement_paths`. These are the
actual lockdown features — the core of the system.

| ID | Name | Description | Status | Entry function |
|----|------|-------------|--------|----------------|
| E-ENCRYPT | file-encryption | Fernet encryption of LOCKDOWN_FOLDER | verified-on-hardware | `agent.encrypt_folder` |
| E-DECRYPT | file-decryption | Fernet decryption on recovery | verified-in-unit-test | `agent.decrypt_folder` |
| E-LOCK-SCREEN | workstation-lock | LockWorkStation/tsdiscon/CGSession | verified-on-hardware | `agent._lock_workstation` |
| E-GUARDIAN | lock-guardian | Background thread re-asserting lock every 10s | verified-on-hardware | `agent.start_lock_guardian` |
| E-BCD | bcd-lockdown | bcdedit to disable WinRE, boot menu, F8 | verified-on-hardware | `bcd_lockdown.apply_bcd_lockdown` |
| E-HP-UEFI | hp-uefi-lockdown | HP WMI SetBIOSSetting for USB, PXE, legacy, F12 | verified-in-unit-test | `hp_uefi_lockdown.apply_boot_lockdown` |
| E-ACK | command-ack | ACK with key_material + bios_password to server | verified-in-unit-test | `agent.ack_command` |
| E-RECOVERY | unlock-recovery | Server releases key, agent decrypts, removes sentinel | verified-in-unit-test | `agent.handle_unlock` |
| E-TRACK | covert-tracking | Silent geolocation reporting (wifi + IP geo) | verified-in-unit-test | `agent.handle_track` |
| E-DEADMAN | deadman-switch | Auto-lockdown if no server contact for 24h | verified-in-unit-test | `agent.check_deadman` |
| E-EFFECTIVENESS | lockdown-effectiveness | boot_lock_detail + lockdown_effective reporting | verified-in-unit-test | `agent.handle_lockdown` |
| E-OFFLINE-QUEUE | offline-queue | SQLite queue for location reports when offline | verified-in-unit-test | `agent.queue_offline` |
| E-AUTO-UPDATE | agent-auto-update | Download + verify + apply signed agent updates | verified-in-unit-test | `agent.check_for_update` |

**4 verified on hardware** (E-ENCRYPT, E-LOCK-SCREEN, E-GUARDIAN, E-BCD).
**9 still need hardware verification** — this is the remaining convergence
gap. Graph invariant I3 blocks marking them verified-on-hardware without
a real hardware artifact.

## The debt ledger: docs/adr/DEBT-LEDGER.md

The single source of truth for what needs to ship. Each debt item has:
- `id` (D-001 through D-021)
- `description`
- `close_criteria`
- `status` (OPEN or CLOSED)
- `commit_ref` (required for CLOSED — enforced by I2)
- `artifact_ref` (required for CLOSED — enforced by I2)

**All debt items are CLOSED.** The remaining work is hardware verification
of the 9 enforcement paths still at `verified-in-unit-test`.

## The memory system: .devin/memory/ + scripts/memory.py

A 5-stage file-based persistent memory system:

| Stage | When | Command |
|-------|------|---------|
| RETRIEVE | Session start (mandatory) | `python3 scripts/memory.py retrieve --query "keywords"` |
| CAPTURE | Session end (mandatory) | `python3 scripts/memory.py capture --task "..." --learnings "..." --mistakes "..." --files "..."` |
| CONSOLIDATE | Every 5 sessions (auto) | `python3 scripts/memory.py consolidate` |
| DECAY | Every 10 sessions (auto) | `python3 scripts/memory.py decay` |
| RECONCILE | Opportunistic | `python3 scripts/memory.py reconcile --id m-001 --status confirmed` |

Memory storage layout:
- `.devin/memory/raw/` — raw session captures (`sess-*.md`)
- `.devin/memory/consolidated/` — consolidated memories
- `.devin/memory/decayed/` — decayed old memories
- `.devin/memory/index.md` — memory index

See `.devin/skills/memory/SKILL.md` for full documentation.

## Other skills in .devin/skills/

| Skill | Path | Purpose |
|-------|------|---------|
| graph-session-lifecycle | `graph-session-lifecycle/SKILL.md` | Mandatory session lifecycle (SESSION-START -> ... -> CLOSE-DEBT) |
| hw-test-harness-v2 | `hw-test-harness-v2/SKILL.md` | Hardware test harness v2.0 (12 enforcement path tests) |
| verify-environment | `verify-environment/SKILL.md` | Environment verification runbook (61 checks) |
| codebase-navigation | `codebase-navigation/SKILL.md` | This skill — navigating the project structure |
| memory | `memory/SKILL.md` | 5-stage persistent agent memory system |
| code-review | `code-review/SKILL.md` | Code review skill |
| research | `research/SKILL.md` | Research skill |
| wayfinder | `wayfinder/SKILL.md` | Wayfinder hardening tickets |
| wizard | `wizard/SKILL.md` | Wizard skill |
| grill-me | `grill-me/SKILL.md` | Grilling skill |
| grill-with-docs | `grill-with-docs/SKILL.md` | Grilling with docs skill |

## How to find things

| Question | Where to look |
|----------|---------------|
| "What work is left?" | `.devin/graph/current-state.md` — convergence table + next session opening |
| "What does phase N do?" | `.devin/skills/phase-N-*/SKILL.md` |
| "What enforcement paths exist?" | `.devin/graph/GRAPH-SPEC.yaml` — `enforcement_paths` section |
| "What debt is open?" | `docs/adr/DEBT-LEDGER.md` (or current-state.md "Open debt items" section) |
| "What happened in previous sessions?" | `.devin/graph/trace.md` (full history) or `trace-archive-*.md` (old) |
| "What are the graph invariants?" | `.devin/graph/GRAPH-SPEC.yaml` — `invariants` section |
| "How do I run tests?" | `make test` (all) or see AGENTS.md "Verification Commands" |
| "How do I verify the build?" | `make verify-env` (61 checks) or `make full-verify` (everything) |
| "How do I run hardware tests?" | `make hw-test-dry` (dry-run) or `make hw-test` (simulate) |
| "What CI gates exist?" | `.github/workflows/ci.yml` — 11 jobs (all depend on graph-check) |
| "What conventions must I follow?" | `AGENTS.md` — "Conventions" section |
| "What is the session lifecycle?" | `.devin/skills/graph-session-lifecycle/SKILL.md` |
| "How does the memory system work?" | `.devin/skills/memory/SKILL.md` |
| "Where is the agent source?" | `agent/` — `agent.py`, `bcd_lockdown.py`, `hp_uefi_lockdown.py`, `duress.py`, `tamper_protection.py`, `tpm_seal.py`, etc. |
| "Where is the server API?" | `server/src/` — `routes/`, `db/`, `middleware/`, `notifications/`, `jobs/` |
| "Where is the dashboard UI?" | `dashboard/src/` — `pages/`, `components/`, `hooks/`, `api/` |

## Key Makefile targets

| Target | What it does |
|--------|-------------|
| `make gen-state` | Regenerate `current-state.md` from `trace.md` + graph spec |
| `make graph-check` | Run `graph_assert.py` — all 7 invariants (I1-I7) |
| `make graph-status` | Print convergence report (phases, debt, enforcement gaps) |
| `make full-verify` | Everything: graph-check + lint + tests + e2e + verify-env + artifacts |
| `make verify-env` | 61 environment checks (PyInstaller, NSIS, Docker, Electron, signing) |
| `make check-structure` | Check dist dirs exist (non-fatal) |
| `make test` | All test suites (server + agent + dashboard) |
| `make test-e2e` | API-level E2E tests |
| `make test-e2e-dashboard` | Playwright browser E2E tests |
| `make hw-test` | Hardware test harness v2.0 (simulate mode) |
| `make hw-test-dry` | Hardware test harness dry-run |
| `make hw-test-check` | Hardware test harness eligibility check |
| `make build` | Full build (dashboard + agent + electron) |
| `make lint` | Lint all components (eslint + ruff) |
| `make archive-trace` | Rotate old sessions from trace.md to archive files |
| `make clean-state` | Run 5-condition clean state checklist |
| `make clean` | Remove all dist/ directories |

## Mandatory reads at session start

1. `.devin/graph/current-state.md` — **read FIRST** (generated, ~100 lines)
2. `.devin/graph/GRAPH-SPEC.yaml` — all nodes, edges, invariants
3. `docs/adr/DEBT-LEDGER.md` — open debt items and close criteria
4. `docs/adr/GRAPH-SPEC.md` — human-readable ADR for the graph (optional)
5. `AGENTS.md` — project-specific guidance and conventions
6. Retrieve memory: `python3 scripts/memory.py retrieve --query "keywords"`

## Key files quick reference

| File | Purpose |
|------|---------|
| `AGENTS.md` | Project-specific guidance for AI agents (start here) |
| `.devin/graph/GRAPH-SPEC.yaml` | The node graph spec (center of the project) |
| `.devin/graph/current-state.md` | Generated compact session state (read first) |
| `.devin/graph/trace.md` | Full session history |
| `docs/adr/DEBT-LEDGER.md` | Debt items with close criteria |
| `docs/adr/GRAPH-SPEC.md` | Human-readable graph ADR |
| `Makefile` | Developer convenience targets (wraps scripts/) |
| `scripts/graph_session.py` | Session lifecycle tool |
| `scripts/memory.py` | Memory system CLI |
| `scripts/verify-environment.sh` | Environment verification (61 checks) |
| `agent/hw_test_harness.py` | Hardware test harness v2.0 |
| `.github/workflows/ci.yml` | CI pipeline (11 jobs) |
