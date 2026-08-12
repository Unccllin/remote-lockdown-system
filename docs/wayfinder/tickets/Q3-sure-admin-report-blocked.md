# Q3: Sure Admin handling

> **Label:** `wayfinder:grilling`
> **Status:** CLOSED
> **Resolved:** 2026-08-13 (grilling Round 1)

## Question

If Sure Admin / EBAM is enabled, should the agent use signed payloads or just
report blocked?

## Resolution

**B — Report blocked.** If Sure Admin is detected, skip BIOS changes and
report "BIOS lockdown blocked by Sure Admin" in the ACK. Operator must either
disable Sure Admin (via signed payload from another system) or provision SPM
keys.

## Rationale

Signed payloads (A) require key management infrastructure that doesn't exist
yet in this system. Building that is a separate project. Reporting blocked (B)
is honest, safe, and lets the operator decide. The hybrid (C) is risky — Sure
Admin rejection may return success code 0 (silently ignored), which is the
same "trust return code" problem we just fixed with D-013.
