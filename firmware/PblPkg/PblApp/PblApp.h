/** @file
  PblApp.h — Central header for the Pre-Boot Lock UEFI application.

  This file defines the types, constants, and function prototypes that map
  directly to the frozen contracts C1–C4:
    - C1 (LockVerdict):   docs/adr/PBL-C1-LockVerdict.md
    - C2 (TPM contract):  docs/adr/PBL-C2-TPM-Contract.md
    - C3 (Network client): docs/adr/PBL-C3-Network-Client.md
    - C4 (Policy blob):   docs/adr/PBL-C4-Policy-Blob.md

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#ifndef PBL_APP_H_
#define PBL_APP_H_

#include <Uefi.h>
#include <Library/BaseLib.h>
#include <Library/BaseMemoryLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/DebugLib.h>
#include <Library/PrintLib.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Library/UefiLib.h>
#include <Library/UefiRuntimeServicesTableLib.h>
#include <Library/DevicePathLib.h>
#include <Library/BaseCryptLib.h>
#include <Library/IoLib.h>
#include <Guid/GlobalVariable.h>
#include <IndustryStandard/Acpi20.h>
#include <Guid/FileInfo.h>
#include <Protocol/SimpleFileSystem.h>
#include <Protocol/Tcg2Protocol.h>
#include <Protocol/Smbios.h>
#include <Protocol/Rng.h>
#include <Guid/Rng.h>
#include <Protocol/SimpleTextOut.h>
#include <Protocol/SimpleTextInEx.h>
#include <Protocol/DevicePath.h>
#include <Protocol/Http.h>
#include <Protocol/ServiceBinding.h>
#include <Protocol/SimpleNetwork.h>
#include <Protocol/Tcp4.h>
#include <Protocol/Ip4.h>
#include <Protocol/ManagedNetwork.h>
#include <Protocol/Tls.h>
#include <Protocol/TlsConfig.h>

// ============================================================================
// Constants (from contracts)
// ============================================================================

// C2 §1: NV index base (default 0x01C00000, overridable via PCD)
#define PBL_NV_LOCK_STATE      (FixedPcdGet32(PcdNvIndexBase) + 0x01)  // 0x01C00001
#define PBL_NV_POLICY_VERSION  (FixedPcdGet32(PcdNvIndexBase) + 0x02)  // 0x01C00002
#define PBL_NV_AK_NAME         (FixedPcdGet32(PcdNvIndexBase) + 0x03)  // 0x01C00003

// C2 §1.1: Lock state cache structure (64 bytes)
#define PBL_LOCK_STATE_SIZE    64
#define PBL_LOCK_STATE_MAGIC   0x50  // 'P'

// C1 §2 + C5: Verdict values
#define PBL_VERDICT_UNLOCKED     0
#define PBL_VERDICT_LOCKED       1
#define PBL_VERDICT_WIPE_PENDING 2
#define PBL_VERDICT_TRACKING     3  // C5: Covert tracking — boot normally, agent reports location

// C1 §2: Wire format version
#define PBL_VERDICT_VERSION    1

// PBL firmware version (from PCD)
#define PBL_VERSION  FixedPcdGet32(PcdPblVersion)

// C1 §2.2: Max verdict size (COSE_Sign1)
#define PBL_MAX_VERDICT_SIZE   512

// C4 §1.1: Max policy blob size
#define PBL_MAX_POLICY_SIZE    FixedPcdGet32(PcdMaxPolicySize)

// C3 §8: Max response body size
#define PBL_MAX_RESPONSE_SIZE  FixedPcdGet32(PcdMaxResponseSize)

// C2 §3: TPM session attributes
#define PBL_TPM_SESSION_ATTRS  (TPMA_SESSION_CONTINUESESSION | TPMA_SESSION_DECRYPT | TPMA_SESSION_ENCRYPT)

// C2 §4: PCR indices PBL writes to
#define PBL_PCR_DECISION       12
#define PBL_PCR_INPUTS         13

// Decision results (C4 §5)
typedef enum {
  PblResultPass     = 0,
  PblResultDegraded = 1,
  PblResultBlock    = 2
} PBL_RESULT;

// ============================================================================
// C1: LockVerdict types
// ============================================================================

/** C1 §2: LockVerdict payload (parsed from COSE_Sign1). **/
typedef struct {
  UINT32  Version;          // key 1
  UINT8   DeviceId[32];     // key 2: SHA-256(AK public Area)
  UINT8   Nonce[32];        // key 3: echo of client nonce
  UINT8   Verdict;          // key 4: LOCKED|UNLOCKED|WIPE_PENDING
  UINT64  PolicyVersion;    // key 5
  UINT32  IssuedAt;         // key 6: Unix timestamp
  UINT32  GraceUntil;       // key 7: Unix timestamp
  CHAR8   Reason[128];      // key 8: human-readable reason
  BOOLEAN HasChallengeSeed; // key 9 present?
  UINT8   ChallengeSeed[16];// key 9: offline override challenge
} PBL_VERDICT;

