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

/** Byte length of a device path's "disk prefix": all nodes up to but
  excluding the first MEDIA_DEVICE_PATH node (HD partition node etc.).
  The remaining ACPI/PCI/messaging nodes (SATA port, NVMe namespace, USB
  port) identify the physical disk. If no media node exists the whole
  path is the prefix.

  @param  Dp  Device path to measure.

  @return Byte length of the disk prefix; 0 for NULL.
**/
STATIC
UINTN
PblFveDiskPrefixLen (
  IN CONST EFI_DEVICE_PATH_PROTOCOL  *Dp
  )
{
  CONST EFI_DEVICE_PATH_PROTOCOL *Node;

  if (Dp == NULL) {
    return 0;
  }
  Node = Dp;
  while (!IsDevicePathEnd (Node)) {
    if (DevicePathType (Node) == MEDIA_DEVICE_PATH) {
      break;
    }
    Node = NextDevicePathNode (Node);
  }
  return (UINTN)((CONST UINT8 *)Node - (CONST UINT8 *)Dp);
}

/** TRUE when Handle's device path shares its disk prefix with BootDp —
  i.e. the handle's volume lives on the same physical disk PBL booted
  from.

  @param  Handle  Device handle carrying EFI_DEVICE_PATH_PROTOCOL.
  @param  BootDp  Device path of PBL's boot device (must not be NULL).
**/
STATIC
BOOLEAN
PblFveSameDisk (
  IN EFI_HANDLE                       Handle,
  IN CONST EFI_DEVICE_PATH_PROTOCOL  *BootDp
  )
{
  EFI_DEVICE_PATH_PROTOCOL *Dp;
  UINTN                    PrefixLen;
  UINTN                    BootPrefixLen;

  if (EFI_ERROR (gBS->HandleProtocol (
                    Handle, &gEfiDevicePathProtocolGuid, (VOID **)&Dp)) ||
      Dp == NULL) {
    return FALSE;
  }
  PrefixLen     = PblFveDiskPrefixLen (Dp);
  BootPrefixLen = PblFveDiskPrefixLen (BootDp);
  return PrefixLen > 0 && PrefixLen == BootPrefixLen &&
         CompareMem (Dp, BootDp, PrefixLen) == 0;
}

/** NG-T5: Return the first MEDIA_DEVICE_PATH HD() node on Handle's device
  path, or NULL. The HD node carries the partition identity (GPT partition
  GUID in Signature[16] with SignatureType 0x02, or MBR signature +
  PartitionStart with SignatureType 0x01) that the BCD osdevice blob
  encodes.
**/
STATIC
CONST HARDDRIVE_DEVICE_PATH *
PblFveHdNode (
  IN EFI_HANDLE  Handle
  )
{
  EFI_DEVICE_PATH_PROTOCOL       *Dp;
  CONST EFI_DEVICE_PATH_PROTOCOL *Node;

  if (EFI_ERROR (gBS->HandleProtocol (
                    Handle, &gEfiDevicePathProtocolGuid, (VOID **)&Dp)) ||
      Dp == NULL) {
    return NULL;
  }
  for (Node = Dp; !IsDevicePathEnd (Node); Node = NextDevicePathNode (Node)) {
    if (DevicePathType (Node) == MEDIA_DEVICE_PATH &&
        DevicePathSubType (Node) == MEDIA_HARDDRIVE_DP) {
      return (CONST HARDDRIVE_DEVICE_PATH *)Node;
    }
  }
  return NULL;
}

