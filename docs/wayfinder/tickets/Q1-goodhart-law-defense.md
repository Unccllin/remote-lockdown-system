# Q1: Goodhart's Law defense — structural minimums for gameable invariants

> **Label:** `wayfinder:grilling`
> **Status:** CLOSED (2026-08-13)
> **Blocks:** T2 (Goodhart defense implementation)

## Question

The WalkingLabs course (Lecture 14) warns: "Metrics become targets and lose
their value." Three graph invariants are gameable — they can be satisfied with
shallow compliance that passes the assertion but doesn't achieve the intent:

- **I4** (session close requires trace update): a one-line trace entry satisfies it
- **I5** (no code before RULE-ZERO): a RULE-ZERO entry with no file citations satisfies it
- **I7** (every COMPLETE phase has artifact): "tests pass" as artifact ref satisfies it without evidence

What structural minimums should be added to `graph_assert.py` to prevent the
laziest gaming without becoming bureaucratic?

## Options

### I5 — RULE-ZERO gate (most consequential)

**Current check**: `grep -q "RULE-ZERO" trace.md` (presence-only)

**Option A**: RULE-ZERO entry must cite >=2 file paths (e.g., paths containing `/` or `\`)
**Option B**: RULE-ZERO entry must cite >=2 file paths AND include at least 1 "Finding" or "Read" line
**Option C**: RULE-ZERO entry must be at least 5 lines long (structural minimum)

### I4 — session-end trace block

**Current check**: session-end block exists with required section headers

**Option A**: Each required section (fog cleared, fog remaining, debt closed, debt open, blockers, next session) must have at least 1 line of non-header content
**Option B**: Section content must include at least 1 file path reference
**Option C**: Block must be at least 20 lines total

### I7 — phase artifact reference

**Current check**: `.complete` file is non-empty

**Option A**: `.complete` file must contain a commit hash pattern (7+ hex chars)
**Option B**: `.complete` file must contain a commit hash AND a test count (digits + "test" or "pass")
**Option C**: `.complete` file must contain a commit hash AND a test count AND a date

## Resolution

**I5 = Option B** (>=2 file paths + >=1 Finding/Read line). This is the most
consequential invariant — code before understanding is the costliest failure
mode. File citations prove the agent actually read source. A Finding line
proves the agent synthesized something, not just copy-pasted paths.

**I4 = Option A** (each section has >=1 line of non-header content). This
prevents empty sections without requiring specific content types. A section
that says "None" is legitimate (e.g., "Blockers: None") — the check should
verify the section isn't just a header with nothing under it.

**I7 = Option B** (commit hash + test count). A commit hash alone doesn't
prove tests ran. A test count alone doesn't prove the code was committed.
Both together prove: code was committed AND tests were counted at that commit.

## Rationale

These minimums are structural — they check for patterns, not semantics. They
prevent the laziest gaming (empty entries, "tests pass" without numbers,
RULE-ZERO with no file references) without requiring a semantic evaluator.
The course's L09 principle ("externalized verification — replace feelings
with execution-based tests") supports this: the assertions check for
evidence of work, not quality of work.

The thresholds are deliberately low (2 file paths, 1 finding, 1 line per
section). The goal is to block shallow compliance, not to enforce depth —
depth is the agent's responsibility, enforced by code review and test
quality, not by graph assertions.