/** C2 §1.1: Lock state cache (stored in TPM NV). **/
typedef struct {
  UINT8   Magic;            // 0x50 ('P')
  UINT8   Verdict;          // 0=UNLOCKED, 1=LOCKED, 2=WIPE_PENDING
  UINT32  IssuedAt;         // Unix timestamp (BE)
  UINT32  GraceUntil;       // Unix timestamp (BE)
  UINT8   DeviceId[32];     // SHA-256(AK public Area)
  UINT8   Reserved[20];     // padding to 64 bytes
} PBL_LOCK_STATE_CACHE;

// ============================================================================
// C4: Policy blob types (abbreviated — full parse in Policy.c)
// ============================================================================

/** C4 §2.1: Policy metadata. **/
typedef struct {
  UINT32  Version;          // key 1: monotonic
  UINT32  IssuedAt;         // key 2
  UINT32  ExpiresAt;        // key 3
  UINT32  MinPblVersion;    // key 4
} PBL_POLICY_META;

/** C4 §2.5 key 40: TPM session requirements. **/
typedef struct {
  BOOLEAN HmacRequired;
  BOOLEAN ParamEncryptRequired;
  BOOLEAN SaltedRequired;
  BOOLEAN BoundRequired;
} PBL_TPM_SESSION_REQ;

/** C4 §2.9 key 83: Override rate limit. **/
typedef struct {
  UINT32  MaxAttempts;
  UINT32  WindowSeconds;
} PBL_OVERRIDE_RATE_LIMIT;

