# D-129 window artifacts

`PblApp-6fa6ac418b726075.efi` is the **built** PblApp image, committed here so the
hardware window can be run from any machine without a local EDK II toolchain or a
USB round-trip through the build host.

| field | value |
|---|---|
| sha256 | `6fa6ac418b726075a6b97588c8ed580fe955ffff7dc21f545b2ca6aa8b5e5a05` |
| size | 1,380,352 bytes |
| format | PE32+ executable for EFI (application), x86-64, 3 sections incl. `.reloc` |
| built by | PBL CI, run `43444819018`, job *Build PblApp (X64, GCC)*, commit `f2385c5` |
| EDK II | `2970e5699ba6267f3384ffab20f96647578aebc8` (pinned in `pbl-ci.yml`) |
| toolchain | GCC, `RELEASE`, X64 |

The filename carries the first 16 hex digits of the digest on purpose: a build
artifact that cannot be told apart from another build is worse than no artifact,
and `sha256sum` on any copy answers "which one is this?" in one command.

**This is not a norm.** `firmware/PblPkg/PblApp.efi` stays gitignored; binaries
are built, not versioned. This one is committed because it is the specific input
to a specific hardware run that has to be reproducible *after* the CI job that
produced it has aged out.

## Running it from any machine

Copy it to the machine's EFI System Partition as a **new** file — do not
overwrite `\EFI\Microsoft\...` or `\EFI\BOOT\BOOTX64.EFI`; those are the Windows
boot loader and replacing them can stop the machine booting.

```powershell
# Windows, admin PowerShell
mountvol S: /S
mkdir S:\EFI\PBL -Force
Invoke-WebRequest -Uri https://raw.githubusercontent.com/Unccllin/remote-lockdown-system/master/firmware/PblPkg/artifacts/PblApp-6fa6ac418b726075.efi -OutFile S:\EFI\PBL\PblApp.efi
Get-FileHash S:\EFI\PBL\PblApp.efi -Algorithm SHA256   # must be 6FA6AC41…
mountvol S: /D
```

Then reboot → F9 → **Boot from EFI File** → internal disk → `EFI\PBL\PblApp.efi`.

**Secure Boot must be off** for this image: it is unsigned. With Secure Boot on,
firmware refuses it (and HP usually says nothing, it just boots Windows).
