## @file
# Anti-Theft Network Init Platform Description
##

[Defines]
  PLATFORM_NAME                  = AntiTheftNetInit
  PLATFORM_GUID                  = A8B9C0D1-E2F3-4456-B123-56789ABCDEF0
  PLATFORM_VERSION               = 0.1
  DSC_SPECIFICATION              = 0x00010006
  OUTPUT_DIRECTORY               = Build/AntiTheftNetInit
  SUPPORTED_ARCHITECTURES        = X64
  BUILD_TARGETS                  = DEBUG|RELEASE
  SKUID_IDENTIFIER               = DEFAULT

[BuildOptions]
  GCC:*_*_X64_CC_FLAGS = -DNO_BUILTIN

[LibraryClasses]
  UefiApplicationEntryPoint|MdePkg/Library/UefiApplicationEntryPoint/UefiApplicationEntryPoint.inf
  UefiLib|MdePkg/Library/UefiLib/UefiLib.inf
  UefiBootServicesTableLib|MdePkg/Library/UefiBootServicesTableLib/UefiBootServicesTableLib.inf
  UefiRuntimeServicesTableLib|MdePkg/Library/UefiRuntimeServicesTableLib/UefiRuntimeServicesTableLib.inf
  BaseLib|MdePkg/Library/BaseLib/BaseLib.inf
  BaseMemoryLib|MdePkg/Library/BaseMemoryLib/BaseMemoryLib.inf
  MemoryAllocationLib|MdePkg/Library/UefiMemoryAllocationLib/UefiMemoryAllocationLib.inf
  DebugLib|MdePkg/Library/BaseDebugLibNull/BaseDebugLibNull.inf
  PcdLib|MdePkg/Library/BasePcdLibNull/BasePcdLibNull.inf
  DevicePathLib|MdePkg/Library/UefiDevicePathLib/UefiDevicePathLib.inf
  PrintLib|MdePkg/Library/BasePrintLib/BasePrintLib.inf
  UefiRuntimeLib|MdePkg/Library/UefiRuntimeLib/UefiRuntimeLib.inf
  RegisterFilterLib|MdePkg/Library/RegisterFilterLibNull/RegisterFilterLibNull.inf
  StackCheckLib|MdePkg/Library/StackCheckLibNull/StackCheckLibNull.inf
  StackCheckFailureHookLib|MdePkg/Library/StackCheckFailureHookLibNull/StackCheckFailureHookLibNull.inf

[Components]
  AntiTheftNetInit/AntiTheftNetInit.inf
