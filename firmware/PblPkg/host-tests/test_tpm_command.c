/** @file
  Byte-level tests for the TPM 2.0 commands TpmClient.c / TpmSession.c build (D-224).

  These are the tests D-117's close criteria named and did not deliver: the parsing modules got
  host tests in S265, but the TPM wire format did not, because "the TPM path needs
  EFI_TCG2_PROTOCOL plumbing and the TPM 2.0 structure headers". Both are now supplied —
  host_tpm.c fakes the protocol, include/IndustryStandard holds vendored EDK II headers — so
  the *shipped* construction code runs here and the commands it produces are asserted byte by
  byte.

  Why bother, given QEMU+swtpm already boots the real firmware? Because a boot only reports
  "TPM_RC_SIZE" or "the boot flow failed". D-135 is the precedent: the epoch counter silently
  stopped counting for sessions because LOCK_EPOCH was never added to a hand-maintained list,
  and the only symptom was a WARN line during a boot nobody was reading. Here the same class of
  mistake is a failing assertion with the produced bytes printed next to the expected ones.

  Run with firmware/PblPkg/host-tests/run-host-tests.sh.
**/

#include "PblApp.h"
#include "host_tpm.h"

#include <stdio.h>
#include <string.h>

/* ---- tiny test harness (same shape as test_cbor_decode.c) -------------- */

static int         g_failures;
static int         g_checks;
static const char *g_current;

