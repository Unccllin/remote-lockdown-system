# C2 — TPM Contract

> **Status:** FROZEN (Day 0). Agents A and D code against this. Agent E
> writes tests against it. Changes require orchestrator approval.
> **Owner:** Agent D (guarantees the layout and ships the simulator);
> Agent A (executes commands from PBL); Agent E (negative tests).
> **References:** PBL-IMPLEMENTATION-PLAN.md §3, §4 REQ-05/06/07/11/12/13;
> TCG TPM 2.0 Library Spec; tpm2-tools reference.

---

## 1. NV index layout

Three NV indices, all under the **Platform hierarchy** (not Storage
hierarchy). Rationale: Platform hierarchy is cleared by `TPM2_Clear` with
`RH_PLATFORM` authorization, which requires physical presence or a platform
auth — an OS-level attacker (T2) cannot clear it. A `TPM2_Clear` with
`RH_OWNER` (Storage hierarchy) does NOT touch Platform-hierarchy NV indices.
This means a stolen machine that gets `TPM2_Clear` (owner clear) from a T2
attacker **retains the lock state** — clearing helps the defender, not the
attacker.

| Index | Name | Offset | Size | Attributes | Purpose |
|-------|------|--------|------|------------|---------|
| `0x01C00001` | PBL_LOCK_STATE | 0 | 64 bytes | see §1.1 | Current lock verdict cache + grace metadata |
| `0x01C00002` | PBL_POLICY_VERSION | 0 | 8 bytes | see §1.2 | Monotonic counter — highest policy version accepted |
| `0x01C00003` | PBL_AK_NAME | 0 | 34 bytes | see §1.3 | AK Name (TPM2B_NAME) for device_id derivation |

All indices use the Platform hierarchy handle range `0x4000000C` (TPM_HT_NV_INDEX)
with OEM-reserved offset `0x01C00000`. Agent D must verify this range does
not collide with existing OEM NV usage at enrolment; if it does, the offset
is configurable via C4 `nv_index_base`.

### 1.1 PBL_LOCK_STATE (0x01C00001)

```
Offset  Size  Field
0       1     magic          = 0x50 ('P') — identifies a valid cache entry
1       1     verdict        = 0 (UNLOCKED) | 1 (LOCKED) | 2 (WIPE_PENDING)
2       5     issued_at      = uint32 BE, Unix timestamp
7       5     grace_until    = uint32 BE, Unix timestamp
12      32    device_id      = SHA-256(AK public Area) — must match PBL_AK_NAME
44      20    reserved       = 0x00...
```

