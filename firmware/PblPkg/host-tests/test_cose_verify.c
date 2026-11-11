/** @file
  Host-side tests for PblVerifyCoseSign1 — verdict COSE_Sign1 verification (D-224).

  D-224's second close criterion: "verdict-verification tests using test keys — sign a CBOR
  payload with a throwaway ES256 key and assert PblVerifyCoseSign1 accepts it and rejects a
  tampered payload/signature."

  Why this needs a host test at all: `PblVerifyCoseSign1` decides whether the firmware believes a
  LOCK/UNLOCK verdict. Everything it gets wrong fails in one of two directions, and both are bad:
  a too-permissive bug unlocks devices on an unsigned verdict, a too-strict one bricks them on a
  valid one. QEMU boots only ever feed it either a synthetic payload or nothing, so the
  interesting middle — a correctly signed payload, a payload tampered after signing, a signature
  from the wrong key — has never been exercised.

  The fixture (a throwaway P-256 key and a self-signed cert for it) is generated per run by
  run-host-tests.sh under build/cose-fixture/, so no key material is committed.

  Run with firmware/PblPkg/host-tests/run-host-tests.sh.
**/

#include "PblApp.h"
#include "host_crypto.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- tiny test harness (same shape as the other host suites) ----------- */

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

/* ---- minimal CBOR encoder (minimal-width heads, like the decoder expects) ---- */

typedef struct {
  UINT8  Buf[1024];
  UINTN  Len;
} CBOR;

static void
PutByte (CBOR *Out, UINT8 Value)
{
  Out->Buf[Out->Len++] = Value;
}

static void
PutHead (CBOR *Out, UINT8 Major, UINT64 Value)
{
  UINT8 M = (UINT8)(Major << 5);

  if (Value < 24) {
    PutByte (Out, (UINT8)(M | Value));
  } else if (Value <= 0xFF) {
    PutByte (Out, (UINT8)(M | 24));
    PutByte (Out, (UINT8)Value);
  } else if (Value <= 0xFFFF) {
    PutByte (Out, (UINT8)(M | 25));
    PutByte (Out, (UINT8)(Value >> 8));
    PutByte (Out, (UINT8)(Value & 0xFF));
  } else {
    PutByte (Out, (UINT8)(M | 26));
    PutByte (Out, (UINT8)((Value >> 24) & 0xFF));
    PutByte (Out, (UINT8)((Value >> 16) & 0xFF));
    PutByte (Out, (UINT8)((Value >> 8) & 0xFF));
    PutByte (Out, (UINT8)(Value & 0xFF));
  }
}

static void
PutBstr (CBOR *Out, CONST UINT8 *Data, UINTN Size)
{
  PutHead (Out, 2, Size);
  if (Size > 0 && Data != NULL) {
    CopyMem (Out->Buf + Out->Len, Data, Size);
    Out->Len += Size;
  }
}

static void
PutUint (CBOR *Out, UINT64 Value)
{
  PutHead (Out, 0, Value);
}

/** CBOR negative integer for -1 - Value (major type 1). */
static void
PutNegInt (CBOR *Out, UINT64 Value)
{
  PutHead (Out, 1, Value);
}

static void
PutTstr (CBOR *Out, const char *Text)
{
  UINTN Len = strlen (Text);
  PutHead (Out, 3, Len);
  CopyMem (Out->Buf + Out->Len, Text, Len);
  Out->Len += Len;
}

/* ---- fixture ---------------------------------------------------------- */

static CONST CHAR8 *g_fixtureDir;

static VOID
FixturePath (CONST CHAR8 *Name, CHAR8 *Out, UINTN OutSize)
{
  snprintf ((char *)Out, (size_t)OutSize, "%s/%s", (const char *)g_fixtureDir, (const char *)Name);
}

/* The signing key and its certificate, loaded once. */
static VOID     *g_key;
static UINT8     g_kid[32];
static UINT8     g_certDer[2048];
static UINTN     g_certDerSize;
static BOOLEAN   g_fixtureReady;

