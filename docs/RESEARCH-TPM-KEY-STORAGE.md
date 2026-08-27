# Research: TPM 2.0 Key Storage Prototype

> **Date**: 2026-08-14
> **Purpose**: Clear fog around TPM 2.0 key sealing for the anti-theft system
> **Status**: Prototype VERIFIED using swtpm + tpm2-tools on Linux

---

## Fog Questions Answered

### 1. Can we test TPM in QEMU?

**YES.** QEMU supports TPM 2.0 emulation via `swtpm` (software TPM).

**Setup**:
```bash
# Start swtpm (TPM 2.0 emulator)
swtpm socket \
  --tpm2 \
  --tpmstate dir=/tmp/swtpm-state \
  --ctrl type=unixio,path=/tmp/swtpm-state/swtpm-sock \
  --daemon

# Boot QEMU with TPM device
qemu-system-x86_64 \
  -chardev socket,id=chrtpm,path=/tmp/swtpm-state/swtpm-sock \
  -tpmdev emulator,id=tpm0,chardev=chrtpm \
  -device tpm-tis,tpmdev=tpm0 \
  ...other args...
```

**Verified**: OVMF firmware successfully initializes the TPM during boot (sends
TPM2_Startup, runs self-tests). The swtpm log shows the full TPM command sequence.

### 2. Can we access TPM from Linux?

**YES.** Linux exposes TPM through:
- `/dev/tpm0` — direct TPM access (requires exclusive lock)
- `/dev/tpmrm0` — TPM resource manager (preferred, handles context management)
- `tpm2-tools` — command-line utilities (tpm2_createprimary, tpm2_create, tpm2_unseal, etc.)
- `tpm2-tss` — C library (libtss2-esys, libtss2-sys, libtss2-mu)
- `tpm2-pytss` — Python bindings

For swtpm specifically, use the `swtpm:` TCTI:
```bash
export TPM2TOOLS_TCTI="swtpm:path=/tmp/swtpm-state/swtpm.sock"
```

### 3. What's the exact TPM 2.0 seal/unseal command sequence?

**Seal** (create a keyedhash object with PCR policy):
```
1. tpm2_createprimary -C o -g sha256 -G ecc
   → Creates primary key (handle 0x80000000)

2. tpm2_pcrread -o pcr.bin sha256:0,1,2,3
   → Reads current PCR values

3. tpm2_createpolicy --policy-pcr -l sha256:0,1,2,3 -f pcr.bin -L pcr.policy
   → Creates PCR policy digest

4. echo -n "SECRET" | tpm2_create -C 0x80000000 -L pcr.policy -i- -u seal.pub -r seal.priv
   → Seals data into keyedhash object bound to PCR policy
```

**Unseal** (retrieve sealed data):
```
5. tpm2_load -C 0x80000000 -u seal.pub -r seal.priv -c seal.ctx
   → Loads sealed object into TPM

6. tpm2_unseal -c seal.ctx -p pcr:sha256:0,1,2,3
   → Unseals data (TPM checks PCR values match policy)
   → Returns plaintext if PCRs match, error if they don't
```

**TPM 2.0 commands under the hood**:
- `TPM2_CreatePrimary` — creates storage parent key
- `TPM2_PCR_Read` — reads PCR values
- `TPM2_PolicyPCR` — creates PCR policy (via trial session)
- `TPM2_Create` — creates sealed object (keyedhash with data + policy)
- `TPM2_Load` — loads object into TPM
- `TPM2_StartAuthSession` + `TPM2_PolicyPCR` — satisfies policy at unseal time
- `TPM2_Unseal` — returns sealed data if policy is satisfied

### 4. Can we use Microsoft TSS.MSR on Linux?

**YES.** TSS.MSR is cross-platform:
- **TSS.Net**: .NET Standard 2.0, works on .NET Core 2.1+ for Linux
  - Windows: uses TBS API (Tbsip_Submit_Command)
  - Linux: uses `/dev/tpm0` or `libtss2-tcti-tabrmd.so`
