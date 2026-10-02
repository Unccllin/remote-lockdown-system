## @file
# PblPkg.dsc — Build description for the PBL UEFI application.
#
# Builds for X64 and AARCH64 with GCC and VS2019 toolchains.
# GCC5 is deprecated in edk2-stable202408; use GCC instead.
# -fno-lto is required to generate .reloc section for HP Insyde BIOS.
# Reproducible build: use build-pbl.sh which sets SOURCE_DATE_EPOCH and
# deterministic compiler flags.
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

[Defines]
  PLATFORM_NAME                  = PblPkg
  PLATFORM_GUID                  = 8B4C6D3E-2F5A-4B7C-9D1E-F23456789012
  PLATFORM_VERSION               = 0.1.0
  DSC_SPECIFICATION              = 0x00010005
  OUTPUT_DIRECTORY               = Build/PblPkg
  SUPPORTED_ARCHITECTURES        = X64|AARCH64
  BUILD_TARGETS                  = RELEASE|DEBUG
  SKUID_IDENTIFIER               = DEFAULT
  FLASH_DEFINITION               = PblPkg/PblPkg.fdf

  # Default architecture and toolchain (overridden by build-pbl.sh)
  DEFINE TARGET_ARCH             = X64
  DEFINE TARGET_TOOLCHAIN        = GCC

[BuildOptions]
  # -fno-lto: Disable LTO to generate .reloc section (HP Insyde BIOS requirement).
  #   LTO eliminates absolute relocations, so GenFw produces no .reloc.
  #   Without .reloc, HP Insyde F.39 rejects the EFI binary.
  #   Applied globally (all modules) so GenFw sees absolute relocations.
  GCC:RELEASE_*_*_CC_FLAGS = -fno-lto
  GCC:RELEASE_*_*_DLINK_FLAGS = -fno-lto

  VS:RELEASE_VS2019_*_CC_FLAGS = /WX /W4 /D UEFI_BUILD
  VS:DEBUG_VS2019_*_CC_FLAGS   = /WX /W4 /D UEFI_BUILD /D PBL_DEBUG

[Packages]
  MdePkg/MdePkg.dec
  MdeModulePkg/MdeModulePkg.dec
  NetworkPkg/NetworkPkg.dec
  SecurityPkg/SecurityPkg.dec
  CryptoPkg/CryptoPkg.dec
  PblPkg/PblPkg.dec

[LibraryClasses]
  BaseLib|MdePkg/Library/BaseLib/BaseLib.inf
  BaseMemoryLib|MdePkg/Library/BaseMemoryLib/BaseMemoryLib.inf
  DebugLib|MdePkg/Library/UefiDebugLibStdErr/UefiDebugLibStdErr.inf
  DevicePathLib|MdePkg/Library/UefiDevicePathLib/UefiDevicePathLib.inf
  MemoryAllocationLib|MdePkg/Library/UefiMemoryAllocationLib/UefiMemoryAllocationLib.inf
  PcdLib|MdePkg/Library/BasePcdLibNull/BasePcdLibNull.inf
  PrintLib|MdePkg/Library/BasePrintLib/BasePrintLib.inf
  IoLib|MdePkg/Library/BaseIoLibIntrinsic/BaseIoLibIntrinsic.inf
  RegisterFilterLib|MdePkg/Library/RegisterFilterLibNull/RegisterFilterLibNull.inf
  PerformanceLib|MdePkg/Library/BasePerformanceLibNull/BasePerformanceLibNull.inf
  UefiApplicationEntryPoint|MdePkg/Library/UefiApplicationEntryPoint/UefiApplicationEntryPoint.inf
  UefiDriverEntryPoint|MdePkg/Library/UefiDriverEntryPoint/UefiDriverEntryPoint.inf
  UefiBootServicesTableLib|MdePkg/Library/UefiBootServicesTableLib/UefiBootServicesTableLib.inf
  UefiLib|MdePkg/Library/UefiLib/UefiLib.inf
  UefiRuntimeServicesTableLib|MdePkg/Library/UefiRuntimeServicesTableLib/UefiRuntimeServicesTableLib.inf

  # Crypto (for COSE_Sign1 verification, C1/C4)
  # Using Null libs to reduce binary size for HP BIOS size limit
  BaseCryptLib|CryptoPkg/Library/BaseCryptLib/BaseCryptLib.inf
  IntrinsicLib|CryptoPkg/Library/IntrinsicLib/IntrinsicLib.inf
  OpensslLib|CryptoPkg/Library/OpensslLib/OpensslLibFull.inf
  SynchronizationLib|MdePkg/Library/BaseSynchronizationLib/BaseSynchronizationLib.inf
  TimerLib|MdePkg/Library/SecPeiDxeTimerLibCpu/SecPeiDxeTimerLibCpu.inf
  RngLib|MdeModulePkg/Library/BaseRngLibTimerLib/BaseRngLibTimerLib.inf
  StackCheckLib|MdePkg/Library/StackCheckLibNull/StackCheckLibNull.inf
  DebugPrintErrorLevelLib|MdePkg/Library/BaseDebugPrintErrorLevelLib/BaseDebugPrintErrorLevelLib.inf

[Components]
  PblPkg/PblApp/PblApp.inf

  # DXE persistence module — built as a standalone .efi for capsule/FFS
  # packaging. Registers a ReadyToBoot callback that re-drops the lockdown
  # agent to the ESP (survives OS reinstall + disk replacement).
  PblPkg/PblPersistDxe/PblPersistDxe.inf

  # Test-only loader (QEMU) — boots as BOOTX64.EFI, LoadImage+StartImage's the
  # DXE driver so its ReadyToBoot callback registers, then returns to BDS.
  PblPkg/PblPersistDxe/PblPersistLoader.inf
