# Q4: Sure Run

> **Label:** `wayfinder:grilling`
> **Status:** CLOSED
> **Resolved:** 2026-08-13 (grilling Round 1)

## Question

Should the agent use HP Sure Run to protect itself from being killed?

## Resolution

**C — Detect and report only.** Include Sure Run status in the ACK but don't
configure it. Let the operator decide whether to enable it separately.

## Rationale

Sure Run protection is valuable but it's a separate concern from boot lockdown.
Configuring Sure Run requires HP CMSL cmdlets and potentially TPM-dependent
state management. It's better as a separate hardening feature than mixed into
the lockdown flow. The agent should report Sure Run status so the operator
knows it's available.
