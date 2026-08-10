# GRAPH-SPEC.md — Node Graph Architecture Decision Record

## Status
PROPOSEED — 2026-08-10

## Context
The remote-lockdown-system has 17 production-readiness phases (P0-P16), each with
a skill file, config, and test gate. However:

1. The orchestrator (`orchestrator.sh`) only knows about phases 0-7 — phases 8-16
   exist as skill files and configs but are invisible to the orchestration layer.
2. Phase completion markers are empty 0-byte files with no commit hash or artifact
   reference — there's no way to verify what was actually done.
3. There is no cross-session context persistence — each agent session starts fresh
   with no memory of what previous sessions learned or decided.
4. There is no formal definition of allowed transitions between work states — an
   agent can skip Rule Zero, skip verification, or close a debt item without evidence.
5. There is no debt ledger tracking what needs to ship vs. what's done.

The ICT trading bot orchestration pattern (see prompt example) demonstrates a
multi-session agent orchestration system that solves these problems with:
- A node graph defining all work states and allowed transitions
- A debt ledger with close criteria and evidence requirements
- A session trace persisting context across sessions
- Rule Zero (read before code) as a mandatory gate
- Run artifacts as the only acceptable proof of completion
- Graph assertions that raise on invalid transitions

## Decision
Make the node graph the center and heart of the project. All agent sessions,
all phase transitions, all verification gates, and all enforcement path validations
flow through the graph.

### Node types (mandatory)

The graph defines 7 node types. A node of each type MUST exist in the graph:

1. **SESSION** — Lifecycle nodes that frame each agent session
   - `SESSION-START`: Read trace, read debt ledger, identify next work
   - `IMPLEMENT`: Write code changes (only after RULE-ZERO)
   - `CLOSE-DEBT`: Update debt ledger and trace

2. **GATE** — Mandatory checkpoints that must pass before proceeding
   - `RULE-ZERO`: Read source/skill files before any code changes
   - `VERIFY`: Run verification suite (tests, lint, build)

3. **PHASE** — Production-readiness phases (P0-P16)
   - Each has: skill file, config, file ownership, test gate, deps
   - 17 phases currently defined

4. **VERIFY** — Verification nodes (tests, lint, build, env checks)
   - 12 verification nodes currently defined
   - Each has: command, expected exit code, expected output

5. **ENFORCE** — Enforcement path nodes (the actual lockdown features)
   - 13 enforcement paths currently defined
   - Each has: entry function, verified_by, status, risk_notes
   - Status: `verified-in-unit-test` → `verified-in-sandbox` → `verified-on-hardware`

6. **COMPONENT** — Buildable components (server, dashboard, agent, electron)
   - 4 component nodes currently defined
   - Each has: build command, verify nodes

7. **EVIDENCE** — Run artifacts that prove a node actually executed
   - `ARTIFACT`: Capture printed output from live execution

### Session lifecycle (the only allowed path)

```
SESSION-START → RULE-ZERO → IMPLEMENT → VERIFY → ARTIFACT → CLOSE-DEBT
                                                              │
                                                              ▼
                                                         SESSION-START (next session)
```

No shortcuts. No skipping. The graph asserts:
- I5: No code changes before RULE-ZERO is complete
- I4: No session close without trace.md update
- I2: No debt closure without commit hash + artifact reference

### Graph invariants (enforced by graph_assert.py)

| ID | Rule | Description |
|----|------|-------------|
| I1 | phase_deps_must_be_complete | No phase runs before its deps are COMPLETE |
| I2 | debt_close_requires_evidence | No debt CLOSED without commit_ref + artifact_ref |
| I3 | hardware_verification_requires_real_artifact | No "verified-on-hardware" without real hardware |
| I4 | session_close_requires_trace_update | No session close without trace.md status block |
| I5 | rule_zero_before_code | No code changes before RULE-ZERO complete |
| I6 | orchestrator_knows_all_phases | Orchestrator must know all 17 phases |
| I7 | complete_phases_have_artifacts | Every COMPLETE phase has non-empty artifact ref |

Currently violated: I6 (orchestrator only has 0-7), I7 (all .complete files are empty).

### Files

| File | Purpose |
|------|---------|
| `.devin/graph/GRAPH-SPEC.yaml` | Machine-readable graph spec (all nodes, edges, invariants) |
| `.devin/graph/graph_loader.py` | Single entry point for reading the graph |
| `.devin/graph/graph_assert.py` | Assertion engine — raises GraphViolationError on violations |
| `.devin/graph/trace.md` | Cross-session context trace (updated every session) |
| `docs/adr/DEBT-LEDGER.md` | Debt items with close criteria, status, evidence |
| `docs/adr/GRAPH-SPEC.md` | This file — human-readable ADR for the graph |

### Skill file integration

Every skill file (`.devin/skills/phase-N-*/SKILL.md`) must include a
`## Graph Integration` section that references:
- The phase node ID (e.g., `P3`)
- The verification nodes that gate this phase
- The enforcement paths this phase touches (if any)
- The debt items this phase can close (if any)

### Orchestrator integration

The orchestrator (`orchestrator.sh`) must be updated to:
1. Know about all 17 phases (currently only 0-7)
2. Check phase dependencies via the graph loader
3. Run verification nodes via the graph assertion engine
4. Write commit hash + artifact reference to .complete files

## Consequences

**Positive**:
- Cross-session context persistence — no more starting fresh every session
- Formal verification gates — no more skipping tests or Rule Zero
- Debt tracking with evidence — no more claiming something is done without proof
- Graph assertions catch violations early — no more silent drift

**Negative**:
- Every session has overhead (read trace, read debt ledger, read graph spec)
- Every code change requires Rule Zero first (slower but safer)
- Every debt closure requires a run artifact (higher bar for "done")

**Neutral**:
- The graph is a new source of truth — it must be kept in sync with reality
- The orchestrator needs refactoring to use the graph (D-001)

## Refactors needed to make the graph the center

1. **Update `orchestrator.sh`** to know about all 17 phases and use the graph loader
   for dependency checking (closes D-001)
2. **Populate `.complete` files** with commit hash + artifact reference (closes D-002)
3. **Add `## Graph Integration` section** to every skill file (17 files)
4. **Wire `graph_assert.py`** into the orchestrator's phase transition logic
5. **Add `trace.md` update** as a mandatory step at session end (enforced by I4)
6. **Add `RULE-ZERO` gate** to the orchestrator's task execution (enforced by I5)
