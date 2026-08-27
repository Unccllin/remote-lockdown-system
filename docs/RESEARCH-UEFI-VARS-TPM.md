# Research: UEFI Variable Access from Windows & TPM Key Sealing

> **Source**: Beyond BIOS (Zimmer et al., 2017), Rootkits and Bootkits (Matrosov et al., 2019), Microsoft Learn documentation
> **Date**: 2026-08-14
> **Purpose**: Clear fog around Windows UEFI variable access and TPM key sealing for the anti-theft system

---

## 1. UEFI Variable Access from Windows

### 1.1 Runtime Services Persistence

From **Beyond BIOS** (Chapter 5, "UEFI Runtime"):

> "Runtime services, however, do remain available to the operating system at runtime and provide an interface for reading and writing NVRAM UEFI variables, performing firmware updates (via Capsule Update), and rebooting or shutting down the system."
> — Rootkits and Bootkits, p. 243

Key facts from Beyond BIOS Chapter 5:
- UEFI variables have three access attributes: **NON_VOLATILE** (persists across reset), **BOOTSERVICE_ACCESS** (accessible during boot), **RUNTIME_ACCESS** (accessible after ExitBootServices)
- **Runtime access implies boot service access** — a variable with RUNTIME_ACCESS must also have BOOTSERVICE_ACCESS
- After `ExitBootServices()`, only variables with **both** `NON_VOLATILE` and `RUNTIME_ACCESS` attributes can be **written** via `SetVariable()`
- Variables with `RUNTIME_ACCESS` but not `NON_VOLATILE` become **read-only** after `ExitBootServices()`
- To **delete** a variable: call `SetVariable()` with a zero-byte data payload
- Attributes are only applied when a variable is **created**; rewriting with different attributes has indeterminate behavior — must delete and recreate

### 1.2 Windows Win32 API

From Microsoft Learn documentation:

**`SetFirmwareEnvironmentVariableExW()`** (winbase.h):
```cpp
BOOL SetFirmwareEnvironmentVariableExW(
    LPCWSTR lpName,      // Variable name (Unicode)
    LPCWSTR lpGuid,      // Namespace GUID as string "{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}"
    PVOID   pValue,      // Pointer to value data
    DWORD   nSize,       // Size in bytes (0 = delete, unless APPEND_WRITE or AUTH attributes)
    DWORD   dwAttributes // UEFI variable attributes bitmask
);
```

**`GetFirmwareEnvironmentVariableW()`** (winbase.h):
```cpp
DWORD GetFirmwareEnvironmentVariableW(
    LPCWSTR lpName,      // Variable name
    LPCWSTR lpGuid,      // Namespace GUID as string
    LPVOID  pBuffer,     // Output buffer
    DWORD   nSize        // Buffer size
);
```

### 1.3 Privilege Requirements

**Critical finding**: To write a firmware environment variable, the user account must have the **`SE_SYSTEM_ENVIRONMENT_NAME`** privilege (also called `SeSystemEnvironmentPrivilege`).

- User Right: "Modify firmware environment values"
- This privilege is typically held by **SYSTEM** and **Administrators**
- A Windows service running as **LocalSystem** (NT AUTHORITY\SYSTEM) has this privilege by default
- A regular admin process must **enable** the privilege before calling the API (using `AdjustTokenPrivileges()`)

### 1.4 Variable Attributes (Windows side)

| Constant | Value | Meaning |
|----------|-------|---------|
| `VARIABLE_ATTRIBUTE_NON_VOLATILE` | 0x00000001 | Stored in NVRAM (survives reboot) |
| `VARIABLE_ATTRIBUTE_BOOTSERVICE_ACCESS` | 0x00000002 | Accessible during boot services |
| `VARIABLE_ATTRIBUTE_RUNTIME_ACCESS` | 0x00000004 | Accessible at OS runtime |
| `VARIABLE_ATTRIBUTE_HARDWARE_ERROR_RECORD` | 0x00000008 | Hardware error record |
| `VARIABLE_ATTRIBUTE_AUTHENTICATED_WRITE_ACCESS` | 0x00000010 | Requires signed write (deprecated) |
| `VARIABLE_ATTRIBUTE_TIME_BASED_AUTHENTICATED_WRITE_ACCESS` | 0x00000020 | Requires timestamped signature |
| `VARIABLE_ATTRIBUTE_APPEND_WRITE` | 0x00000040 | Append to existing value |