/** C4: Full policy blob (parsed). Agent A fills this from Policy.c. **/
typedef struct {
  PBL_POLICY_META           Meta;
  // Secure Boot (REQ-01, REQ-02) — parsed on demand from raw CBOR
  // SPI (REQ-03) — parsed on demand
  // Firmware floors (REQ-04) — parsed on demand
  PBL_TPM_SESSION_REQ       TpmSessionReq;     // REQ-05
  // TPM firmware floors (REQ-06) — parsed on demand
  UINT32                    TpmFirmwareFloor;   // C4 §2.5 key 41
  UINT8                     TpmPinPolicy;       // C4 §2.5 key 42: 0=none,1=required,2=preferred
  UINT32                    NvIndexBase;        // C4 §2.5 key 43
  UINT8                     BitLockerTier;      // 0=standard, 1=high_assurance
  // Boot config (REQ-07,08,09) — parsed on demand
  // Recovery (REQ-10) — parsed on demand
  // Pins (C1/C3) — parsed on demand
  CHAR8                     LockServiceUri[256]; // C4 §2.8 key 70
  UINT8                     LockServiceCertPin[32]; // C4 key 71
  UINT8                     TlsCaPin[32];          // C4 key 73
  // D-205: Verdict signing key SPKI (full DER, not just SHA-256 fingerprint).
  // kid (LockServiceCertPin) = SHA-256 of this SPKI.
  // Pointer into RawCbor — valid as long as the policy buffer is alive.
  CONST UINT8               *VerdictSigningKeySpki; // C4 key 76
  UINTN                     VerdictSigningKeySpkiSize;
  // D-205: Verdict signing cert chain (C4 key 77) — array of DER certs.
  // The leaf cert (first element) is used with EcGetPublicKeyFromX509()
  // to obtain an EC context for EcDsaVerify. This is required because
  // BaseCryptLib has no EcSetPubKey — only EcGetPublicKeyFromX509.
  // Pointer into RawCbor — valid as long as the policy buffer is alive.
  CONST UINT8               *VerdictSigningCert;    // C4 key 77 (leaf cert)
  UINTN                     VerdictSigningCertSize;
  // D-205: Full cert chain as concatenated DER bytes (for X509VerifyCertChain).
  // Allocated by CborDecode.c (not a pointer into RawCbor — must FreePool).
  UINT8                     *VerdictSigningCertChain;  // concatenated DER
  UINTN                     VerdictSigningCertChainSize;
  CONST UINT8               *VerdictSigningRootCert;    // last cert in chain
  UINTN                     VerdictSigningRootCertSize;
  UINT32                    VerdictFreshnessSec;   // C4 key 80
  UINT32                    GracePeriodSec;        // C4 key 81
  UINT32                    WipeDeadlineSec;       // C4 key 82
  PBL_OVERRIDE_RATE_LIMIT   OverrideRateLimit;     // C4 key 83
  // RE-hardening #2: Expected SHA-256 of bootmgfw.efi (C4 key 58).
  // If present, PBL hashes bootmgfw.efi before LoadImage and compares.
  // If absent (zero), no hash check is performed (dev mode / old policy).
  UINT8                     BootMgrHash[32];       // C4 key 58
  BOOLEAN                   BootMgrHashPresent;    // TRUE if key 58 present
  // Raw CBOR for on-demand field access
  UINT8                     *RawCbor;
  UINTN                     RawCborSize;
} PBL_POLICY;

// ============================================================================
// Platform state (collected by PlatformState.c, consumed by Decision.c)
// ============================================================================

typedef struct {
  // REQ-01: Secure Boot state
  BOOLEAN   SecureBootEnabled;
  BOOLEAN   SetupMode;        // true = SetupMode=1 (insecure)
  BOOLEAN   DeployedMode;     // true = DeployedMode=1
  UINT8     PkFingerprint[32]; // SHA-256 of PK cert DER

  // REQ-02: db/dbx
  BOOLEAN   DbHasWindowsUefiCa2023;
  BOOLEAN   DbxHasMs2011Revocation;
  BOOLEAN   DbxHasBootHoleHashes;
  UINT32    BootmgrSvn;

  // REQ-03: SPI protections
  BOOLEAN   SpiProtectionsKnown;
  BOOLEAN   Bioswe;
  BOOLEAN   Ble;
  BOOLEAN   SmmBwp;
  BOOLEAN   PrrCoverBios;

  // REQ-04: Firmware version
  CHAR8     FirmwareVendor[64];
  CHAR8     FirmwareVersion[64];
  CHAR8     ProductName[64];
  BOOLEAN   AmtProvisioned;
  BOOLEAN   UsbDciEnabled;

  // D-206: SMBIOS Type 1 UUID for device identity auto-link
  UINT8     SystemUuid[16];     // SMBIOS Type 1 UUID (mixed-endian)

  // REQ-06: TPM firmware version (for floor check)
  UINT32    TpmFirmwareVersion;  // e.g., 0x00070002 = 7.2

  // REQ-07: Boot config
  BOOLEAN   S3Enabled;
  BOOLEAN   KernelDmaProtection;
  BOOLEAN   MorRequested;

  // REQ-08: Network boot
  BOOLEAN   NetworkBootEntriesPresent;

  // REQ-09: BCD / winre.wim
  UINT8     BcdHash[32];
  UINT8     WinreWimHash[32];
  BOOLEAN   BitLockerEnabled;

  // REQ-10: Recovery
  UINT8     FirmwareRecovery; // 0=dual_image, 1=intel_pfr, 2=none

  // REQ-12: PCR readings (for platform_state_digest)
  UINT8     Pcr4[32];
  UINT8     Pcr5[32];
  UINT8     Pcr7[32];
  UINT8     Pcr11[32];

  // C2 §1.3: device_id
  UINT8     DeviceId[32];     // SHA-256(AK public Area)
} PBL_PLATFORM_STATE;