- **TSS.CPP**: C++ library, works on Linux (but has build issues with OpenSSL sm3.h)
- **TSS.Py**: Python, supports Python 2.7 and 3.5+

For our Windows service, we would use TSS.Net with TBS API. The same code
compiles for .NET Core on Linux for testing.

### 5. What PCR values exist in QEMU's TPM?

**All PCRs start at zero** after TPM2_Startup(SU_CLEAR). OVMF extends PCRs
during boot with firmware measurements:

| PCR | What it measures | After OVMF boot |
|-----|-----------------|-----------------|
| 0 | CRTM, firmware code | Extended by OVMF |
| 1 | ACPI, E820, EFI variables | Extended by OVMF |
| 2 | Option ROMs | Extended if Option ROMs present |
| 3 | Option ROM data | Extended if Option ROMs present |
| 4 | OS bootloader (IPL) | Extended by OS loader |
| 5 | OS bootloader data | Extended by OS loader |
| 6 | Power management events | Extended by OS |
| 7 | Secure Boot policy | Extended by OVMF (if Secure Boot enabled) |

In our QEMU test, PCRs 0-3 were all zero because OVMF didn't extend them
(our custom OVMF build may not have measurement enabled). On real hardware,
PCRs 0-7 would contain firmware measurements.

### 6. How does TPM ownership/provisioning work?

**TPM 2.0 doesn't have "ownership" like TPM 1.2.** Instead:
- **Storage Root Key (SRK)**: Created by `TPM2_CreatePrimary` in the owner
  hierarchy. The SRK is the root of the storage hierarchy.
- **Endorsement Key (EK)**: Created by the TPM manufacturer, persistent.
  Used for privacy-sensitive operations (attestation, credential activation).
- **Platform hierarchy**: Managed by the platform firmware (OVMF/BIOS).
- **Owner hierarchy**: Managed by the OS (Windows provisions this automatically).
- **No explicit "provisioning" needed for seal/unseal**: Just create a primary
  key and use it. Windows auto-provisions the SRK during TPM initialization.

For our anti-theft system: we create our own primary key (SRK equivalent)
and use it to seal/unseal data. No Windows provisioning dependency.

### 7. Can we do the full seal→unseal cycle in QEMU with swtpm?

**YES — VERIFIED.** The full cycle works:

```
Seal: "ANTI-THEFT-DEVICE-KEY-7A3F9B2C" → TPM keyedhash object
      Bound to PCR policy (sha256:0,1,2,3)

Unseal (PCRs match): → "ANTI-THEFT-DEVICE-KEY-7A3F9B2C" ✓
Unseal (PCR 0 extended): → DENIED (error) ✓
```

**Test results**:
- Seal/Unseal cycle: **PASS**
- Tamper detection (PCR modification): **PASS**

---

## Prototype Implementation

### Files

| File | Purpose |
|------|---------|
| `firmware/tpm-test/tpm-seal-test.sh` | Full seal/unseal test script using swtpm + tpm2-tools |

### Test Output (verified 2026-08-14)

```
========================================
  TPM 2.0 Seal/Unseal Prototype
  Anti-Theft Key Storage
========================================

[1] Starting swtpm (TPM 2.0 emulator)...
    PID: 85978

[2] Initializing TPM (TPM2_Startup)...
    TPM started

[3] Creating primary key (ECC, SHA-256, owner hierarchy)...
    Primary key created (handle 0x80000000)

[4] Reading PCRs and creating PCR policy...
    PCR selection: sha256:0,1,2,3
    PCR policy created

[5] Sealing secret into TPM...
    Secret: 'ANTI-THEFT-DEVICE-KEY-7A3F9B2C'
    Object type: keyedhash (sealed data)
    Policy: PCR-bound (sha256:0,1,2,3)
    Secret sealed

[6] Loading sealed object and unsealing...
    Unsealed: 'ANTI-THEFT-DEVICE-KEY-7A3F9B2C'
    [PASS] Seal/Unseal cycle SUCCESSFUL!

[7] Testing tamper detection...
    Extending PCR 0 (simulating firmware modification)...
    Attempting unseal after tampering...
    [PASS] Unseal correctly DENIED after platform tampering!

========================================
  Results:
    Seal/Unseal:  PASS
    Tamper detect: PASS
========================================
```

