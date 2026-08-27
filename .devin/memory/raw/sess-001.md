# Session Capture — 2026-08-17 — sess-001

## Context
- Task: Build and test UEFI capsule update for anti-theft firmware agent delivery
- Environment: remote-lockdown-system, firmware/, EDK2, QEMU/OVMF
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- <none recorded>

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- EDK2 GenerateCapsule --signer-private-cert needs a combined PEM file (cat key.crt > signer.pem), not separate key and cert files
- FMP capsule payload has a 16-byte FMP_PAYLOAD_HEADER with MSS1 signature (0x3153534D) before the actual UEFI image
- Signed FMP capsules have EFI_FIRMWARE_IMAGE_AUTHENTICATION: 8-byte MonotonicCount + WIN_CERTIFICATE (dwLength gives total cert size)
- OVMF does not support FMP capsule updates — QueryCapsuleCapabilities returns EFI_UNSUPPORTED
- CapsuleApp.efi must be run from UEFI shell with arguments, cannot be used as BOOTX64.EFI
- SetFirmwareEnvironmentVariableExW with CapsuleUpdateData variable name + FMP capsule GUID is the Windows path for capsule delivery
- QEMU pc-bios files are in separate packages: seabios, qemu-system-data, ipxe-qemu
- /tmp extracted packages do not survive between sessions — install system-wide if possible

## Mistakes / Corrections
- Used wrong MSS1 signature byte order (0x4D535331 instead of 0x3153534D): should check hexdump of capsule to verify signature encoding
- Forgot EFI_FIRMWARE_IMAGE_AUTHENTICATION has MonotonicCount before WIN_CERTIFICATE: should read the UEFI spec structure definition before parsing
- Did not check if OVMF supports FMP before building the full test: should have grepped OVMF DSC/FDF for FMP modules first

## Open Questions
- <none recorded>

## File References
- firmware/AntiTheftCapsule/AntiTheftFmpDxe.c
- firmware/AntiTheftCapsule/CapsuleLoader.c
- firmware/capsule-output/AntiTheft.cap
- firmware/capsule-output/AntiTheft-USB.img
- firmware/windows-test/CapsuleUpdater.ps1
- scripts/memory.py
- .devin/skills/memory/SKILL.md