static BOOLEAN
LoadFixture (VOID)
{
  FILE   *Fp;
  CHAR8   keyPath[512];
  CHAR8   certPath[512];

  if (g_fixtureReady) {
    return TRUE;
  }

  if (g_fixtureDir == NULL) {
    return FALSE;
  }

  FixturePath ("key.pem", keyPath, sizeof (keyPath));
  FixturePath ("cert.der", certPath, sizeof (certPath));

  if (!HostCryptoLoadSigningKey (keyPath, &g_key, g_kid)) {
    return FALSE;
  }

  Fp = fopen ((const char *)certPath, "rb");
  if (Fp == NULL) {
    return FALSE;
  }

  g_certDerSize = fread (g_certDer, 1, sizeof (g_certDer), Fp);
  fclose (Fp);
  if (g_certDerSize == 0) {
    return FALSE;
  }

  g_fixtureReady = TRUE;
  return TRUE;
}

/* ---- COSE_Sign1 construction ------------------------------------------ */

typedef struct {
  UINT8  Protected[160];
  UINTN  ProtectedSize;
  UINT8  Payload[256];
  UINTN  PayloadSize;
  UINT8  Signature[64];
  UINT8  Cose[768];
  UINTN  CoseSize;
} COSE_FIXTURE;

/** Build a signed COSE_Sign1 over `Payload` with alg ES256 and the fixture's kid. */
static BOOLEAN
BuildSignedCose (COSE_FIXTURE *Out, CONST UINT8 *Payload, UINTN PayloadSize)
{
  CBOR   ProtectedHeader;
  CBOR   SigStructure;
  CBOR   Envelope;
  CBOR   PayloadBstr;
  UINT8  Digest[32];

  if (!LoadFixture ()) {
    return FALSE;
  }

  /* protected = bstr( { 1: -7 (ES256), 4: kid } ) */
  ProtectedHeader.Len = 0;
  PutHead (&ProtectedHeader, 5, 2); /* map, 2 entries */
  PutUint (&ProtectedHeader, 1);
  PutNegInt (&ProtectedHeader, 6);  /* -7 */
  PutUint (&ProtectedHeader, 4);
  PutBstr (&ProtectedHeader, g_kid, sizeof (g_kid));
  CopyMem (Out->Protected, ProtectedHeader.Buf, ProtectedHeader.Len);
  Out->ProtectedSize = ProtectedHeader.Len;

  CopyMem (Out->Payload, Payload, PayloadSize);
  Out->PayloadSize = PayloadSize;

  /* Sig_structure = [ "Signature1", protected, h'', payload ] (RFC 8152 §4.4) */
  SigStructure.Len = 0;
  PutHead (&SigStructure, 4, 4);
  PutTstr (&SigStructure, "Signature1");
  PutBstr (&SigStructure, Out->Protected, Out->ProtectedSize);
  PutBstr (&SigStructure, NULL, 0);
  PayloadBstr.Len = 0;
  PutBstr (&PayloadBstr, Payload, PayloadSize);
  CopyMem (SigStructure.Buf + SigStructure.Len, PayloadBstr.Buf, PayloadBstr.Len);
  SigStructure.Len += PayloadBstr.Len;

  Sha256HashAll (SigStructure.Buf, SigStructure.Len, Digest);
  if (!HostCryptoSignEs256 (g_key, Digest, sizeof (Digest), Out->Signature)) {
    return FALSE;
  }

  /* COSE_Sign1 = [ protected: bstr, unprotected: {}, payload: bstr, signature: bstr ] */
  Envelope.Len = 0;
  PutHead (&Envelope, 4, 4);
  PutBstr (&Envelope, Out->Protected, Out->ProtectedSize);
  PutHead (&Envelope, 5, 0); /* empty unprotected map */
  PutBstr (&Envelope, Payload, PayloadSize);
  PutBstr (&Envelope, Out->Signature, sizeof (Out->Signature));
  CopyMem (Out->Cose, Envelope.Buf, Envelope.Len);
  Out->CoseSize = Envelope.Len;
  return TRUE;
}