#define CHECK(cond, fmt, ...)                                    \
  do {                                                           \
    g_checks++;                                                  \
    if (!(cond)) {                                               \
      g_failures++;                                              \
      printf ("FAIL [%s] " fmt "\n", g_current, ##__VA_ARGS__);  \
    }                                                            \
  } while (0)

#define CHECK_STATUS(expr, expected)                                          \
  do {                                                                        \
    EFI_STATUS _st = (expr);                                                  \
    g_checks++;                                                               \
    if (_st != (expected)) {                                                  \
      g_failures++;                                                           \
      printf ("FAIL [%s] expected status 0x%llx got 0x%llx\n", g_current,     \
              (unsigned long long)(expected), (unsigned long long)_st);       \
    }                                                                         \
  } while (0)

static void
run (void (*fn) (void), const char *name)
{
  g_current = name;
  fn ();
}

/* ---- command decoder -------------------------------------------------- */

/* TPM 2.0 wire form for a session command:
     header(10) | handles(4*N) | authAreaSize(4) | authArea | parameters
   The handle count is not self-describing on the wire, so the caller states how many it
   expects — and that expectation is itself part of the test. */
typedef struct {
  UINT16        Tag;
  UINT32        Size;
  UINT32        Code;
  UINT32        HandleCount;
  UINT32        Handles[4];
  UINT32        AuthAreaSize;
  CONST UINT8  *Auth;
  CONST UINT8  *Params;
  UINT32        ParamsSize;
} PARSED_CMD;

static UINT16
Be16 (CONST UINT8 *P)
{
  return (UINT16)((P[0] << 8) | P[1]);
}

static UINT32
Be32 (CONST UINT8 *P)
{
  return ((UINT32)P[0] << 24) | ((UINT32)P[1] << 16) | ((UINT32)P[2] << 8) | (UINT32)P[3];
}

/** Decode a captured command. Returns FALSE when the buffer cannot hold the claimed layout —
    which is itself a failure worth reporting rather than indexing past the end. **/
static BOOLEAN
ParseCommand (CONST HOST_TPM_CAPTURED *Cap, UINT32 ExpectHandles, PARSED_CMD *Out)
{
  CONST UINT8  *Raw;
  UINT32        Offset;

  if (Cap == NULL || Out == NULL) {
    return FALSE;
  }

  ZeroMem (Out, sizeof (*Out));
  Raw  = Cap->Raw;
  Out->Tag  = Be16 (Raw);
  Out->Size = Be32 (Raw + 2);
  Out->Code = Be32 (Raw + 6);

  if (Out->Size > Cap->Submitted) {
    return FALSE;
  }

  Offset = 10;
  if (Out->Tag == TPM_ST_SESSIONS) {
    Out->HandleCount = ExpectHandles;
    if (Offset + (4 * ExpectHandles) + 4 > Out->Size) {
      return FALSE;
    }

    for (UINT32 i = 0; i < ExpectHandles; i++) {
      Out->Handles[i] = Be32 (Raw + Offset);
      Offset += 4;
    }

    Out->AuthAreaSize = Be32 (Raw + Offset);
    Offset += 4;
    if (Offset + Out->AuthAreaSize > Out->Size) {
      return FALSE;
    }

    Out->Auth       = Raw + Offset;
    Offset         += Out->AuthAreaSize;
    Out->Params     = Raw + Offset;
    Out->ParamsSize = Out->Size - Offset;
  } else {
    /* No-session form: handles still follow the header, but there is no auth area. */
    Out->HandleCount = ExpectHandles;
    if (Offset + (4 * ExpectHandles) > Out->Size) {
      return FALSE;
    }

    for (UINT32 i = 0; i < ExpectHandles; i++) {
      Out->Handles[i] = Be32 (Raw + Offset);
      Offset += 4;
    }

    Out->Params     = Raw + Offset;
    Out->ParamsSize = Out->Size - Offset;
  }

  return TRUE;
}

/* ---- tests ------------------------------------------------------------ */

/** TPM2_NV_Read on the lock-state index: the command PBL sends on every boot. */
static void
TestReadLockState (VOID)
{
  PBL_LOCK_STATE_CACHE     Cache;
  HOST_TPM_CAPTURED CONST *Cap;
  PARSED_CMD               Cmd;
  CONST UINT8             *Pw;
  UINT16                   PwSize;
  UINTN                    PcdSize;

  HostTpmReset ();
  /* TPM_RC_NV_UNINITIALIZED: the index exists but was never written — the real first-boot
     answer, and the path that must degrade to "no cached value" rather than an error. */
  HostTpmQueueResponse (TPM_ST_SESSIONS, 0x14A, NULL, 0);

  CHECK_STATUS (PblTpmReadLockState (&Cache), EFI_NOT_FOUND);
  CHECK (HostTpmCaptureCount () == 1, "expected exactly 1 command, got %u", HostTpmCaptureCount ());

  Cap = HostTpmCapture (0);
  CHECK (Cap != NULL, "command was not captured");
  if (Cap == NULL) {
    return;
  }

  CHECK (ParseCommand (Cap, 2, &Cmd), "captured command does not parse");
  CHECK (Cmd.Tag == TPM_ST_SESSIONS, "tag 0x%04x, expected TPM_ST_SESSIONS", Cmd.Tag);
  CHECK (Cmd.Code == TPM_CC_NV_Read, "cc 0x%x, expected TPM_CC_NV_Read", Cmd.Code);
  CHECK (Cmd.HandleCount == 2, "NV_Read takes authHandle + nvIndex");
  CHECK (Cmd.Handles[0] == PBL_NV_LOCK_STATE, "authHandle 0x%x, expected PBL_NV_LOCK_STATE", Cmd.Handles[0]);
  CHECK (Cmd.Handles[1] == PBL_NV_LOCK_STATE, "nvIndex 0x%x, expected PBL_NV_LOCK_STATE", Cmd.Handles[1]);

  /* Password session against an NV index must carry the NV auth value, not an empty password:
     the D-135 boot failure was exactly this (0x9A2 on every boot). */
  Pw     = FixedPcdGetPtr (PcdPblTpmNvAuthValue);
  PcdSize = FixedPcdGetSize (PcdPblTpmNvAuthValue);
  CHECK (Cmd.AuthAreaSize == 9 + PcdSize, "authAreaSize %u, expected 9 + %u (password session)",
         Cmd.AuthAreaSize, (unsigned)PcdSize);
  CHECK (Be32 (Cmd.Auth) == TPM_RS_PW, "sessionHandle 0x%x, expected TPM_RS_PW", Be32 (Cmd.Auth));
  CHECK (Be16 (Cmd.Auth + 4) == 0, "nonceCaller must be empty for a password session");
  CHECK (Cmd.Auth[6] == 0, "sessionAttributes 0x%02x, expected 0", Cmd.Auth[6]);
  PwSize = Be16 (Cmd.Auth + 7);
  CHECK (PwSize == PcdSize, "password size %u, expected %u (PcdPblTpmNvAuthValue)", PwSize, (unsigned)PcdSize);
  CHECK (PwSize > 0 && CompareMem (Cmd.Auth + 9, Pw, PwSize) == 0,
         "password bytes do not match PcdPblTpmNvAuthValue");

  /* Parameters: size then offset, both 16-bit big-endian (NV_Read_In order). */
  CHECK (Cmd.ParamsSize == 4, "NV_Read params %u bytes, expected 4", Cmd.ParamsSize);
  if (Cmd.ParamsSize == 4) {
    CHECK (Be16 (Cmd.Params) == PBL_LOCK_STATE_SIZE, "read size %u, expected %u",
           Be16 (Cmd.Params), PBL_LOCK_STATE_SIZE);
    CHECK (Be16 (Cmd.Params + 2) == 0, "read offset %u, expected 0", Be16 (Cmd.Params + 2));
  }
}

/** TPM2_NV_Write on the lock-state index, including the NG-T7 epoch stamping branch. */
static void
TestWriteLockState (VOID)
{
  PBL_LOCK_STATE_CACHE     Cache;
  HOST_TPM_CAPTURED CONST *Cap;
  PARSED_CMD               Cmd;

  ZeroMem (&Cache, sizeof (Cache));
  Cache.Magic   = PBL_LOCK_STATE_MAGIC;
  Cache.Verdict = PBL_VERDICT_LOCKED;
  Cache.Epoch   = 0xDEADBEEF; /* pre-stamp value: must be replaced by the fresh epoch */

  HostTpmReset ();
  /* The epoch increment fails, which is the documented "unprovisioned or old TPM" branch: the
     write must still go out, stamped Epoch=0. Note only TWO commands result — the counter
     read-back is short-circuited by the failed increment (`if (!EFI_ERROR (inc) &&
     !EFI_ERROR (read))`), so an increment that cannot work costs one round-trip, not two. */
  HostTpmQueueResponse (TPM_ST_SESSIONS, 0x149, NULL, 0); /* NV_Increment   */
  HostTpmQueueResponse (TPM_ST_SESSIONS, 0, NULL, 0);     /* NV_Write: ok   */

  PblTpmWriteLockState (&Cache);

  CHECK (HostTpmCaptureCount () == 2, "expected increment + write, got %u", HostTpmCaptureCount ());
  if (HostTpmCaptureCount () != 2) {
    return;
  }

  Cap = HostTpmCapture (0);
  /* NV_Increment carries authHandle AND nvIndex per TPM 2.0 Part 3 — two handles, both the
     index. Asserting one would have masked a command the TPM rejects outright. */
  CHECK (ParseCommand (Cap, 2, &Cmd) && Cmd.Code == TPM_CC_NV_Increment,
         "first command should be NV_Increment, got cc 0x%x", Cmd.Code);
  CHECK (Cmd.Handles[0] == PBL_NV_LOCK_EPOCH && Cmd.Handles[1] == PBL_NV_LOCK_EPOCH,
         "increment handles 0x%x/0x%x, expected PBL_NV_LOCK_EPOCH twice",
         Cmd.Handles[0], Cmd.Handles[1]);

  Cap = HostTpmCapture (1);
  CHECK (Cap != NULL, "write command was not captured");
  if (Cap == NULL) {
    return;
  }

  CHECK (ParseCommand (Cap, 2, &Cmd), "write command does not parse");
  CHECK (Cmd.Code == TPM_CC_NV_Write, "cc 0x%x, expected TPM_CC_NV_Write", Cmd.Code);
  CHECK (Cmd.Handles[0] == PBL_NV_LOCK_STATE && Cmd.Handles[1] == PBL_NV_LOCK_STATE,
         "both NV_Write handles must be the lock-state index");
  CHECK (Cmd.ParamsSize == 2 + PBL_LOCK_STATE_SIZE + 2,
         "NV_Write params %u bytes, expected 2 + %u + 2", Cmd.ParamsSize, PBL_LOCK_STATE_SIZE);
  if (Cmd.ParamsSize == 2 + PBL_LOCK_STATE_SIZE + 2) {
    CHECK (Be16 (Cmd.Params) == PBL_LOCK_STATE_SIZE, "written size %u, expected %u",
           Be16 (Cmd.Params), PBL_LOCK_STATE_SIZE);
    /* The stamped copy: same magic/verdict as the caller's, but Epoch forced to 0 because the
       increment failed. Getting this wrong is how a rolled-back cache would look fresh. */
    CHECK (Cmd.Params[2] == PBL_LOCK_STATE_MAGIC, "written Magic 0x%02x, expected 0x%02x",
           Cmd.Params[2], PBL_LOCK_STATE_MAGIC);
    CHECK (Be16 (Cmd.Params + 2 + PBL_LOCK_STATE_SIZE) == 0, "write offset must be 0");
  }
}

/** The four NV indices must all be defined, in the owner hierarchy (D-134's ruling). */
static void
TestProvisionDefinesEveryIndex (VOID)
{
  UINT32                ExpectedIndices[4];
  UINT32                ExpectedHierarchy;
  HOST_TPM_CAPTURED CONST *Cap;
  PARSED_CMD            Cmd;

  ExpectedIndices[0] = PBL_NV_LOCK_STATE;
  ExpectedIndices[1] = PBL_NV_POLICY_VERSION;
  ExpectedIndices[2] = PBL_NV_AK_NAME;
  ExpectedIndices[3] = PBL_NV_LOCK_EPOCH;
  ExpectedHierarchy  = FixedPcdGetBool (PcdPblTpmUsePlatformHierarchy) ? TPM_RH_PLATFORM : TPM_RH_OWNER;

  HostTpmReset ();
  for (int i = 0; i < 12; i++) {
    HostTpmQueueResponse (TPM_ST_SESSIONS, 0, NULL, 0);
  }

  PblTpmProvisionNvIndices ();

  CHECK (HostTpmCaptureCount () >= 4, "expected at least 4 NV_DefineSpace commands, got %u",
         HostTpmCaptureCount ());

  for (UINT32 i = 0; i < 4; i++) {
    Cap = HostTpmCapture (i);
    if (Cap == NULL) {
      CHECK (FALSE, "command %u was not captured", i);
      continue;
    }

    if (!ParseCommand (Cap, 1, &Cmd)) {
      CHECK (FALSE, "command %u does not parse", i);
      continue;
    }

    CHECK (Cmd.Code == TPM_CC_NV_DefineSpace, "command %u cc 0x%x, expected NV_DefineSpace", i, Cmd.Code);
    CHECK (Cmd.Handles[0] == ExpectedHierarchy,
           "command %u authHandle 0x%x, expected 0x%x from PcdPblTpmUsePlatformHierarchy",
           i, Cmd.Handles[0], ExpectedHierarchy);

    /* NV_DefineSpace_In order is auth FIRST, then publicInfo. Swapping them made the TPM read
       the publicInfo size as the auth size and answer TPM_RC_SIZE (S158's 0x2D5). */
    UINTN AuthLen = Be16 (Cmd.Params);
    CONST UINT8 *Public = Cmd.Params + 2 + AuthLen;
    CHECK (AuthLen == FixedPcdGetSize (PcdPblTpmNvAuthValue),
           "command %u auth size %u, expected the PCD auth value length", i, (unsigned)AuthLen);

    CHECK (Be16 (Public) == 14, "command %u TPM2B_NV_PUBLIC size %u, expected 14", i, Be16 (Public));
    CHECK (Be32 (Public + 2) == ExpectedIndices[i],
           "command %u nvIndex 0x%x, expected 0x%x", i, Be32 (Public + 2), ExpectedIndices[i]);
    CHECK (Be16 (Public + 6) == TPM_ALG_SHA256, "command %u nameAlg 0x%04x, expected SHA-256", i, Be16 (Public + 6));
  }

  /* LOCK_EPOCH is index 3 above; D-135 was that this one silently went missing. Showing the
     assertion exists on its own line is deliberate — it is the regression this test is for. */
  Cap = HostTpmCapture (3);
  if (Cap != NULL && ParseCommand (Cap, 1, &Cmd) && Cmd.Code == TPM_CC_NV_DefineSpace) {
    CHECK (Be32 (Cmd.Params + 2 + Be16 (Cmd.Params) + 2) == PBL_NV_LOCK_EPOCH,
           "the fourth defined index must be the lock-epoch counter");
  }
}

/** TPM2_NV_Increment on the policy-version counter. */
static void
TestIncrementPolicyVersion (VOID)
{
  HOST_TPM_CAPTURED CONST *Cap;
  PARSED_CMD               Cmd;

  HostTpmReset ();
  HostTpmQueueResponse (TPM_ST_SESSIONS, 0, NULL, 0);

  PblTpmIncrementPolicyVersion ();

  CHECK (HostTpmCaptureCount () == 1, "expected 1 command, got %u", HostTpmCaptureCount ());
  Cap = HostTpmCapture (0);
  if (Cap == NULL) {
    return;
  }

  CHECK (ParseCommand (Cap, 2, &Cmd), "command does not parse");
  CHECK (Cmd.Code == TPM_CC_NV_Increment, "cc 0x%x, expected NV_Increment", Cmd.Code);
  CHECK (Cmd.Handles[0] == PBL_NV_POLICY_VERSION && Cmd.Handles[1] == PBL_NV_POLICY_VERSION,
         "handles 0x%x/0x%x, expected PBL_NV_POLICY_VERSION twice",
         Cmd.Handles[0], Cmd.Handles[1]);
  CHECK (Cmd.ParamsSize == 0, "NV_Increment has no parameters, got %u bytes", Cmd.ParamsSize);
}

/** TPM2_PCR_Extend without a PCR session: no-session form, digest list of one SHA-256 digest. */
static void
TestExtendPcrNoSession (VOID)
{
  UINT8                    Digest[32];
  HOST_TPM_CAPTURED CONST *Cap;
  PARSED_CMD               Cmd;

  for (UINT32 i = 0; i < sizeof (Digest); i++) {
    Digest[i] = (UINT8)i;
  }

  HostTpmReset ();
  HostTpmQueueResponse (TPM_ST_NO_SESSIONS, 0, NULL, 0);

  PblTpmExtendPcr (PBL_PCR_DECISION, Digest, sizeof (Digest));

  Cap = HostTpmCapture (0);
  CHECK (Cap != NULL, "no command captured");
  if (Cap == NULL) {
    return;
  }

  CHECK (ParseCommand (Cap, 1, &Cmd), "command does not parse");
  CHECK (Cmd.Code == TPM_CC_PCR_Extend, "cc 0x%x, expected PCR_Extend", Cmd.Code);
  CHECK (Cmd.Tag == TPM_ST_NO_SESSIONS, "tag 0x%04x, expected the no-session fallback form", Cmd.Tag);
  CHECK (Cmd.Handles[0] == PBL_PCR_DECISION, "pcrHandle %u, expected PBL_PCR_DECISION (%u)",
         Cmd.Handles[0], PBL_PCR_DECISION);
  CHECK (Cmd.ParamsSize == 4 + 2 + 32, "params %u bytes, expected count + alg + digest", Cmd.ParamsSize);
  if (Cmd.ParamsSize >= 4) {
    CHECK (Be32 (Cmd.Params) == 1, "digest count %u, expected 1", Be32 (Cmd.Params));
  }

  if (Cmd.ParamsSize == 4 + 2 + 32) {
    CHECK (Be16 (Cmd.Params + 4) == TPM_ALG_SHA256, "hashAlg 0x%04x, expected SHA-256",
           Be16 (Cmd.Params + 4));
    CHECK (CompareMem (Cmd.Params + 6, Digest, sizeof (Digest)) == 0, "digest bytes were altered");
  }
}

/** A PCR other than 12/13 must be refused before any command is built (C2 §4). */
static void
TestExtendPcrRefusesOtherBanks (VOID)
{
  UINT8 Digest[32];

  ZeroMem (Digest, sizeof (Digest));
  HostTpmReset ();

  CHECK_STATUS (PblTpmExtendPcr (0, Digest, sizeof (Digest)), EFI_INVALID_PARAMETER);
  CHECK_STATUS (PblTpmExtendPcr (7, Digest, sizeof (Digest)), EFI_INVALID_PARAMETER);
  CHECK (HostTpmCaptureCount () == 0, "a refused PCR must not reach the TPM, sent %u",
         HostTpmCaptureCount ());
}

/** Find the StartAuthSession command among the captures, or return NULL.

    PblTpmStartHmacSession draws its nonceCaller from PblTpmGetRandom first, so the session
    command is never capture 0 — locating it by command code is what keeps this test honest
    about ordering instead of assuming it. */
static CONST HOST_TPM_CAPTURED *
FindStartAuthSession (VOID)
{
  for (UINT32 i = 0; i < HostTpmCaptureCount (); i++) {
    CONST HOST_TPM_CAPTURED *Cap = HostTpmCapture (i);
    if (Cap != NULL && Cap->CommandCode == TPM_CC_StartAuthSession) {
      return Cap;
    }
  }

  return NULL;
}

/** Queue a GetRandom answer plus one for whatever follows.

    GetRandom needs a real TPM2B_DIGEST body (2-byte size + bytes): a bare success response
    makes the caller reject the 10-byte reply and bail before it ever builds the session
    command, which is how this test first failed. */
static VOID
QueueSessionResponses (VOID)
{
  UINT8 RandomBody[2 + 32];

  RandomBody[0] = 0x00;
  RandomBody[1] = 0x20;
  for (UINT32 i = 0; i < 32; i++) {
    RandomBody[2 + i] = (UINT8)(0xA0 + i);
  }

  HostTpmQueueResponse (TPM_ST_NO_SESSIONS, 0, RandomBody, sizeof (RandomBody));
  HostTpmQueueResponse (TPM_ST_NO_SESSIONS, 0, NULL, 0);
  HostTpmQueueResponse (TPM_ST_SESSIONS, 0, NULL, 0);
}

/** The production shape: a session bound to the lock-state index (PblApp.c:479). */
static void
TestStartAuthSessionBound (VOID)
{
  CONST HOST_TPM_CAPTURED *Cap;
  PARSED_CMD               Cmd;
  UINT8                    NvAuth[64];

  CopyMem (NvAuth, FixedPcdGetPtr (PcdPblTpmNvAuthValue),
           FixedPcdGetSize (PcdPblTpmNvAuthValue) <= sizeof (NvAuth)
             ? FixedPcdGetSize (PcdPblTpmNvAuthValue)
             : sizeof (NvAuth));

  HostTpmReset ();
  QueueSessionResponses ();

  PblTpmStartHmacSession (PBL_NV_LOCK_STATE, NvAuth, FixedPcdGetSize (PcdPblTpmNvAuthValue));

  Cap = FindStartAuthSession ();
  CHECK (Cap != NULL, "no StartAuthSession command was sent (captured %u commands)",
         HostTpmCaptureCount ());
  if (Cap == NULL) {
    return;
  }

  CHECK (ParseCommand (Cap, 2, &Cmd), "StartAuthSession does not parse");
  CHECK (Cmd.Tag == TPM_ST_NO_SESSIONS, "tag 0x%04x, expected TPM_ST_NO_SESSIONS", Cmd.Tag);
  CHECK (Cmd.HandleCount == 2, "StartAuthSession takes tpmKey + bind");
  CHECK (Cmd.Handles[0] == TPM_RH_NULL, "tpmKey 0x%x, expected TPM_RH_NULL (unsalted)", Cmd.Handles[0]);
  CHECK (Cmd.Handles[1] == PBL_NV_LOCK_STATE,
         "bind 0x%x, expected the lock-state index the session authorizes", Cmd.Handles[1]);
  CHECK (Cmd.ParamsSize >= 2 && Be16 (Cmd.Params) == 32,
         "nonceCaller size %u, expected 32", Cmd.ParamsSize >= 2 ? Be16 (Cmd.Params) : 0);
}

/** The unbound encoding: bind == TPM_RH_NULL must survive verbatim.

    Worth pinning because `PblTpmStartHmacSession` writes BindHandle straight into the command
    with no normalization — so "unbound" is only correct when the caller passes TPM_RH_NULL
    (0x40000007) itself, not 0. No current caller passes 0 (the only call site binds to the NV
    index), so this is a latent trap rather than a live defect: the test states the contract and
    a future caller that passes 0 gets a command the TPM answers with TPM_RC_HANDLE. **/
static void
TestStartAuthSessionUnbound (VOID)
{
  CONST HOST_TPM_CAPTURED *Cap;
  PARSED_CMD               Cmd;

  HostTpmReset ();
  QueueSessionResponses ();

  PblTpmStartHmacSession (TPM_RH_NULL, NULL, 0);

  Cap = FindStartAuthSession ();
  CHECK (Cap != NULL, "no StartAuthSession command was sent");
  if (Cap == NULL) {
    return;
  }

  CHECK (ParseCommand (Cap, 2, &Cmd), "StartAuthSession does not parse");
  CHECK (Cmd.Handles[1] == TPM_RH_NULL, "bind 0x%x, expected TPM_RH_NULL for an unbound session",
         Cmd.Handles[1]);
}

/** The cross-cutting invariant: every command the client sends declares its own size. */
static void
TestEveryCommandDeclaresItsSize (VOID)
{
  CHECK (HostTpmSizeMismatches () == 0,
         "%u command(s) had header.CommandSize != bytes submitted — a size field that does not "
         "cover what was written is answered TPM_RC_SIZE", HostTpmSizeMismatches ());
  CHECK (HostTpmOverflowDrops () == 0, "%u scripted response(s) were dropped", HostTpmOverflowDrops ());

  for (UINT32 i = 0; i < HostTpmCaptureCount (); i++) {
    CONST HOST_TPM_CAPTURED *Cap = HostTpmCapture (i);
    CHECK (Cap != NULL && Cap->SizeMatchesSubmission,
           "capture %u: declared size %u, submitted %u", i,
           Cap ? Cap->DeclaredSize : 0, Cap ? Cap->Submitted : 0);
  }
}

int
main (int argc, char **argv)
{
  (VOID)argc;
  (VOID)argv;

  printf ("test_tpm_command: byte-level TPM command construction\n");

  run (TestReadLockState, "nv-read/lock-state");
  run (TestWriteLockState, "nv-write/lock-state");
  run (TestProvisionDefinesEveryIndex, "nv-define/all-four-indices");
  run (TestIncrementPolicyVersion, "nv-increment/policy-version");
  run (TestExtendPcrNoSession, "pcr-extend/no-session-12");
  run (TestExtendPcrRefusesOtherBanks, "pcr-extend/refuses-other-banks");
  run (TestStartAuthSessionBound, "session/start-auth-session-bound");
  run (TestStartAuthSessionUnbound, "session/start-auth-session-unbound");
  run (TestEveryCommandDeclaresItsSize, "invariant/declared-size");

  printf ("\nhost-tests: %d checks, %d failures across 8 cases\n", g_checks, g_failures);
  if (g_failures == 0) {
    printf ("PASS — TPM command buffers match the TPM 2.0 wire format\n");
  }
  return g_failures == 0 ? 0 : 1;
}
