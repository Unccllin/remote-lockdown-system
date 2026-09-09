/** @file
  LockScreen.c — REQ-14 lock screen and degraded notice UI.

  PblShowLockScreen: Display a full-screen text-mode lock screen when
  the decision is BLOCK. Shows the device ID, lock reason, and contact
  information. Waits for the override handler.

  PblShowDegradedNotice: Display a brief notice when the decision is
  DEGRADED, then continue booting after a countdown.

  Both functions use EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL (ConOut) for
  text-mode rendering. Graphics mode (EFI_GRAPHICS_OUTPUT_PROTOCOL)
  is optional and not used in this implementation — text mode is
  sufficient for the lock screen and is universally available.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

/** Clear the screen and set colors. **/
STATIC
VOID
PblClearScreen (
  VOID
  )
{
  if (gST->ConOut != NULL) {
    gST->ConOut->ClearScreen (gST->ConOut);
    gST->ConOut->SetAttribute (gST->ConOut,
      EFI_TEXT_ATTR (EFI_LIGHTGRAY, EFI_BLUE));
  }
}

/** Print a centered line at the given row. **/
STATIC
VOID
PblPrintCentered (
  IN CONST CHAR16  *Text
  )
{
  if (gST->ConOut == NULL || Text == NULL) {
    return;
  }
  // Simple centering — print with leading spaces
  UINTN Len = StrLen (Text);
  UINTN Cols = 80;
  UINTN Pad = (Cols > Len) ? (Cols - Len) / 2 : 0;
  while (Pad > 0) {
    Print (L" ");
    Pad--;
  }
  Print (L"%s\n", Text);
}

/** Convert a byte array to hex string (lowercase, no prefix). **/
STATIC
VOID
PblBytesToHexStr (
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

/** Show the lock screen when the decision is BLOCK.

  Displays the device ID, lock reason, and contact information. The
  screen stays until the override handler completes or the machine
  is shut down.

  @param  Verdict      The server verdict (contains device_id, reason).
  @param  ContactInfo  Contact information string (ASCII).

  @retval EFI_SUCCESS   Lock screen displayed and dismissed.
  @retval EFI_DEVICE_ERROR  Console not available.
**/
EFI_STATUS
PblShowLockScreen (
  IN CONST PBL_VERDICT  *Verdict,
  IN CONST CHAR8        *ContactInfo
  )
{
  CHAR16  DeviceIdHex[65];  // 32 bytes * 2 + NUL
  CHAR16  Reason[128];
  UINTN   i;

  if (gST->ConOut == NULL) {
    return EFI_DEVICE_ERROR;
  }

  PblClearScreen ();

  // Header
  Print (L"\n\n\n");
  PblPrintCentered (L"========================================");
  PblPrintCentered (L"  THIS DEVICE IS LOCKED");
  PblPrintCentered (L"========================================");
  Print (L"\n\n");

  // Device ID
  if (Verdict != NULL) {
    PblBytesToHexStr (Verdict->DeviceId, 32, DeviceIdHex, sizeof (DeviceIdHex) / sizeof (CHAR16));
    PblPrintCentered (L"Device ID:");
    Print (L"  %s\n\n", DeviceIdHex);

    // Reason
    for (i = 0; i < sizeof (Verdict->Reason) && Verdict->Reason[i] != '\0'; i++) {
      Reason[i] = (CHAR16)Verdict->Reason[i];
    }
    Reason[i] = L'\0';
    if (i > 0) {
      PblPrintCentered (L"Reason:");
      Print (L"  %s\n\n", Reason);
    }
  }

  // Contact info
  if (ContactInfo != NULL) {
    CHAR16 Contact[256];
    for (i = 0; i < 255 && ContactInfo[i] != '\0'; i++) {
      Contact[i] = (CHAR16)ContactInfo[i];
    }
    Contact[i] = L'\0';
    PblPrintCentered (L"Contact your administrator:");
    Print (L"  %s\n\n", Contact);
  }

  // Footer
  PblPrintCentered (L"This device has been administratively locked.");
  PblPrintCentered (L"Do not attempt to bypass this lock.");
  Print (L"\n\n");

  return EFI_SUCCESS;
}

/** Show a degraded notice when the decision is DEGRADED.

  Displays a brief warning message with the reason, then counts down
  DisplaySeconds before returning (allowing the caller to chain-load).

  @param  Reason         Why the decision is degraded (ASCII).
  @param  DisplaySeconds How long to show the notice (seconds).

  @retval EFI_SUCCESS     Notice displayed and countdown completed.
  @retval EFI_DEVICE_ERROR  Console not available.
**/
EFI_STATUS
PblShowDegradedNotice (
  IN CONST CHAR8  *Reason,
  IN UINT8         DisplaySeconds
  )
{
  CHAR16 ReasonW[128];
  UINTN  i;
  UINT8  Seconds;

  if (gST->ConOut == NULL) {
    return EFI_DEVICE_ERROR;
  }

  PblClearScreen ();

  Print (L"\n\n\n");
  PblPrintCentered (L"========================================");
  PblPrintCentered (L"  SECURITY NOTICE");
  PblPrintCentered (L"========================================");
  Print (L"\n\n");

  // Reason
  if (Reason != NULL) {
    for (i = 0; i < 127 && Reason[i] != '\0'; i++) {
      ReasonW[i] = (CHAR16)Reason[i];
    }
    ReasonW[i] = L'\0';
    PblPrintCentered (L"This device has a security degradation:");
    Print (L"  %s\n\n", ReasonW);
  }

  PblPrintCentered (L"Boot will continue, but security is reduced.");
  PblPrintCentered (L"Contact your administrator.");
  Print (L"\n\n");

  // Countdown
  for (Seconds = DisplaySeconds; Seconds > 0; Seconds--) {
    Print (L"\rContinuing in %d seconds...  ", Seconds);
    gBS->Stall (1000000);  // 1 second
  }
  Print (L"\r                          \r");

  // Restore normal colors
  gST->ConOut->SetAttribute (gST->ConOut,
    EFI_TEXT_ATTR (EFI_LIGHTGRAY, EFI_BLACK));

  return EFI_SUCCESS;
}