// ============================================================================
// Function prototypes (one per source file)
// ============================================================================

// PblApp.c — entry point
EFI_STATUS
EFIAPI
PblAppEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  );

// PlatformState.c — REQ-01,02,04,07,08,09,10 collection
EFI_STATUS
PblCollectPlatformState (
  OUT PBL_PLATFORM_STATE  *State
  );

// SpiProtections.c — REQ-03
EFI_STATUS
PblCheckSpiProtections (
  OUT PBL_PLATFORM_STATE  *State
  );

// Policy.c — C4 parse + sig verify + anti-rollback (REQ-11)
EFI_STATUS
PblParsePolicy (
  IN  CONST UINT8   *CoseData,
  IN  UINTN          CoseSize,
  OUT PBL_POLICY    *Policy
  );

EFI_STATUS
PblVerifyPolicySignature (
  IN CONST PBL_POLICY  *Policy,
  IN CONST UINT8       *CoseData,
  IN UINTN              CoseSize
  );

// Svn.c — REQ-02
EFI_STATUS
PblReadBootmgrSvn (
  OUT UINT32  *Svn
  );

// AmtCheck.c — REQ-04
EFI_STATUS
PblCheckAmt (
  OUT BOOLEAN  *Provisioned
  );

// DciCheck.c — REQ-04
EFI_STATUS
PblCheckDci (
  OUT BOOLEAN  *Enabled
  );

// DmaProtection.c — REQ-07
EFI_STATUS
PblCheckDmaProtection (
  OUT BOOLEAN  *Enabled
  );

// Mor.c — REQ-07
EFI_STATUS
PblRequestMor (
  VOID
  );

// TpmClient.c — C2 (REQ-05,06,11,12,13)
EFI_STATUS
PblTpmProvisionNvIndices (
  VOID
  );

EFI_STATUS
PblTpmReadLockState (
  OUT PBL_LOCK_STATE_CACHE  *Cache
  );

EFI_STATUS
PblTpmWriteLockState (
  IN CONST PBL_LOCK_STATE_CACHE  *Cache
  );

EFI_STATUS
PblTpmReadPolicyVersion (
  OUT UINT64  *Version
  );

EFI_STATUS
PblTpmIncrementPolicyVersion (
  VOID
  );

EFI_STATUS
PblTpmReadAkName (
  OUT UINT8  *AkName,  // 34 bytes
  IN  UINTN   AkNameSize
  );

EFI_STATUS
PblTpmExtendPcr (
  IN UINT8          PcrIndex,
  IN CONST UINT8   *Data,
  IN UINTN          DataSize
  );

EFI_STATUS
PblTpmReadPcr (
  IN  UINT8   PcrIndex,
  OUT UINT8   *PcrValue,  // 32 bytes
  IN  UINTN   PcrValueSize
  );

EFI_STATUS
PblTpmFlushContext (
  IN  VOID  *SessionHandle
  );

// TpmClient.c — D-118: TPM2_GetRandom fallback
EFI_STATUS
PblTpmGetRandom (
  OUT UINT8  *Buffer,
  IN  UINTN   Size
  );

// TpmClient.c — D-111: TPM firmware version for floor check (step 10)
EFI_STATUS
PblTpmGetFirmwareVersion (
  OUT UINT32  *Version
  );

// TpmClient.c — D-102: HMAC session with AES-256-CFB (C2 §3)
// Helper functions exported from TpmClient.c for TpmSession.c
EFI_TCG2_PROTOCOL *
PblTcg2Locate (
  VOID
  );