/** NG-T5: TRUE when Handle's HD() node matches one of the decoded osdevice
  partition identities — i.e. the FVE volume IS a Windows boot partition,
  not merely a volume on the boot disk.

  GPT (TableType 0): blob.PartitionID is the unique partition GUID, which
    the HD node carries verbatim in Signature[16] (SignatureType 0x02). The
    partition GUID is globally unique, so the disk GUID is redundant
    confirmation and not required.
  MBR (TableType 1): blob.DiskID[0:4] is the MBR disk signature and
    blob.PartitionID is the partition's byte offset; the HD node carries
    the MBR signature in Signature[0:4] (SignatureType 0x01) and the
    partition start LBA in PartitionStart, so we compare signature AND
    PartitionStart * BlockSize == byte offset.

  @param  Handle  Device handle whose HD() node is tested.
  @param  Bio     BlockIo on the same handle (for BlockSize on MBR).
  @param  State   Platform state carrying the decoded osdevice blobs.
**/
STATIC
BOOLEAN
PblFveSamePartition (
  IN EFI_HANDLE              Handle,
  IN EFI_BLOCK_IO_PROTOCOL  *Bio,
  IN PBL_PLATFORM_STATE     *State
  )
{
  CONST HARDDRIVE_DEVICE_PATH *Hd;
  UINT8  i;

  if (State == NULL || State->BcdOsDeviceCount == 0) {
    return FALSE;
  }
  Hd = PblFveHdNode (Handle);
  if (Hd == NULL) {
    return FALSE;
  }

  for (i = 0; i < State->BcdOsDeviceCount; i++) {
    UINT8 TableType = State->BcdOsDeviceTableType[i];
    if (TableType == 0) {
      // GPT: HD.SignatureType 0x02 + Signature[16] == partition GUID.
      if (Hd->SignatureType == 0x02 &&
          CompareMem (Hd->Signature, State->BcdOsDevicePartId[i], 16) == 0) {
        return TRUE;
      }
    } else if (TableType == 1) {
      // MBR: HD.SignatureType 0x01 + Signature[0:4] == disk signature AND
      // PartitionStart(LBA) * BlockSize == byte offset in PartId[0:8].
      if (Hd->SignatureType == 0x01 && Bio != NULL && Bio->Media != NULL &&
          Bio->Media->BlockSize != 0 &&
          CompareMem (Hd->Signature, State->BcdOsDeviceDiskId[i], 4) == 0) {
        UINT64 PartOffset = ReadUnaligned64 ((UINT64 *)State->BcdOsDevicePartId[i]);
        if (PartOffset == (UINT64)Hd->PartitionStart * Bio->Media->BlockSize) {
          return TRUE;
        }
      }
    }
  }
  return FALSE;
}

/** Inspect one FVE volume: walk the three metadata block offsets and
  parse the first block that verifies. Caller resets the Fve* fields
  before calling so a boot-disk volume can supersede a provisional parse.

  @param  Dio      DiskIo protocol on the volume's handle.
  @param  MediaId  BlockIo MediaId for that handle.
  @param  VolHdr   512-byte volume header already read (sig verified).
  @param  State    Platform state to update.
**/
STATIC
VOID
PblFveInspectVolume (
  IN     EFI_DISK_IO_PROTOCOL *Dio,
  IN     UINT32               MediaId,
  IN     CONST UINT8          *VolHdr,
  IN OUT PBL_PLATFORM_STATE   *State
  )
{
  EFI_STATUS  Status;

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
}

