# Q10: Recovery runbook

> **Label:** `wayfinder:grilling`
> **Status:** CLOSED
> **Resolved:** 2026-08-13 (grilling Round 2)

## Question

Should the recovery runbook for a rebooted PBA device be a dashboard feature
or just documentation?

## Resolution

**C — Both.** Dashboard feature AND documentation. The dashboard is the
primary path (operator sees credentials without DB access); the doc is the
fallback for when the dashboard is down or the operator needs step-by-step
instructions.

## Rationale

The dashboard feature is the operator-facing path. The documentation is the
fallback. The dashboard should show a prominent warning that remote unlock
won't work and physical access is required.