/** A realistic verdict payload: a CBOR map with a verdict and reason. */
static UINTN
MakeVerdictPayload (UINT8 *Out)
{
  CBOR Map;

  Map.Len = 0;
  PutHead (&Map, 5, 2);
  PutUint (&Map, 4);       /* verdict  */
  PutUint (&Map, 1);       /* LOCKED   */
  PutUint (&Map, 8);       /* reason   */
  PutTstr (&Map, "policy: device reported lost");

  CopyMem (Out, Map.Buf, Map.Len);
  return Map.Len;
}

/* ---- tests ------------------------------------------------------------ */

static void
TestAcceptsValidSignature (VOID)
{
  COSE_FIXTURE Fix;
  UINT8        Payload[256];
  UINTN        PayloadSize;

  PayloadSize = MakeVerdictPayload (Payload);
  if (!BuildSignedCose (&Fix, Payload, PayloadSize)) {
    CHECK (FALSE, "could not build the signed fixture (is the fixture directory present?)");
    return;
  }

  CHECK_STATUS (
    PblVerifyCoseSign1 (Fix.Cose, Fix.CoseSize, g_certDer, g_certDerSize, g_kid, sizeof (g_kid)),
    EFI_SUCCESS
    );
}

static void
TestRejectsTamperedPayload (VOID)
{
  COSE_FIXTURE Fix;
  UINT8        Payload[256];
  UINTN        PayloadSize;

  PayloadSize = MakeVerdictPayload (Payload);
  if (!BuildSignedCose (&Fix, Payload, PayloadSize)) {
    CHECK (FALSE, "could not build the signed fixture");
    return;
  }

  /* Turn LOCKED into UNLOCKED *inside the envelope after signing*: the signature no longer
     covers the payload. This is the exact attack COSE_Sign1 exists to prevent, so anything but
     a rejection here is a security defect. */
  for (UINTN i = 0; i + 1 < Fix.CoseSize; i++) {
    /* the payload's verdict value byte is the 0x01 following key 0x04 */
    if (Fix.Cose[i] == 0x04 && Fix.Cose[i + 1] == 0x01) {
      Fix.Cose[i + 1] = 0x00;
      break;
    }
  }

  CHECK_STATUS (
    PblVerifyCoseSign1 (Fix.Cose, Fix.CoseSize, g_certDer, g_certDerSize, g_kid, sizeof (g_kid)),
    EFI_SECURITY_VIOLATION
    );
}

static void
TestRejectsTamperedSignature (VOID)
{
  COSE_FIXTURE Fix;
  UINT8        Payload[256];
  UINTN        PayloadSize;

  PayloadSize = MakeVerdictPayload (Payload);
  if (!BuildSignedCose (&Fix, Payload, PayloadSize)) {
    CHECK (FALSE, "could not build the signed fixture");
    return;
  }

  /* The signature is the last 64 bytes plus a bstr head; flip a bit in its final byte. */
  Fix.Cose[Fix.CoseSize - 1] ^= 0x01;

  CHECK_STATUS (
    PblVerifyCoseSign1 (Fix.Cose, Fix.CoseSize, g_certDer, g_certDerSize, g_kid, sizeof (g_kid)),
    EFI_SECURITY_VIOLATION
    );
}

static void
TestRejectsWrongKid (VOID)
{
  COSE_FIXTURE Fix;
  UINT8        Payload[256];
  UINTN        PayloadSize;
  UINT8        WrongKid[32];

  PayloadSize = MakeVerdictPayload (Payload);
  if (!BuildSignedCose (&Fix, Payload, PayloadSize)) {
    CHECK (FALSE, "could not build the signed fixture");
    return;
  }

  CopyMem (WrongKid, g_kid, sizeof (WrongKid));
  WrongKid[0] ^= 0xFF;

  /* The signature itself is valid; only the policy's pinned kid differs. A verdict signed by a
     key the policy does not name must not be accepted. */
  CHECK_STATUS (
    PblVerifyCoseSign1 (Fix.Cose, Fix.CoseSize, g_certDer, g_certDerSize, WrongKid, sizeof (WrongKid)),
    EFI_SECURITY_VIOLATION
    );
}

