## @file
#  AntiTheftCapsule.dsc — Build description for the capsule payload driver
#
##

[Defines]
  PLATFORM_NAME                  = AntiTheftCapsule
  PLATFORM_GUID                  = E6F7A8B9-C0D1-2345-EF01-7890ABCDEF01
  PLATFORM_VERSION               = 1.0
  DSC_SPECIFICATION              = 0x00010006
  OUTPUT_DIRECTORY               = Build/AntiTheftCapsule
  SUPPORTED_ARCHITECTURES        = X64
  BUILD_TARGETS                  = DEBUG|RELEASE
  SKUID_IDENTIFIER               = DEFAULT

[BuildOptions]
  GCC:*_*_X64_CC_FLAGS = -DNO_BUILTIN

[LibraryClasses]
  UefiDriverEntryPoint|MdePkg/Library/UefiDriverEntryPoint/UefiDriverEntryPoint.inf
  UefiApplicationEntryPoint|MdePkg/Library/UefiApplicationEntryPoint/UefiApplicationEntryPoint.inf
  UefiLib|MdePkg/Library/UefiLib/UefiLib.inf
  UefiBootServicesTableLib|MdePkg/Library/UefiBootServicesTableLib/UefiBootServicesTableLib.inf
  UefiRuntimeServicesTableLib|MdePkg/Library/UefiRuntimeServicesTableLib/UefiRuntimeServicesTableLib.inf
  BaseLib|MdePkg/Library/BaseLib/BaseLib.inf
  BaseMemoryLib|MdePkg/Library/BaseMemoryLib/BaseMemoryLib.inf
  DebugLib|MdePkg/Library/BaseDebugLibNull/BaseDebugLibNull.inf
  PcdLib|MdePkg/Library/BasePcdLibNull/BasePcdLibNull.inf
  MemoryAllocationLib|MdePkg/Library/UefiMemoryAllocationLib/UefiMemoryAllocationLib.inf
  PrintLib|MdePkg/Library/BasePrintLib/BasePrintLib.inf
  DevicePathLib|MdePkg/Library/UefiDevicePathLib/UefiDevicePathLib.inf
  UefiRuntimeLib|MdePkg/Library/UefiRuntimeLib/UefiRuntimeLib.inf
  FileHandleLib|MdePkg/Library/UefiFileHandleLib/UefiFileHandleLib.inf
  RegisterFilterLib|MdePkg/Library/RegisterFilterLibNull/RegisterFilterLibNull.inf
  StackCheckLib|MdePkg/Library/StackCheckLibNull/StackCheckLibNull.inf
  StackCheckFailureHookLib|MdePkg/Library/StackCheckFailureHookLibNull/StackCheckFailureHookLibNull.inf

[Components]
  AntiTheftCapsule/AntiTheftFmpDxe.inf
  AntiTheftCapsule/CapsuleLoader.inf
