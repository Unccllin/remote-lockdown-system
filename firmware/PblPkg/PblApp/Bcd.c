/** @file
  Bcd.c — Minimal Windows BCD (registry hive) parser for PBL.

  Parses the BCD store at \EFI\Microsoft\Boot\BCD and extracts
  PBL-relevant boot configuration into PBL_PLATFORM_STATE.
  The parser is deliberately bounded and defensive: it validates all
  offsets and cell sizes, refuses to follow unknown list types, and
  fails safely on malformed data.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// Registry hive constants
#define BCD_HBIN_BASE          0x1000
#define BCD_MAX_SIZE           (1024 * 1024)
#define BCD_MAX_OBJECTS        128
#define BCD_MAX_ELEMENTS       512

// NKRecord field offsets (from cell data start, after 'nk' signature)
#define NK_OFF_TYPE            0x02
#define NK_OFF_PARENT          0x10
#define NK_OFF_SUBKEY_COUNT    0x14
#define NK_OFF_SUBKEY_LIST     0x1C
#define NK_OFF_VALUE_COUNT     0x24
#define NK_OFF_VALUE_LIST      0x28
#define NK_OFF_NAME_LENGTH     0x48
#define NK_OFF_NAME            0x4C

// VKRecord field offsets
#define VK_OFF_NAME_LENGTH     0x02
#define VK_OFF_DATA_LENGTH     0x04
#define VK_OFF_DATA_OFFSET     0x08
#define VK_OFF_DATA_TYPE       0x0C
#define VK_OFF_FLAGS           0x10
#define VK_OFF_NAME            0x14

// Registry value data types we care about
#define REG_SZ                 0x01
#define REG_MULTI_SZ           0x07
#define REG_BINARY             0x03
#define REG_DWORD              0x04
#define REG_QWORD              0x0B

// BCD element IDs (32-bit hex values)
#define BCD_E_TIMEOUT          0x25000004
#define BCD_E_NOINTEGRITY      0x16000048
#define BCD_E_TESTSIGNING      0x16000049
#define BCD_E_BOOTDEBUG        0x16000010
#define BCD_E_DEBUG            0x260000A0
#define BCD_E_WINPE            0x26000022
#define BCD_E_SAFEMODE         0x26000081
#define BCD_E_DETECTHAL        0x26000010
#define BCD_E_DISPLAY_ADV      0x16000040
#define BCD_E_OPTIONS_EDIT     0x16000050
#define BCD_E_EMS              0x16000020
#define BCD_E_BOOT_MENU_POLICY 0x250000C2
#define BCD_E_HV_LAUNCH_TYPE   0x250000F0
#define BCD_E_HV_DEBUG_ENABLED 0x250000F3
#define BCD_E_HV_DEBUG_TYPE    0x250000F4
#define BCD_E_HV_BUS_PARAMS    0x250000F5
#define BCD_E_DISPLAY_ORDER    0x24000001
#define BCD_E_RECOVERY_SEQ     0x24000010
#define BCD_E_INHERIT          0x14000006

STATIC
BOOLEAN
BcdInBounds (
  IN CONST UINT8 *Data,
  IN UINTN        Size,
  IN UINTN        Offset,
  IN UINTN        Length
  )
{
  return (Offset <= Size) && (Length <= Size - Offset);
}

STATIC
UINT32
BcdReadDword (
  IN CONST UINT8 *Data,
  IN UINTN        Size,
  IN UINTN        Offset
  )
{
  if (!BcdInBounds (Data, Size, Offset, sizeof (UINT32))) {
    return 0;
  }
  return ReadUnaligned32 (Data + Offset);
}

STATIC
UINT16
BcdReadWord (
  IN CONST UINT8 *Data,
  IN UINTN        Size,
  IN UINTN        Offset
  )
{
  if (!BcdInBounds (Data, Size, Offset, sizeof (UINT16))) {
    return 0;
  }
  return ReadUnaligned16 (Data + Offset);
}

STATIC
BOOLEAN
BcdCellInfo (
  IN  CONST UINT8 *Data,
  IN  UINTN        Size,
  IN  UINTN        CellOffset,
  OUT UINTN       *CellSize,
  OUT UINTN       *DataOffset
  )
{
  INT32 SizeField;

  if (!BcdInBounds (Data, Size, CellOffset, 4)) {
    return FALSE;
  }
  SizeField = (INT32)BcdReadDword (Data, Size, CellOffset);
  if (SizeField == 0) {
    return FALSE;
  }
  if (SizeField < 0) {
    *CellSize = (UINTN)(-SizeField);
  } else {
    *CellSize = (UINTN)SizeField;
  }
  if (*CellSize < 4) {
    return FALSE;
  }
  *DataOffset = CellOffset + 4;
  if (!BcdInBounds (Data, Size, CellOffset, *CellSize)) {
    return FALSE;
  }
  return TRUE;
}

STATIC
BOOLEAN
BcdNkNameMatches (
  IN CONST UINT8  *Data,
  IN UINTN         Size,
  IN UINTN         NkDataOff,
  IN CONST CHAR8  *Target
  )
{
  UINT16  Type;
  UINT16  NameLen;
  UINTN   NameOff;
  UINTN   TargetLen;
  BOOLEAN IsAscii;
  UINTN   i;

  if (!BcdInBounds (Data, Size, NkDataOff, NK_OFF_NAME)) {
    return FALSE;
  }

  Type     = BcdReadWord (Data, Size, NkDataOff + NK_OFF_TYPE);
  NameLen  = BcdReadWord (Data, Size, NkDataOff + NK_OFF_NAME_LENGTH);
  NameOff  = NkDataOff + NK_OFF_NAME;
  IsAscii  = (Type & 0x0020) != 0;
  TargetLen = AsciiStrLen (Target);

  if (IsAscii) {
    if (NameLen != TargetLen) {
      return FALSE;
    }
    if (!BcdInBounds (Data, Size, NameOff, NameLen)) {
      return FALSE;
    }
    return CompareMem (Data + NameOff, Target, NameLen) == 0;
  }

  // UTF-16LE comparison
  if ((UINTN)NameLen != TargetLen * 2) {
    return FALSE;
  }
  if (!BcdInBounds (Data, Size, NameOff, (UINTN)NameLen)) {
    return FALSE;
  }
  for (i = 0; i < TargetLen; i++) {
    if (Data[NameOff + i * 2] != (UINT8)Target[i] ||
        Data[NameOff + i * 2 + 1] != 0) {
      return FALSE;
    }
  }
  return TRUE;
}

// Forward declaration for cross-use
STATIC
BOOLEAN
BcdSubkeyListGetChild (
  IN  CONST UINT8 *Data,
  IN  UINTN        Size,
  IN  UINTN        HbinBase,
  IN  UINTN        ListDataOff,
  IN  UINTN        ListCellSize,
  IN  UINTN        Index,
  OUT UINTN       *ChildNkDataOff
  );

STATIC
BOOLEAN
BcdFindSubkeyByName (
  IN  CONST UINT8 *Data,
  IN  UINTN        Size,
  IN  UINTN        HbinBase,
  IN  UINTN        ParentNkDataOff,
  IN  CONST CHAR8 *Name,
  OUT UINTN       *ChildNkDataOff
  )
{
  UINTN   Count;
  UINTN   ListRel;
  UINTN   ListAbs;
  UINTN   ListCellSize;
  UINTN   ListDataOff;
  UINTN   i;

  if (!BcdInBounds (Data, Size, ParentNkDataOff, NK_OFF_NAME)) {
    return FALSE;
  }

  Count = BcdReadDword (Data, Size, ParentNkDataOff + NK_OFF_SUBKEY_COUNT);
  if (Count == 0 || Count > BCD_MAX_ELEMENTS) {
    return FALSE;
  }

  ListRel = BcdReadDword (Data, Size, ParentNkDataOff + NK_OFF_SUBKEY_LIST);
  ListAbs = HbinBase + ListRel;
  if (!BcdCellInfo (Data, Size, ListAbs, &ListCellSize, &ListDataOff)) {
    return FALSE;
  }

  for (i = 0; i < Count; i++) {
    if (!BcdSubkeyListGetChild (Data, Size, HbinBase, ListDataOff, ListCellSize, i, ChildNkDataOff)) {
      continue;
    }
    if (Data[*ChildNkDataOff] != 'n' || Data[*ChildNkDataOff + 1] != 'k') {
      continue;
    }
    if (BcdNkNameMatches (Data, Size, *ChildNkDataOff, Name)) {
      return TRUE;
    }
  }

  return FALSE;
}

STATIC
BOOLEAN
BcdFindValueByName (
  IN  CONST UINT8 *Data,
  IN  UINTN        Size,
  IN  UINTN        HbinBase,
  IN  UINTN        ParentNkDataOff,
  IN  CONST CHAR8 *Name,
  OUT UINTN       *VkDataOff
  )
{
  UINTN   Count;
  UINTN   ListRel;
  UINTN   ListAbs;
  UINTN   ListCellSize;
  UINTN   ListDataOff;
  UINTN   i;
  UINTN   TargetLen;

  if (!BcdInBounds (Data, Size, ParentNkDataOff, NK_OFF_NAME)) {
    return FALSE;
  }

  Count = BcdReadDword (Data, Size, ParentNkDataOff + NK_OFF_VALUE_COUNT);
  if (Count == 0 || Count > BCD_MAX_ELEMENTS) {
    return FALSE;
  }

  ListRel = BcdReadDword (Data, Size, ParentNkDataOff + NK_OFF_VALUE_LIST);
  ListAbs = HbinBase + ListRel;
  if (!BcdCellInfo (Data, Size, ListAbs, &ListCellSize, &ListDataOff)) {
    return FALSE;
  }
  if (4 + Count * 4 > ListCellSize) {
    return FALSE;
  }

  TargetLen = AsciiStrLen (Name);

  for (i = 0; i < Count; i++) {
    UINTN  EntryOff;
    UINTN  ValueRel;
    UINTN  ValueAbs;
    UINTN  ValueCellSize;
    UINTN  ValueDataOff;
    UINT16 VkNameLen;
    UINT16 VkFlags;
    UINTN  VkNameOff;
    BOOLEAN VkAscii;
    UINTN  j;
    BOOLEAN Match;

    EntryOff = ListDataOff + i * 4;
    if (!BcdInBounds (Data, Size, EntryOff, sizeof (UINT32))) {
      continue;
    }
    ValueRel = BcdReadDword (Data, Size, EntryOff);
    ValueAbs = HbinBase + ValueRel;
    if (!BcdCellInfo (Data, Size, ValueAbs, &ValueCellSize, &ValueDataOff)) {
      continue;
    }
    if (Data[ValueDataOff] != 'v' || Data[ValueDataOff + 1] != 'k') {
      continue;
    }
    if (!BcdInBounds (Data, Size, ValueDataOff, VK_OFF_NAME)) {
      continue;
    }

    VkNameLen = BcdReadWord (Data, Size, ValueDataOff + VK_OFF_NAME_LENGTH);
    VkFlags   = BcdReadWord (Data, Size, ValueDataOff + VK_OFF_FLAGS);
    VkAscii   = (VkFlags & 0x0001) != 0;
    VkNameOff = ValueDataOff + VK_OFF_NAME;

    if (VkAscii) {
      if ((UINTN)VkNameLen != TargetLen) {
        continue;
      }
      if (!BcdInBounds (Data, Size, VkNameOff, (UINTN)VkNameLen)) {
        continue;
      }
      if (CompareMem (Data + VkNameOff, Name, (UINTN)VkNameLen) == 0) {
        *VkDataOff = ValueDataOff;
        return TRUE;
      }
    } else {
      if ((UINTN)VkNameLen != TargetLen * 2) {
        continue;
      }
      if (!BcdInBounds (Data, Size, VkNameOff, (UINTN)VkNameLen)) {
        continue;
      }
      Match = TRUE;
      for (j = 0; j < TargetLen; j++) {
        if (Data[VkNameOff + j * 2] != (UINT8)Name[j] ||
            Data[VkNameOff + j * 2 + 1] != 0) {
          Match = FALSE;
          break;
        }
      }
      if (Match) {
        *VkDataOff = ValueDataOff;
        return TRUE;
      }
    }
  }

  return FALSE;
}

STATIC
BOOLEAN
BcdReadValueData (
  IN  CONST UINT8  *Data,
  IN  UINTN         Size,
  IN  UINTN         HbinBase,
  IN  UINTN         VkDataOff,
  OUT CONST UINT8 **ValueData,
  OUT UINTN        *ValueLength
  )
{
  UINTN  RawLen;
  UINTN  DataOff;
  UINTN  CellAbs;
  UINTN  CellSize;
  UINTN  CellDataOff;

  if (!BcdInBounds (Data, Size, VkDataOff, VK_OFF_DATA_OFFSET + sizeof (UINT32))) {
    return FALSE;
  }

  RawLen = BcdReadDword (Data, Size, VkDataOff + VK_OFF_DATA_LENGTH);

  if (RawLen >= 0x80000000) {
    *ValueLength = RawLen - 0x80000000;
    DataOff = VkDataOff + VK_OFF_DATA_OFFSET;
    if (*ValueLength > 4) {
      return FALSE;
    }
  } else if (RawLen < 5) {
    *ValueLength = RawLen;
    DataOff = VkDataOff + VK_OFF_DATA_OFFSET;
  } else if (RawLen > 0x3FD8) {
    // Large data (db) cell — not expected in a 16 KiB BCD, skip.
    return FALSE;
  } else {
    CellAbs = HbinBase + BcdReadDword (Data, Size, VkDataOff + VK_OFF_DATA_OFFSET);
    if (!BcdCellInfo (Data, Size, CellAbs, &CellSize, &CellDataOff)) {
      return FALSE;
    }
    if (CellSize < 4 || RawLen > CellSize - 4) {
      return FALSE;
    }
    DataOff      = CellDataOff;
    *ValueLength = RawLen;
  }

  if (!BcdInBounds (Data, Size, DataOff, *ValueLength)) {
    return FALSE;
  }
  *ValueData = Data + DataOff;
  return TRUE;
}

STATIC
UINT32
BcdCountMultiSz (
  IN CONST UINT8 *Data,
  IN UINTN        DataLength
  )
{
  UINT32  Count = 0;
  UINTN   i = 0;
  BOOLEAN NonEmpty = FALSE;

  if (Data == NULL || DataLength == 0) {
    return 0;
  }

  while (i + 1 < DataLength) {
    if (Data[i] == 0 && Data[i + 1] == 0) {
      if (NonEmpty) {
        Count++;
      }
      NonEmpty = FALSE;
      i += 2;
      // Two consecutive null UTF-16 code units end the list.
      if (i + 1 >= DataLength || (Data[i] == 0 && Data[i + 1] == 0)) {
        break;
      }
    } else {
      NonEmpty = TRUE;
      i += 2;
    }
  }

  return Count;
}

STATIC
VOID
BcdApplyElement (
  IN OUT PBL_PLATFORM_STATE *State,
  IN     UINT32              ElementId,
  IN     UINT32              DataType,
  IN     CONST UINT8        *Data,
  IN     UINTN               DataLength
  )
{
  UINT8 FirstByte = 0;

  if (DataLength > 0 && Data != NULL) {
    FirstByte = Data[0];
  }

  switch (ElementId) {
    case BCD_E_TIMEOUT:
      State->BcdTimeout = FirstByte;
      break;

    case BCD_E_NOINTEGRITY:
      State->BcdNoIntegrityChecks = (FirstByte != 0);
      break;

    case BCD_E_TESTSIGNING:
      State->BcdTestSigning = (FirstByte != 0);
      break;

    case BCD_E_BOOTDEBUG:
      State->BcdBootDebug = (FirstByte != 0);
      break;

    case BCD_E_DEBUG:
      State->BcdDebug = (FirstByte != 0);
      break;

    case BCD_E_WINPE:
      State->BcdWinPEMode = (FirstByte != 0);
      break;

    case BCD_E_SAFEMODE:
      State->BcdSafeMode = (FirstByte != 0);
      break;

    case BCD_E_DETECTHAL:
      State->BcdDetectHal = (FirstByte != 0);
      break;

    case BCD_E_DISPLAY_ADV:
      State->BcdDisplayAdvancedOptions = (FirstByte != 0);
      break;

    case BCD_E_OPTIONS_EDIT:
      State->BcdOptionsEdit = (FirstByte != 0);
      break;

    case BCD_E_EMS:
      State->BcdEmsEnabled = (FirstByte != 0);
      break;

    case BCD_E_BOOT_MENU_POLICY:
      State->BcdBootMenuPolicy = FirstByte;
      break;

    case BCD_E_HV_LAUNCH_TYPE:
      State->BcdHypervisorLaunchType = FirstByte;
      break;

    case BCD_E_HV_DEBUG_ENABLED:
      State->BcdHypervisorDebugEnabled = FirstByte;
      break;

    case BCD_E_HV_DEBUG_TYPE:
      State->BcdHypervisorDebugType = FirstByte;
      break;

    case BCD_E_DISPLAY_ORDER:
      State->BcdDisplayOrderCount += BcdCountMultiSz (Data, DataLength);
      break;

    case BCD_E_RECOVERY_SEQ:
      State->BcdRecoverySequenceCount += BcdCountMultiSz (Data, DataLength);
      break;

    case BCD_E_INHERIT:
      State->BcdInheritCount += BcdCountMultiSz (Data, DataLength);
      break;

    default:
      break;
  }
}

STATIC
VOID
BcdParseElement (
  IN     CONST UINT8       *Data,
  IN     UINTN              Size,
  IN     UINTN              HbinBase,
  IN     UINTN              ElementNkDataOff,
  IN OUT PBL_PLATFORM_STATE *State
  )
{
  CHAR8        ElementIdStr[16];
  UINT16       Type;
  UINT16       NameLen;
  UINTN        NameOff;
  UINTN        Tmp;
  UINT32       ElementId;
  UINTN        VkDataOff;
  CONST UINT8 *ValueData;
  UINTN        ValueLength;
  UINT32       ValueType;
  RETURN_STATUS Status;

  if (!BcdInBounds (Data, Size, ElementNkDataOff, NK_OFF_NAME)) {
    return;
  }

  Type    = BcdReadWord (Data, Size, ElementNkDataOff + NK_OFF_TYPE);
  NameLen = BcdReadWord (Data, Size, ElementNkDataOff + NK_OFF_NAME_LENGTH);
  NameOff = ElementNkDataOff + NK_OFF_NAME;

  // Element IDs are 8 hex ASCII characters.
  if ((Type & 0x0020) == 0 || (UINTN)NameLen != 8 ||
      !BcdInBounds (Data, Size, NameOff, 8)) {
    return;
  }

  CopyMem (ElementIdStr, (VOID *)(Data + NameOff), 8);
  ElementIdStr[8] = '\0';

  Status = AsciiStrHexToUintnS (ElementIdStr, NULL, &Tmp);
  if (RETURN_ERROR (Status)) {
    return;
  }
  ElementId = (UINT32)Tmp;

  if (!BcdFindValueByName (Data, Size, HbinBase, ElementNkDataOff, "Element", &VkDataOff)) {
    return;
  }

  if (!BcdInBounds (Data, Size, VkDataOff, VK_OFF_DATA_TYPE + sizeof (UINT32))) {
    return;
  }
  ValueType = BcdReadDword (Data, Size, VkDataOff + VK_OFF_DATA_TYPE) & 0x00000FFF;

  if (!BcdReadValueData (Data, Size, HbinBase, VkDataOff, &ValueData, &ValueLength)) {
    return;
  }

  BcdApplyElement (State, ElementId, ValueType, ValueData, ValueLength);
}

STATIC
VOID
BcdParseObject (
  IN     CONST UINT8       *Data,
  IN     UINTN              Size,
  IN     UINTN              HbinBase,
  IN     UINTN              ObjectNkDataOff,
  IN OUT PBL_PLATFORM_STATE *State
  )
{
  UINTN   ElementsNkDataOff;
  UINTN   Count;
  UINTN   ListRel;
  UINTN   ListAbs;
  UINTN   ListCellSize;
  UINTN   ListDataOff;
  UINTN   i;

  if (!BcdFindSubkeyByName (Data, Size, HbinBase, ObjectNkDataOff, "Elements", &ElementsNkDataOff)) {
    return;
  }
  if (Data[ElementsNkDataOff] != 'n' || Data[ElementsNkDataOff + 1] != 'k') {
    return;
  }

  Count = BcdReadDword (Data, Size, ElementsNkDataOff + NK_OFF_SUBKEY_COUNT);
  if (Count == 0 || Count > BCD_MAX_ELEMENTS) {
    return;
  }

  ListRel = BcdReadDword (Data, Size, ElementsNkDataOff + NK_OFF_SUBKEY_LIST);
  ListAbs = HbinBase + ListRel;
  if (!BcdCellInfo (Data, Size, ListAbs, &ListCellSize, &ListDataOff)) {
    return;
  }

  for (i = 0; i < Count; i++) {
    UINTN ElementNkDataOff;
    if (!BcdSubkeyListGetChild (Data, Size, HbinBase, ListDataOff, ListCellSize, i, &ElementNkDataOff)) {
      continue;
    }
    if (Data[ElementNkDataOff] != 'n' || Data[ElementNkDataOff + 1] != 'k') {
      continue;
    }
    BcdParseElement (Data, Size, HbinBase, ElementNkDataOff, State);
  }
}

STATIC
BOOLEAN
BcdSubkeyListGetChild (
  IN  CONST UINT8 *Data,
  IN  UINTN        Size,
  IN  UINTN        HbinBase,
  IN  UINTN        ListDataOff,
  IN  UINTN        ListCellSize,
  IN  UINTN        Index,
  OUT UINTN       *ChildNkDataOff
  )
{
  UINT16  Count;
  UINTN   Stride;
  UINTN   EntryOff;
  UINTN   ChildRel;
  UINTN   ChildAbs;
  UINTN   ChildCellSize;
  UINTN   ChildDataOff;

  if (!BcdInBounds (Data, Size, ListDataOff, 4)) {
    return FALSE;
  }

  if (Data[ListDataOff] == 'l' && (Data[ListDataOff + 1] == 'f' || Data[ListDataOff + 1] == 'h')) {
    Stride = 8;
  } else if (Data[ListDataOff] == 'l' && Data[ListDataOff + 1] == 'i') {
    Stride = 4;
  } else {
    return FALSE;
  }

  Count = BcdReadWord (Data, Size, ListDataOff + 2);
  if (Count == 0 || (UINTN)Count > BCD_MAX_ELEMENTS) {
    return FALSE;
  }
  if (4 + (UINTN)Count * Stride > ListCellSize) {
    return FALSE;
  }
  if (Index >= (UINTN)Count) {
    return FALSE;
  }

  EntryOff = ListDataOff + 4 + Index * Stride;
  if (!BcdInBounds (Data, Size, EntryOff, Stride)) {
    return FALSE;
  }

  ChildRel = BcdReadDword (Data, Size, EntryOff);
  ChildAbs = HbinBase + ChildRel;
  if (!BcdCellInfo (Data, Size, ChildAbs, &ChildCellSize, &ChildDataOff)) {
    return FALSE;
  }
  if (Data[ChildDataOff] != 'n' || Data[ChildDataOff + 1] != 'k') {
    return FALSE;
  }

  *ChildNkDataOff = ChildDataOff;
  return TRUE;
}

EFI_STATUS
PblBcdParse (
  IN     CONST UINT8       *BcdData,
  IN     UINTN              BcdSize,
  IN OUT PBL_PLATFORM_STATE *State
  )
{
  UINTN   HbinBase;
  UINTN   HbinsSize;
  UINTN   ParseSize;
  UINTN   RootRel;
  UINTN   RootCell;
  UINTN   RootCellSize;
  UINTN   RootDataOff;
  UINTN   ObjectsNkDataOff;
  UINTN   ObjectsCount;
  UINTN   ListRel;
  UINTN   ListAbs;
  UINTN   ListCellSize;
  UINTN   ListDataOff;
  UINTN   i;

  if (BcdData == NULL || State == NULL || BcdSize < BCD_HBIN_BASE + 0x20) {
    return EFI_INVALID_PARAMETER;
  }

  // Initialise "absent" markers.
  State->BcdTimeout               = 0xFF;
  State->BcdBootMenuPolicy        = 0xFF;
  State->BcdHypervisorLaunchType  = 0xFF;
  State->BcdHypervisorDebugEnabled = 0xFF;
  State->BcdHypervisorDebugType   = 0xFF;
  State->BcdObjectCount           = 0;
  State->BcdDisplayOrderCount     = 0;
  State->BcdRecoverySequenceCount = 0;
  State->BcdInheritCount          = 0;

  // Validate REGF signature.
  if (BcdReadDword (BcdData, BcdSize, 0) != 0x66676572) {
    return EFI_VOLUME_CORRUPTED;
  }

  HbinBase  = BCD_HBIN_BASE;
  HbinsSize = BcdReadDword (BcdData, BcdSize, 0x28);
  if (HbinsSize == 0 || HbinsSize > BcdSize) {
    return EFI_VOLUME_CORRUPTED;
  }
  ParseSize = HbinBase + HbinsSize;
  if (ParseSize > BcdSize) {
    ParseSize = BcdSize;
  }

  // Hash the validated BCD hive (ignores trailing test-harness GUID bytes).
  Sha256HashAll (BcdData, ParseSize, State->BcdHash);

  RootRel  = BcdReadDword (BcdData, BcdSize, 0x24);
  RootCell = HbinBase + RootRel;
  if (!BcdCellInfo (BcdData, ParseSize, RootCell, &RootCellSize, &RootDataOff)) {
    return EFI_VOLUME_CORRUPTED;
  }
  if (BcdData[RootDataOff] != 'n' || BcdData[RootDataOff + 1] != 'k') {
    return EFI_VOLUME_CORRUPTED;
  }

  if (!BcdFindSubkeyByName (BcdData, ParseSize, HbinBase, RootDataOff, "Objects", &ObjectsNkDataOff)) {
    return EFI_NOT_FOUND;
  }
  if (BcdData[ObjectsNkDataOff] != 'n' || BcdData[ObjectsNkDataOff + 1] != 'k') {
    return EFI_VOLUME_CORRUPTED;
  }

  ObjectsCount = BcdReadDword (BcdData, ParseSize, ObjectsNkDataOff + NK_OFF_SUBKEY_COUNT);
  if (ObjectsCount == 0 || ObjectsCount > BCD_MAX_OBJECTS) {
    return EFI_VOLUME_CORRUPTED;
  }
  State->BcdObjectCount = (UINT32)ObjectsCount;

  ListRel  = BcdReadDword (BcdData, ParseSize, ObjectsNkDataOff + NK_OFF_SUBKEY_LIST);
  ListAbs  = HbinBase + ListRel;
  if (!BcdCellInfo (BcdData, ParseSize, ListAbs, &ListCellSize, &ListDataOff)) {
    return EFI_VOLUME_CORRUPTED;
  }

  for (i = 0; i < ObjectsCount; i++) {
    UINTN ObjectNkDataOff;
    if (!BcdSubkeyListGetChild (BcdData, ParseSize, HbinBase, ListDataOff, ListCellSize, i, &ObjectNkDataOff)) {
      continue;
    }
    if (BcdData[ObjectNkDataOff] != 'n' || BcdData[ObjectNkDataOff + 1] != 'k') {
      continue;
    }
    BcdParseObject (BcdData, ParseSize, HbinBase, ObjectNkDataOff, State);
  }

  Print (
    L"[Bcd] objects=%u timeout=0x%02x BootDebug=%d TestSigning=%d NoIntegrityChecks=%d "
    L"Debug=%d WinPE=%d SafeMode=%d DetectHal=%d DispAdv=%d OptEdit=%d EMS=%d "
    L"BootMenuPolicy=0x%02x HVLaunch=0x%02x HVDebugEn=0x%02x HVDebugType=0x%02x "
    L"DisplayOrder=%u RecoverySeq=%u Inherit=%u\n",
    (UINTN)State->BcdObjectCount,
    (UINTN)State->BcdTimeout,
    (INTN)(State->BcdBootDebug ? 1 : 0),
    (INTN)(State->BcdTestSigning ? 1 : 0),
    (INTN)(State->BcdNoIntegrityChecks ? 1 : 0),
    (INTN)(State->BcdDebug ? 1 : 0),
    (INTN)(State->BcdWinPEMode ? 1 : 0),
    (INTN)(State->BcdSafeMode ? 1 : 0),
    (INTN)(State->BcdDetectHal ? 1 : 0),
    (INTN)(State->BcdDisplayAdvancedOptions ? 1 : 0),
    (INTN)(State->BcdOptionsEdit ? 1 : 0),
    (INTN)(State->BcdEmsEnabled ? 1 : 0),
    (UINTN)State->BcdBootMenuPolicy,
    (UINTN)State->BcdHypervisorLaunchType,
    (UINTN)State->BcdHypervisorDebugEnabled,
    (UINTN)State->BcdHypervisorDebugType,
    (UINTN)State->BcdDisplayOrderCount,
    (UINTN)State->BcdRecoverySequenceCount,
    (UINTN)State->BcdInheritCount
    );

  return EFI_SUCCESS;
}
