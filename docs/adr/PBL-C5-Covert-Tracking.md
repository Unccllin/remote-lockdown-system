# PBL-C5-Covert-Tracking.md — Covert Tracking Mode

## Status

Proposed — 2026-09-07

## Context

The current PBL architecture has a single lockdown response: when the server
returns `LOCKED`, PBL shows a lock screen and shuts down the machine. This
protects data but alerts the thief, who then wipes the disk, reflashes
firmware, or discards the machine — making recovery impossible.

The system already has covert tracking infrastructure in the agent layer:
- `E-TRACK` enforcement path (verified-in-unit-test)
- `handle_track()` in `agent/agent.py` — enters covert tracking mode
- `report_location()` — WiFi scan + IP geolocation
- `tracking` device status in `serverless/worker.ts`
- `LOCATE` and `STOP_TRACK` commands

But PBL (the UEFI layer) doesn't know about tracking. When the server says
`LOCKED`, PBL blocks boot — the agent never runs, and no location is
reported.

## Decision

Add a fourth verdict value: **`TRACKING = 3`**.

When the server returns `TRACKING`, PBL lets Windows boot normally — no
lock screen, no degraded notice, no visible difference from an unlocked
boot. The agent starts with Windows, sees the device status is `tracking`,
and enters covert mode: reporting location via WiFi scan + IP geolocation
at regular intervals.

The admin chooses per-device whether to issue `LOCKED` (protect data) or
`TRACKING` (covert location recovery). This is an explicit tradeoff:

| Mode | Data protection | Location tracking | Thief awareness |
|------|----------------|-------------------|-----------------|
| `UNLOCKED` | Yes (BitLocker active) | No | Normal |
| `LOCKED` | Yes (PBL blocks boot) | No | Lock screen visible |
| `TRACKING` | No (Windows runs) | Yes (agent reports) | None — appears normal |
| `WIPE_PENDING` | Yes (PBL blocks boot) | No | Lock screen visible |

## C1 verdict wire format changes

### Verdict value (key 4)

```
0 = UNLOCKED
1 = LOCKED
2 = WIPE_PENDING
3 = TRACKING   ← NEW
```

### Reason codes (key 8)

Add `"reported_stolen"` as the reason for `TRACKING` verdicts. The existing
reason codes are unchanged:

| Verdict | Reason |
|---------|--------|
| `UNLOCKED` | `"enrolment"`, `"recovered"` |
| `LOCKED` | `"admin_lock"`, `"reported_stolen"`, `"policy_violation"` |
| `WIPE_PENDING` | `"wipe_pending"` |
| `TRACKING` | `"reported_stolen"` |

### Challenge seed (key 9)

Never present in `TRACKING` verdicts. Override is not available in
tracking mode — the thief should not see any prompt.

## PBL behavior in TRACKING mode

### Decision engine (Decision.c, C4 §5 step 16)

The server `TRACKING` verdict does **not** force `BLOCK`. Instead:

- `TRACKING` → result stays as policy checks determined (usually `PASS`)
- PBL chain-loads Windows normally
- PBL extends PCR 13 with inputs (same as any boot)
- PBL extends PCR 12 with the decision hash (which includes the verdict
  value — so PCR 12 in tracking mode differs from PCR 12 in normal mode)

### Action switch (PblApp.c, C4 §5 step 18)

```
case PblResultPass (with TRACKING verdict):
  → PblChainLoadWindows(ImageHandle)
  → No lock screen, no notice, no visible difference
```

The tracking behavior is invisible at the UEFI layer. PBL does nothing
special — it just boots Windows. The agent handles the covert tracking.

### PCR sealing implications

PBL extends PCR 12 with the decision hash, which includes the verdict
value. In tracking mode, PCR 12 will differ from normal mode because the
verdict value is `TRACKING` (3) instead of `UNLOCKED` (0).

BitLocker VMK sealing must account for this:

- During enrollment, the VMK is sealed to **both** normal-mode and
  tracking-mode PCR values
