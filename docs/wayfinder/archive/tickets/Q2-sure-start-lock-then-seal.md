# Q2: Sure Start BIOS Setting Protection

> **Label:** `wayfinder:grilling`
> **Status:** CLOSED
> **Resolved:** 2026-08-13 (grilling Round 1)

## Question

Should the agent use the "lock then seal" pattern for HP Sure Start BIOS
Setting Protection?

## Resolution

**A — Yes, implement "lock then seal".** Disable protection → apply lockdown
→ re-enable protection. The lockdown settings become tamper-proof.

## Rationale

If BIOS Setting Protection is enabled, it will revert the lockdown system's
BIOS changes on the next boot. If we don't handle this, the lockdown BIOS
changes silently revert — the agent reports success but the machine isn't
actually locked down. This is the same class of bug as D-013 (trusting return
code 0 without verification). The "lock then seal" pattern is the correct fix.
