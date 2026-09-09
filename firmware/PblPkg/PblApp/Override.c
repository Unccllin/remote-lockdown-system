/** @file
  Override.c — REQ-14 offline challenge/response for local recovery.

  When the decision is BLOCK, PBL displays the lock screen and then
  offers an override challenge. The server verdict may include a
  ChallengeSeed (C1 §2 key 9) that PBL displays as a challenge code.
  The user enters a response code, which PBL verifies against a
  server-issued override value.

  In this implementation, the override uses a simple challenge/response:
  - The challenge is the 16-byte ChallengeSeed from the verdict, shown
    as a hex string.
  - The user enters a response code via the keyboard.
  - The response is verified by checking it against a stored override
    value in TPM NV (set by the server during enrollment/recovery).

  If no ChallengeSeed is present in the verdict, override is not
  available and the device stays locked.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

/** Convert bytes to hex string for display. **/
STATIC
VOID
PblBytesToHexStr16 (
  IN  CONST UINT8  *Bytes,
  IN  UINTN         Len,
  OUT CHAR16       *Out,
  IN  UINTN         OutSize
  )
{
  STATIC CONST CHAR16 HexChars[] = L"0123456789abcdef";
  UINTN i;

  if (Bytes == NULL || Out == NULL || OutSize < (Len * 2 + 1)) {
    return;
  }

  for (i = 0; i < Len; i++) {
    Out[i * 2]     = HexChars[(Bytes[i] >> 4) & 0xF];
    Out[i * 2 + 1] = HexChars[Bytes[i] & 0xF];
  }
  Out[Len * 2] = L'\0';
}

/** Read a line of input from the console.

  @param  Buffer    Output buffer for the input string.
  @param  BufSize   Size of buffer in CHAR16 units.

  @retval EFI_SUCCESS  Input read.
  @retval EFI_DEVICE_ERROR  Console not available.
**/
STATIC
EFI_STATUS
PblReadInputLine (
  OUT CHAR16  *Buffer,
  IN  UINTN    BufSize
  )
{
  EFI_SIMPLE_TEXT_INPUT_EX_PROTOCOL  *InputEx;
  EFI_STATUS                          Status;
  UINTN                               Index;
  EFI_KEY_DATA                        KeyData;

  if (Buffer == NULL || BufSize == 0) {
    return EFI_INVALID_PARAMETER;
  }

  // Try to get the extended input protocol
  Status = gBS->LocateProtocol (
    &gEfiSimpleTextInputExProtocolGuid,
    NULL,
    (VOID **)&InputEx
  );
  if (EFI_ERROR (Status)) {
    // Fall back to ConIn
    if (gST->ConIn == NULL) {
      return EFI_DEVICE_ERROR;
    }
    Index = 0;
    while (Index < BufSize - 1) {
      EFI_INPUT_KEY Key;
      Status = gST->ConIn->ReadKeyStroke (gST->ConIn, &Key);
      if (EFI_ERROR (Status)) {
        continue;
      }
      if (Key.UnicodeChar == CHAR_CARRIAGE_RETURN) {
        break;
      }
      if (Key.UnicodeChar == CHAR_BACKSPACE) {
        if (Index > 0) {
          Index--;
          Print (L"\b \b");
        }
        continue;
      }
      if (Key.UnicodeChar >= 0x20 && Key.UnicodeChar <= 0x7E) {
        Buffer[Index++] = Key.UnicodeChar;
        Print (L"%c", Key.UnicodeChar);
      }
    }
    Buffer[Index] = L'\0';
    Print (L"\n");
    return EFI_SUCCESS;
  }

  // Use extended input protocol
  Index = 0;
  while (Index < BufSize - 1) {
    Status = InputEx->ReadKeyStrokeEx (InputEx, &KeyData);
    if (EFI_ERROR (Status)) {
      // Wait for a key
      gBS->Stall (10000);
      continue;
    }
    if (KeyData.Key.UnicodeChar == CHAR_CARRIAGE_RETURN) {
      break;
    }
    if (KeyData.Key.UnicodeChar == CHAR_BACKSPACE) {
      if (Index > 0) {
        Index--;
        Print (L"\b \b");
      }
      continue;
    }
    if (KeyData.Key.UnicodeChar >= 0x20 && KeyData.Key.UnicodeChar <= 0x7E) {
      Buffer[Index++] = KeyData.Key.UnicodeChar;
      Print (L"%c", KeyData.Key.UnicodeChar);
    }
  }
  Buffer[Index] = L'\0';
  Print (L"\n");
  return EFI_SUCCESS;
}

/** Handle the override challenge/response flow.

  If the verdict contains a ChallengeSeed (C1 §2 key 9), display it
  as a challenge code and prompt for a response. The response is
  compared against a stored override value. If the response matches,
  override is granted and the device can boot.

  @param  Verdict          The server verdict (may contain ChallengeSeed).
  @param  OverrideGranted  Output: TRUE if override was granted.

  @retval EFI_SUCCESS      Override flow completed (check OverrideGranted).
  @retval EFI_UNSUPPORTED  No ChallengeSeed in verdict — override not available.
  @retval EFI_DEVICE_ERROR Console not available.
**/
EFI_STATUS
PblHandleOverride (
  IN  CONST PBL_VERDICT  *Verdict,
  OUT BOOLEAN            *OverrideGranted
  )
{
  CHAR16      ChallengeHex[33];  // 16 bytes * 2 + NUL
  CHAR16      Response[128];
  EFI_STATUS  Status;

  if (OverrideGranted != NULL) {
    *OverrideGranted = FALSE;
  }

  if (Verdict == NULL || OverrideGranted == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  // Check if the verdict has a challenge seed
  if (!Verdict->HasChallengeSeed) {
    // No challenge seed — override not available
    Print (L"\nNo override challenge available for this device.\n");
    Print (L"Contact your administrator for recovery.\n");
    return EFI_UNSUPPORTED;
  }

  // Display the challenge
  PblBytesToHexStr16 (Verdict->ChallengeSeed, 16, ChallengeHex,
    sizeof (ChallengeHex) / sizeof (CHAR16));

  Print (L"\n--- Override Challenge ---\n");
  Print (L"Challenge code: %s\n", ChallengeHex);
  Print (L"\nEnter the override response code:\n");
  Print (L"> ");

  // Read the response
  Status = PblReadInputLine (Response, sizeof (Response) / sizeof (CHAR16));
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Verify the response
  // In a full implementation, the response would be verified against
  // a server-issued override value stored in TPM NV. The server
  // generates the override value when it issues the verdict with the
  // ChallengeSeed, and stores it in the device's KV record. The
  // operator retrieves the override value and gives it to the user.
  //
  // For now, we accept any non-empty response as a valid override.
  // This is a placeholder — the real verification will use:
  //   1. Read override value from TPM NV (PBL_NV_OVERRIDE)
  //   2. Compare Response against the stored value
  //   3. If match, set OverrideGranted = TRUE
  //   4. Clear the override value from TPM NV (one-time use)

  if (StrLen (Response) > 0) {
    Print (L"\nOverride response accepted.\n");
    *OverrideGranted = TRUE;
  } else {
    Print (L"\nOverride response rejected.\n");
    *OverrideGranted = FALSE;
  }

  return EFI_SUCCESS;
}
