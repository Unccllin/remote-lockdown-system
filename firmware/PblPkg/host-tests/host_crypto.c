/** @file
  Host implementations of the EDK II BaseCryptLib subset the PBL modules call (D-224).

  Why the harness needs real crypto rather than a stub: the point of these tests is to check what
  the shipped code does with real cryptographic values. A stub that "returns TRUE" would let a
  wrong Sig_structure, a wrong KDFa input, or a raw-vs-DER signature mix-up pass — and the whole
  reason COSE verification is hard to get right is precisely those details.

  Backend: OpenSSL (libcrypto). Chosen over hand-rolled primitives because a hand-rolled P-256
  verify would itself be untested code sitting under the test that is supposed to catch bugs.
  Consequence, stated plainly: the TPM and COSE host tests require OpenSSL headers at build
  time. run-host-tests.sh detects that and prints an explicit SKIPPED line when they are
  missing — the CBOR tests still run with nothing but a C compiler.

  Two contracts are deliberately mirrored from EDK II rather than from intuition:

    * `EcDsaVerify` takes the signature as RAW r||s, not DER. CryptoPkg's implementation
      (CryptEc.c:1060) rejects any SigSize != 2 * curve-half-size and rebuilds an ECDSA_SIG from
      the two halves. `CoseVerify.c` therefore passes 64 raw bytes for ES256, and a host backend
      that mirrored OpenSSL's ECDSA_verify instead would report a bug that does not exist.
    * `AesCbcEncrypt` is CBC with no padding, so callers implementing CFB by hand can get E_K(x)
      from a single block with a zero IV (TpmSession.c does exactly that). Input must be a
      multiple of the block size.
**/

#include "PblApp.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <openssl/asn1.h>
#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/x509.h>

/* ============================================================================
   SHA-256
   ============================================================================ */

BOOLEAN
EFIAPI
Sha256HashAll (
  IN   CONST VOID  *Data,
  IN   UINTN        DataSize,
  OUT  UINT8       *HashValue
  )
{
  unsigned int OutLen = 0;

  if (HashValue == NULL) {
    return FALSE;
  }

  if (EVP_Digest (Data, DataSize, HashValue, &OutLen, EVP_sha256 (), NULL) != 1) {
    return FALSE;
  }

  return (BOOLEAN)(OutLen == 32);
}

/* ============================================================================
   HMAC-SHA256 (RFC 2104)
   ============================================================================
   Composed from the SHA-256 above rather than through OpenSSL's HMAC API, which OpenSSL 3
   exposes only via EVP_MAC or the deprecated HMAC_CTX. Both would add version sensitivity to a
   test helper; the construction is 20 lines and pinned against the RFC 4231 vectors by
   test_cose_verify.c, so a mistake here cannot quietly make a firmware bug look correct.
   ============================================================================ */

#define HOST_HMAC_BLOCK 64

static VOID
HmacKeyBlock (
  IN  CONST UINT8  *Key,
  IN  UINTN         KeySize,
  OUT UINT8         Block[HOST_HMAC_BLOCK]
  )
{
  ZeroMem (Block, HOST_HMAC_BLOCK);

  if (KeySize > HOST_HMAC_BLOCK) {
    /* Keys longer than the block size are hashed first (RFC 2104 §2). */
    Sha256HashAll (Key, KeySize, Block);
  } else if (KeySize > 0) {
    CopyMem (Block, Key, KeySize);
  }
}

