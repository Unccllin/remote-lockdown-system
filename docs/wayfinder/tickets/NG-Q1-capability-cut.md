# NG-Q1: The capability cut — which synthesis items become the next-gen build list?

> **Label:** `wayfinder:grilling` (HITL)
> **Status:** OPEN
> **Blocks:** all implementation tickets (fog — graduate on resolution)
> **Blocked by:** none

## Question

`SYNTHESIS-NEXT-GEN-DESIGN.md` §3 lists ~40 capabilities across firmware /
agent / server / cross-layer, plus 7 correctness findings. The destination
needs a **cut list** — the capabilities the next generation actually gets,
in an agreed order. ~40 is a roadmap, not a plan.

The grilling should decide, per capability: **in / out / defer**, plus the
ordering inside "in."

## Options

The candidate set (grouped as in the synthesis; grill each group):

### Firmware/PBL (14 candidates)
Boot#### classification (shell/CSM/network detection) · disk boot-structure
baseline (LBA0/GPT/VBR/BPB/hidden sectors) · variable authentication
hardening · monotonic-counter freshness · ConnectController NIC self-heal ·
UEFI error-record lock logging · HII keyword probing · HECI/MEI client ·
PCR-5 golden baseline (server side) · S3-resume provenance · Option-ROM
image classification · VMK lock-state proof · partition-level FVE binding ·
UID-based override

### Agent (9 candidates)
kernel-integrity telemetry driver · raw-disk-access tripwire ·
self-integrity hash · VM/snapshot detection · clock-rollback deadman ·
detached-signature updates · service-manager watchdog (systemd/launchd/SCM)
· vulnerable-driver inventory · packed-binary sweep

### Server (12 candidates)
attestation enrichment (discrete fields) · attested enrollment
(Autopilot-style) · command lifecycle states · escrow-before-arm ·
role-scoped key reads · cross-layer disagreement alarms ·
compliance-as-code graduated response · device-record GC · update rings ·
lock-screen provenance marker · forensic runbook · digest-drift engine

### Suggested cut heuristics to grill
- Everything Tier-0-adjacent (correctness-adjacent fixes) is almost
  certainly "in" — the question is which need tickets vs. fold into
  existing work.
- The **digest-drift engine** is the biggest architectural piece — worth
  its own grilling before it lands on the list.
- Computrace coexistence + provenance marker touch the product's legal
  story — decide explicitly, don't let them slip in by default.

## Resolution

Record the in/out/defer table + ordering as the ticket's resolution
comment; graduate one implementation ticket per "in" item.