static void
TestRejectsMalformedEnvelope (VOID)
{
  COSE_FIXTURE Fix;
  UINT8        Payload[256];
  UINTN        PayloadSize;
  CBOR         WrongShape;
  EFI_STATUS   Status;

  PayloadSize = MakeVerdictPayload (Payload);
  if (!BuildSignedCose (&Fix, Payload, PayloadSize)) {
    CHECK (FALSE, "could not build the signed fixture");
    return;
  }

  /* Truncated to the header: a LENGTH failure, so the contract is "any error", not a specific
     code. Pinning whichever code the parser happens to return first would describe an
     implementation detail instead of the fail-closed requirement. */
  Status = PblVerifyCoseSign1 (Fix.Cose, 4, g_certDer, g_certDerSize, g_kid, sizeof (g_kid));
  CHECK (EFI_ERROR (Status), "a truncated COSE_Sign1 must not verify (status 0x%llx)",
         (unsigned long long)Status);

  /* Well-formed CBOR, wrong shape: an array of three integers where COSE_Sign1 requires four
     items. This is the case the parser should name precisely. */
  WrongShape.Len = 0;
  PutHead (&WrongShape, 4, 3);
  PutUint (&WrongShape, 1);
  PutUint (&WrongShape, 2);
  PutUint (&WrongShape, 3);

  CHECK_STATUS (
    PblVerifyCoseSign1 (WrongShape.Buf, WrongShape.Len, g_certDer, g_certDerSize, g_kid, sizeof (g_kid)),
    EFI_PROTOCOL_ERROR
    );
}

static void
TestRejectsNullArguments (VOID)
{
  UINT8 Kid[32];

  ZeroMem (Kid, sizeof (Kid));
  CHECK_STATUS (PblVerifyCoseSign1 (NULL, 10, g_certDer, 100, Kid, sizeof (Kid)), EFI_INVALID_PARAMETER);
  CHECK_STATUS (PblVerifyCoseSign1 ((CONST UINT8 *)"x", 1, NULL, 100, Kid, sizeof (Kid)),
                EFI_INVALID_PARAMETER);
  CHECK_STATUS (PblVerifyCoseSign1 ((CONST UINT8 *)"x", 1, g_certDer, 100, NULL, 32),
                EFI_INVALID_PARAMETER);
}

static void
TestEd25519IsUnsupportedNotAccepted (VOID)
{
  CBOR   ProtectedHeader;
  CBOR   Envelope;
  UINT8  Payload[64];
  UINT8  Protected[64];
  UINTN  PayloadSize;

  /* alg -8 (Ed25519): BaseCryptLib has no Ed25519 verify, and C1 §7 requires an unverifiable
     verdict to fail closed rather than unlock. EFI_UNSUPPORTED is the contract.
     The kid must be the RIGHT one: PblVerifyCoseSign1 checks the kid before the algorithm, so a
     header without a kid correctly fails as EFI_SECURITY_VIOLATION instead — which is a
     different (and also correct) assertion, so this case carries the matching kid. */
  ProtectedHeader.Len = 0;
  PutHead (&ProtectedHeader, 5, 2);
  PutUint (&ProtectedHeader, 1);
  PutNegInt (&ProtectedHeader, 7); /* -8 */
  PutUint (&ProtectedHeader, 4);
  PutBstr (&ProtectedHeader, g_kid, sizeof (g_kid));
  CopyMem (Protected, ProtectedHeader.Buf, ProtectedHeader.Len);

  PayloadSize = MakeVerdictPayload (Payload);

  Envelope.Len = 0;
  PutHead (&Envelope, 4, 4);
  PutBstr (&Envelope, Protected, ProtectedHeader.Len);
  PutHead (&Envelope, 5, 0);
  PutBstr (&Envelope, Payload, PayloadSize);
  PutBstr (&Envelope, NULL, 0);

  if (!LoadFixture ()) {
    CHECK (FALSE, "could not load the fixture");
    return;
  }

  CHECK_STATUS (
    PblVerifyCoseSign1 (Envelope.Buf, Envelope.Len, g_certDer, g_certDerSize, g_kid, sizeof (g_kid)),
    EFI_UNSUPPORTED
    );
}