/** D-120: Detect BitLocker by FVE volume metadata on attached disks and
  bind the volume to the boot device.

  Sets State->BitLockerEnabled, FveMetadataVersion, FveEncryptionMethod,
  FveProtectionMask, FveClearKeyOnly, FveVolumeCount, FveOnBootDisk,
  FveBootDiskKnown.

  Binding: PBL's LoadedImage->DeviceHandle device path identifies the
  disk PBL booted from (the ESP on the Windows disk). An FVE volume
  whose device-path disk prefix (nodes before the first MEDIA node)
  matches that path lives on the same physical disk — the OS-volume
  candidate. An FVE volume on another disk is detected but not bound;
  when both exist, the bound volume's metadata is authoritative.

  @param State        Platform state to update.
  @param ImageHandle  PBL's own image handle (NULL = binding not evaluated).
**/
VOID
PblCheckFve (
  IN OUT PBL_PLATFORM_STATE *State,
  IN     EFI_HANDLE         ImageHandle
  )
{
  EFI_STATUS                 Status;
  EFI_HANDLE                 *Handles = NULL;
  UINTN                      NumHandles = 0;
  UINTN                      i;
  EFI_DEVICE_PATH_PROTOCOL   *BootDp = NULL;
  EFI_LOADED_IMAGE_PROTOCOL  *Loaded = NULL;
  UINT8                      FveCount = 0;

  // BitLockerEnabled is OR'd in below — the BCD recovery-GUID heuristic in
  // PblCollectBcdState remains as a weak fallback when no FVE volume is
  // attached at pre-boot time.
  State->FveEncryptionMethod = 0;
  State->FveProtectionMask   = 0;
  State->FveMetadataVersion  = 0;
  State->FveClearKeyOnly     = FALSE;
  State->FveVolumeCount      = 0;
  State->FveOnBootDisk       = FALSE;
  State->FveOnBootPartition  = FALSE;
  State->FveBootDiskKnown    = FALSE;

  // Resolve PBL's boot disk: the device PBL itself was loaded from.
  if (ImageHandle != NULL) {
    Status = gBS->HandleProtocol (
      ImageHandle, &gEfiLoadedImageProtocolGuid, (VOID **)&Loaded
    );
    if (!EFI_ERROR (Status) && Loaded != NULL && Loaded->DeviceHandle != NULL) {
      Status = gBS->HandleProtocol (
        Loaded->DeviceHandle, &gEfiDevicePathProtocolGuid, (VOID **)&BootDp
      );
      if (!EFI_ERROR (Status) && BootDp != NULL) {
        State->FveBootDiskKnown = TRUE;
      } else {
        BootDp = NULL;
      }
    }
  }

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
    FveCount++;
    State->BitLockerEnabled = TRUE;
    Print (L"  [OK] FVE-FS volume detected (device %u)\n", (UINT32)i);

    BOOLEAN Bound = State->FveBootDiskKnown &&
                    PblFveSameDisk (Handles[i], BootDp);
    if (Bound) {
      State->FveOnBootDisk = TRUE;
      Print (L"  [OK] FVE volume bound to boot disk (device %u)\n", (UINT32)i);
      // NG-T5: upgrade to partition-level binding — does this FVE volume's
      // HD() node match a decoded osdevice partition identity? Any-match:
      // an osloader pointing at this partition proves it is a real Windows
      // boot target. Degrades silently when no osdevice blobs were decoded.
      if (PblFveSamePartition (Handles[i], Bio, State)) {
        State->FveOnBootPartition = TRUE;
        Print (L"  [OK] FVE volume bound to boot partition (device %u)\n", (UINT32)i);
      }
    } else if (State->FveBootDiskKnown) {
      Print (L"  [WARN] FVE volume not on boot disk (device %u)\n", (UINT32)i);
    }

    // The boot-disk volume is authoritative for metadata — reset and
    // re-parse so its method/protectors win over a provisional parse of
    // an earlier non-bound volume.
    if (Bound || FveCount == 1) {
      State->FveEncryptionMethod = 0;
      State->FveProtectionMask   = 0;
      State->FveMetadataVersion  = 0;
      State->FveClearKeyOnly     = FALSE;
      PblFveInspectVolume (Dio, MediaId, VolHdr, State);
    }

    if (Bound) {
      break;  // bound volume found — done
    }
  }

  State->FveVolumeCount = FveCount;
  if (FveCount > 0 && !State->FveBootDiskKnown) {
    Print (L"  [INFO] FVE boot-disk binding not evaluated\n");
  }
  if (FveCount > 1) {
    Print (L"  [INFO] FVE volumes found: %u\n", (UINT32)FveCount);
  }

  gBS->FreePool (Handles);
}