### QEMU + OVMF + TPM Integration (verified)

QEMU boots with swtpm and OVMF successfully initializes the TPM:
```
qemu-system-x86_64 \
  -chardev socket,id=chrtpm,path=/tmp/swtpm-qemu/swtpm-sock \
  -tpmdev emulator,id=tpm0,chardev=chrtpm \
  -device tpm-tis,tpmdev=tpm0 \
  -drive if=pflash,format=raw,readonly=on,file=OVMF_CODE.fd \
  -drive if=pflash,format=raw,file=OVMF_VARS.fd \
  ...
```

swtpm log shows OVMF sending:
1. `TPM2_Startup(SU_CLEAR)` — initializes the TPM
2. Self-tests (RSA-1024, RSA-2048, camellia-128/256, 3DES)
3. `TPM2_Shutdown(SU_CLEAR)` — clean shutdown

---

## Architecture: Anti-Theft TPM Key Storage

```
┌─────────────────────────────────────────────────────────┐
│                    TPM 2.0 (hardware or swtpm)           │
│                                                          │
│  ┌─────────────────┐    ┌──────────────────────────┐    │
│  │  Primary Key    │───▶│  Sealed Object           │    │
│  │  (ECC, SRK)     │    │  (keyedhash)             │    │
│  │  Handle: 0x8... │    │  Policy: PCR 0,1,2,3    │    │
│  └─────────────────┘    │  Data: DEVICE-KEY        │    │
│                          └──────────────────────────┘    │
│  ┌─────────────────────────────────────────────────┐    │
│  │  PCRs (sha256)                                   │    │
│  │  PCR-0: firmware measurement                     │    │
│  │  PCR-1: ACPI/EFI measurement                     │    │
│  │  PCR-2: Option ROM measurement                   │    │
│  │  PCR-3: Option ROM data measurement              │    │
│  │  PCR-7: Secure Boot policy (production)          │    │
│  └─────────────────────────────────────────────────┘    │
└───────────┬──────────────────────────┬──────────────────┘
            │                          │
     Seal (write)               Unseal (read)
            │                          │
            ▼                          ▼
┌───────────────────┐      ┌──────────────────────────┐
│ Windows Service    │      │ Windows Service          │
│ (TBS API +         │      │ (TBS API +               │
│  TSS.MSR)          │      │  TSS.MSR)                │
│                    │      │                          │
│ 1. CreatePrimary   │      │ 1. Load sealed object    │
│ 2. Read PCRs       │      │ 2. Start policy session  │
│ 3. CreatePolicy    │      │ 3. PolicyPCR             │
│ 4. Create(seal)    │      │ 4. Unseal                │
│ 5. Save to UEFI    │      │ 5. Use device key        │
│    NVRAM or file   │      │                          │
└───────────────────┘      └──────────────────────────┘
```

---

## Windows Implementation Plan

### Option A: TSS.MSR (recommended)

```csharp
// C# with TSS.MSR (cross-platform .NET)
using Tpm2Lib;

var tpm = new Tpm2(new LinuxTpmDevice("/dev/tpmrm0"));
// On Windows: new Tpm2(new TbsDevice());

// Create primary key
var primary = tpm.CreatePrimary(
    TpmRh.Owner, new TpmPublic(...));

// Read PCRs
var pcrs = tpm.PCR_Read(new TPMS_PCR_SELECTION[] {
    new TPMS_PCR_SELECTION(TpmAlgId.Sha256, 0, 1, 2, 3)
});

// Create PCR policy
var policySession = tpm.StartAuthSession(
    null, null, null, null, TpmSe.Policy,
    TpmAlgId.Sha256);
tpm.PolicyPCR(policySession, pcrSelection, pcrValues);
var policyDigest = tpm.PolicyGetDigest(policySession);

// Seal data
var sealedObj = tpm.Create(primary.handle,
    new TpmPublic(TpmAlgId.Sha256, ...,
        new TPMS_KEYEDHASH_PARMS(...),
        policyDigest),
    new TpmSensitive(dataToSeal, ...));

// Unseal
tpm.PolicyPCR(policySession, pcrSelection, currentPcrs);
var unsealed = tpm.Unseal(sealedObj.handle);
```