EFI_STATUS
PblTpmSubmitCommand (
  IN  EFI_TCG2_PROTOCOL *Tcg2,
  IN  UINT8             *Command,
  IN  UINT32            CommandSize,
  OUT UINT8             *Response,
  IN  UINT32            ResponseSize,
  OUT UINT32            *ActualResponseSize
  );

UINT8 *
PblTpmBeginCommand (
  OUT UINT8  *Buffer,
  IN  UINT32  BufferSize,
  IN  TPM_CC  CommandCode
  );

VOID
PblTpmFinalizeCommand (
  IN OUT UINT8 *CommandBuffer,
  IN     UINT32 TotalSize
  );

// TpmSession.c — D-102: HMAC session with AES-256-CFB (C2 §3)
EFI_STATUS
PblTpmStartHmacSession (
  IN  UINT32        BindHandle,
  IN  CONST UINT8  *BindAuth,
  IN  UINTN         BindAuthSize
  );

UINT32
PblTpmGetSessionHandle (
  VOID
  );

BOOLEAN
PblTpmIsSessionActive (
  VOID
  );

EFI_STATUS
PblTpmRefreshNonce (
  VOID
  );

CONST UINT8 *
PblTpmGetNonceCaller (
  VOID
  );

EFI_STATUS
PblTpmEncryptCommandParams (
  IN OUT UINT8  *Data,
  IN     UINTN  DataSize
  );

EFI_STATUS
PblTpmDecryptResponseParams (
  IN OUT UINT8  *Data,
  IN     UINTN  DataSize
  );

EFI_STATUS
PblTpmComputeCommandHmac (
  IN  CONST UINT8  *CommandBuffer,
  IN  UINTN         CommandSize,
  OUT UINT8        *Hmac
  );

// ============================================================================
// D-102: HMAC session state (TpmSession.c)
// ============================================================================

/** PBL HMAC session state. */
typedef struct {
  UINT32   SessionHandle;     // TPM handle returned by StartAuthSession
  UINT8    SessionKey[32];    // AES-256-CFB + HMAC key (empty when unbound)
  UINT8    SessionKeySize;    // Size of session key (0 when bind=NULL + no salt)
  UINT8    NonceCaller[32];   // Our nonce (from EFI_RNG)
  UINT8    NonceTpm[32];      // TPM's nonce (from StartAuthSession response)
  UINT32   BindHandle;        // The NV index this session is bound to
  BOOLEAN  Active;            // TRUE if session is established
} PBL_TPM_SESSION;

// D-206: Compute per-command session attributes (continueSession + decrypt/encrypt)
UINT8
PblTpmSessionAttrsForCommand (
  IN  TPM_CC  CommandCode
  );

// D-206: Cache NV index name after provisioning (for cpHash computation)
VOID
PblTpmCacheNvName (
  IN UINT32  NvIndex,
  IN UINT32  Attributes,
  IN UINT16  DataSize
  );

// D-206: Get session key size (0 for unbound sessions — no KDFa)
UINT8
PblTpmGetSessionKeySize (
  VOID
  );

// Session-parameterized HMAC helpers (internal — used by TpmClient.c for PCR session)
EFI_STATUS
PblTpmComputeCommandHmacSession (
  IN  PBL_TPM_SESSION  *Session,
  IN  UINT32            CommandCode,
  IN  CONST UINT8      *Params,
  IN  UINTN             ParamsSize,
  OUT UINT8            *Hmac
  );

EFI_STATUS
PblTpmVerifyResponseHmacSession (
  IN  PBL_TPM_SESSION  *Session,
  IN  UINT32            CommandCode,
  IN  CONST UINT8      *ResponseBuffer,
  IN  UINTN             ResponseSize,
  IN  CONST UINT8      *ResponseHmac
  );

// D-102: PCR session nonce refresh (parallel to PblTpmRefreshNonce for mSession)
EFI_STATUS
PblTpmRefreshPcrNonce (
  VOID
  );

CONST UINT8 *
PblTpmGetPcrNonceCaller (
  VOID
  );

