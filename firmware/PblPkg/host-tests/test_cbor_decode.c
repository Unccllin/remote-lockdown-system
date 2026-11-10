/** @file
  Host-side unit tests for PblApp/CborDecode.c (D-117).

  The decoder is the highest-risk parsing surface in the firmware: it takes
  attacker-adjacent bytes (a COSE_Sign1 verdict/policy fetched over TLS) and
  writes into fixed-size struct fields. Until S265 the only verification was
  `-Werror` compilation plus one QEMU end-to-end boot, so a range/typing bug in,
  say, the `reason` copy would surface as "the whole boot flow broke" — or not at
  all, if the test policy never exercised that field.

  Run with firmware/PblPkg/host-tests/run-host-tests.sh.
**/

#include "PblApp.h"

#include <stdio.h>
#include <string.h>

/* ---- tiny test harness ------------------------------------------------ */

static int g_failures;
static int g_checks;
static const char *g_current;

#define CHECK(cond, fmt, ...)                             \
  do {                                                    \
    g_checks++;                                           \
    if (!(cond)) {                                        \
      g_failures++;                                       \
      printf ("FAIL [%s] " fmt "\n", g_current, ##__VA_ARGS__); \
    }                                                     \
  } while (0)

#define CHECK_STATUS(expr, expected)                                         \
  do {                                                                       \
    EFI_STATUS _st = (expr);                                                 \
    g_checks++;                                                              \
    if (_st != (expected)) {                                                 \
      g_failures++;                                                          \
      printf ("FAIL [%s] expected status 0x%llx got 0x%llx\n", g_current,    \
              (unsigned long long)(expected), (unsigned long long)_st);      \
    }                                                                        \
  } while (0)

static void
run (void (*fn) (void), const char *name)
{
  g_current = name;
  fn ();
}

/* ---- CBOR builders (minimal encoder, minimal-width heads) ------------- */

typedef struct {
  UINT8  Buf[512];
  UINTN  Len;
} CBOR_OUT;

static VOID
PutHead (CBOR_OUT *Out, UINT8 Major, UINT64 Value)
{
  UINT8 M = (UINT8)(Major << 5);
  if (Value < 24) {
    Out->Buf[Out->Len++] = (UINT8)(M | Value);
  } else if (Value <= 0xFF) {
    Out->Buf[Out->Len++] = (UINT8)(M | 24);
    Out->Buf[Out->Len++] = (UINT8)Value;
  } else if (Value <= 0xFFFF) {
    Out->Buf[Out->Len++] = (UINT8)(M | 25);
    Out->Buf[Out->Len++] = (UINT8)(Value >> 8);
    Out->Buf[Out->Len++] = (UINT8)Value;
  } else {
    Out->Buf[Out->Len++] = (UINT8)(M | 26);
    Out->Buf[Out->Len++] = (UINT8)(Value >> 24);
    Out->Buf[Out->Len++] = (UINT8)(Value >> 16);
    Out->Buf[Out->Len++] = (UINT8)(Value >> 8);
    Out->Buf[Out->Len++] = (UINT8)Value;
  }
}

static VOID
PutUint (CBOR_OUT *Out, UINT64 Value)
{
  PutHead (Out, 0, Value);
}

static VOID
PutBstr (CBOR_OUT *Out, CONST UINT8 *Data, UINTN Len)
{
  PutHead (Out, 2, Len);
  CopyMem (Out->Buf + Out->Len, Data, Len);
  Out->Len += Len;
}

static VOID
PutTstr (CBOR_OUT *Out, CONST CHAR8 *Text)
{
  UINTN Len = strlen (Text);
  PutHead (Out, 3, Len);
  CopyMem (Out->Buf + Out->Len, Text, Len);
  Out->Len += Len;
}

static VOID
PutMap (CBOR_OUT *Out, UINT64 Entries)
{
  PutHead (Out, 5, Entries);
}

static VOID
PutArray (CBOR_OUT *Out, UINT64 Entries)
{
  PutHead (Out, 4, Entries);
}

static VOID
PutBool (CBOR_OUT *Out, BOOLEAN Value)
{
  Out->Buf[Out->Len++] = (UINT8)(0xE0 | (Value ? 21 : 20));
}

static VOID
Fill (UINT8 *Dst, UINTN Len, UINT8 Start)
{
  for (UINTN i = 0; i < Len; i++) {
    Dst[i] = (UINT8)(Start + i);
  }
}

/* ---- verdict payload builder ------------------------------------------ */

/** Build a LockVerdict CBOR map (C1 §2) into `Payload`. */
static VOID
BuildVerdictPayload (CBOR_OUT *Payload, int IncludeChallengeSeed, int IncludeReason)
{
  UINT8 DeviceId[32];
  UINT8 Nonce[32];
  UINT8 Seed[16];
  UINT64 Entries = IncludeChallengeSeed ? 9 : 7;

  Fill (DeviceId, sizeof (DeviceId), 0x11);
  Fill (Nonce, sizeof (Nonce), 0x22);
  Fill (Seed, sizeof (Seed), 0x33);

  Payload->Len = 0;
  PutMap (Payload, Entries);

  PutUint (Payload, 1);            /* version */
  PutUint (Payload, 1);
  PutUint (Payload, 2);            /* device_id */
  PutBstr (Payload, DeviceId, 32);
  PutUint (Payload, 3);            /* nonce */
  PutBstr (Payload, Nonce, 32);
  PutUint (Payload, 4);            /* verdict = LOCKED */
  PutUint (Payload, 1);
  PutUint (Payload, 5);            /* policy_version */
  PutUint (Payload, 7);
  PutUint (Payload, 6);            /* issued_at */
  PutUint (Payload, 1700000000);
  PutUint (Payload, 7);            /* grace_until */
  PutUint (Payload, 1700003600);
  if (IncludeReason) {
    PutUint (Payload, 8);          /* reason */
    PutTstr (Payload, "device flagged");
  }
  if (IncludeChallengeSeed) {
    PutUint (Payload, 9);          /* challenge_seed */
    PutBstr (Payload, Seed, 16);
  }
}

/** Wrap a payload in a COSE_Sign1 envelope (4-element array). */
static VOID
BuildCose (CBOR_OUT *Cose, CONST CBOR_OUT *Payload)
{
  UINT8 Protected[] = { 0xA1, 0x01, 0x26 };  /* {1: -7} = ES256 */
  UINT8 Signature[64];

  Fill (Signature, sizeof (Signature), 0xA5);

  Cose->Len = 0;
  PutArray (Cose, 4);
  PutBstr (Cose, Protected, sizeof (Protected));
  PutMap (Cose, 0);                          /* unprotected: empty map */
  PutBstr (Cose, Payload->Buf, Payload->Len);
  PutBstr (Cose, Signature, sizeof (Signature));
}

/* ---- tests ------------------------------------------------------------ */

static VOID
TestVerdictParsesEveryField (VOID)
{
  CBOR_OUT          Payload, Cose;
  PBL_VERDICT       Verdict;
  UINT8             Expected[32];

  BuildVerdictPayload (&Payload, 1, 1);
  BuildCose (&Cose, &Payload);

  CHECK_STATUS (PblCborDecodeVerdict (Cose.Buf, Cose.Len, &Verdict), EFI_SUCCESS);

  Fill (Expected, sizeof (Expected), 0x11);
  CHECK (Verdict.Version == 1, "version=%u", Verdict.Version);
  CHECK (CompareMem (Verdict.DeviceId, Expected, 32) == 0, "device_id not copied");
  Fill (Expected, sizeof (Expected), 0x22);
  CHECK (CompareMem (Verdict.Nonce, Expected, 32) == 0, "nonce not copied");
  CHECK (Verdict.Verdict == 1, "verdict=%u", Verdict.Verdict);
  CHECK (Verdict.PolicyVersion == 7, "policy_version=%llu",
         (unsigned long long)Verdict.PolicyVersion);
  CHECK (Verdict.IssuedAt == 1700000000, "issued_at=%u", Verdict.IssuedAt);
  CHECK (Verdict.GraceUntil == 1700003600, "grace_until=%u", Verdict.GraceUntil);
  CHECK (strcmp (Verdict.Reason, "device flagged") == 0, "reason='%s'", Verdict.Reason);
  CHECK (Verdict.HasChallengeSeed == TRUE, "challenge seed flag not set");
  Fill (Expected, 16, 0x33);
  CHECK (CompareMem (Verdict.ChallengeSeed, Expected, 16) == 0, "challenge seed not copied");
}

static VOID
TestVerdictWithoutOptionalFields (VOID)
{
  CBOR_OUT    Payload, Cose;
  PBL_VERDICT Verdict;

  BuildVerdictPayload (&Payload, 0, 0);
  BuildCose (&Cose, &Payload);

  CHECK_STATUS (PblCborDecodeVerdict (Cose.Buf, Cose.Len, &Verdict), EFI_SUCCESS);
  CHECK (Verdict.HasChallengeSeed == FALSE, "optional seed reported present");
  CHECK (Verdict.Reason[0] == '\0', "reason should be empty, got '%s'", Verdict.Reason);
}

static VOID
TestVerdictIgnoresWrongLengthDeviceId (VOID)
{
  CBOR_OUT    Payload, Cose;
  PBL_VERDICT Verdict;
  UINT8       Short[16];

  Fill (Short, sizeof (Short), 0x77);

  Payload.Len = 0;
  PutMap (&Payload, 1);
  PutUint (&Payload, 2);
  PutBstr (&Payload, Short, sizeof (Short));
  BuildCose (&Cose, &Payload);

  /* A 16-byte device_id is not the wire format — the decoder must not copy it
     into a 32-byte field, and must not read past it either. */
  CHECK_STATUS (PblCborDecodeVerdict (Cose.Buf, Cose.Len, &Verdict), EFI_SUCCESS);
  for (UINTN i = 0; i < 32; i++) {
    CHECK (Verdict.DeviceId[i] == 0, "device_id[%u]=0x%02x should be zero", (unsigned)i,
           Verdict.DeviceId[i]);
  }
}

static VOID
TestVerdictRejectsNonMapPayload (VOID)
{
  CBOR_OUT    Payload, Cose;
  PBL_VERDICT Verdict;

  Payload.Len = 0;
  PutArray (&Payload, 0);
  BuildCose (&Cose, &Payload);

  CHECK_STATUS (PblCborDecodeVerdict (Cose.Buf, Cose.Len, &Verdict), EFI_PROTOCOL_ERROR);
}

static VOID
TestVerdictRejectsWrongEnvelopeArity (VOID)
{
  CBOR_OUT    Payload, Cose;
  PBL_VERDICT Verdict;

  BuildVerdictPayload (&Payload, 0, 0);
  BuildCose (&Cose, &Payload);
  /* Overwrite the 4-element array head with a 3-element one. */
  Cose.Buf[0] = 0x83;

  CHECK_STATUS (PblCborDecodeVerdict (Cose.Buf, Cose.Len, &Verdict), EFI_PROTOCOL_ERROR);
}

static VOID
TestVerdictRejectsTruncatedPayload (VOID)
{
  CBOR_OUT    Payload, Cose;
  PBL_VERDICT Verdict;
  UINT8       DeviceId[32];

  /* Declare a 32-byte device_id and supply 4: the bstr length check must fail.
     (Cutting the *signature* is not an error here — PblCoseExtractPayload only
     reads protected+payload; the signature is PblVerifyCoseSign1's input.) */
  Fill (DeviceId, sizeof (DeviceId), 0x11);
  Payload.Len = 0;
  PutMap (&Payload, 1);
  PutUint (&Payload, 2);
  PutHead (&Payload, 2, 32);
  PutBstr (&Payload, DeviceId, 4);
  BuildCose (&Cose, &Payload);

  CHECK_STATUS (PblCborDecodeVerdict (Cose.Buf, Cose.Len, &Verdict), EFI_BUFFER_TOO_SMALL);
}

static VOID
TestVerdictPayloadOnlyEnvelopeStillDecodes (VOID)
{
  CBOR_OUT    Payload, Cose;
  PBL_VERDICT Verdict;

  /* Documented boundary, pinned so it cannot drift silently: the payload
     extractor stops after the payload, so an envelope whose signature bytes are
     absent still decodes. Signature presence/validity belongs to
     PblVerifyCoseSign1 (CoseVerify.c), which is where a missing signature is
     rejected — not here, and not by accident. */
  BuildVerdictPayload (&Payload, 0, 1);
  BuildCose (&Cose, &Payload);
  Cose.Len -= 64;  /* drop the signature bstr's bytes, keep the 4-element head */

  CHECK_STATUS (PblCborDecodeVerdict (Cose.Buf, Cose.Len, &Verdict), EFI_SUCCESS);
  CHECK (Verdict.Verdict == 1, "verdict=%u", Verdict.Verdict);
}

static VOID
TestVerdictRejectsIndefiniteLengthMap (VOID)
{
  CBOR_OUT    Payload, Cose;
  PBL_VERDICT Verdict;

  /* 0xBF = map with indefinite length. The head reader returns EFI_UNSUPPORTED
     for it (its documented answer, not PROTOCOL_ERROR); the important half is
     that it refuses rather than looping or reading garbage. */
  Payload.Len = 0;
  Payload.Buf[Payload.Len++] = 0xBF;
  BuildCose (&Cose, &Payload);

  CHECK_STATUS (PblCborDecodeVerdict (Cose.Buf, Cose.Len, &Verdict), EFI_UNSUPPORTED);
}

static VOID
TestVerdictTruncatesOversizedReasonButKeepsTheStream (VOID)
{
  CBOR_OUT    Payload, Cose;
  PBL_VERDICT Verdict;
  CHAR8       Reason[200];

  memset (Reason, 'A', sizeof (Reason) - 1);
  Reason[sizeof (Reason) - 1] = '\0';

  /* Reason[128] cannot hold 199 bytes. The decoder truncates rather than failing
     (the payload is signed, and the field is human-readable text) — but it must
     then keep the cursor in sync, because key 4 follows. Before S265 it advanced
     by the truncated length, so the remaining 72 string bytes were decoded as
     CBOR and the next key was read out of string data. */
  Payload.Len = 0;
  PutMap (&Payload, 2);
  PutUint (&Payload, 8);
  PutTstr (&Payload, Reason);
  PutUint (&Payload, 4);
  PutUint (&Payload, 2); /* WIPE_PENDING */
  BuildCose (&Cose, &Payload);

  CHECK_STATUS (PblCborDecodeVerdict (Cose.Buf, Cose.Len, &Verdict), EFI_SUCCESS);
  CHECK (strlen (Verdict.Reason) == 127, "reason length=%u want 127",
         (unsigned)strlen (Verdict.Reason));
  CHECK (Verdict.Verdict == 2, "stream desynced: verdict=%u want 2", Verdict.Verdict);
}

static VOID
TestVerdictRejectsWrongValueType (VOID)
{
  CBOR_OUT    Payload, Cose;
  PBL_VERDICT Verdict;

  /* key 4 must be a uint; a text string is malformed. */
  Payload.Len = 0;
  PutMap (&Payload, 1);
  PutUint (&Payload, 4);
  PutTstr (&Payload, "LOCKED");
  BuildCose (&Cose, &Payload);

  CHECK_STATUS (PblCborDecodeVerdict (Cose.Buf, Cose.Len, &Verdict), EFI_PROTOCOL_ERROR);
}

static VOID
TestVerdictNullArguments (VOID)
{
  PBL_VERDICT Verdict;
  UINT8       One = 0x00;

  CHECK_STATUS (PblCborDecodeVerdict (NULL, 10, &Verdict), EFI_INVALID_PARAMETER);
  CHECK_STATUS (PblCborDecodeVerdict (&One, 0, &Verdict), EFI_INVALID_PARAMETER);
  CHECK_STATUS (PblCborDecodeVerdict (&One, 1, NULL), EFI_INVALID_PARAMETER);
}

static VOID
TestVerdictSkipsUnknownKeys (VOID)
{
  CBOR_OUT    Payload, Cose;
  PBL_VERDICT Verdict;

  /* Forward compatibility: an unknown key with a structured value must be
     skipped, not treated as an error. */
  Payload.Len = 0;
  PutMap (&Payload, 2);
  PutUint (&Payload, 99);
  PutArray (&Payload, 2);
  PutUint (&Payload, 1);
  PutTstr (&Payload, "future");
  PutUint (&Payload, 4);
  PutUint (&Payload, 2);          /* WIPE_PENDING */

  BuildCose (&Cose, &Payload);

  CHECK_STATUS (PblCborDecodeVerdict (Cose.Buf, Cose.Len, &Verdict), EFI_SUCCESS);
  CHECK (Verdict.Verdict == 2, "verdict=%u", Verdict.Verdict);
}

static VOID
TestCoseExtractAllPointsIntoTheBuffer (VOID)
{
  CBOR_OUT      Payload, Cose;
  CONST UINT8  *Protected, *Body, *Signature;
  UINTN         ProtectedSize, BodySize, SignatureSize;

  BuildVerdictPayload (&Payload, 1, 1);
  BuildCose (&Cose, &Payload);

  CHECK_STATUS (
    PblCoseExtractAll (Cose.Buf, Cose.Len, &Protected, &ProtectedSize, &Body, &BodySize,
                       &Signature, &SignatureSize),
    EFI_SUCCESS);

  /* No copies: every pointer must land inside the caller's buffer. */
  CHECK (Protected >= Cose.Buf && Protected < Cose.Buf + Cose.Len, "protected ptr outside buffer");
  CHECK (Body >= Cose.Buf && Body < Cose.Buf + Cose.Len, "payload ptr outside buffer");
  CHECK (Signature >= Cose.Buf && Signature < Cose.Buf + Cose.Len, "signature ptr outside buffer");
  CHECK (ProtectedSize == 3, "protected size=%u", (unsigned)ProtectedSize);
  CHECK (BodySize == Payload.Len, "payload size=%u want %u", (unsigned)BodySize,
         (unsigned)Payload.Len);
  CHECK (SignatureSize == 64, "signature size=%u", (unsigned)SignatureSize);
  CHECK (CompareMem (Body, Payload.Buf, Payload.Len) == 0, "payload bytes differ");
}

static VOID
TestCoseExtractAllRejectsBadInput (VOID)
{
  CBOR_OUT      Payload, Cose;
  CONST UINT8  *A;
  UINTN         ALen, BLen, CLen;

  BuildVerdictPayload (&Payload, 0, 0);
  BuildCose (&Cose, &Payload);

  CHECK_STATUS (PblCoseExtractAll (NULL, Cose.Len, &A, &ALen, &A, &BLen, &A, &CLen),
                EFI_INVALID_PARAMETER);

  Cose.Buf[0] = 0x85;  /* array of 5 */
  CHECK_STATUS (PblCoseExtractAll (Cose.Buf, Cose.Len, &A, &ALen, &A, &BLen, &A, &CLen),
                EFI_PROTOCOL_ERROR);
}

static VOID
TestProtectedHeaderParsesAlgAndKid (VOID)
{
  CBOR_OUT      Header;
  INT64         AlgId = 0;
  CONST UINT8  *Kid = NULL;
  UINTN         KidSize = 0;
  UINT8         KidBytes[32];

  Fill (KidBytes, sizeof (KidBytes), 0x5A);

  Header.Len = 0;
  PutMap (&Header, 2);
  PutUint (&Header, 1);
  Header.Buf[Header.Len++] = 0x26;  /* -7 (ES256) */
  PutUint (&Header, 4);
  PutBstr (&Header, KidBytes, sizeof (KidBytes));

  CHECK_STATUS (PblCoseParseProtectedHeader (Header.Buf, Header.Len, &AlgId, &Kid, &KidSize),
                EFI_SUCCESS);

  CHECK (AlgId == -7, "alg=%lld", (long long)AlgId);
  CHECK (KidSize == 32, "kid size=%u", (unsigned)KidSize);
  CHECK (Kid != NULL && CompareMem (Kid, KidBytes, 32) == 0, "kid bytes differ");
}

static VOID
TestProtectedHeaderRejectsNonMap (VOID)
{
  CBOR_OUT     Header;
  INT64        AlgId;
  CONST UINT8 *Kid;
  UINTN        KidSize;

  Header.Len = 0;
  PutArray (&Header, 1);

  CHECK_STATUS (PblCoseParseProtectedHeader (Header.Buf, Header.Len, &AlgId, &Kid, &KidSize),
                EFI_PROTOCOL_ERROR);
}

static VOID
TestPolicyParsesDedicatedFields (VOID)
{
  CBOR_OUT   Payload, Cose;
  PBL_POLICY Policy;
  UINT8      Pin[32], CaPin[32];

  Fill (Pin, sizeof (Pin), 0x0A);
  Fill (CaPin, sizeof (CaPin), 0x0B);

  Payload.Len = 0;
  PutMap (&Payload, 8);
  PutUint (&Payload, 1);           /* version */
  PutUint (&Payload, 3);
  PutUint (&Payload, 2);           /* issued_at */
  PutUint (&Payload, 1700000000);
  PutUint (&Payload, 3);           /* expires_at */
  PutUint (&Payload, 1700086400);
  PutUint (&Payload, 70);          /* lock_service_uri */
  PutTstr (&Payload, "https://verdict.example/api/v1/verdict");
  PutUint (&Payload, 71);          /* cert pin */
  PutBstr (&Payload, Pin, 32);
  PutUint (&Payload, 80);          /* freshness */
  PutUint (&Payload, 86400);
  PutUint (&Payload, 81);          /* grace */
  PutUint (&Payload, 604800);
  PutUint (&Payload, 82);          /* wipe deadline */
  PutUint (&Payload, 1209600);

  BuildCose (&Cose, &Payload);

  CHECK_STATUS (PblCborDecodePolicy (Cose.Buf, Cose.Len, &Policy), EFI_SUCCESS);
  CHECK (Policy.Meta.Version == 3, "version=%u", Policy.Meta.Version);
  CHECK (Policy.Meta.IssuedAt == 1700000000, "issued_at=%u", Policy.Meta.IssuedAt);
  CHECK (Policy.Meta.ExpiresAt == 1700086400, "expires_at=%u", Policy.Meta.ExpiresAt);
  CHECK (strcmp (Policy.LockServiceUri, "https://verdict.example/api/v1/verdict") == 0,
         "uri='%s'", Policy.LockServiceUri);
  CHECK (CompareMem (Policy.LockServiceCertPin, Pin, 32) == 0, "cert pin not copied");
  CHECK (Policy.VerdictFreshnessSec == 86400, "freshness=%u", Policy.VerdictFreshnessSec);
  CHECK (Policy.GracePeriodSec == 604800, "grace=%u", Policy.GracePeriodSec);
  CHECK (Policy.WipeDeadlineSec == 1209600, "wipe=%u", Policy.WipeDeadlineSec);
  /* RawCbor must point at the payload inside the caller's COSE buffer. */
  CHECK (Policy.RawCborSize == Payload.Len, "raw size=%u want %u",
         (unsigned)Policy.RawCborSize, (unsigned)Payload.Len);
  CHECK (Policy.RawCbor != NULL && Policy.RawCbor >= Cose.Buf && Policy.RawCbor < Cose.Buf + Cose.Len,
         "raw pointer outside buffer");
}

static VOID
TestPolicyParsesTpmSessionSubMap (VOID)
{
  CBOR_OUT   Payload, Cose;
  PBL_POLICY Policy;

  Payload.Len = 0;
  PutMap (&Payload, 2);
  PutUint (&Payload, 40);
  PutMap (&Payload, 4);
  PutTstr (&Payload, "hmac");
  PutBool (&Payload, TRUE);
  PutTstr (&Payload, "param_encrypt");
  PutBool (&Payload, TRUE);
  PutTstr (&Payload, "salted");
  PutBool (&Payload, FALSE);
  PutTstr (&Payload, "bound");
  PutBool (&Payload, TRUE);
  PutUint (&Payload, 42);          /* pin policy */
  PutTstr (&Payload, "required");

  BuildCose (&Cose, &Payload);

  CHECK_STATUS (PblCborDecodePolicy (Cose.Buf, Cose.Len, &Policy), EFI_SUCCESS);
  CHECK (Policy.TpmSessionReq.HmacRequired == TRUE, "hmac flag");
  CHECK (Policy.TpmSessionReq.ParamEncryptRequired == TRUE, "param_encrypt flag");
  CHECK (Policy.TpmSessionReq.SaltedRequired == FALSE, "salted flag");
  CHECK (Policy.TpmSessionReq.BoundRequired == TRUE, "bound flag");
  CHECK (Policy.TpmPinPolicy == 1, "pin policy=%u", Policy.TpmPinPolicy);
}

static VOID
TestPolicyRejectsMalformed (VOID)
{
  CBOR_OUT   Payload, Cose;
  PBL_POLICY Policy;

  /* Payload is an array, not a map. */
  Payload.Len = 0;
  PutArray (&Payload, 0);
  BuildCose (&Cose, &Payload);
  CHECK_STATUS (PblCborDecodePolicy (Cose.Buf, Cose.Len, &Policy), EFI_PROTOCOL_ERROR);

  /* Key 1 must be a uint. */
  Payload.Len = 0;
  PutMap (&Payload, 1);
  PutUint (&Payload, 1);
  PutTstr (&Payload, "three");
  BuildCose (&Cose, &Payload);
  CHECK_STATUS (PblCborDecodePolicy (Cose.Buf, Cose.Len, &Policy), EFI_PROTOCOL_ERROR);

  /* Truncated envelope. */
  BuildCose (&Cose, &Payload);
  Cose.Len -= 3;
  CHECK (EFI_ERROR (PblCborDecodePolicy (Cose.Buf, Cose.Len, &Policy)),
         "truncated policy envelope returned success");
}

int
main (VOID)
{
  run (TestVerdictParsesEveryField, "verdict/all-fields");
  run (TestVerdictWithoutOptionalFields, "verdict/optional-absent");
  run (TestVerdictIgnoresWrongLengthDeviceId, "verdict/short-device-id");
  run (TestVerdictRejectsNonMapPayload, "verdict/payload-not-map");
  run (TestVerdictRejectsWrongEnvelopeArity, "verdict/envelope-arity");
  run (TestVerdictRejectsTruncatedPayload, "verdict/truncated-payload");
  run (TestVerdictPayloadOnlyEnvelopeStillDecodes, "verdict/signature-not-read-here");
  run (TestVerdictRejectsIndefiniteLengthMap, "verdict/indefinite-map");
  run (TestVerdictTruncatesOversizedReasonButKeepsTheStream, "verdict/oversized-reason-sync");
  run (TestVerdictRejectsWrongValueType, "verdict/wrong-value-type");
  run (TestVerdictNullArguments, "verdict/null-args");
  run (TestVerdictSkipsUnknownKeys, "verdict/unknown-key-skipped");
  run (TestCoseExtractAllPointsIntoTheBuffer, "cose/extract-all");
  run (TestCoseExtractAllRejectsBadInput, "cose/extract-all-bad-input");
  run (TestProtectedHeaderParsesAlgAndKid, "cose/protected-header");
  run (TestProtectedHeaderRejectsNonMap, "cose/protected-header-not-map");
  run (TestPolicyParsesDedicatedFields, "policy/fields");
  run (TestPolicyParsesTpmSessionSubMap, "policy/tpm-session-submap");
  run (TestPolicyRejectsMalformed, "policy/malformed");

  printf ("\nhost-tests: %d checks, %d failures across 19 cases\n", g_checks, g_failures);
  if (g_failures == 0) {
    printf ("PASS — CborDecode.c public API behaves as specified\n");
  }
  return g_failures == 0 ? 0 : 1;
}
