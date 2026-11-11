/** @file
  Interface to the host TPM harness (D-224).

  host_tpm.c provides a fake EFI_TCG2_PROTOCOL so the byte-level tests can run the shipped
  TpmClient.c / TpmSession.c code and inspect exactly what it puts on the wire. This header is
  the contract between that fake and test_tpm_command.c; the build compiles both into one
  binary, and the firmware headers are never involved in the harness's own types.

  Naming: everything the harness exports is `HostTpm*` / `HOST_TPM_*` so a grep for the harness
  can never be confused with the firmware's own `PblTpm*` API.
**/

#ifndef PBL_HOST_TPM_H
#define PBL_HOST_TPM_H

#include "PblApp.h"

#define HOST_TPM_MAX_CAPTURE 16

/** One command captured at the SubmitCommand seam.

    `DeclaredSize` is the header's own CommandSize field, byte-swapped to host order;
    `Submitted` is the length the client actually handed to SubmitCommand. They must be equal —
    a command whose header under-reports its length is answered TPM_RC_SIZE, and that is the
    single most common wire-format mistake. **/
typedef struct {
  UINT8   Raw[512];
  UINT32  Submitted;
  UINT16  Tag;
  UINT32  DeclaredSize;
  UINT32  CommandCode;
  BOOLEAN SizeMatchesSubmission;
} HOST_TPM_CAPTURED;

/** Discard all captured commands and scripted responses, and reset the counters. **/
VOID
HostTpmReset (
  VOID
  );

/** Queue one scripted response, consumed in order.

    When the queue is empty the fake answers TPM_RC_FAILURE (0x101), so a test that forgets to
    script an answer exercises a visible error path instead of accidentally passing.

    @param Tag       Response tag (TPM_ST_SESSIONS or TPM_ST_NO_SESSIONS).
    @param Rc        TPM return code — 0 for success.
    @param Body      Response parameters (may be NULL).
    @param BodySize  Length of Body. **/
VOID
HostTpmQueueResponse (
  IN UINT16       Tag,
  IN UINT32       Rc,
  IN CONST UINT8 *Body OPTIONAL,
  IN UINT32       BodySize
  );

/** Number of commands captured since the last reset. **/
UINT32
HostTpmCaptureCount (
  VOID
  );

/** The captured command at `Index`, or NULL when out of range. **/
CONST HOST_TPM_CAPTURED *
HostTpmCapture (
  IN UINT32 Index
  );

/** Count of captured commands whose header size disagreed with the submitted length. **/
UINT32
HostTpmSizeMismatches (
  VOID
);

/** Count of scripted responses dropped because the queue was full. **/
UINT32
HostTpmOverflowDrops (
  VOID
);

#endif /* PBL_HOST_TPM_H */