- Normal boot → PCR 12 matches normal sealing → VMK released
- Tracking boot → PCR 12 matches tracking sealing → VMK released
- Firmware reflash (PBL doesn't run) → PCR 12 has no PBL extensions →
  VMK **not** released

This means BitLocker stays active in tracking mode. The thief can use
Windows (the VMK is released to the running OS), but if they remove the
disk and try to read it on another machine, the data is still encrypted.

## BitLocker in tracking mode

**BitLocker stays active.** PBL does not touch BitLocker. The VMK is
released because the PCR policy includes the tracking-mode PCR values.

Rationale:
1. BitLocker is transparent to the running OS — the thief can use Windows
   normally. Keeping it active doesn't prevent usage.
2. BitLocker protects against disk removal — if the thief pulls the disk,
   the data is still encrypted. This is the one attack you want to stop.
3. No additional complexity — PBL just chain-loads Windows. BitLocker's
   unlock happens at the OS level.
4. The agent can suspend BitLocker later via a separate admin command
   (`manage-bde -protectors -disable`) if the admin decides that's needed.

## Data protection in tracking mode

BitLocker protects against disk removal, but it doesn't protect the real
user's data from a thief who is logged into Windows. In tracking mode,
the thief can use Windows — so we need additional data protection that
is invisible to the thief.

### Approach: Decoy account + account lockout + EFS

The agent applies three layers of data protection immediately on
entering tracking mode, all invisible to the thief:

**Layer 1: Disable the real user's Windows account**

```
net user <username> /active:no
```

The real user's account disappears from the login screen. The thief
cannot log in as the real user. If the thief discovers the account name
and resets its password (e.g. via `net user <username> newpassword`),
the account is re-enabled but EFS files (Layer 3) remain inaccessible.

**Layer 2: Enable a decoy account**

```
net user GuestDecoy <random_password> /add
net user GuestDecoy /active:yes
net localgroup Users GuestDecoy /add
```

A decoy account appears on the login screen. It has a clean desktop,
no documents, no browser history — a believable "fresh" Windows
account. The thief logs in here and uses the machine normally.
The decoy account has no access to the real user's profile directory
(`C:\Users\<real_user>\`).

**Layer 3: EFS-encrypt the real user's sensitive files**

```powershell
cipher /e /s:"C:\Users\<real_user>\Documents"
cipher /e /s:"C:\Users\<real_user>\Desktop"
cipher /e /s:"C:\Users\<real_user>\Downloads"
cipher /e /s:"C:\Users\<real_user>\Pictures"
```

The real user's Documents, Desktop, Downloads, and Pictures are
encrypted with EFS (Encrypting File System). EFS keys are per-user —
the decoy account's EFS certificate cannot decrypt the real user's
files. Even if the thief resets the real user's password and logs in
as them, EFS files stay encrypted without the original certificate
(which the agent has backed up to the server).

### Why this approach

| Approach | Works on any partition layout? | Covert? | Reversible? |
|----------|-------------------------------|---------|-------------|
| Selective BitLocker (OS only) | No — requires separate data partition | Yes | Yes |
| Decoy account + EFS | Yes — no partition assumptions | Yes | Yes |
| Full disk re-encryption | Yes | No — visible disk activity | Slow |

Decoy account + EFS is chosen because:
1. **Works on any Windows installation** — no partition layout assumptions
2. **Most covert** — thief sees a normal login screen with a usable account
3. **Defense in depth** — three independent layers (account disabled, decoy account, EFS)
4. **Reversible** — admin unlocks real account, EFS decrypts with backed-up certificate
5. **Simple to implement** — `net user` commands + `cipher` CLI, no custom crypto

### Recovery flow

When the device is recovered:
1. Admin sends `STOP_TRACK` command → agent reverses all three layers
2. Agent re-enables real user's account: `net user <username> /active:yes`
3. Agent disables and deletes decoy account: `net user GuestDecoy /delete`
4. Agent decrypts EFS files: `cipher /d /s:"C:\Users\<real_user>\Documents"` etc.
5. Agent restores the EFS certificate from the server backup if needed

### What the thief sees

1. Windows boots normally (PBL chain-loads, no lock screen)
2. Login screen shows one account: "GuestDecoy" (or similar generic name)
3. Thief logs in with the decoy password (or creates their own account)
4. Desktop is clean — no documents, no history, no bookmarks
5. Machine is fully usable — web browsing, installing software, etc.
6. Agent runs as SYSTEM, reports location every 5 minutes
7. Real user's data is invisible — account disabled, files EFS-encrypted

### What the thief cannot access

1. Real user's Documents, Desktop, Downloads, Pictures (EFS-encrypted)
2. Real user's browser history and saved passwords (in their profile, EFS-encrypted)
3. Real user's email (Outlook PST files in their profile, EFS-encrypted)
4. Any file in `C:\Users\<real_user>\` that was EFS-encrypted

### Limitations

1. **Files outside the user profile** — files on the Desktop of the
   real user are protected, but files in arbitrary locations (e.g.
   `D:\Projects\`) are not EFS-encrypted. The admin can configure
   additional paths to encrypt.
2. **Non-EFS applications** — some applications store data outside
   the user profile (e.g. `C:\ProgramData\`). These are not protected.
3. **Admin-level thief** — a thief who boots from a USB drive and
   uses `ntpasswd` or similar tools could re-enable the real user's
   account. EFS still protects the files, but the thief could delete
   them. BitLocker protects against this if the USB boot is blocked
   by Secure Boot + PBL.
4. **EFS certificate backup** — the agent must back up the real
   user's EFS certificate to the server before encrypting, so recovery
   is possible if the certificate is lost.

## Agent stealth in tracking mode

The agent uses **scheduled task + service** for maximum resilience:

1. **Windows service** — runs as `SYSTEM` with a generic name (e.g.
   `Windows System Management Service`). No tray icon, no window, no
   notifications. Location reports use HTTPS to the same server.

2. **Scheduled task** — a system-level scheduled task triggers every
   5 minutes and restarts the service if it's not running. Even if the
   thief finds and kills the service, the scheduled task restarts it.

3. **Location reporting** — WiFi scan via `netsh wlan show networks
   mode=bssid` (no prompt, no UI). IP geolocation via the server's
   `/api/geo` endpoint. Reports every 5 minutes by default, configurable
   via server command.

4. **No visible artifacts** — the agent binary, config, and logs are
   stored in `C:\Windows\System32\config\` with system file attributes.
   The scheduled task is named `Microsoft\Windows\SystemMaintenance\SysMemOpt`.
   The service name is `SysMgmtSvc`.

## Server-side changes

### Device status

The existing `tracking` status is used. The admin flow is:

1. Admin flags device as stolen → `POST /api/devices/:id/flag`
2. Server sets status to `stolen`
3. Admin chooses mode: `POST /api/devices/:id/track` (covert) or
   `POST /api/devices/:id/lock` (hard lock)
4. Server sets status to `tracking` or `locked`
5. PBL fetches verdict → gets `TRACKING` or `LOCKED`

### Verdict endpoint

`serverless/pbl/routes/verdict.ts` — `statusToVerdict()`:

```typescript
case 'tracking':
  return { verdict: VERDICT_TRACKING, reason: 'reported_stolen' };
```

### Admin UI

The dashboard's device detail page gets two buttons:
- **Lock Device** — issues `LOCKED` verdict (data protection)
- **Track Device** — issues `TRACKING` verdict (covert location)

The admin must confirm the tradeoff before selecting either option.

## Failure modes

### Server unreachable in tracking mode

If the server is unreachable, PBL reads the cached verdict from TPM NV.
If the cached verdict is `TRACKING` and within the grace period, PBL
continues to boot normally. The agent continues to report location if
it can reach the server. If the agent can't reach the server either,
it caches location reports locally and uploads them when connectivity
returns.

### Thief reinstalls Windows

If the thief reinstalls Windows, the agent is gone. But:
- The server-side state still shows `tracking`
- PBL still runs on next boot (it's in firmware)
- PBL fetches the verdict → gets `TRACKING` → boots normally
- The agent is not there to report location
- PBL can report a basic "device booted" ping via the verdict request
  itself (the request includes device_id + timestamp)

### Thief reflashes firmware

PBL is gone. But:
- TPM NV state survives firmware reflash
- BitLocker VMK is sealed to PCR values that include PBL's extensions
- Without PBL, PCR 12/13 don't have the expected values → VMK not released
- Windows won't boot (BitLocker recovery required)
- The thief sees a BitLocker recovery prompt — this is unavoidable

### Thief replaces the disk

PBL runs, but the disk has no Windows installation. The agent is gone.
BitLocker keys are gone. The server-side state persists, but there's
no way to track the device. This is the one scenario where tracking
fails completely.

## What does NOT change

- `LOCKED` verdict behavior is unchanged — lock screen, override, shutdown
- `WIPE_PENDING` verdict behavior is unchanged
- `UNLOCKED` verdict behavior is unchanged
- Policy checks (C4 §5 steps 3-14) still run in all modes
- PCR extensions (step 17) still happen in all modes
- Verdict signature verification still happens in all modes
- The decision engine's worst-result combination still applies — if
  policy checks produce `BLOCK`, the result is `BLOCK` even if the
  verdict is `TRACKING`. Tracking mode does not override policy failures.

## Implementation plan

1. **C1 contract update** — add `TRACKING = 3` to verdict values
2. **PblApp.h** — add `PBL_VERDICT_TRACKING = 3`
3. **Decision.c** — handle `TRACKING` in step 16 (do not force BLOCK)
4. **PblApp.c** — no change needed (TRACKING → PASS → chain-load)
5. **Server verdict route** — map `tracking` status to `TRACKING` verdict
6. **Server tests** — add test for tracking verdict
7. **Agent data protection** — implement decoy account + account lockout
   + EFS encryption in `handle_track`
8. **Agent stealth** — implement scheduled task + service with generic names
9. **Agent recovery** — implement `handle_stop_track` reversal (re-enable
   real account, delete decoy, decrypt EFS files)
10. **Dashboard** — add "Track Device" button to device detail page
11. **PCR sealing** — document that VMK must be sealed to both normal
    and tracking PCR values during enrollment