### Option B: Raw TBS API (Windows only)

```cpp
// C++ with Tbsip_Submit_Command (Windows only)
#include <tbs.h>

TBS_HCONTEXT hContext;
TBS_CONTEXT_PARAMS2 params = { sizeof(params) };
params.version = TBS_CONTEXT_VERSION_TWO;
Tbsi_Context_Create(&params, &hContext);

// Build TPM2_CreatePrimary command bytes
BYTE cmd[] = { /* TPM 2.0 command header + parameters */ };
BYTE rsp[4096];
UINT32 rspLen = sizeof(rsp);
Tbsip_Submit_Command(hContext, TBS_COMMAND_LOCALITY_ZERO,
    TBS_COMMAND_PRIORITY_NORMAL, cmd, sizeof(cmd), rsp, &rspLen);
// Parse response...
```

### Option C: tpm2-tools (Linux testing only)

```bash
# Shell script using tpm2-tools (for testing, not production)
tpm2_createprimary -C o -g sha256 -G ecc
tpm2_pcrread -o pcr.bin sha256:0,1,2,3
tpm2_createpolicy --policy-pcr -l sha256:0,1,2,3 -f pcr.bin -L pcr.policy
echo -n "SECRET" | tpm2_create -C 0x80000000 -L pcr.policy -i- -u seal.pub -r seal.priv
tpm2_load -C 0x80000000 -u seal.pub -r seal.priv -c seal.ctx
tpm2_unseal -c seal.ctx -p pcr:sha256:0,1,2,3
```

---

## Production Considerations

### PCR Selection for Anti-Theft

| PCR | Purpose | Use for sealing? |
|-----|---------|-----------------|
| 0 | Firmware code | YES — detects firmware replacement |
| 1 | Firmware data (ACPI, EFI vars) | YES — detects config changes |
| 2 | Option ROMs | Optional — may change with HW swaps |
| 3 | Option ROM data | Optional |
| 4 | OS bootloader | NO — changes with OS updates |
| 5 | OS bootloader data | NO |
| 7 | Secure Boot policy | YES — detects Secure Boot disable |

**Recommended for production**: Seal to PCR-0 + PCR-7 (firmware + Secure Boot state).
This detects:
- Firmware replacement (PCR-0 changes)
- Secure Boot disable (PCR-7 changes)
- Does NOT break on OS updates (PCR-4/5 not included)

### Sealed Object Storage

The sealed object (seal.pub + seal.priv) needs to be stored somewhere:
1. **UEFI NVRAM variable** — survives OS reinstalls, but limited space
2. **TPM NV index** — most secure, but limited space (~2KB)
3. **Disk file** — simplest, but lost on disk replacement

For anti-theft: store in UEFI NVRAM (survives disk replacement) or TPM NV index.

### Key Recovery

If the platform state changes legitimately (e.g., firmware update), the sealed
key becomes inaccessible. Solutions:
1. **Dual-seal**: Seal to both old and new PCR values, use policy OR
2. **Recovery key**: Seal a backup copy with a password policy (no PCR binding)
3. **BitLocker approach**: Use recovery password as fallback

---

## Cross-References

- `docs/RESEARCH-UEFI-VARS-TPM.md` — UEFI variable access + TPM research
- `firmware/tpm-test/tpm-seal-test.sh` — working seal/unseal prototype
- Beyond BIOS Chapter 10 — TPM, Measured Boot, PCR mapping
- Microsoft TSS.MSR: github.com/microsoft/TSS.MSR
- tpm2-tools documentation: github.com/tpm2-software/tpm2-tools
- swtpm: github.com/stefanberger/swtpm