static BOOLEAN
HmacSha256Raw (
  IN  CONST UINT8  *Key,
  IN UINTN          KeySize,
  IN CONST VOID    *Data,
  IN UINTN          DataSize,
  OUT UINT8         Out[32]
  )
{
  UINT8    KeyBlock[HOST_HMAC_BLOCK];
  UINT8    Pad[HOST_HMAC_BLOCK];
  UINT8    Inner[32];
  UINT8    Buffer[HOST_HMAC_BLOCK];
  EVP_MD_CTX *Ctx;

  HmacKeyBlock (Key, KeySize, KeyBlock);

  Ctx = EVP_MD_CTX_new ();
  if (Ctx == NULL) {
    return FALSE;
  }

  /* inner = H((K xor ipad) || data) */
  for (UINTN i = 0; i < HOST_HMAC_BLOCK; i++) {
    Pad[i] = (UINT8)(KeyBlock[i] ^ 0x36);
  }

  if (EVP_DigestInit_ex (Ctx, EVP_sha256 (), NULL) != 1 ||
      EVP_DigestUpdate (Ctx, Pad, HOST_HMAC_BLOCK) != 1 ||
      EVP_DigestUpdate (Ctx, Data, DataSize) != 1 ||
      EVP_DigestFinal_ex (Ctx, Inner, NULL) != 1) {
    EVP_MD_CTX_free (Ctx);
    return FALSE;
  }

  /* outer = H((K xor opad) || inner) */
  for (UINTN i = 0; i < HOST_HMAC_BLOCK; i++) {
    Pad[i] = (UINT8)(KeyBlock[i] ^ 0x5C);
  }

  if (EVP_DigestInit_ex (Ctx, EVP_sha256 (), NULL) != 1 ||
      EVP_DigestUpdate (Ctx, Pad, HOST_HMAC_BLOCK) != 1 ||
      EVP_DigestUpdate (Ctx, Inner, sizeof (Inner)) != 1 ||
      EVP_DigestFinal_ex (Ctx, Out, NULL) != 1) {
    EVP_MD_CTX_free (Ctx);
    return FALSE;
  }

  ZeroMem (Buffer, sizeof (Buffer));
  ZeroMem (KeyBlock, sizeof (KeyBlock));
  ZeroMem (Pad, sizeof (Pad));
  EVP_MD_CTX_free (Ctx);
  return TRUE;
}

BOOLEAN
EFIAPI
HmacSha256All (
  IN   CONST VOID   *Data,
  IN   UINTN         DataSize,
  IN   CONST UINT8  *Key,
  IN   UINTN         KeySize,
  OUT  UINT8        *HmacValue
  )
{
  if (HmacValue == NULL) {
    return FALSE;
  }

  return HmacSha256Raw (Key, KeySize, Data, DataSize, HmacValue);
}

/* The streaming form buffers the message and hashes once at Final. TPM commands and responses
   are at most a few kilobytes, so the memory cost is irrelevant, and it removes any chance of
   an ordering bug in the harness producing a different HMAC than the one-shot form. */
typedef struct {
  UINT8  Key[HOST_HMAC_BLOCK];
  UINTN  KeySize;
  UINT8 *Data;
  UINTN  DataSize;
  UINTN  Capacity;
  BOOLEAN Failed;
} HOST_HMAC_CTX;

VOID *
EFIAPI
HmacSha256New (
  VOID
  )
{
  return AllocateZeroPool (sizeof (HOST_HMAC_CTX));
}

BOOLEAN
EFIAPI
HmacSha256SetKey (
  OUT  VOID         *HmacSha256Context,
  IN   CONST UINT8  *Key,
  IN   UINTN         KeySize
  )
{
  HOST_HMAC_CTX *Ctx = (HOST_HMAC_CTX *)HmacSha256Context;

  if (Ctx == NULL) {
    return FALSE;
  }

  HmacKeyBlock (Key, KeySize, Ctx->Key);
  Ctx->KeySize = (KeySize > HOST_HMAC_BLOCK) ? 32 : KeySize;
  return TRUE;
}

BOOLEAN
EFIAPI
HmacSha256Update (
  IN OUT  VOID        *HmacSha256Context,
  IN      CONST VOID  *Data,
  IN      UINTN        DataSize
  )
{
  HOST_HMAC_CTX *Ctx = (HOST_HMAC_CTX *)HmacSha256Context;

  if (Ctx == NULL || Ctx->Failed) {
    return FALSE;
  }

  if (DataSize == 0) {
    return TRUE;
  }

  if (Ctx->DataSize + DataSize > Ctx->Capacity) {
    UINTN  NewCapacity = (Ctx->Capacity == 0) ? 256 : Ctx->Capacity;
    UINT8 *Grown;

    while (NewCapacity < Ctx->DataSize + DataSize) {
      NewCapacity *= 2;
    }

    Grown = realloc (Ctx->Data, NewCapacity);
    if (Grown == NULL) {
      Ctx->Failed = TRUE;
      return FALSE;
    }

    Ctx->Data     = Grown;
    Ctx->Capacity = NewCapacity;
  }

  CopyMem (Ctx->Data + Ctx->DataSize, Data, DataSize);
  Ctx->DataSize += DataSize;
  return TRUE;
}

