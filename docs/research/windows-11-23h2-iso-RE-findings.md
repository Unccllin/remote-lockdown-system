# Windows 11 23H2 ISO — Direct Reverse-Engineering Findings

**Scope:** hands-on static analysis of real Windows 11 23H2 boot artifacts for the PBL UEFI pre-boot lockdown system.

**Artifact source:** `Win11_23H2_English_x64v2.iso` (third-party CDN mirror `cdn.as212934.net`, consumed by the `quickemu` project).

**Analyzed:** 2026-09-15

---

## 1. Acquisition and integrity

| Item | Value |
|------|-------|
| File | `Win11_23H2_English_x64v2.iso` |
| Size | 6,812,706,816 bytes |
| SHA-256 | `a3cc49f28ed43864e2a267515455df2eb5aca6fd4d86e76aece7fd9f251f27ec` |
| Volume label (UDF) | `CCCOMA_X64FRE_EN-US_DV9` |
| ISO created | 2023-12-05 00:00:00 UTC |
| ISO type | UDF 1.02 / Microsoft CDIMAGE UDF bridge |

**Caveat:** The SHA-256 does not match the widely published `36de5ecb...` hash for the 2024 refresh of `Win11_23H2_English_x64v2.iso`. This is an earlier build (2023-12) with the same filename. The `CCCOMA_X64FRE_EN-US_DV9` volume label and the correct PE/BCD structure confirm it is a genuine Windows 11 23H2 x64 retail install image, not a random binary.

**Extraction reproducibility:**

```bash
# 1. Download (aria2c used for multi-connection speed)
docker run --rm -v /work:/uupdump -w /uupdump --entrypoint aria2c \
  btwiuse/uupdump --no-conf --max-connection-per-server=16 --split=16 \
  --min-split-size=1M -d /uupdump -o Win11_23H2_English_x64v2.iso \
  "https://cdn.as212934.net/windows/Win11_23H2_English_x64v2.iso"

# 2. Extract ISO
docker run --rm -v /work:/uupdump -w /uupdump alpine:latest \
  sh -c 'apk add --no-cache p7zip && 7z x -o/uupdump/Win11Extract /uupdump/Win11_23H2_English_x64v2.iso'

# 3. Dump BCD to .reg
docker run --rm -v /work/Win11Extract:/uupdump -w /uupdump --entrypoint reged \
  btwiuse/uupdump -x efi/microsoft/boot/bcd HKEY_LOCAL_MACHINE\\BCD00000000 "\\\\" /uupdump/bcd.reg
```

---

## 2. Boot manager binaries

### 2.1 Files found on the install ISO

| Path | Size | SHA-256 | Notes |
|------|------|---------|-------|
| `efi/boot/bootx64.efi` | 1,692,144 | `a20b359849cdd4ae847cc1bff219b5a3343a80bcd50d8207bc16d6eeec0cdfbc` | UEFI removable-media boot manager (equivalent to installed `bootmgfw.efi`) |
| `bootmgr.efi` | 1,692,128 | `917386863cc55c264f09f8467958cab373ea0b4eec83a9b2a92adbd7d31d0c7e` | Fixed-media UEFI boot manager |
| `efi/microsoft/boot/bcd` | 16,384 | `6e0611d24c6e5029ecd6f4dc8a4f296bc378e4998bf5ee48ea24a029a4c6efed` | BCD registry hive (install media version) |

`bootx64.efi` is what the firmware executes when booting the install media. On an installed system the same code lives at `\EFI\Microsoft\Boot\bootmgfw.efi`, so it is the correct target for PBL chain-load analysis.

### 2.2 PE/COFF header facts