// D-102: Update nonceTPM from response auth area (after HMAC verification)
EFI_STATUS
PblTpmUpdateNonceTpm (
  IN  CONST UINT8  *NewNonceTpm,
  IN  UINTN         NonceSize
  );

EFI_STATUS
PblTpmUpdatePcrNonceTpm (
  IN  CONST UINT8  *NewNonceTpm,
  IN  UINTN         NonceSize
  );

EFI_STATUS
PblTpmComputeCommandHmacEx (
  IN  UINT32        CommandCode,
  IN  CONST UINT8  *Params,
  IN  UINTN         ParamsSize,
  OUT UINT8        *Hmac
  );

EFI_STATUS
PblTpmVerifyResponseHmac (
  IN  CONST UINT8  *ResponseBuffer,
  IN  UINTN         ResponseSize,
  IN  CONST UINT8  *ResponseHmac
  );

EFI_STATUS
PblTpmVerifyResponseHmacEx (
  IN  UINT32        CommandCode,
  IN  CONST UINT8  *ResponseBuffer,
  IN  UINTN         ResponseSize,
  IN  CONST UINT8  *ResponseHmac
  );

EFI_STATUS
PblTpmFlushSession (
  VOID
  );

// D-102: PCR session (bound to TPM_RH_NULL, C2 §3.3)
EFI_STATUS
PblTpmStartPcrSession (
  VOID
  );

BOOLEAN
PblTpmIsPcrSessionActive (
  VOID
  );

UINT32
PblTpmGetPcrSessionHandle (
  VOID
  );

PBL_TPM_SESSION *
PblTpmGetPcrSession (
  VOID
  );

EFI_STATUS
PblTpmFlushPcrSession (
  VOID
  );

// TcgLog.c — REQ-12
EFI_STATUS
PblParseTcgLog (
  OUT UINT8  *Pcr4,
  OUT UINT8  *Pcr5,
  OUT UINT8  *Pcr7,
  OUT UINT8  *Pcr11
  );

EFI_STATUS
PblLogExtendEvent (
  IN UINT8          PcrIndex,
  IN UINT32         EventType,
  IN CONST UINT8   *EventData,
  IN UINTN          EventDataSize,
  IN CONST UINT8   *HashData,
  IN UINTN          HashDataSize
  );

// HttpsClient.c — C3
EFI_STATUS
PblParseUriHostname (
  IN  CONST CHAR8   *Uri,
  OUT CHAR8         *Hostname,
  IN  UINTN          HostnameSize
  );

EFI_STATUS
EFIAPI
PblHttpsPost (
  IN  CONST CHAR8   *Uri,
  IN  CONST UINT8   *Body,
  IN  UINTN          BodyLen,
  IN  CONST UINT8   *TlsCaPin,       // 32-byte SHA-256 of CA cert (C4 key 73)
  IN  CONST CHAR8   *ExpectedHostname, // for TLS hostname verification
  OUT UINT8        **Resp,
  OUT UINTN         *RespLen
  );

// TlsVerify.c — C3 §4
EFI_STATUS
PblTlsVerifyCert (
  IN CONST UINT8  *CertDer,
  IN UINTN         CertDerSize,
  IN CONST UINT8  *CaPin,     // 32-byte SHA-256
  IN CONST CHAR8  *ExpectedHostname
  );

// CborEncode.c — C3 §3.2 (request body)
EFI_STATUS
PblCborEncodeVerdictRequest (
  IN CONST UINT8  *DeviceId,       // 32 bytes
  IN CONST UINT8  *Nonce,          // 32 bytes
  IN CONST UINT8  *PlatformStateDigest, // 32 bytes
  IN UINT64        PolicyVersion,
  OUT UINT8       **Output,
  OUT UINTN        *OutputSize
  );

// CborDecode.c — C1/C4 (COSE_Sign1 + CBOR map parsing)
EFI_STATUS
PblCborDecodeVerdict (
  IN  CONST UINT8   *CoseData,
  IN  UINTN          CoseSize,
  OUT PBL_VERDICT   *Verdict
  );

