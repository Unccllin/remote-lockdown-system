---
name: phase-15-load-testing
description: k6 load testing scripts for baseline polling, lockdown spike, and mixed traffic scenarios
---

# Phase 15 — Load Testing

## Context

The system needs to handle fleets of 1000+ devices polling every 30s. That's
~33 requests/second baseline, with spikes during lockdown (all devices get
commands simultaneously). This phase adds load testing infrastructure.

## Current State

### k6 Load Test Scripts
- `tests/load/k6-baseline.js` — baseline polling scenario
  - 1000 virtual users (VUs), each polling every 30s (~33 req/s sustained)
  - Each VU: authenticate as agent → checkin → sleep 30s
  - Thresholds: p95 < 500ms, error rate < 1%
  - Duration: 5 minutes
- `tests/load/k6-lockdown-spike.js` — lockdown spike scenario
  - 1000 VUs all polling simultaneously
  - All receive lockdown command → all ACK
  - Measures server response time under spike load
- `tests/load/k6-mixed.js` — mixed traffic scenario
  - 90% agent polling, 5% admin dashboard, 5% ACKs
  - Realistic traffic mix

### Load Test Runner
- `scripts/run-load-test.sh` — load test runner
  - `--scenario <baseline|lockdown|mixed|all>` — which test
  - `--url <server-url>` — target server (default: `http://localhost:3001`)
  - `--vus <count>` — override VU count
  - `--duration <time>` — override duration
  - Checks k6 is installed, runs test, reports results
  - Exit 0 on success

### Documentation
- `docs/LOAD_TESTING.md` — load testing documentation
  - How to install k6
  - How to run each scenario
  - How to interpret results
  - Performance benchmarks/baselines
  - Tuning recommendations

### Metrics Collected
- `http_req_duration` (p95, p99)
- `http_req_failed` (error rate)
- `vus` (active virtual users)
- `iterations_per_second` (throughput)
- Server-side: CPU, memory, DB connection pool usage

## Verification

```bash
# Verify k6 scripts exist
ls tests/load/k6-baseline.js tests/load/k6-lockdown-spike.js tests/load/k6-mixed.js

# Verify load test runner exists
ls -la scripts/run-load-test.sh

# Verify load testing docs exist
ls docs/LOAD_TESTING.md

# Shell syntax check
bash -n scripts/run-load-test.sh

# Run a load test (requires k6 installed + running server)
# scripts/run-load-test.sh --scenario baseline --url http://localhost:3001

# Full verification sweep
make full-verify
```

## Regression checks

1. **Verify k6 scripts have thresholds defined**: `grep -c "thresholds" tests/load/k6-baseline.js`
2. **Verify baseline test uses 1000 VUs**: `grep -i "1000\|target" tests/load/k6-baseline.js`
3. **Verify lockdown spike tests simultaneous polling**: `grep -i "lockdown\|spike\|simultaneous" tests/load/k6-lockdown-spike.js`
4. **Verify mixed test has realistic traffic mix**: `grep -i "90\|polling\|dashboard\|ack" tests/load/k6-mixed.js`
5. **Verify run-load-test.sh checks k6 is installed**: `grep -i "k6\|install" scripts/run-load-test.sh`

## Gotchas

- Load tests do NOT run in CI — too slow and resource-intensive. Run manually or in a dedicated nightly job
- Load tests require a running server — script starts a test server if one isn't running, or accepts `--url` to point to an existing server
- Tests use k6 virtual users to simulate agent HTTP calls (not real Python processes — 1000 Python processes would overwhelm the test machine)
- k6 is Go-based, purpose-built for HTTP load testing, with good metrics and CI integration
- k6 must be installed separately (not an npm/pip package) — see `docs/LOAD_TESTING.md` for installation instructions

## Graph Integration

**Phase node**: `P15` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P15` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-SERVER, V-DASHBOARD

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: — (none)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
