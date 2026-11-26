# ADR-011 — Re-arm requires administrator approval, not a hardware UUID

**Status**: accepted (2026-11-26, session 365)
**Constrains**: `serverless/worker.ts` (`handleRearm`, the admin re-arm routes), `serverless/kv-store.ts`
(`putDevice`'s derived keys), `serverless/worker.test.ts`
**Supersedes**: the implicit design recorded in `firmware/PblPkg/PblPersistDxe/PblPersistDxe.c`, whose
comment says the payload "carries no device secret; hardware_uuid is the identifier"
**Tracked as**: D-226 (external review finding S2)

## Context

`POST /api/rearm` exists so a device whose agent was wiped — a disk replacement, a reinstall, a dropped
bootstrap — can collect a fresh API key and reinstall itself. The caller is a PowerShell payload that
`PblPersistDxe` drops onto the ESP:

```powershell
$hw = (Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID
$body = @{ hardware_uuid = $hw; hostname = $env:COMPUTERNAME } | ConvertTo-Json
$script = Invoke-RestMethod -Uri "$api/rearm" -Method POST -Body $body -ContentType 'application/json'
```

Three facts make the current gate insufficient:

1. **The payload carries no secret.** The DXE driver writes byte-identical bytes to every disk, and the
   firmware comment says so explicitly.
2. **The hardware UUID is not a credential.** It is printed in firmware setup and readable from Windows
   by any process — including one belonging to the person holding the machine.
3. **The route issues a new `api_key_hash` for any enrolled device that is not `active`.** So whoever
   presents a stolen machine's UUID gets the key, and the genuine agent's key is replaced: the device
   can ACK lock commands without locking, report false locations, and cut the fleet off from the real
   machine. It also reads every device record plus one metadata key per device, per anonymous request.

That defeats the product's purpose for exactly the fleet it is sold to protect.

## Options

**A. TPM-sealed device secret.** PBL seals a per-device secret into TPM NV at enrolment; the payload
reads it and presents it. Strongest, fully automatic — and blocked in practice: PBL's NV indices live
under the platform hierarchy (D-134, open), the owner-hierarchy fallback needs `OWNERREAD` added, and
whether Windows sets a non-empty `ownerAuth` is unverified on hardware. Building the re-arm proof on
that would make recovery fail on exactly the machines it exists for.

**B. Administrator approval.** The request is recorded, not honoured; a super-admin approves it in the
console; the device retries and collects the key once. No firmware change, no new secret to provision,
and the gate is a human who can see the device's theft history.

**C. Disable the route.** Zero exposure today, but it removes the documented disk-replacement recovery
path without replacing it.

## Decision

**B.** `POST /api/rearm` no longer issues a key on demand:

1. It validates the body, looks the device up **directly** by hardware UUID (index `hwid:<uuid>` →
   device id, maintained by `putDevice` alongside the existing `agent_key:` pointer, with a bounded
   scan only as a fallback for records written before this ADR), and keeps the existing rule that only
   an enrolled, non-`active` device is eligible.
2. It is **rate limited** per source IP (and per UUID) so an anonymous caller cannot use it to bill the
   client for reads.
3. It records `rearm_request:<device_id>` = `{device_id, hardware_uuid, hostname, requested_at,
   source_ip, status: 'pending'}` plus an audit entry `rearm_requested`, and answers **409** with an
   instruction a technician can act on.
4. A super-admin lists pending requests and approves or denies them; both are audited.
5. An approved request is **single-use and time-limited**. The next `POST /api/rearm` for that device
   consumes it and returns the install script exactly once; a second call finds no approval and gets
   409 again. A stale approval has the same effect, so an approval cannot be banked indefinitely.

The technician's retry is what makes this workable in the field: the payload writes its success marker
only after the install script runs, so a 409 leaves the device free to try again once the admin clicks
approve.

## Consequences

- **Recovery needs an administrator awake.** That is the trade: the alternative is a thief who needs
  nothing but the UUID. For a device flagged stolen, a human decision is the correct gate.
- **A stolen machine cannot self-serve.** Presenting the UUID now produces a pending request that an
  administrator can see, with the device's status and history, and deny.
- **The TPM path is not abandoned, only deferred.** Once D-134 closes and the hierarchy question is
  answered on hardware, a sealed secret can replace the human step — the request/approval records are
  the same shape an automatic proof would write.
- **A dashboard panel is the natural follow-up.** The endpoints exist and are tested here; approving by
  API or `curl` is workable for a recovery tool but not for a client's IT staff.

## Tests that hold this decision

- a re-arm for an enrolled, stolen device issues **no key** and records a pending request
- a second call before approval is still 409 (nothing was banked)
- an approval allows exactly one key; the following call is 409
- an approval older than the window is refused
- a device that is `active` is still 404 (unchanged behaviour)
- an unknown UUID is 404, and the lookup does not scan the whole fleet on the indexed path
- the rate limit answers 429 rather than doing the work
