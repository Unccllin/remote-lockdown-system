# Q5: SafeBoot registry entries

> **Label:** `wayfinder:grilling`
> **Status:** CLOSED
> **Resolved:** 2026-08-13 (grilling Round 1)

## Question

Should the agent add itself to SafeBoot groups at install time or at lockdown
time?

## Resolution

**A — Install time.** Add the registry entries when the agent service is
installed. The agent always starts in Safe Mode, even when not in lockdown
state.

## Rationale

The agent should always start in Safe Mode, not just during lockdown. If a
device is stolen before lockdown is applied, the agent still needs to run in
Safe Mode to receive the lockdown command. Adding it only at lockdown time
creates a chicken-and-egg problem: if the device is already in Safe Mode when
the lockdown command arrives, the agent isn't running to receive it.
