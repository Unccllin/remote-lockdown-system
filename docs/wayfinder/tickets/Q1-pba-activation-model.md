# Q1: PBA activation model

> **Label:** `wayfinder:grilling`
> **Status:** CLOSED
> **Resolved:** 2026-08-13 (grilling Round 1)

## Question

Should PBA be opt-in, default, or an escalation tier?

## Resolution

**A — Opt-in flag** (`enable_pba: true`, default false). Operator explicitly
chooses PBA per lockdown. Simple, explicit, no surprises. The operator makes
a deliberate decision to sacrifice remote recoverability for data protection.
Escalation tier (server tracks "lost" vs "stolen" status) can be built on top
later by having the server automatically send `enable_pba: true` when status
changes to "stolen", but the agent API should be the simple flag first.

## Rationale

PBA fundamentally conflicts with remote unlock — once set, a rebooted device
can't be remotely recovered (the agent can't boot to receive unlock commands).
This means PBA can't be the default state for devices that may need remote
recovery. The opt-in flag makes this trade-off explicit per lockdown.
