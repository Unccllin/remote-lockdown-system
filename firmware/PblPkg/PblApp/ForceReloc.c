/** @file
  ForceReloc.c — Force .reloc section generation for HP Insyde BIOS compatibility.

  The HP Insyde BIOS (F.39, 2018) requires a .reloc section to load EFI
  applications. EDK2's GenFw only creates .reloc when the ELF has
  R_X86_64_64 (absolute) relocations. PBL's code compiled with -fPIC
  generates only R_X86_64_PC32 (PC-relative) relocations, so GenFw
  produces an EFI without .reloc, which the HP BIOS rejects.

  This file creates a global function-pointer table in .data that the
  linker cannot optimize away, forcing R_X86_64_64 relocations.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// Function pointer table in .data — generates R_X86_64_64 relocations
// that GenFw converts to PE/COFF base relocations (.reloc section).
// __attribute__((used)) prevents LTO from optimizing this away.
typedef struct {
  EFI_STATUS (EFIAPI *EntryPoint)(EFI_HANDLE, EFI_SYSTEM_TABLE *);
  VOID      *Marker;
} PBL_RELOC_FORCE;

__attribute__((used))
PBL_RELOC_FORCE gPblForceReloc = {
  .EntryPoint = PblAppEntryPoint,
  .Marker     = (VOID *)(UINTN)0xDEADBEEFCAFEBABEULL
};
