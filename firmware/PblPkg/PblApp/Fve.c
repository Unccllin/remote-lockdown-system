/** @file Fve.c — D-120: BitLocker FVE volume metadata inspection.

  The BCD only carries boot configuration; the authoritative BitLocker
  signal is the FVE metadata on the encrypted volume. This module:

    1. Scans every DiskIo block device for the "-FVE-FS-" signature at
       offset 3 of the volume header (Win7/10 variant; boot EB 58 90).
    2. Reads the three metadata block offsets (u64 @ 176/184/192) and
       opens the first block that verifies.
    3. Walks the metadata entry array for VMK entries
       (entry_type 0x0002, value_type 0x0008) and accumulates the VMK
       protection types (offset 26 within the VMK value: clear key 0x0000,
       TPM 0x0100, startup key 0x0200, TPM+PIN 0x0500, recovery password
       0x0800, password 0x2000).

  Layout per libyal/libbde "BitLocker Drive Encryption (BDE) format"
  specification.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"
#include <Protocol/BlockIo.h>
#include <Protocol/DiskIo.h>

#define FVE_SIG            "-FVE-FS-"
#define FVE_SIG_OFF        3
#define FVE_MD_OFF_0       176   // Win7/10 volume header: 3 x u64 block offsets
#define FVE_MD_BLOCK_HDR   64    // block header size
#define FVE_MD_HDR         48    // metadata header size
#define FVE_MD_MAX_READ    (128 * 1024)

// VMK protection-type → bitmask
#define FVE_PROT_CLEAR     BIT0   // 0x0000 clear key (auto-unlock)
#define FVE_PROT_TPM       BIT1   // 0x0100 TPM
#define FVE_PROT_STARTUP   BIT2   // 0x0200 startup key
#define FVE_PROT_TPM_PIN   BIT3   // 0x0500 TPM+PIN
#define FVE_PROT_RECOVERY  BIT4   // 0x0800 recovery password
#define FVE_PROT_PASSWORD  BIT5   // 0x2000 password
#define FVE_PROT_UNKNOWN   BIT15

STATIC
UINT16
PblFveProtBit (
  IN UINT16  ProtType
  )
{
  switch (ProtType) {
    case 0x0000: return FVE_PROT_CLEAR;
    case 0x0100: return FVE_PROT_TPM;
    case 0x0200: return FVE_PROT_STARTUP;
    case 0x0500: return FVE_PROT_TPM_PIN;
    case 0x0800: return FVE_PROT_RECOVERY;
    case 0x2000: return FVE_PROT_PASSWORD;
    default:     return FVE_PROT_UNKNOWN;
  }
}

/** Read a byte range from a device via DiskIo. **/
STATIC
EFI_STATUS
PblFveRead (
  IN  EFI_DISK_IO_PROTOCOL *Dio,
  IN  UINT32               MediaId,
  IN  UINT64               Offset,
  IN  UINTN                Size,
  OUT UINT8               *Buf
  )
{
  return Dio->ReadDisk (Dio, MediaId, Offset, Size, Buf);
}

/** Parse one FVE metadata block buffer.

  @param Block   Buffer starting at the block header ("-FVE-FS-").
  @param Size    Bytes available in Block.
  @param State   State to update (mask/method/version on success).

  @retval TRUE   Signature valid and entries walked.
**/
STATIC
BOOLEAN
PblFveParseMetadataBlock (
  IN     CONST UINT8         *Block,
  IN     UINTN                Size,
  IN OUT PBL_PLATFORM_STATE  *State
  )
{
  if (Size < FVE_MD_BLOCK_HDR + FVE_MD_HDR) {
    return FALSE;
  }
  if (CompareMem (Block, FVE_SIG, 8) != 0) {
    return FALSE;
  }

  State->FveMetadataVersion  = (UINT8)ReadUnaligned32 ((UINT32 *)(Block + 8));
  UINT32 MetaSize  = ReadUnaligned32 ((UINT32 *)(Block + FVE_MD_BLOCK_HDR + 0));
  UINT16 EncMethod = ReadUnaligned16 ((UINT16 *)(Block + FVE_MD_BLOCK_HDR + 36));
  State->FveEncryptionMethod = EncMethod;

  // Entries start after block header + metadata header and run for
  // MetaSize bytes (metadata header + entries), bounded by the buffer.
  UINTN EntriesStart = FVE_MD_BLOCK_HDR + FVE_MD_HDR;
  UINTN End = FVE_MD_BLOCK_HDR + MetaSize;
  if (End > Size) {
    End = Size;
  }

  UINTN P = EntriesStart;
  while (P + 8 <= End) {
    UINT16 EntrySize  = ReadUnaligned16 ((UINT16 *)(Block + P + 0));
    UINT16 EntryType  = ReadUnaligned16 ((UINT16 *)(Block + P + 2));
    UINT16 ValueType  = ReadUnaligned16 ((UINT16 *)(Block + P + 4));
    if (EntrySize < 8 || P + EntrySize > End) {
      break;
    }
    if (EntryType == 0x0002 && ValueType == 0x0008 && EntrySize >= 8 + 28) {
      // VMK value: GUID@8, FILETIME@24, unknown@32, protection@34 (entry-rel)
      UINT16 Prot = ReadUnaligned16 ((UINT16 *)(Block + P + 34));
      State->FveProtectionMask |= PblFveProtBit (Prot);
    }
    P += EntrySize;
  }

  return TRUE;
}