For our anti-theft system, we need: `NON_VOLATILE | BOOTSERVICE_ACCESS | RUNTIME_ACCESS` = **0x07**

### 1.5 GUID Format

The `lpGuid` parameter must be a **string** in the format `"{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}"` (with curly braces). This is the namespace GUID that, combined with the variable name, uniquely identifies a UEFI variable.

### 1.6 UEFI App → Windows Service Communication

From the Rootkits and Bootkits book (p. 278, 373):
- UEFI NVRAM variables are stored in **SPI flash memory** alongside system firmware
- They persist across reboots, OS reinstalls, and disk replacements
- Windows accesses them via UEFI runtime services through HAL wrappers
- The `bootmgfw.efi` bootloader path itself is stored in an NVRAM variable
- Secure Boot keys (PK, KEK, db, dbx) are all stored as NVRAM variables

**Implication for anti-theft**: A UEFI DXE driver can write a NON_VOLATILE variable during boot, and a Windows SYSTEM service can read it later using `GetFirmwareEnvironmentVariable()`. The variable survives OS reinstalls because it's in SPI flash, not on the disk.

### 1.7 Authenticated Variables

From Rootkits and Bootkits (p. 337, 361):
- Secure Boot variables (PK, KEK, db, dbx) use **authenticated** attributes
- `VARIABLE_ATTRIBUTE_TIME_BASED_AUTHENTICATED_WRITE_ACCESS` (0x20) requires a complete `EFI_VARIABLE_AUTHENTICATION_2` descriptor with a valid signature
- The signature must be from a key whose certificate is in the PK/KEK chain
- **Our custom variables do NOT need authentication** — we can use plain `NON_VOLATILE | BOOTSERVICE_ACCESS | RUNTIME_ACCESS` (0x07) without any signature requirement

### 1.8 Universal Windows App Restrictions

From Microsoft Learn:
- Universal Windows Apps (UWP) need custom capabilities: `microsoft.firmwareRead_cw5n1h2txyewy` and `microsoft.firmwareWrite_cw5n1h2txyewy`
- Must also declare `protectedApp` restricted capability
- Must set `/INTEGRITYCHECK` linker option
- **Our Windows service is a Win32 service, not UWP** — we don't need these capabilities, just `SeSystemEnvironmentPrivilege`

---

## 2. TPM Key Sealing from Windows

### 2.1 TPM Architecture

From **Beyond BIOS** (Chapter 10, "Platform Security and Trust"):

- TPM is a passive hardware device on the system board (connected via LPC bus or integrated in chipset)
- TPM serves as **Root of Trust for Storage (RTS)** and **Root of Trust for Reporting (RTR)**
- Uses **Storage Root Key (SRK)** and **Platform Configuration Registers (PCRs)**
- PCRs are **write-only** (can only be extended, not directly set) and cleared upon platform reset (static PCRs 0-15)
- **Seal operation**: Like encryption that also includes PCR values — data can only be decrypted when PCR values match
- **Unseal operation**: Decryption that verifies PCR values match those at seal time
- If platform state changes between seal and unseal, the unseal fails (detecting unauthorized changes)

### 2.2 PCR Usage (TCG/UEFI)

From Beyond BIOS (p. 166-167):
- **PCR-0**: CRTM measures firmware (bootloader/BIOS) → stores measurement
- **PCR-1**: ACPI, E820, EFI measurements
- **PCR-2**: Option ROM measurements
- **PCR-4**: Bootloader/BIOS measures OS Initial Program Load (IPL)
- Static PCRs (0-15): zeroed only across platform reset
- Dynamic PCRs (16+): zeroed upon DRTM launch (resettable)