EFI_STATUS
PblCborDecodePolicy (
  IN  CONST UINT8   *CoseData,
  IN  UINTN          CoseSize,
  OUT PBL_POLICY    *Policy
  );

// CborDecode.c — COSE_Sign1 extraction for signature verification (D-109/D-110)
EFI_STATUS
PblCoseExtractAll (
  IN  CONST UINT8 *CoseData,
  IN  UINTN        CoseSize,
  OUT CONST UINT8 **ProtectedHdr,
  OUT UINTN       *ProtectedSize,
  OUT CONST UINT8 **Payload,
  OUT UINTN       *PayloadSize,
  OUT CONST UINT8 **Signature,
  OUT UINTN       *SignatureSize
  );

EFI_STATUS
PblCoseParseProtectedHeader (
  IN  CONST UINT8 *ProtectedHdr,
  IN  UINTN        ProtectedSize,
  OUT INT64       *AlgId,
  OUT CONST UINT8 **Kid,
  OUT UINTN       *KidSize
  );

// CoseVerify.c — COSE_Sign1 signature verification (D-109/D-110/D-205)
EFI_STATUS
PblVerifyCertChain (
  IN CONST UINT8  *RootCert,
  IN UINTN         RootCertSize,
  IN CONST UINT8  *CertChain,
  IN UINTN         CertChainSize
  );

EFI_STATUS
PblVerifyCoseSign1 (
  IN CONST UINT8  *CoseData,
  IN UINTN         CoseSize,
  IN CONST UINT8   *SigningCertDer,    // X.509 leaf cert DER (from policy key 77)
  IN UINTN          SigningCertDerSize,
  IN CONST UINT8   *ExpectedKid,       // 32-byte SHA-256 of SPKI (from policy key 71)
  IN UINTN          ExpectedKidSize
  );

// PolicyRootOfTrust.c — Policy signing key root of trust (D-205)
BOOLEAN
PblPolicySigningKeyIsProvisioned (
  VOID
  );

CONST UINT8 *
PblGetPolicySigningKeySpki (
  OUT UINTN  *SpkiSize
  );

CONST UINT8 *
PblGetPolicySigningKeyKid (
  VOID
  );

CONST UINT8 *
PblGetPolicySigningKeyCert (
  OUT UINTN  *CertSize
  );

// Verdict.c — C1 §7 (9-step verification)
EFI_STATUS
PblVerifyVerdict (
  IN  CONST PBL_VERDICT       *Verdict,
  IN  CONST UINT8             *SelfNonce,     // 32 bytes
  IN  CONST UINT8             *SelfDeviceId,  // 32 bytes
  IN  UINT64                   SelfNvCounter,
  IN  CONST PBL_POLICY        *Policy
  );

// Decision.c — C4 §5 (18-step evaluation)
PBL_RESULT
PblEvaluateDecision (
  IN CONST PBL_PLATFORM_STATE  *State,
  IN CONST PBL_POLICY          *Policy,
  IN CONST PBL_VERDICT         *Verdict
  );

// LockScreen.c — REQ-14 UI
EFI_STATUS
PblShowLockScreen (
  IN CONST PBL_VERDICT  *Verdict,
  IN CONST CHAR8        *ContactInfo
  );

EFI_STATUS
PblShowDegradedNotice (
  IN CONST CHAR8  *Reason,
  IN UINT8         DisplaySeconds
  );

// Override.c — REQ-14 offline challenge/response
EFI_STATUS
PblHandleOverride (
  IN  CONST PBL_VERDICT  *Verdict,
  OUT BOOLEAN            *OverrideGranted
  );

// ChainLoad.c — load bootmgfw.efi
EFI_STATUS
PblChainLoadWindows (
  IN EFI_HANDLE         ImageHandle,
  IN CONST PBL_POLICY   *Policy
  );

// Sbat.c — SBAT section
EFI_STATUS
PblGetSbatVersion (
  OUT UINT32  *SbatVersion
  );

#endif // PBL_APP_H_