/** D-120: Detect BitLocker by FVE volume metadata on attached disks.

  Sets State->BitLockerEnabled, FveMetadataVersion, FveEncryptionMethod,
  FveProtectionMask, FveClearKeyOnly.

  @param State  Platform state to update.
**/
VOID
PblCheckFve (
  IN OUT PBL_PLATFORM_STATE *State
  )
{
  EFI_STATUS  Status;
  EFI_HANDLE  *Handles = NULL;
  UINTN       NumHandles = 0;
  UINTN       i;

  // BitLockerEnabled is OR'd in below — the BCD recovery-GUID heuristic in
  // PblCollectBcdState remains as a weak fallback when no FVE volume is
  // attached at pre-boot time.
  State->FveEncryptionMethod = 0;
  State->FveProtectionMask   = 0;
  State->FveMetadataVersion  = 0;
  State->FveClearKeyOnly     = FALSE;

  Status = gBS->LocateHandleBuffer (
    ByProtocol, &gEfiDiskIoProtocolGuid, NULL, &NumHandles, &Handles
  );
  if (EFI_ERROR (Status) || Handles == NULL) {
    return;
  }

  for (i = 0; i < NumHandles; i++) {
    EFI_DISK_IO_PROTOCOL  *Dio = NULL;
    EFI_BLOCK_IO_PROTOCOL *Bio = NULL;
    Status = gBS->HandleProtocol (Handles[i], &gEfiDiskIoProtocolGuid, (VOID **)&Dio);
    if (EFI_ERROR (Status) || Dio == NULL) {
      continue;
    }
    // MediaId comes from BlockIo on the same handle.
    Status = gBS->HandleProtocol (Handles[i], &gEfiBlockIoProtocolGuid, (VOID **)&Bio);
    if (EFI_ERROR (Status) || Bio == NULL || Bio->Media == NULL) {
      continue;
    }
    UINT32 MediaId = Bio->Media->MediaId;

    UINT8 VolHdr[512];
    Status = PblFveRead (Dio, MediaId, 0, sizeof (VolHdr), VolHdr);
    if (EFI_ERROR (Status)) {
      continue;
    }
    if (CompareMem (VolHdr + FVE_SIG_OFF, FVE_SIG, 8) != 0) {
      continue;
    }

    // FVE-FS signature found — this is a BitLocker volume.
    State->BitLockerEnabled = TRUE;
    Print (L"  [OK] FVE-FS volume detected (device %u)\n", (UINT32)i);

    // Win7/10 volume header: three u64 metadata block byte offsets.
    for (UINTN k = 0; k < 3; k++) {
      UINT64 MdOff = ReadUnaligned64 ((UINT64 *)(VolHdr + FVE_MD_OFF_0 + 8 * k));
      if (MdOff == 0 || MdOff > (1ULL << 40)) {
        continue;
      }
      // Read block header + metadata header first to size the region.
      UINT8 Head[FVE_MD_BLOCK_HDR + FVE_MD_HDR];
      Status = PblFveRead (Dio, MediaId, MdOff, sizeof (Head), Head);
      if (EFI_ERROR (Status) || CompareMem (Head, FVE_SIG, 8) != 0) {
        continue;
      }
      UINT32 MetaSize = ReadUnaligned32 ((UINT32 *)(Head + FVE_MD_BLOCK_HDR));
      if (MetaSize == 0 || MetaSize > FVE_MD_MAX_READ - FVE_MD_BLOCK_HDR) {
        continue;
      }
      UINTN Total = FVE_MD_BLOCK_HDR + MetaSize;
      UINT8 *Block = AllocatePool (Total);
      if (Block == NULL) {
        continue;
      }
      CopyMem (Block, Head, sizeof (Head));
      Status = PblFveRead (Dio, MediaId, MdOff + sizeof (Head),
                           Total - sizeof (Head), Block + sizeof (Head));
      if (!EFI_ERROR (Status) && PblFveParseMetadataBlock (Block, Total, State)) {
        Print (L"  [INFO] FVE metadata v%u, method 0x%04x, protectors 0x%04x\n",
               State->FveMetadataVersion, State->FveEncryptionMethod,
               State->FveProtectionMask);
        FreePool (Block);
        break;
      }
      FreePool (Block);
    }

    // A clear-key-only VMK set means the volume auto-unlocks without any
    // protector — encryption at rest but no pre-boot gate.
    if (State->FveProtectionMask != 0 &&
        (State->FveProtectionMask & ~FVE_PROT_CLEAR) == 0) {
      State->FveClearKeyOnly = TRUE;
      Print (L"  [WARN] FVE volume uses clear key only (auto-unlock)\n");
    }
    break;  // first FVE volume is enough
  }

  gBS->FreePool (Handles);
}