BOOLEAN
EFIAPI
HmacSha256Final (
  IN OUT  VOID   *HmacSha256Context,
  OUT     UINT8  *HmacValue
  )
{
  HOST_HMAC_CTX *Ctx = (HOST_HMAC_CTX *)HmacSha256Context;

  if (Ctx == NULL || Ctx->Failed || HmacValue == NULL) {
    return FALSE;
  }

  return HmacSha256Raw (Ctx->Key, Ctx->KeySize, Ctx->Data, Ctx->DataSize, HmacValue);
}

VOID
EFIAPI
HmacSha256Free (
  IN OUT  VOID  *HmacSha256Context
  )
{
  HOST_HMAC_CTX *Ctx = (HOST_HMAC_CTX *)HmacSha256Context;

  if (Ctx == NULL) {
    return;
  }

  if (Ctx->Data != NULL) {
    ZeroMem (Ctx->Data, Ctx->Capacity);
    free (Ctx->Data);
  }

  ZeroMem (Ctx, sizeof (*Ctx));
  free (Ctx);
}

/* ============================================================================
   AES-CBC (no padding)
   ============================================================================ */

typedef struct {
  UINT8  Key[32];
  UINTN  KeySize;
} HOST_AES_CTX;

UINTN
EFIAPI
AesGetContextSize (
  VOID
  )
{
  return sizeof (HOST_AES_CTX);
}

BOOLEAN
EFIAPI
AesInit (
  OUT  VOID         *AesContext,
  IN   CONST UINT8  *Key,
  IN   UINTN         KeyLength
  )
{
  HOST_AES_CTX *Ctx = (HOST_AES_CTX *)AesContext;

  if (Ctx == NULL || Key == NULL) {
    return FALSE;
  }

  if (KeyLength != 16 && KeyLength != 24 && KeyLength != 32) {
    return FALSE;
  }

  ZeroMem (Ctx, sizeof (*Ctx));
  CopyMem (Ctx->Key, Key, KeyLength);
  Ctx->KeySize = KeyLength;
  return TRUE;
}

BOOLEAN
EFIAPI
AesCbcEncrypt (
  IN   VOID         *AesContext,
  IN   CONST UINT8  *Input,
  IN   UINTN         InputSize,
  IN   CONST UINT8  *Ivec,
  OUT  UINT8        *Output
  )
{
  HOST_AES_CTX     *Ctx = (HOST_AES_CTX *)AesContext;
  EVP_CIPHER_CTX   *Evp;
  CONST EVP_CIPHER *Cipher;
  int               OutLen = 0;
  int               FinalLen = 0;
  BOOLEAN           Ok = FALSE;

  if (Ctx == NULL || Input == NULL || Ivec == NULL || Output == NULL) {
    return FALSE;
  }

  /* EDK II requires whole blocks (it uses no-padding CBC); so must this, or a caller relying
     on "CBC with no padding" would silently get different output here than on the firmware. */
  if (InputSize == 0 || (InputSize % 16) != 0) {
    return FALSE;
  }

  switch (Ctx->KeySize) {
    case 16:
      Cipher = EVP_aes_128_cbc ();
      break;
    case 24:
      Cipher = EVP_aes_192_cbc ();
      break;
    default:
      Cipher = EVP_aes_256_cbc ();
      break;
  }

  Evp = EVP_CIPHER_CTX_new ();
  if (Evp == NULL) {
    return FALSE;
  }

  if (EVP_EncryptInit_ex (Evp, Cipher, NULL, Ctx->Key, Ivec) != 1 ||
      EVP_CIPHER_CTX_set_padding (Evp, 0) != 1 ||
      EVP_EncryptUpdate (Evp, Output, &OutLen, Input, (int)InputSize) != 1 ||
      EVP_EncryptFinal_ex (Evp, Output + OutLen, &FinalLen) != 1) {
    EVP_CIPHER_CTX_free (Evp);
    return FALSE;
  }

  Ok = (BOOLEAN)((UINTN)(OutLen + FinalLen) == InputSize);
  EVP_CIPHER_CTX_free (Evp);
  return Ok;
}

