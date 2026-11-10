/** @file
  TlsVerify.c — TLS trust anchor installation (C3 §4).

  Implements PblInstallTlsCaCertificate: replaces the platform
  `TlsCaCertificate` store with the CA certificate carried in the signed policy
  (C4 key 78) immediately before the verdict fetch.

  This file used to also contain PblTlsVerifyCert, a 223-line pin+hostname
  verifier that nothing ever called. It was removed in S265: the pin it compared
  was a SHA-256, and no EDK II API accepts a hash as a chain anchor, so it could
  never have been wired in. Chain validation is EFI_TLS_VERIFY_PEER against the
  store installed below; hostname binding is HttpDxe's job. Keeping an uncalled
  security function invites a future reader to believe it enforces something
  (tracked as the D-116 cleanliness item).

  C3 §4 requirements this function serves:
    - Certificate pinning: lock-service CA pinned in C4 (key 73 pin, key 78 DER)
    - Do NOT trust the platform TlsCaCertificate store alone — it is rebuilt
      from the policy on every boot, so an OS-level attacker cannot leave a CA
      there that PBL would trust.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"
#include <Guid/ImageAuthentication.h>
#include <Guid/TlsAuthentication.h>

/** D-132: install the policy-pinned CA as the platform TLS trust anchor.

  Why this exists
  ---------------
  EDK2's HTTP client cannot be told to skip chain validation: HttpDxe hard-codes
  VerifyMethod = EFI_TLS_VERIFY_PEER (NetworkPkg/HttpDxe/HttpsSupport.c:660) and
  validates the server chain against DER certificates in the platform
  `TlsCaCertificate` variable. When that variable is absent HttpDxe deliberately
  continues and the handshake fails later, which is what a packet capture showed
  as SYN/SYN-ACK/ACK/RST with no request ever sent.

  C4 gave PBL only a SHA-256 pin (key 73), and no DER-accepting API takes a hash,
  so the pin could never satisfy that check — PblTlsVerifyCert was consequently
  never called. C4 key 78 now carries the CA certificate itself, and this
  function makes that certificate the *only* entry in the platform store
  immediately before the fetch.

  That last point is what keeps C3 §4.1's threat model intact: the store is
  rebuilt from the policy on every boot, so a T2 attacker who has admin on the OS
  and could write `TlsCaCertificate` cannot leave a CA in place that PBL would
  trust — it is overwritten before the request.

  @param[in] CertDer      DER-encoded CA certificate (C4 key 78).
  @param[in] CertDerSize  Size of CertDer in bytes.

  @retval EFI_SUCCESS            Store replaced with exactly this certificate.
  @retval EFI_INVALID_PARAMETER  CertDer is NULL or empty.
  @retval others                 SetVariable failed (e.g. out of NV space).
**/
EFI_STATUS
PblInstallTlsCaCertificate (
  IN CONST UINT8  *CertDer,
  IN UINTN         CertDerSize
  )
{
  EFI_SIGNATURE_LIST *CertList;
  EFI_SIGNATURE_DATA *CertData;
  UINTN               EntrySize;
  UINTN               ListSize;
  EFI_STATUS          Status;

  if (CertDer == NULL || CertDerSize == 0) {
    return EFI_INVALID_PARAMETER;
  }

  // EFI_SIGNATURE_LIST with exactly one EFI_SIGNATURE_DATA entry of type
  // EFI_CERT_X509_GUID. SignatureSize covers the owner GUID plus the DER body;
  // SignatureHeaderSize is 0 for X509 lists (the header is used by SHA-256 lists).
  EntrySize = sizeof (EFI_GUID) + CertDerSize;
  ListSize  = sizeof (EFI_SIGNATURE_LIST) + EntrySize;

  CertList = AllocateZeroPool (ListSize);
  if (CertList == NULL) {
    return EFI_OUT_OF_RESOURCES;
  }

  CopyMem (&CertList->SignatureType, &gEfiCertX509Guid, sizeof (EFI_GUID));
  CertList->SignatureListSize   = (UINT32)ListSize;
  CertList->SignatureHeaderSize = 0;
  CertList->SignatureSize       = (UINT32)EntrySize;

  CertData = (EFI_SIGNATURE_DATA *)((UINT8 *)CertList + sizeof (EFI_SIGNATURE_LIST));
  CopyMem (&CertData->SignatureOwner, &gEfiCallerIdGuid, sizeof (EFI_GUID));
  CopyMem (CertData->SignatureData, CertDer, CertDerSize);

  // SetVariable replaces an existing variable of the same name outright, which
  // is the "reset to exactly the pin" behaviour this depends on.
  Status = gRT->SetVariable (
                  EFI_TLS_CA_CERTIFICATE_VARIABLE,
                  &gEfiTlsCaCertificateGuid,
                  EFI_VARIABLE_NON_VOLATILE |
                  EFI_VARIABLE_BOOTSERVICE_ACCESS |
                  EFI_VARIABLE_RUNTIME_ACCESS,
                  ListSize,
                  CertList
                  );

  FreePool (CertList);
  return Status;
}
