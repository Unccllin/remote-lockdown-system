## @file
# PblPkg.dsc — Build description for the PBL UEFI application.
#
# Builds for X64 and AARCH64 with GCC5 and VS2019 toolchains.
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
  DEFINE TARGET_TOOLCHAIN        = GCC5

[BuildOptions]
  # -Werror: warnings are errors (charter §4 Agent A constraints)
  # -Wall -Wextra: comprehensive warnings
  # -fno-stack-protector: UEFI has no libc stack protector; use compiler intrinsic
  GCC:RELEASE_GCC5_*_CC_FLAGS = -Werror -Wall -Wextra -Wno-unused-parameter -fno-stack-protector -DUEFI_BUILD
  GCC:DEBUG_GCC5_*_CC_FLAGS   = -Werror -Wall -Wextra -Wno-unused-parameter -fno-stack-protector -DUEFI_BUILD -DPBL_DEBUG

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
  UefiBootServicesTableLib|MdePkg/Library/UefiBootServicesTableLib/UefiBootServicesTableLib.inf
  UefiLib|MdePkg/Library/UefiLib/UefiLib.inf
  UefiRuntimeServicesTableLib|MdePkg/Library/UefiRuntimeServicesTableLib/UefiRuntimeServicesTableLib.inf

  # Crypto (for COSE_Sign1 verification, C1/C4)
  BaseCryptLib|CryptoPkg/Library/BaseCryptLib/BaseCryptLib.inf
  IntrinsicLib|CryptoPkg/Library/IntrinsicLib/IntrinsicLib.inf
  OpensslLib|CryptoPkg/Library/OpensslLib/OpensslLib.inf
  SynchronizationLib|MdePkg/Library/BaseSynchronizationLib/BaseSynchronizationLib.inf
  TimerLib|MdePkg/Library/SecPeiDxeTimerLibCpu/SecPeiDxeTimerLibCpu.inf
  RngLib|MdeModulePkg/Library/BaseRngLibTimerLib/BaseRngLibTimerLib.inf
  StackCheckLib|MdePkg/Library/StackCheckLibNull/StackCheckLibNull.inf
  DebugPrintErrorLevelLib|MdePkg/Library/BaseDebugPrintErrorLevelLib/BaseDebugPrintErrorLevelLib.inf

[Components]
  PblPkg/PblApp/PblApp.inf
