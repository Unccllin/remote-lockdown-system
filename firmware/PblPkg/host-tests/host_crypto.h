/** @file
  Test-only crypto helpers for the COSE suite (D-224).

  These are the signing side of `PblVerifyCoseSign1`. They exist so the test can produce a real
  ES256 signature over a real CBOR payload with a throwaway key — the firmware itself never
  signs, so without these the accept path of COSE verification would be untestable and only the
  reject paths could be exercised.

  Implemented in host_crypto.c, which also provides the EDK II BaseCryptLib subset the firmware
  modules call. Kept in their own header so a reader can see at a glance which symbols are
  harness scaffolding rather than firmware contract.
**/

#ifndef PBL_HOST_CRYPTO_HELPERS_H
#define PBL_HOST_CRYPTO_HELPERS_H

#include "PblApp.h"

/** Load a PEM EC private key and return the kid the firmware will look for:
    SHA-256 of the key's SubjectPublicKeyInfo DER (C1 §5).

    @param KeyPemPath  Path to a PEM private key.
    @param KeyOut      Receives an opaque key handle for HostCryptoSignEs256/FreeKey.
    @param SpkiDigest  Receives the 32-byte SHA-256 SPKI digest. **/
BOOLEAN
HostCryptoLoadSigningKey (
  IN  CONST CHAR8  *KeyPemPath,
  OUT VOID        **KeyOut,
  OUT UINT8        *SpkiDigest
  );

VOID
HostCryptoFreeKey (
  IN VOID  *Key
  );

/** Sign a SHA-256 digest and emit the RAW r||s signature (64 bytes for P-256), which is the
    form `EcDsaVerify` — and therefore `PblVerifyCoseSign1` — consumes. **/
BOOLEAN
HostCryptoSignEs256 (
  IN  VOID         *Key,
  IN  CONST UINT8  *Digest,
  IN  UINTN         DigestSize,
  OUT UINT8        *Signature
  );

#endif /* PBL_HOST_CRYPTO_HELPERS_H */