### 2.3 Windows TPM Base Services (TBS) API

From Microsoft Learn and Stack Overflow research:

**Low-level API**: `Tbsip_Submit_Command()` — sends raw TPM command byte streams to the TPM.

```cpp
TBS_RESULT Tbsip_Submit_Command(
    TBS_HCONTEXT         hContext,     // Context handle from Tbsi_Context_Create
    TBS_COMMAND_LOCALITY Locality,     // Usually TBS_COMMAND_LOCALITY_ZERO
    TBS_COMMAND_PRIORITY Priority,     // TBS_COMMAND_PRIORITY_NORMAL for apps
    PCBYTE               pabCommand,   // Raw TPM command bytes
    UINT32               cbCommand,    // Command size
    PBYTE                pabResult,    // Response buffer
    PUINT32              pcbResult     // Response size in/out
);
```

**Context creation**:
```cpp
TBS_CONTEXT_PARAMS2 contextParams = { sizeof(TBS_CONTEXT_PARAMS2) };
contextParams.version = TBS_CONTEXT_VERSION_TWO;
TBS_HCONTEXT hContext;
TBS_RESULT result = Tbsi_Context_Create(&contextParams, &hContext);
```

**Library**: Link with `Tbs.lib`, include `tbs.h`

### 2.4 TPM 2.0 Seal Equivalent

In TPM 2.0, the "Seal" operation is done via **`TPM2_Create`** with a PCR selection in the auth policy:

1. **Create a sealed object**: `TPM2_Create(parentHandle, inSensitive, inPublic, ...)`
   - The `inPublic` template specifies a **keyedhash** object (for sealing data)
   - The `inSensitive` contains the data to seal and the auth value
   - A **policy digest** based on `TPM2_PolicyPCR` is included in the object's auth policy
   - The sealed data can only be unsealed when the PCR values match the policy

2. **Unseal the object**: 
   - `TPM2_Load(parentHandle, inPrivate, inPublic, ...)` → load the sealed object
   - Start a policy session: `TPM2_StartAuthSession(TPM_SE_POLICY, ...)`
   - Execute `TPM2_PolicyPCR(sessionHandle, pcrSelection, pcrValues)` — the TPM checks if current PCRs match
   - `TPM2_Unseal(objectHandle, ...)` — returns the sealed data if policy is satisfied

### 2.5 Higher-Level Alternatives

Instead of raw TBS commands, consider:

1. **Microsoft TSS.MSR** (github.com/microsoft/TSS.MSR): C++ TSS (TPM Software Stack) library that wraps TBS with high-level classes
   - `Tpm2::Create()`, `Tpm2::Load()`, `Tpm2::Unseal()` etc.
   - Handles command encoding, session management, error handling

2. **Windows CNG (Cryptography API: Next Generation)** with TPM KSP:
   - `NCryptOpenStorageProvider()` with `MS_NCRYPT_PROVIDER` → TPM key storage provider
   - Can create keys that are bound to the TPM
   - But doesn't directly support PCR-based sealing

3. **TPM NV (Non-Volatile) Index**:
   - `TPM2_NV_DefineSpace` + `TPM2_NV_Write` + `TPM2_NV_Read`
   - Simpler than sealing — stores data in TPM's own NV memory
   - Can be protected with auth values and policies
   - Limited space (typically ~2KB usable)
   - **Does NOT bind to PCR values** — just auth-protected storage

### 2.6 Recommendation for Anti-Theft System

For the anti-theft system, the approach should be:

1. **Primary mechanism**: UEFI NVRAM variable (NON_VOLATILE | BOOTSERVICE_ACCESS | RUNTIME_ACCESS)
   - Written by the UEFI DXE driver during boot
   - Read by the Windows SYSTEM service via `GetFirmwareEnvironmentVariable()`
   - Contains: device ID, last check-in time, theft flag, server URL
   - **No authentication required** for custom variables