| Field | `bootx64.efi` | `bootmgr.efi` |
|-------|---------------|---------------|
| Machine | `0x8664` (x64) | `0x8664` |
| Subsystem | `0xa` (EFI application) | `0x10` (EFI boot service driver) |
| ImageBase | `0x10000000` | `0x140000000` |
| EntryPoint (RVA) | `0x24320` | `0x23544` |
| SizeOfImage | `0x1e1000` | `0x1dd000` |
| DllCharacteristics | `0x100` (NX compatible) | `0x0` |
| Sections | 6 (`.text`, `TRANSIT`, `.data`, `.pdata`, `.rsrc`, `.reloc`) | same layout |
| Certificate table | present at file offset `0x19ac00`, type `0x0002` (PKCS#7) | present |

Observations for PBL:

- **Preferred ImageBase is non-zero.** Unlike PBL (`ImageBase = 0x0`), the Windows boot manager has a non-zero preferred base. It still uses PE/COFF relocations, but the in-memory bytes are less likely to flip arbitrarily. This is why a self-image hash of `bootmgfw.efi` *might* be stable if you hash the file on disk, but hashing the relocated in-memory image is still unsafe.
- **Certificate table is appended at the end of the file.** A whole-file SHA-256 includes the PKCS#7 signature. If you want a stable code-only measurement, hash bytes `[0 ... certificate_table_offset)` (here `0x19ac00`).
- **No import table.** The boot manager is a self-contained UEFI application that calls UEFI boot/runtime services by pointer and uses its own `Bl` (boot library) functions.

### 2.3 Entry point

Disassembly at `0x10024320` (`ImageBase + EntryPoint`) shows a tiny thunk:

```asm
sub  rsp, 0x28
call 0x10036c70
test rax, rax
jne  0x10024335
mov  eax, 0xc000000d
jmp  0x1002433d
mov  rcx, rax
call 0x100244ec
mov  ecx, eax
add  rsp, 0x28
jmp  0x10037918
```

The boot manager first calls an initializer (`0x10036c70`), then passes the returned pointer to `0x100244ec`, and finally jumps to `0x10037918`. A full flow reconstruction would require several hours and is out of scope for this artifact, but the entry point is confirmed and the binary is correctly disassemblable with Capstone.

### 2.4 Strings of PBL interest from `bootx64.efi`

```
\EFI\Microsoft\Boot
\EFI\Microsoft\Recovery\BCD
\EFI\Microsoft\Boot\bootmgr.efi
\Windows\System32\winload.efi
\Windows\System32\boot\winload.efi
Boot library initialized.
Launching boot entry.
Rebooting the device
BmpSvnCheck: Major SVN check failed, current SVN: %lu, cached SVN: %lu
```

Security / BitLocker / debug:

```
The boot manager experienced error (%08x) due to an invalid entry in the BCD store.
The boot manager experienced an error (%08x) parsing element (%ws) within BCD object %s.
The boot manager experienced an error (%08x) due to the default Secure Boot policy not being found.
SecureBootPolicy.p7b
SecureBootUnlockToken.pol
SecureBootDebugPolicy.pol
```

BitLocker full-volume-encryption UI and network unlock:

```
<fve-error-select error-text='
<fve-recovery-select recovery-text='
<fve-title-update value='
ERROR: Unable to read BitLocker network unlock metadata(0x%x)
ERROR: Unable to create BitLocker network unlock request (0x%x)
ERROR: Unable to send BitLocker network unlock request (0x%x)
ERROR: Unable to receive BitLocker network unlock response (0x%x)
ERROR: Unable to decrypt BitLocker network unlock response (0x%x)
ERROR: Invalid BitLocker network unlock response (0x%x)
ERROR: FveUdpTransmit(): (0x%x)
ERROR: FveUdpReceiveProcess(): (0x%x)
```

BCD `loadoptions` / debug / test-signing tokens:

```
NOINTEGRITYCHECKS
TESTSIGNING
BOOTDEBUG
NODEBUG
DEBUGPORT
HYPERVISORLAUNCHTYPE=AUTO
HYPERVISORLAUNCHTYPE=OFF
HYPERVISORDBG
HYPERVISORIOMMUPOLICY=DEFAULT
HYPERVISORIOMMUPOLICY=ENABLE
HYPERVISORIOMMUPOLICY=DISABLE
Shutting down VHD quickly.
FORCEHVTONOTSHAREDEBUGDEVICE
```

**Key takeaway:** `bootmgfw.efi` parses the BCD, enforces Secure Boot policy files, presents BitLocker recovery UI, and honors `NOINTEGRITYCHECKS` / `TESTSIGNING` / `BOOTDEBUG` / `HYPERVISOR*` load options. A PBL pre-boot lock must treat all of these as part of the platform-state measurement, because any of them materially change the trust boundary.

---

## 3. BCD store analysis

The install-media BCD contains 9 objects. Below are the objects decoded from the live hive with element IDs mapped to their Windows BCD constants.

### 3.1 BCD objects

| GUID | Type | Description | PBL relevance |
|------|------|-------------|---------------|
| `{9dea862c-5cdd-4e70-acc1-f32b344d4795}` | `0x10100002` Boot Manager | "Windows Boot Manager" | Default loader, timeout, display order |
| `{7619dcc9-fafe-11d9-b411-000476eba25f}` | `0x10200003` OS Loader | "Windows Setup" | The `winload.efi` path and `WinPE` flag |
| `{b2721d73-1db4-4c62-bf78-c548a880142d}` | `0x10200005` Memory Tester | "Windows Memory Diagnostic" | Tools entry |
| `{7ff607e0-4395-11db-b0de-0800200c9a66}` | `0x20200003` Hypervisor Settings | "Hypervisor Settings" | Hypervisor launch/debug |
| `{0ce4991b-e6b3-4b16-b23c-5e0d9250e5d9}` | `0x20100000` Inherit | EMS/debug settings | `EmsEnabled = false` |
| `{4636856e-540f-4170-a130-a84776f4c654}` | `0x20100000` Inherit | Debug settings | `DebuggerType`, `DebuggerPort`, `DebuggerBaudRate` |
| `{6efb52bf-1766-41db-a6b3-0ee5eff72bd7}` | `0x20100000` Inherit | Common settings | Inherited objects list |
| `{7ea2e1ac-2e61-4728-aaa3-896d9d0a9f0e}` | `0x20100000` Inherit | Common settings | Inherited objects list |

### 3.2 Boot Manager object `{9dea862c-...}`

Decoded elements:

| Element | Name | Value on this ISO |
|---------|------|-------------------|
| `0x12000004` | `Description` | `"Windows Boot Manager"` |
| `0x12000005` | `PreferredLocale` | `"en-US"` |
| `0x14000006` | `InheritedObjects` | `{7ea2e1ac-...}` |
| `0x23000003` | `DefaultObject` | `{7619dcc9-...}` |
| `0x24000001` | `DisplayOrder` | `{7619dcc9-...}` |
| `0x24000010` | `ToolsDisplayOrder` | `{b2721d73-...}` |
| `0x25000004` | `Timeout` | `0x1e` (30 seconds) |

### 3.3 OS Loader object `{7619dcc9-...}` (Windows Setup)

| Element | Name | Value on this ISO |
|---------|------|-------------------|
| `0x11000001` | `OSDevice` | `Boot device: Partition = boot partition` |
| `0x12000002` | `SystemRoot` | `\windows\system32\boot\winload.efi` |
| `0x12000004` | `Description` | `Windows Setup` |
| `0x12000005` | `Locale` | `en-US` |
| `0x14000006` | `InheritedObjects` | `{6efb52bf-...}` |
| `0x16000060` | `IsolatedExecutionContext` | `0x01` (enabled) |
| `0x21000001` | `ResumeFileDevice` | same device record as `OSDevice` |
| `0x22000002` | `ResumeFilePath` | `\windows` |
| `0x250000c2` | `BootMenuPolicy` | `0x01` |
| `0x26000010` | `DetectKernelAndHal` | `0x01` |
| `0x26000022` | `WinPEMode` | `0x01` (this is setup media, not installed Windows) |
| `0x260000b0` | `BootStatusPolicy` | `0x00` |

### 3.4 Hypervisor Settings object `{7ff607e0-...}`

| Element | Name | Value |
|---------|------|-------|
| `0x250000f3` | `HypervisorDebugEnabled` | `0` |
| `0x250000f4` | `HypervisorDebugType` | `1` |
| `0x250000f5` | `HypervisorDebugPort` | `115200` (0x1c200) |

### 3.5 Inheritable settings objects

- `{0ce4991b-...}`: `EmsEnabled` = `false`
- `{4636856e-...}`: `DebuggerType = 0`, `DebuggerPort = 1`, `DebuggerBaudRate = 115200`
- `{6efb52bf-...}` and `{7ea2e1ac-...}`: contain only `InheritedObjects` lists, used to share common settings between boot entries.

### 3.6 PBL-relevant BCD fields not present on install media but real on installed systems

The install-media BCD is small. An installed Windows BCD additionally contains:

- `0x14000008` `RecoverySequence` — ordered list of recovery entries to try.
- `0x16000009` `AutoRecoveryEnabled` — whether to auto-fallback to recovery.
- `0x16000040` `DisplayAdvancedOptions`
- `0x16000041` `DisplayOptionsEdit`
- `0x16000049` `AllowPrereleaseSignatures` (maps to `TESTSIGNING`)
- `0x16000048` `NoIntegrityChecks`
- `0x26000025` `UseLastGoodSettings`
- `0x26000081` `SafeMode`
- `0x260000a0` `Debug`
- `0x25000020` `NxPolicy`
- `0x22000011` `KernelPath`, `0x22000012` `HalPath`, `0x22000013` `DbgTransportPath`

**Critical point:** PBL cannot detect the actual BitLocker **lock/unlock state** from the BCD alone. BitLocker state is stored in the FVE metadata on the encrypted volume and in the TPM. The BCD only tells the boot manager *how to present recovery UI* (`RecoverySequence`, `AutoRecoveryEnabled`) and *which paths to load* (`winload.efi`, `systemroot`). Any PBL "BitLocker detection" feature must therefore read BCD for boot configuration, but must also inspect the volume's FVE metadata for the actual encryption state.

---

## 4. Implications for PBL

### 4.1 Chain-load (`bootmgfw.efi`)

PBL currently hashes `bootmgfw.efi` and compares it against `policy.bootmgr_hash` (key 58). Facts from the real binary:

- The file is a signed PE32+ with the certificate table appended at `0x19ac00`.
- A whole-file hash includes the signature.
- A more robust measurement for attestation would hash bytes `[0 .. certificate_table_offset)`.
- PBL already passes the verified buffer to `LoadImage`, which is correct because UEFI `LoadImage` may re-validate the PE and would fail on a corrupt file.

**Action:** consider adding an optional "code-only" hash mode in the policy blob, or document that `bootmgr_hash` is the whole-file hash for a specific build.

Debt mapping:
- `D-214` — chain-load hash verification needs testing with a real `bootmgfw.efi` and a real policy hash.
- `D-218` — policy-provided `bootmgr_hash` is now testable against this artifact.

### 4.2 BCD / platform state

Real BCD confirms the platform-state digest should include:

1. **BCD file hash** — PBL already collects `BcdHash` in `PBL_PLATFORM_STATE`.
2. **BCD object count** and **critical element flags**:
   - `TESTSIGNING` / `NOINTEGRITYCHECKS` / `BOOTDEBUG` / `DEBUG` (`0x16000049`, `0x16000048`, `0x16000010`, `0x260000a0`)
   - `WinPEMode` (`0x26000022`)
   - `HypervisorLaunchType` (derived from `0x250000f3/f4/f5`)
   - `SafeMode` (`0x26000081`)
   - `BootMenuPolicy` / `DisplayAdvancedOptions` / `Timeout`
3. **Boot manager binary hash** — already collected (or should be).
4. **Loaded UEFI image count** — already collected, but D-213 notes the signal is weak.

The boot manager itself parses these BCD elements before launching `winload.efi`. PBL's platform-state measurement is only useful if it captures the same elements the boot manager will act on.

**Action:** extend `PlatformState.c` to parse the BCD hive and extract the above flags, then include them in the platform-state digest. This addresses `D-120` (BCD/BitLocker detection from the ESP) in a realistic way.

### 4.3 BitLocker / FVE

`bootx64.efi` contains FVE recovery UI and network-unlock code, but the actual BitLocker key/lock state is not in BCD. The boot manager reads FVE metadata from the volume and, if needed, calls `winload.efi` with recovery parameters.

For PBL this means:

- **BCD gives boot configuration, not encryption state.**
- **FVE metadata on the encrypted volume is the authoritative BitLocker signal.**
- PBL can detect BitLocker *configuration* from BCD (is there a `RecoverySequence`? is `AutoRecoveryEnabled` set?), but to know whether the volume is locked or in recovery, PBL must inspect the volume.

**Action:** split `D-120` into two parts: (a) BCD boot-config extraction (feasible now), (b) FVE volume metadata inspection (requires more RE and a real encrypted volume).

### 4.4 Secure Boot policy files

`bootx64.efi` references:

- `SecureBootPolicy.p7b`
- `SecureBootUnlockToken.pol`
- `SecureBootDebugPolicy.pol`
- `\boot.stl` ( boot-status log )

These are checked by the boot manager. If the default Secure Boot policy is missing, the boot manager fails. PBL's platform-state measurement could record the presence/hashes of these files on the ESP.

### 4.5 Self-image hash lesson (re-confirming prior revert)

`bootx64.efi` has `ImageBase = 0x10000000`, but UEFI still relocates it. PBL's own `ImageBase = 0x0` caused the self-image hash to change every boot because the PE relocations patch absolute addresses. **This re-confirms that the prior revert of self-image measurement (D-212) was correct.** Chain-load hashing the file on disk (not in memory) is the safe pattern.

---

## 5. Verification commands used

```bash
# PE quick view
python3 - <<'PY'
import pefile
for f in ['efi/boot/bootx64.efi','bootmgr.efi']:
    pe = pefile.PE(f)
    print(f, 'ImageBase', hex(pe.OPTIONAL_HEADER.ImageBase), 'EP', hex(pe.OPTIONAL_HEADER.AddressOfEntryPoint))
    for s in pe.sections:
        print(' ', s.Name.decode().strip('\x00'), hex(s.VirtualAddress), hex(s.Misc_VirtualSize))
PY

# Strings
strings -n 6 -e l efi/boot/bootx64.efi | grep -iE 'bitlock|tpm|measure|fve|bcd|secure|nointegrity|testsigning|hyperv|vhd|debug'

# BCD dump
docker run --rm -v $(pwd):/uupdump -w /uupdump --entrypoint reged \
  btwiuse/uupdump -x efi/microsoft/boot/bcd HKEY_LOCAL_MACHINE\\BCD00000000 "\\\\" /uupdump/bcd.reg

# Capstone disassembly around entry point
python3 - <<'PY'
import pefile, capstone
pe = pefile.PE('efi/boot/bootx64.efi')
ep = pe.OPTIONAL_HEADER.AddressOfEntryPoint
s = pe.sections[0]
fo = s.PointerToRawData + (ep - s.VirtualAddress)
addr = pe.OPTIONAL_HEADER.ImageBase + ep
data = open('efi/boot/bootx64.efi','rb').read()[fo:fo+0x100]
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
md.syntax = capstone.CS_OPT_SYNTAX_INTEL
for i in md.disasm(data, addr):
    print(hex(i.address), i.mnemonic, i.op_str)
PY
```

---

## 6. Debt item mapping

| Debt | Status | How these findings affect it |
|------|--------|------------------------------|
| `D-120` | Open | BCD can be parsed from the ESP; real BCD structure is now known. BitLocker *state* still requires FVE volume metadata, not just BCD. |
| `D-213` | Open | Loaded EFI image count remains a weak signal. No new finding changes this; still low-value. |
| `D-214` | Open | Real `bootx64.efi` extracted. A QEMU test can now be written that loads the actual file and verifies `PblChainLoadWindows` runs the hash path. |
| `D-218` | Open | Policy key 58 (`bootmgr_hash`) can now be tested against a known real hash of `bootx64.efi`. |
| `D-219` | Open | Policy signature BLOCK path still needs a provisioned-root test, unrelated to this artifact. |
| `D-212` | Reverted/closed | Re-confirmed: self-image in-memory hashing is non-deterministic because of UEFI relocations. Do not re-introduce. |

---

## 7. Next concrete steps

1. **Test PBL chain-load with real `bootx64.efi`.** Copy `efi/boot/bootx64.efi` to the QEMU ESP, build a policy with the SHA-256 from this note, and run the PASS path. This closes `D-214` and `D-218` with an actual artifact.
2. **Extend `PlatformState.c` to parse BCD.** Add a small BCD element reader that extracts the PBL-relevant flags and appends them to the platform-state digest. This makes D-120 actionable.
3. **Investigate FVE volume metadata.** Use a BitLocker-encrypted test volume to find the FVE metadata block and determine whether a pre-OS tool can read the lock/recovery state.
4. **Do not reintroduce self-image hashing.** The Windows boot manager itself is a counter-example of why in-memory image hashes are fragile.

---

## 8. Raw artifacts on this machine

All binaries and the extracted ISO remain in the working directory outside the git tree to avoid committing Microsoft binaries:

```
/home/cllin/remote-lockdown-system/tmp/winre/Win11_23H2_English_x64v2.iso
/home/cllin/remote-lockdown-system/tmp/winre/Win11Extract/efi/boot/bootx64.efi
/home/cllin/remote-lockdown-system/tmp/winre/Win11Extract/bootmgr.efi
/home/cllin/remote-lockdown-system/tmp/winre/Win11Extract/efi/microsoft/boot/bcd
/home/cllin/remote-lockdown-system/tmp/winre/Win11Extract/bcd.reg
```
