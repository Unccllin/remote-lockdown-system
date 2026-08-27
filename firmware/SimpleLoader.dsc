## @file
# SimpleLoader — loads and runs AntiTheftAgent.efi from FAT
##

[Defines]
  PLATFORM_NAME                  = SimpleLoader
  PLATFORM_GUID                  = A1B2C3D4-E5F6-1234-ABCD-EF1234567890
  PLATFORM_VERSION               = 1.0
  DSC_SPECIFICATION              = 0x00010006
  OUTPUT_DIRECTORY               = Build/SimpleLoader
  SUPPORTED_ARCHITECTURES        = X64
  BUILD_TARGETS                  = DEBUG|RELEASE
  SKUID_IDENTIFIER               = DEFAULT

[BuildOptions]
  GCC:*_*_X64_CC_FLAGS = -DNO_BUILTIN

[LibraryClasses]
  UefiApplicationEntryPoint|MdePkg/Library/UefiApplicationEntryPoint/UefiApplicationEntryPoint.inf
  UefiLib|MdePkg/Library/UefiLib/UefiLib.inf
  UefiRuntimeServicesTableLib|MdePkg/Library/UefiRuntimeServicesTableLib/UefiRuntimeServicesTableLib.inf
  BaseLib|MdePkg/Library/BaseLib/BaseLib.inf
  BaseMemoryLib|MdePkg/Library/BaseMemoryLib/BaseMemoryLib.inf
  DebugLib|MdePkg/Library/BaseDebugLibNull/BaseDebugLibNull.inf
  PcdLib|MdePkg/Library/BasePcdLibNull/BasePcdLibNull.inf
  UefiBootServicesTableLib|MdePkg/Library/UefiBootServicesTableLib/UefiBootServicesTableLib.inf
  MemoryAllocationLib|MdePkg/Library/UefiMemoryAllocationLib/UefiMemoryAllocationLib.inf
  DevicePathLib|MdePkg/Library/UefiDevicePathLib/UefiDevicePathLib.inf
  PrintLib|MdePkg/Library/BasePrintLib/BasePrintLib.inf
  RegisterFilterLib|MdePkg/Library/RegisterFilterLibNull/RegisterFilterLibNull.inf
  StackCheckLib|MdePkg/Library/StackCheckLibNull/StackCheckLibNull.inf
  StackCheckFailureHookLib|MdePkg/Library/StackCheckFailureHookLibNull/StackCheckFailureHookLibNull.inf

[Components]
  SimpleLoader/SimpleLoader.inf