/** Pin the harness's own primitives so a broken helper cannot make a firmware bug look fine. */
static void
TestHarnessPrimitivesMatchKnownAnswers (VOID)
{
  /* SHA-256("abc") — NIST FIPS 180-4 vector. */
  static CONST UINT8 abcHash[32] = {
    0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
    0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad
  };
  /* HMAC-SHA-256, RFC 4231 test case 1. */
  static CONST UINT8 rfcKey[20] = {
    0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b,
    0x0b, 0x0b, 0x0b, 0x0b
  };
  static CONST UINT8 rfcData[] = "Hi There";
  static CONST UINT8 rfcMac[32] = {
    0xb0, 0x34, 0x4c, 0x61, 0xd8, 0xdb, 0x38, 0x53, 0x5c, 0xa8, 0xaf, 0xce, 0xaf, 0x0b, 0xf1, 0x2b,
    0x88, 0x1d, 0xc2, 0x00, 0xc9, 0x83, 0x3d, 0xa7, 0x26, 0xe9, 0x37, 0x6c, 0x2e, 0x32, 0xcf, 0xf7
  };
  UINT8 Hash[32];
  UINT8 Mac[32];

  Sha256HashAll ("abc", 3, Hash);
  CHECK (CompareMem (Hash, abcHash, sizeof (abcHash)) == 0, "SHA-256(\"abc\") does not match FIPS 180-4");

  HmacSha256All (rfcData, sizeof (rfcData) - 1, rfcKey, sizeof (rfcKey), Mac);
  CHECK (CompareMem (Mac, rfcMac, sizeof (rfcMac)) == 0, "HMAC-SHA-256 does not match RFC 4231 case 1");
}

int
main (int argc, char **argv)
{
  if (argc >= 2) {
    g_fixtureDir = argv[1];
  } else {
    g_fixtureDir = (CONST CHAR8 *)getenv ("HOST_TESTS_FIXTURE_DIR");
  }

  printf ("test_cose_verify: COSE_Sign1 verdict verification with real ES256 keys\n");
  if (g_fixtureDir == NULL) {
    printf ("FAIL [setup] no fixture directory (pass it as argv[1] or HOST_TESTS_FIXTURE_DIR)\n");
    return 1;
  }

  if (!LoadFixture ()) {
    printf ("FAIL [setup] could not load the key/cert fixture from %s\n", (const char *)g_fixtureDir);
    return 1;
  }

  run (TestHarnessPrimitivesMatchKnownAnswers, "harness/known-answers");
  run (TestAcceptsValidSignature, "cose/accepts-valid");
  run (TestRejectsTamperedPayload, "cose/rejects-tampered-payload");
  run (TestRejectsTamperedSignature, "cose/rejects-tampered-signature");
  run (TestRejectsWrongKid, "cose/rejects-wrong-kid");
  run (TestRejectsMalformedEnvelope, "cose/rejects-malformed");
  run (TestRejectsNullArguments, "cose/rejects-null-args");
  run (TestEd25519IsUnsupportedNotAccepted, "cose/ed25519-unsupported");

  printf ("\nhost-tests: %d checks, %d failures across 8 cases\n", g_checks, g_failures);
  if (g_failures == 0) {
    printf ("PASS — COSE_Sign1 verification accepts valid verdicts and rejects tampered ones\n");
  }

  HostCryptoFreeKey (g_key);
  return g_failures == 0 ? 0 : 1;
}