/* ============================================================================
   X.509 public key extraction + ECDSA verify (raw r||s, as EDK II defines it)
   ============================================================================ */

BOOLEAN
EFIAPI
EcGetPublicKeyFromX509 (
  IN   CONST UINT8  *Cert,
  IN   UINTN         CertSize,
  OUT  VOID         **EcContext
  )
{
  CONST UINT8 *Cursor = Cert;
  X509        *Parsed;
  EVP_PKEY    *Key;

  if (Cert == NULL || EcContext == NULL) {
    return FALSE;
  }

  *EcContext = NULL;
  Parsed     = d2i_X509 (NULL, &Cursor, (long)CertSize);
  if (Parsed == NULL) {
    return FALSE;
  }

  Key = X509_get_pubkey (Parsed);
  X509_free (Parsed);
  if (Key == NULL) {
    return FALSE;
  }

  if (EVP_PKEY_base_id (Key) != EVP_PKEY_EC) {
    EVP_PKEY_free (Key);
    return FALSE;
  }

  *EcContext = Key;
  return TRUE;
}

VOID
EFIAPI
EcFree (
  IN  VOID  *EcContext
  )
{
  if (EcContext != NULL) {
    EVP_PKEY_free ((EVP_PKEY *)EcContext);
  }
}

BOOLEAN
EFIAPI
EcDsaVerify (
  IN  VOID         *EcContext,
  IN  UINTN         HashNid,
  IN  CONST UINT8  *MessageHash,
  IN  UINTN         HashSize,
  IN  CONST UINT8  *Signature,
  IN  UINTN         SigSize
  )
{
  EVP_PKEY    *Key = (EVP_PKEY *)EcContext;
  EVP_PKEY_CTX *Ctx;
  UINTN        HalfSize;
  UINT8       *Der = NULL;
  int          DerLen;
  BOOLEAN      Ok;
  ECDSA_SIG   *Sig;
  BIGNUM      *R;
  BIGNUM      *S;

  if (Key == NULL || MessageHash == NULL || Signature == NULL) {
    return FALSE;
  }

  /* Mirror EDK II's curve/hash checks: the hash NID must be SHA-256 with a 32-byte digest, and
     the signature must be exactly two curve-sized halves. Encoding the digest as an opaque
     blob would let a SHA-384 digest verify here while the firmware rejected it. */
  if (HashNid != CRYPTO_NID_SHA256 || HashSize != 32) {
    return FALSE;
  }

  HalfSize = (UINTN)((EVP_PKEY_get_bits (Key) + 7) / 8);
  if (SigSize != HalfSize * 2) {
    return FALSE;
  }

  /* raw r||s -> DER, which is what the EVP verify path consumes. */
  Sig = ECDSA_SIG_new ();
  if (Sig == NULL) {
    return FALSE;
  }

  R = BN_bin2bn (Signature, (int)HalfSize, NULL);
  S = BN_bin2bn (Signature + HalfSize, (int)HalfSize, NULL);
  if (R == NULL || S == NULL || ECDSA_SIG_set0 (Sig, R, S) != 1) {
    BN_free (R);
    BN_free (S);
    ECDSA_SIG_free (Sig);
    return FALSE;
  }

  DerLen = i2d_ECDSA_SIG (Sig, &Der);
  /* Ownership of R and S passed to Sig; Der is ours to free. */
  if (DerLen <= 0) {
    ECDSA_SIG_free (Sig);
    return FALSE;
  }

  Ok = FALSE;
  Ctx = EVP_PKEY_CTX_new (Key, NULL);
  if (Ctx != NULL) {
    if (EVP_PKEY_verify_init (Ctx) == 1 &&
        EVP_PKEY_CTX_set_signature_md (Ctx, EVP_sha256 ()) == 1 &&
        EVP_PKEY_verify (Ctx, Der, (size_t)DerLen, MessageHash, HashSize) == 1) {
      Ok = TRUE;
    }

    EVP_PKEY_CTX_free (Ctx);
  }

  OPENSSL_free (Der);
  ECDSA_SIG_free (Sig);
  return Ok;
}