2. **TPM sealing for sensitive data** (optional enhancement):
   - Seal the encryption key for the anti-theft agent's configuration using `TPM2_Create` with PCR policy
   - Bind to PCR-7 (Secure Boot policy) to ensure the agent only runs on the original platform
   - If the platform state changes (e.g., Secure Boot disabled), the sealed key cannot be unsealed
   - Use Microsoft TSS.MSR library for easier implementation

3. **TPM NV Index for device identity** (alternative to UEFI variable):
   - Store a device UUID in a TPM NV index
   - More tamper-resistant than UEFI NVRAM (requires TPM owner auth to modify)
   - But limited space and harder to update

---

## 3. Implementation Plan

### 3.1 Windows Service: UEFI Variable Access

```
1. Service runs as LocalSystem (has SeSystemEnvironmentPrivilege by default)
2. Enable the privilege: OpenProcessToken → LookupPrivilegeValue → AdjustTokenPrivileges
3. Read UEFI variable: GetFirmwareEnvironmentVariableW(L"AntiTheftState", L"{guid}", buf, size)
4. Write UEFI variable: SetFirmwareEnvironmentVariableExW(L"AntiTheftState", L"{guid}", data, size, 0x07)
5. Verify round-trip: Write → Reboot → Read
```

### 3.2 Windows Service: TPM Key Sealing (Phase 2)

```
1. Link with Tbs.lib, include tbs.h
2. Create TBS context: Tbsi_Context_Create()
3. Create primary key: TPM2_CreatePrimary() 
4. Create sealed object: TPM2_Create() with PCR policy (TPM2_PolicyPCR)
5. Store sealed object in UEFI NVRAM variable or file
6. On next boot: Load sealed object → Start policy session → PolicyPCR → Unseal
```

### 3.3 UEFI DXE Driver: Variable Writer

```
1. DXE driver runs during boot, before OS
2. Calls gRT->SetVariable(L"AntiTheftState", &gAntiTheftGuid, 
                          EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS | EFI_VARIABLE_RUNTIME_ACCESS,
                          dataSize, &data)
3. Variable is stored in SPI flash NVRAM
4. Windows service reads it after boot
```

---

## 4. Key Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| UEFI variable deleted by user (e.g., `bcdedit /set` or firmware setup) | Use a non-obvious variable name and GUID; also store in TPM NV index as backup |
| UEFI variable modified by malware with SYSTEM privileges | Use authenticated variables (requires signing key); or store critical data in TPM sealed object |
| TPM not present or disabled | Fall back to UEFI NVRAM only; detect TPM absence and report to server |
| Secure Boot disabled by attacker | Seal data to PCR-7 (Secure Boot state); if disabled, sealed data is inaccessible |
| SPI flash physically replaced | TPM is separate hardware; sealed data in TPM survives flash replacement |
| OS reinstalled | Both UEFI NVRAM and TPM NV survive OS reinstall (they're on the motherboard) |

---

## 5. Cross-References

- **Beyond BIOS** Chapter 5 (p. 65-80): UEFI Runtime Services, Variable Services
- **Beyond BIOS** Chapter 10 (p. 157-181): TPM, Measured Boot, Secure Boot
- **Rootkits and Bootkits** Chapter 14 (p. 233-253): UEFI boot process, runtime services
- **Rootkits and Bootkits** Chapter 17 (p. 321-350): Secure Boot, NVRAM variables, attacks
- **Rootkits and Bootkits** Chapter 16 (p. 289-320): S3 boot script, GetFirmwareEnvironmentVariable from kernel mode
- Microsoft Learn: `SetFirmwareEnvironmentVariableExW`, `GetFirmwareEnvironmentVariableW`, `Tbsip_Submit_Command`
- Microsoft TSS.MSR: github.com/microsoft/TSS.MSR (C++ TPM 2.0 library)
