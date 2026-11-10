/** @file
  Host implementations of the EDK2 BaseMemoryLib / BaseLib functions the pure
  parsing modules use. Semantics mirror MdePkg: the mem* wrappers are unbounded
  in EDK2, but the callers here always pass in-bounds sizes, and an overrun must
  fail the host test rather than corrupt the harness — so the copies are exact.
**/

#include "PblApp.h"

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
