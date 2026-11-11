/** @file
  Host implementations of the EDK2 BaseMemoryLib / BaseLib functions the pure
  parsing modules use. Semantics mirror MdePkg: the mem* wrappers are unbounded
  in EDK2, but the callers here always pass in-bounds sizes, and an overrun must
  fail the host test rather than corrupt the harness — so the copies are exact.
**/

#include "PblApp.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

VOID *
EFIAPI
CopyMem (
  OUT VOID       *Destination,
  IN  CONST VOID *Source,
  IN  UINTN       Length
  )
{
  return memmove (Destination, Source, Length);
}

VOID *
EFIAPI
ZeroMem (
  OUT VOID  *Buffer,
  IN  UINTN  Length
  )
{
  return memset (Buffer, 0, Length);
}

VOID *
EFIAPI
SetMem (
  OUT VOID  *Buffer,
  IN  UINTN  Length,
  IN  UINT8  Value
  )
{
  return memset (Buffer, Value, Length);
}

INTN
EFIAPI
CompareMem (
  IN CONST VOID  *DestinationBuffer,
  IN CONST VOID  *SourceBuffer,
  IN UINTN        Length
  )
{
  return (INTN)memcmp (DestinationBuffer, SourceBuffer, Length);
}

INTN
EFIAPI
AsciiStrCmp (
  IN CONST CHAR8  *FirstString,
  IN CONST CHAR8  *SecondString
  )
{
  return (INTN)strcmp (FirstString, SecondString);
}

UINTN
EFIAPI
AsciiStrLen (
  IN CONST CHAR8  *String
  )
{
  return (String == NULL) ? 0 : strlen (String);
}

VOID *
EFIAPI
AllocatePool (
  IN UINTN  AllocationSize
  )
{
  return malloc (AllocationSize);
}

VOID *
EFIAPI
AllocateZeroPool (
  IN UINTN  AllocationSize
  )
{
  return calloc (1, AllocationSize);
}

VOID
EFIAPI
FreePool (
  IN VOID  *Buffer
  )
{
  free (Buffer);
}

// ============================================================================
// BaseLib byte-order helpers
//
// EDK II implements these as inline byte swaps; TPM wire format is big-endian, so every
// field the client reads or writes goes through them. Implemented with shifts rather than
// <arpa/inet.h> so the harness stays within exactly the same contract (a no-op swap on a
// big-endian host would make a wire-format bug invisible, so the swap is unconditional —
// which is what EDK II's is).
// ============================================================================

UINT16
EFIAPI
SwapBytes16 (
  IN UINT16  Value
  )
{
  return (UINT16)((Value << 8) | (Value >> 8));
}

UINT32
EFIAPI
SwapBytes32 (
  IN UINT32  Value
  )
{
  return ((Value << 24) & 0xFF000000U) | ((Value << 8) & 0x00FF0000U) |
         ((Value >> 8) & 0x0000FF00U) | ((Value >> 24) & 0x000000FFU);
}

UINT64
EFIAPI
SwapBytes64 (
  IN UINT64  Value
  )
{
  return ((UINT64)SwapBytes32 ((UINT32)Value) << 32) | SwapBytes32 ((UINT32)(Value >> 32));
}

// ============================================================================
// Print — CHAR16 format to stderr
//
// The firmware logs through EDK II's Print with wide-string formats. In the host build
// CHAR16 is uint16_t, so it cannot be handed to vfprintf directly: this narrows the format
// and each argument. Only the specifiers these modules actually use are supported, and an
// unknown one is printed literally instead of being guessed at — a guessed conversion would
// read the wrong vararg and produce a confusing crash in the middle of a failing test.
//
// `%r` is EDK II's EFI_STATUS conversion. EDK II prints the error name; here it prints the
// hex status (the names live in the DebugLib, not here) — the value is what a host test
// needs to correlate with the API's return code.
// ============================================================================

static void
HostPrintWide (FILE *Stream, const CHAR16 *Wide)
{
  // CHAR16 is uint16_t on the host; Latin-1/ASCII is enough for these log strings and a
  // lossy byte is better than a crash. Anything above 0xFF prints as '?'.
  for (; *Wide != 0; Wide++) {
    fputc ((*Wide < 0x80) ? (int)*Wide : '?', Stream);
  }
}

VOID
EFIAPI
Print (
  IN CONST VOID  *Format,
  ...
  )
{
  va_list  Args;
  CHAR16  *Fmt;
  CHAR16  *Cursor;

  if (Format == NULL) {
    return;
  }

  Fmt    = (CHAR16 *)Format;
  Cursor = Fmt;
  va_start (Args, Format);

  while (*Cursor != 0) {
    if (*Cursor != '%') {
      if (*Cursor < 0x80) {
        fputc ((int)*Cursor, stderr);
      }

      Cursor++;
      continue;
    }

    Cursor++;                       // past '%'
    if (*Cursor == '%') {
      fputc ('%', stderr);
      Cursor++;
      continue;
    }

    // Collect the length modifiers so `%lu` is distinguishable from `%u`.
    BOOLEAN IsLong = FALSE;
    BOOLEAN IsLongLong = FALSE;
    while ((*Cursor == 'l') || (*Cursor == '0') || (*Cursor >= '1' && *Cursor <= '9')) {
      if (*Cursor == 'l') {
        if (IsLong) {
          IsLongLong = TRUE;
        } else {
          IsLong = TRUE;
        }
      }

      Cursor++;
    }

    char Spec = (char)*Cursor;
    Cursor++;
    switch (Spec) {
      case 'x':
        if (IsLong) {
          fprintf (stderr, "%lx", va_arg (Args, unsigned long));
        } else {
          fprintf (stderr, "%x", va_arg (Args, unsigned int));
        }

        break;
      case 'u':
        if (IsLongLong) {
          fprintf (stderr, "%llu", va_arg (Args, unsigned long long));
        } else if (IsLong) {
          fprintf (stderr, "%lu", va_arg (Args, unsigned long));
        } else {
          fprintf (stderr, "%u", va_arg (Args, unsigned int));
        }

        break;
      case 'd':
      case 'i':
        if (IsLongLong) {
          fprintf (stderr, "%lld", va_arg (Args, long long));
        } else if (IsLong) {
          fprintf (stderr, "%ld", va_arg (Args, long));
        } else {
          fprintf (stderr, "%d", va_arg (Args, int));
        }

        break;
      case 'c':
        fputc (va_arg (Args, int), stderr);
        break;
      case 'p':
        fprintf (stderr, "%p", va_arg (Args, VOID *));
        break;
      case 's':
        HostPrintWide (stderr, va_arg (Args, CONST CHAR16 *));
        break;
      case 'r':
        // EDK II's EFI_STATUS conversion; the value is 64-bit on X64.
        fprintf (stderr, "%llx", (unsigned long long)va_arg (Args, EFI_STATUS));
        break;
      case 'a':                         // EDK II: ASCII string
        fputs (va_arg (Args, CONST char *), stderr);
        break;
      default:
        // Unknown conversion: print the specifier literally. Never guess — guessing reads
        // the wrong vararg slot and derails every conversion after it.
        fprintf (stderr, "%%%c", Spec);
        break;
    }
  }

  va_end (Args);
}