**Attributes (TPMA_NV):**
- `TPMA_NV_PPWRITE` — write requires Platform hierarchy auth (physical presence)
- `TPMA_NV_PPREAD` — read requires Platform hierarchy auth
- `TPMA_NV_POLICYWRITE` — write also satisfiable via the PBL write policy (§3)
- `TPMA_NV_POLICYREAD` — read also satisfiable via the PBL read policy (§3)
- `TPMA_NV_AUTHREAD` — read with auth value (for PBL's HMAC session)
- `TPMA_NV_AUTHWRITE` — write with auth value (for PBL's HMAC session)
- `TPMA_NV_NO_DA` — exempt from dictionary attack lockout (PBL must never be locked out by DA)
- **NOT** `TPMA_NV_POLICY_DELETE` — the index cannot be deleted via a policy.
  Only `TPM2_NV_UndefineSpace` with Platform hierarchy auth can remove it.
- **NOT** `TPMA_NV_OWNER` — not managed by Storage hierarchy owner.

**Read policy:** `TPM2_PolicyAuthorize` signed by the PBL policy key (same
key that signs C4). This lets PBL read the cache without physical presence,
but only if the policy is current. Agent A satisfies this via a HMAC session
bound to the PBL auth value + the PolicyAuthorize signature.

**Write policy:** Same `TPM2_PolicyAuthorize`, plus the write is only
performed by PBL after a verdict is verified (C1 §7 step 9). The OS agent
(Agent D provisioning) writes the initial state at enrolment using Platform
hierarchy auth.

### 1.2 PBL_POLICY_VERSION (0x01C00002)

```
Offset  Size  Field
0       8     counter        = uint64 BE, monotonic increasing
```

**Attributes:**
- `TPMA_NV_COUNTER` — hardware-guaranteed monotonic; each write increments.
- `TPMA_NV_PPWRITE` + `TPMA_NV_POLICYWRITE`
- `TPMA_NV_PPREAD` + `TPMA_NV_AUTHREAD`
- `TPMA_NV_NO_DA`
- **NOT** `TPMA_NV_POLICY_DELETE`

PBL reads this counter on every boot (REQ-11). If the policy blob's version
(C4 §2) is **less than** this counter, PBL rejects the policy as rolled
back. If greater, PBL increments the counter via `TPM2_NV_Increment` before
applying the new policy.

### 1.3 PBL_AK_NAME (0x01C00003)

```
Offset  Size  Field
0       2     size           = 0x0022 (34 bytes follow)
2       34    name           = TPM2B_NAME: SHA-256(alg) || SHA-256(AK public Area)
```

**Attributes:**
- `TPMA_NV_PPWRITE` — written once at enrolment by Agent D (Platform auth).
- `TPMA_NV_PPREAD` + `TPMA_NV_AUTHREAD`
- `TPMA_NV_NO_DA`
- **NOT** `TPMA_NV_POLICY_DELETE`
- **NOT** `TPMA_NV_POLICYWRITE` — after enrolment, this is read-only. The AK
  does not change unless the device is re-enrolled (which requires server-side
  approval and a new `device_id`).

PBL reads this at boot to compute `device_id = SHA-256(AK public Area)` for
verdict verification (C1 §4).

---

## 2. Authorization policy (TPM2_PolicyAuthorize)

All three indices use a `TPM2_PolicyAuthorize`-based policy so PBL can be
updated (new policy version, new verdict cache format) without
re-provisioning the NV indices. The policy key is the same key that signs
the C4 policy blob.

### 2.1 Policy construction

```
PolicyAuthorize:
  approvedPolicy = hash of a PolicyPCR + PolicyAuthValue sequence
  policyRef     = version-specific nonce (changes per policy version)
  keySign       = PBL policy key public (pinned in C4)
  checkTicket   = signature over (approvedPolicy || policyRef)
```

The inner policy is:
1. `TPM2_PolicyPCR` — binds to PCR 12 (PBL's own measurement). This ensures
   the policy can only be satisfied when PBL's measurement matches the value
   the policy was signed for. A tampered PBL produces a different PCR 12 →
   policy not satisfied → NV access denied → denied boot.
2. `TPM2_PolicyAuthValue` — requires the PBL auth value (provisioned at
   enrolment, stored in the NV index auth area).

The outer `TPM2_PolicyAuthorize` signs over the hash of this inner sequence
+ a `policyRef` that changes per policy version. This means a new policy
version requires a new signature, but the NV indices themselves are not
recreated.

### 2.2 Why PolicyAuthorize instead of a static policy

A static `PolicyPCR` would bind NV access to a single PCR 12 value. Every
PBL update changes PCR 12 → the policy breaks → NV inaccessible → machine
bricked. `PolicyAuthorize` lets the orchestrator sign a new approved policy
for the new PCR 12 value and ship it in C4, without touching the TPM.

---

## 3. Session requirements (REQ-05)

**Every** TPM command PBL issues uses an HMAC session with parameter
encryption. This is the documented defence against dTPM bus sniffing (T3).

### 3.1 Session setup

```
TPM2_StartAuthSession:
  sessionType    = TPM_SE_HMAC
  tpmKey         = TPM_RH_NULL (no salt key) OR a loaded salt key
  bind           = the NV index handle (binds session to that index)
  nonceCaller    = 32 bytes from EFI_RNG_PROTOCOL
  nonceTPM       = (returned by TPM)
  symmetric      = TPM_ALG_AES_256_CFB (parameter encryption)
  authHash       = TPM_ALG_SHA256
  attributes     = TPMA_SESSION_CONTINUESESSION | TPMA_SESSION_DECRYPT | TPMA_SESSION_ENCRYPT
```

- `TPMA_SESSION_DECRYPT` (also called `decrypt`): encrypts command parameters
  (e.g., the auth value, the data being written).
- `TPMA_SESSION_ENCRYPT` (also called `encrypt`): encrypts response
  parameters (e.g., the data being read).
- The session is **salted** if `tpmKey != TPM_RH_NULL`, **bound** because
  `bind = index handle`. A bound session means the session key incorporates
  the index's auth value, so an attacker who sniffs the bus cannot compute
  the session key without the auth value.

### 3.2 Mandatory rules

1. **Never** issue a TPM command with `TPM_RH_NULL` as the auth session
   (plaintext). Agent E's REQ-05 negative test forces this and PBL must
   refuse to boot.
2. **Never** use a password session (`TPM_SE_POLICY` with no HMAC). The auth
   value is always passed via the HMAC session's MAC, encrypted.
3. TPM+PIN is **mandatory** where a discrete TPM is present (charter REQ-05).
   The PIN is a second auth factor enforced by BitLocker's
   `TPM2_PolicySecret` on the endorsement hierarchy — this is Agent D's
   Windows-side concern, not PBL's. PBL only enforces that the session is
   HMAC+encrypted; the PIN gate is in the BitLocker sealing policy.

### 3.3 Session lifecycle in PBL

PBL creates **one** HMAC session at startup (bound to the lock-state index),
reuses it for all NV reads/writes on that index, and creates separate
sessions for PCR extends (bound to `TPM_RH_NULL` since PCR operations don't
bind to an index). Sessions are flushed before chain-loading Windows
(`TPM2_FlushContext`) to avoid leaking session state to the OS.

---

## 4. PCR usage (REQ-12)

**PBL writes only to PCR 12 and PCR 13.** Never to PCR 0–7 (firmware-owned)
or PCR 11 (BitLocker access control — writing here would break BitLocker).

| PCR | Owner | PBL action | What is extended |
|-----|-------|------------|------------------|
| 0 | Firmware | read only | — |
| 4 | Firmware | read only | boot manager code (PBL parses TCG log for this) |
| 5 | Firmware | read only | GPT + BootOrder + ExitBootServices |
| 7 | Firmware | read only | Secure Boot policy (db entry that authorized PBL) |
| 11 | BitLocker | read only | BitLocker access control |
| 12 | **PBL** | **extend** | PBL decision: SHA-256(verdict \|\| policy_version \|\| platform_state_digest \|\| final_result) |
| 13 | **PBL** | **extend** | PBL inputs: SHA-256(policy_blob_hash \|\| nonce \|\| device_id \|\| pcr_readings[4,5,7,11]) |
| 14 | Firmware | read only | boot authorities |

### 4.1 Extend operations

PBL performs exactly three `TPM2_PCR_Extend` calls, in this order, before
chain-loading Windows (PASS/DEGRADED) or showing the lock screen (BLOCK):

1. **PCR 13** (self-image, D-217): `TPM2_PCR_Extend(13, {SHA256(PblApp.efi file bytes)})` — the on-disk PE, deterministic across boots. A tampered or skipped PBL changes PCR 13; prevention itself is Secure Boot (PBL-SECURE-BOOT-DEPLOYMENT.md).
2. **PCR 13** (inputs): `TPM2_PCR_Extend(13, {SHA256(policy_blob_hash || nonce || device_id || pcr4 || pcr5 || pcr7 || pcr11)})`
3. **PCR 12** (decision): `TPM2_PCR_Extend(12, {SHA256(verdict || policy_version || platform_state_digest || final_result)})`

`final_result` is a uint8: `0` = PASS, `1` = DEGRADED, `2` = BLOCK.

### 4.2 TCG event log

PBL uses `EFI_TCG2_PROTOCOL->HashLogExtendEvent` for both extends so the
events appear in the TCG event log (not just in the PCR). The event types:

| PCR | EventType | EventPayload |
|-----|-----------|--------------|
| 13 | `EV_EFI_VARIABLE_DRIVER_CONFIG` (0x80000001) | `{name: "PblInputs", guid: PBL_GUID, data: ...}` |
| 12 | `EV_EFI_ACTION` (0x80000007) | ASCII string: `"PBL verdict=LOCKED policy_version=7 result=BLOCK"` |

PBL also parses the existing TCG event log for PCR 4, 5, 7, 11, 14 events
to verify the boot chain up to PBL's invocation (REQ-12). If the log is
missing or truncated, PBL records this in `platform_state_digest` and the
server may flag it.

### 4.3 BitLocker sealing profile (Agent D)

| Tier | PCR set | Notes |
|------|---------|-------|
| Standard | 7 + 11 | BitLocker default under Secure Boot. PBL's PCR 12/13 are NOT in the sealing set — a PBL update does not trigger BitLocker recovery. |
| High-assurance | 7 + 11 + 12 + 13 | PBL's measurement is part of the seal. A skipped or tampered PBL run changes PCR 12/13 → VMK does not release → BitLocker recovery. This is the §0.3 enforcement mechanism. |

Tier is selected at enrolment (Agent D) and recorded in C4
`bitlocker_sealing_tier` per device or fleet. Switching from Standard to
High-assurance requires re-sealing (BitLocker suspend + resume with new PCR
profile) — Agent D delivers the PowerShell module + Intune/GPO template for
this.

### 4.4 C5 tracking mode and PCR sealing

PCR 12's extend value includes the verdict value (C5 §4.1):
`SHA-256(verdict || policy_version || platform_state_digest || final_result)`.

In tracking mode, the verdict is `TRACKING` (3) instead of `UNLOCKED` (0).
This produces a **different PCR 12 value** than a normal boot. BitLocker
must account for this in the high-assurance sealing tier.

**Enrollment requirement:** When a device is enrolled with the
high-assurance tier, the BitLocker VMK must be sealed to **both** the
normal-boot and tracking-boot PCR 12 values. This is done by:

1. Boot PBL with an `UNLOCKED` verdict → record PCR 12 value A
2. Boot PBL with a `TRACKING` verdict → record PCR 12 value B
3. Seal the VMK to both PCR 12 values (BitLocker supports multiple
   PCR profiles via `Manage-bde -protectors -add` with different
   PCR masks)

If the VMK is only sealed to the normal-boot PCR 12 value, a tracking-mode
boot will trigger BitLocker recovery — the thief would see a recovery
prompt, which defeats the purpose of covert tracking.

**Firmware reflash protection:** Without PBL, PCR 12 has no PBL extension.
Neither value A nor value B matches → VMK not released → BitLocker
recovery. This is the desired behavior: a reflashed machine without PBL
cannot boot Windows, even in tracking mode.

**Standard tier:** PCR 12 is not in the sealing set, so tracking mode has
no effect on BitLocker. The VMK releases regardless of PBL's verdict.
This is acceptable for standard-tier devices — the tracking protection
comes from the agent's data protection (decoy account + EFS), not from
BitLocker.

---

## 5. Command sequences (Agent A implements, Agent D guarantees)

### 5.1 Boot-time read sequence (every boot, ≤ 300 ms cached path)

```
1. TPM2_StartAuthSession (HMAC, AES-256-CFB, bound to 0x01C00001)
2. TPM2_NV_ReadPublic(0x01C00003) → AK Name → compute device_id
3. TPM2_PolicyAuthorize + TPM2_PolicyPCR(12) + TPM2_PolicyAuthValue
4. TPM2_NV_Read(0x01C00001, offset=0, size=64) → lock state cache
5. TPM2_NV_Read(0x01C00002, offset=0, size=8) → policy version counter
6. [if verdict needed] TPM2_PCR_Read(4,5,7,11) → platform_state_digest
7. TPM2_PCR_Extend(13, inputs)
8. TPM2_PCR_Extend(12, decision)
9. TPM2_FlushContext(session)
```

### 5.2 Verdict cache write (after C1 §7 step 9, online path only)

```
1. TPM2_StartAuthSession (HMAC, AES-256-CFW, bound to 0x01C00001)
2. TPM2_PolicyAuthorize + TPM2_PolicyPCR(12) + TPM2_PolicyAuthValue
3. TPM2_NV_Write(0x01C00001, offset=0, data=64-byte cache struct)
4. TPM2_FlushContext(session)
```

### 5.3 Policy version increment (when C4 version > NV counter)

```
1. TPM2_StartAuthSession (HMAC, bound to 0x01C00002)
2. TPM2_PolicyAuthorize + TPM2_PolicyPCR(12) + TPM2_PolicyAuthValue
3. TPM2_NV_Increment(0x01C00002)  // hardware-guaranteed monotonic
4. TPM2_FlushContext(session)
```

### 5.4 Enrolment provisioning (Agent D, once per device, OS-side)

```
1. TPM2_Clear(RH_PLATFORM)  // clean slate, requires physical presence
2. TPM2_CreatePrimary(endorsement hierarchy) → EK
3. TPM2_Create(endorsement hierarchy, AK template) → AK
4. TPM2_NV_DefineSpace(RH_PLATFORM, 0x01C00001, attrs=§1.1, size=64)
5. TPM2_NV_DefineSpace(RH_PLATFORM, 0x01C00002, attrs=§1.2, size=8, COUNTER)
6. TPM2_NV_DefineSpace(RH_PLATFORM, 0x01C00003, attrs=§1.3, size=34)
7. TPM2_NV_Write(0x01C00001, initial_state=UNLOCKED, grace=0)
8. TPM2_NV_Write(0x01C00003, AK Name)
9. TPM2_NV_Increment(0x01C00002)  // set counter to 1
10. [Agent C] POST /v1/enroll with device_id, EK cert, AK public
```

---

## 6. What TPM2_Clear does (defender's friend)

| Clear type | Auth required | Clears PBL NV? | Clears BitLocker? |
|------------|---------------|-----------------|-------------------|
| `TPM2_Clear(RH_OWNER)` | Owner auth (T2 has this) | **No** — PBL NV is Platform hierarchy | Yes — VMK sealed objects are Storage hierarchy → BitLocker recovery on next boot |
| `TPM2_Clear(RH_PLATFORM)` | Platform auth (physical presence) | **Yes** — all NV cleared | Yes |

**Key insight:** A T2 attacker who clears the TPM via owner auth does NOT
remove the lock state (Platform-hierarchy NV survives) but DOES destroy the
BitLocker VMK seal → the machine enters BitLocker recovery on next boot.
The attacker cannot boot to Windows without the recovery key (which is
escrowed server-side, C1 §6). This is the fail-closed-on-data property
(§0.2): data confidentiality is enforced by BitLocker, not by PBL's NV
state.

A T3 attacker with physical access can do `TPM2_Clear(RH_PLATFORM)` with
physical presence, clearing PBL NV. But:
- BitLocker VMK is also destroyed → data inaccessible without escrowed key.
- The machine reappears as LOCKED the moment it checks in with the server
  (server-side state, §0.1 anchor c).
- The lock screen still shows (PBL reads the policy blob from the ESP, which
  is signed and pinned in db; a reflash that removes PBL changes PCR 12/13
  → BitLocker recovery in high-assurance tier).

---

## 7. fTPM / dTPM matrix (REQ-06, Agent D owns)

| TPM type | Risk | Mitigation |
|----------|------|------------|
| Intel fTPM (pre-2020 firmware) | TPM-Fail (CVE-2019-16863) — timing leak allows signature forgery | Force TPM+PIN; require firmware ≥ vendor floor |
| STMicro ST33ZP96 | TPM-Fail variant | Force TPM+PIN; require firmware ≥ vendor floor |
| AMD Zen 2/3 fTPM | faulTPM (CVE-2024-45887-style) — no firmware fix available | Force TPM+PIN; document that PIN is the only mitigation |
| AMD Zen 4+ fTPM | faulTPM patched in Zen 4 | Check firmware version; PIN optional if patched |
| Infineon dTPM (OPTIGA) | Generally sound; bus sniffing risk (T3) | HMAC+parameter encryption (§3); PIN mandatory for dTPM per REQ-05 |
| Nuvoton dTPM | Generally sound; bus sniffing risk | Same as Infineon |

Agent D enumerates the fleet's TPM manufacturers/firmware at enrolment and
records the tier in C4 `tpm_pin_policy` per device class.

---

## 8. Simulator delivery (Day 3, Agent D)

Agent D ships:

```
agent/pbl_tpm/simulator/
  start-swtpm.sh          # launches swtpm with a fresh state dir
  tpm2-reference.sh       # executes §5.1–5.4 against swtpm, prints results
  pbl-nv-init.py          # Python: defines NV indices via tpm2-tools
  pbl-nv-read.py          # Python: reads lock state + counter (for Agent A CI)
  pbl-extend.py           # Python: extends PCR 12/13 (for Agent A CI)
  Dockerfile              # swtpm + tpm2-tools + Python for CI
```

Agent A's CI (`firmware/PblPkg/build-pbl.sh` + `.github/workflows/pbl-ci.yml`)
runs PBL on OVMF/QEMU with this swtpm simulator. The reference script
(`tpm2-reference.sh`) is the **executable spec** — if PBL's TPM commands
produce different results than the reference script, it's a bug in A or a
contract violation in D.

---

## 9. Anti-hammering (Agent D documents, Agent E tests)

- PBL's NV indices have `TPMA_NV_NO_DA` — PBL is never locked out by TPM DA
  counters. This is critical: a stolen machine must not become unbootable
  because an attacker hammered the TPM.
- BitLocker's PIN DOES consume DA counters. Agent D documents the lockout
  threshold (default: 5 attempts, 7200s lockout) and the recovery path
  (escrowed recovery key via C1 §6 admin endpoints). Support must not brand
  a DA-locked machine as bricked — it is a PIN lockout, recoverable with the
  escrowed key.