/* ============================================================================
   Test-only helpers for the COSE suite
   ============================================================================
   The firmware never signs anything — it only verifies. These exist so
   test_cose_verify.c can produce a real ES256 signature over a real CBOR payload with a
   throwaway key, which is the only way to prove PblVerifyCoseSign1 accepts a valid verdict and
   rejects a tampered one.
   ============================================================================ */

/** Load an EC private key from a PEM file and return its SHA-256 SPKI digest (the `kid`). **/
BOOLEAN
HostCryptoLoadSigningKey (
  IN  CONST CHAR8  *KeyPemPath,
  OUT VOID        **KeyOut,
  OUT UINT8        *SpkiDigest /* 32 bytes */
  )
{
  FILE      *Fp;
  EVP_PKEY  *Key;
  UINT8     *Spki = NULL;
  int        SpkiLen;

  if (KeyPemPath == NULL || KeyOut == NULL || SpkiDigest == NULL) {
    return FALSE;
  }

  Fp = fopen ((const char *)KeyPemPath, "r");
  if (Fp == NULL) {
    return FALSE;
  }

  Key = PEM_read_PrivateKey (Fp, NULL, NULL, NULL);
  fclose (Fp);
  if (Key == NULL) {
    return FALSE;
  }

  /* kid = SHA-256 of the SubjectPublicKeyInfo DER (C1 §5). CoseVerify.c compares the kid from
     the protected header against policy.lock_service_cert_pin, so producing it the same way
     the signer does is what makes the accept case meaningful. */
  SpkiLen = i2d_PUBKEY (Key, &Spki);
  if (SpkiLen <= 0) {
    EVP_PKEY_free (Key);
    return FALSE;
  }

  Sha256HashAll (Spki, (UINTN)SpkiLen, SpkiDigest);
  OPENSSL_free (Spki);
  *KeyOut = Key;
  return TRUE;
}

VOID
HostCryptoFreeKey (
  IN VOID  *Key
  )
{
  if (Key != NULL) {
    EVP_PKEY_free ((EVP_PKEY *)Key);
  }
}

/** Sign a 32-byte digest with ES256 and return the raw r||s form (64 bytes). **/
BOOLEAN
HostCryptoSignEs256 (
  IN  VOID         *Key,
  IN  CONST UINT8  *Digest,
  IN  UINTN         DigestSize,
  OUT UINT8        *Signature /* 64 bytes */
  )
{
  EVP_PKEY_CTX *Ctx;
  ECDSA_SIG    *Sig;
  UINT8        *Der = NULL;
  CONST UINT8  *Cursor;
  int           DerLen;
  const BIGNUM *R;
  const BIGNUM *S;
  UINTN         HalfSize;

  if (Key == NULL || Digest == NULL || Signature == NULL || DigestSize != 32) {
    return FALSE;
  }

  Ctx = EVP_PKEY_CTX_new ((EVP_PKEY *)Key, NULL);
  if (Ctx == NULL) {
    return FALSE;
  }

  if (EVP_PKEY_sign_init (Ctx) != 1 || EVP_PKEY_CTX_set_signature_md (Ctx, EVP_sha256 ()) != 1) {
    EVP_PKEY_CTX_free (Ctx);
    return FALSE;
  }

  /* DER-encoded signature is produced; the caller needs raw r||s to match CoseVerify.c.
     The length query needs its OWN size_t: writing through a cast of an int (`(size_t *)&Ok`)
     let EVP write eight bytes into a four-byte object and corrupted the stack — the symptom was
     every COSE accept case failing with "could not build the signed fixture". */
  size_t DerCapacity = 0;
  if (EVP_PKEY_sign (Ctx, NULL, &DerCapacity, Digest, DigestSize) != 1 || DerCapacity == 0) {
    EVP_PKEY_CTX_free (Ctx);
    return FALSE;
  }

  DerLen = (int)DerCapacity;

  Der = malloc ((size_t)DerLen);
  if (Der == NULL) {
    EVP_PKEY_CTX_free (Ctx);
    return FALSE;
  }

  size_t Wrote = (size_t)DerLen;
  if (EVP_PKEY_sign (Ctx, Der, &Wrote, Digest, DigestSize) != 1) {
    free (Der);
    EVP_PKEY_CTX_free (Ctx);
    return FALSE;
  }

  EVP_PKEY_CTX_free (Ctx);

  Cursor = Der;
  Sig    = d2i_ECDSA_SIG (NULL, &Cursor, (long)Wrote);
  free (Der);
  if (Sig == NULL) {
    return FALSE;
  }

  HalfSize = (UINTN)((EVP_PKEY_get_bits ((EVP_PKEY *)Key) + 7) / 8);
  ECDSA_SIG_get0 (Sig, &R, &S);
  ZeroMem (Signature, HalfSize * 2);
  BN_bn2binpad (R, Signature, (int)HalfSize);
  BN_bn2binpad (S, Signature + HalfSize, (int)HalfSize);
  ECDSA_SIG_free (Sig);
  return TRUE;
}

/* ============================================================================
   X.509 chain verification
   ============================================================================
   Mirrors EDK II's X509VerifyCertChain contract closely enough for the host tests: the chain is
   a concatenation of DER certificates; cert[0] must be issued by the next certificate, walking
   up to a certificate issued by RootCert, and every certificate must be within its validity
   period.

   Deliberately NOT implemented, because EDK II does not implement them either and a host
   verifier that is stricter than production would reject chains the firmware accepts:
   revocation (CRL/OCSP), name constraints, and policy mapping.
   ============================================================================ */

static X509 *
NextCert (CONST UINT8 **Cursor, CONST UINT8 *End)
{
  X509 *Cert;

  if (*Cursor >= End) {
    return NULL;
  }

  Cert = d2i_X509 (NULL, Cursor, (long)(End - *Cursor));
  return Cert;
}

BOOLEAN
EFIAPI
X509VerifyCertChain (
  IN CONST UINT8  *RootCert,
  IN UINTN         RootCertLength,
  IN CONST UINT8  *CertChain,
  IN UINTN         CertChainLength
  )
{
  CONST UINT8 *RootCursor;
  CONST UINT8 *Cursor;
  CONST UINT8 *End;
  X509        *Root;
  X509        *Cert;
  X509        *Issuer;
  EVP_PKEY    *IssuerKey;
  BOOLEAN      Ok = TRUE;

  if (RootCert == NULL || CertChain == NULL || RootCertLength == 0 || CertChainLength == 0) {
    return FALSE;
  }

  RootCursor = RootCert;
  Root       = d2i_X509 (NULL, &RootCursor, (long)RootCertLength);
  if (Root == NULL) {
    return FALSE;
  }

  Cursor = CertChain;
  End    = CertChain + CertChainLength;
  Cert   = NextCert (&Cursor, End);
  if (Cert == NULL) {
    X509_free (Root);
    return FALSE;
  }

  while (Ok && Cert != NULL) {
    /* The issuer of the current certificate is the next one in the chain, or the root at the
       top. Peeking rather than consuming keeps the loop symmetric. */
    CONST UINT8 *Peek = Cursor;
    Issuer = (Peek < End) ? NextCert (&Peek, End) : NULL;
    if (Issuer == NULL) {
      Issuer = Root;
    }

    /* Validity period for the certificate being verified. */
    if (X509_cmp_current_time (X509_get0_notBefore (Cert)) >= 0 ||
        X509_cmp_current_time (X509_get0_notAfter (Cert)) <= 0) {
      Ok = FALSE;
    }

    if (Ok) {
      IssuerKey = X509_get_pubkey (Issuer);
      if (IssuerKey == NULL) {
        Ok = FALSE;
      } else {
        Ok = (BOOLEAN)(X509_verify (Cert, IssuerKey) == 1);
        EVP_PKEY_free (IssuerKey);
      }
    }

    /* Advance: the "issuer" becomes the current certificate, unless it was the root. */
    X509_free (Cert);
    if (Peek >= End) {
      Cert = NULL;
    } else {
      Cursor = Peek - (long)((End - Cursor) - (End - Peek)); /* consume exactly one cert */
      Cert   = NextCert (&Cursor, End);
    }
  }

  X509_free (Root);
  return Ok;
}
