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
#include <Protocol/LoadedImage.h>
#include <Protocol/Http.h>
#include <Protocol/ServiceBinding.h>
#include <Protocol/SimpleNetwork.h>
#include <Protocol/Tcp4.h>
#include <Protocol/Ip4.h>
#include <Protocol/Ip4Config2.h>
#include <Protocol/Dhcp4.h>
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

// NG-T5: max osloader osdevice blobs captured per store (multi-boot).
// Defined early — PBL_PLATFORM_STATE sizes its osdevice arrays by it.
#define PBL_MAX_OSDEVICE       8

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
  // NG-T4/B-004: TRUE only if PblBootmgrSvn carried TIME_BASED_AUTHENTICATED
  // attributes. PBL's own writes are unauthenticated → advisory telemetry.
  BOOLEAN   BootmgrSvnTrusted;

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

  // S1.1: TPM reset-counter boot-ID (TPM2_ReadClock → TPMS_TIME_INFO).
  // BootId = resetCount: increments on every TPM reset (cold boot /
  // TPM2_Startup CLEAR), unreadable/rollback-proof from the OS — the
  // hardware anchor the server uses to correlate a PBL boot with an agent
  // check-in. RestartCount covers TPM_SU_STATE resumes and is the S1.4
  // resume-detection signal (a wake with no resetCount bump but a
  // restartCount bump = S3 resume, PBL may not have run). ClockSafe
  // reports TPMS_CLOCK_INFO.safe (clock reliability).
  UINT32    BootId;          // TPMS_CLOCK_INFO.resetCount  (cold-boot ID)
  UINT32    TpmRestartCount; // TPMS_CLOCK_INFO.restartCount (resume count)
  BOOLEAN   TpmClockSafe;    // TPMS_CLOCK_INFO.safe (TPMI_YES_NO)

  // REQ-07: Boot config
  BOOLEAN   S3Enabled;
  BOOLEAN   KernelDmaProtection;
  BOOLEAN   MorRequested;

  // REQ-08: Network boot
  BOOLEAN   NetworkBootEntriesPresent;

  // REQ-08b: boot-path classification (S0.5, B-010/B-017).
  // Boot#### loaders are classified by file path; BootNext is read and
  // its target classified; ESP volumes are scanned for *shell*.efi.
  // All presence data feeds the platform-state digest — a planted shell
  // or one-shot BootNext override changes the measurement.
  UINT16    BootNextOption;    // Boot#### number BootNext targets; 0xFFFF if unset
  UINT16    ShellEntryMask;    // bitmask of first-16 BootOrder positions with *shell* loaders
  UINT8     BootPathFlags;     // PBL_BPF_* bitmask

  // REQ-09: BCD / winre.wim
  UINT8     BcdHash[32];
  UINT8     WinreWimHash[32];
  BOOLEAN   BitLockerEnabled;   // FVE-FS volume detected (D-120)
  // D-120: FVE metadata inspection — the authoritative BitLocker signal
  // (BCD only carries boot config; lock state lives in FVE metadata).
  UINT16    FveEncryptionMethod;  // metadata header @36 (0x8000..0x8005), 0 if absent
  UINT16    FveProtectionMask;    // bitmask of VMK protection types present
  UINT8     FveMetadataVersion;   // block header version (1=Vista, 2=Win7+)
  BOOLEAN   FveClearKeyOnly;      // every VMK entry is clear-key (auto-unlock)
  // D-120 residual: boot-volume binding. An FVE-FS volume only proves the
  // OS volume is encrypted when it lives on the same physical disk PBL
  // booted from (device-path prefix match up to the first MEDIA node —
  // the transport/messaging nodes identify the disk).
  UINT8     FveVolumeCount;       // FVE-FS volumes found on any disk
  BOOLEAN   FveOnBootDisk;        // an FVE volume shares PBL's boot disk
  BOOLEAN   FveBootDiskKnown;     // boot-disk prefix resolved (binding evaluated)

  // NG-T5: partition-level FVE binding. Decoded from the osloader object's
  // `osdevice` device-blob (BCD element 0x21000001, packet type 6). The
  // partition identity (GPT partition GUID, or MBR signature+byte-offset)
  // is compared against each FVE volume's HD() device-path node — "this FVE
  // volume IS the Windows boot partition", stronger than disk-level. We
  // capture up to PBL_MAX_OSDEVICE osloader blobs (multi-boot stores have
  // several) and bind on any-match: an osloader pointing at the FVE
  // partition proves it is a real Windows boot target.
  UINT8     BcdOsDeviceTableType[PBL_MAX_OSDEVICE];  // 0=GPT,1=MBR,0xFF=none
  UINT8     BcdOsDevicePartId[PBL_MAX_OSDEVICE][16]; // GPT:partGUID/MBR:u64 off
  UINT8     BcdOsDeviceDiskId[PBL_MAX_OSDEVICE][16]; // GPT:diskGUID/MBR:u32 sig
  UINT8     BcdOsDeviceCount;      // osloader osdevice blobs decoded
  BOOLEAN   FveOnBootPartition;    // an FVE volume matches an osdevice partition

  // REQ-09: BCD element parsing (D-120)
  // These are deterministic summaries of the BCD store that feed the
  // platform-state digest. 0xFF means "not present / unknown" for the
  // UINT8 fields. Booleans default to FALSE.
  UINT32    BcdObjectCount;           // Number of BCD objects enumerated
  UINT32    BcdDisplayOrderCount;     // Non-empty GUIDs in DisplayOrder (24000001)
  UINT32    BcdRecoverySequenceCount; // Non-empty GUIDs in RecoverySequence (24000010)
  UINT32    BcdInheritCount;          // Non-empty GUIDs in Inherit lists (14000006)
  UINT8     BcdTimeout;               // Display boot menu timeout (25000004), 0xFF=absent
  BOOLEAN   BcdNoIntegrityChecks;     // Element 16000048
  BOOLEAN   BcdTestSigning;           // Element 16000049
  BOOLEAN   BcdBootDebug;             // Element 16000010
  BOOLEAN   BcdDebug;                 // Element 260000A0
  BOOLEAN   BcdWinPEMode;             // Element 26000022
  BOOLEAN   BcdSafeMode;              // Element 26000081
  BOOLEAN   BcdDetectHal;             // Element 26000010 (same object as BootDebug? no, different IDs; 26000010 is DetectHal, 16000010 is BootDebug)
  BOOLEAN   BcdDisplayAdvancedOptions; // Element 16000040
  BOOLEAN   BcdOptionsEdit;           // Element 16000050
  BOOLEAN   BcdEmsEnabled;            // Element 16000020
  UINT8     BcdBootMenuPolicy;        // Element 250000C2, 0xFF=absent
  UINT8     BcdHypervisorLaunchType;  // Element 250000F0, 0xFF=absent
  UINT8     BcdHypervisorDebugEnabled; // Element 250000F3, 0xFF=absent
  UINT8     BcdHypervisorDebugType;   // Element 250000F4, 0xFF=absent

  // REQ-10: Recovery
  UINT8     FirmwareRecovery; // 0=dual_image, 1=intel_pfr, 2=none

  // REQ-12: PCR readings (for platform_state_digest)
  UINT8     Pcr4[32];
  UINT8     Pcr5[32];
  UINT8     Pcr7[32];
  UINT8     Pcr11[32];

  // RE-hardening #3: Loaded EFI image count (bootkit detection).
  // PBL enumerates all loaded EFI images via gEfiLoadedImageProtocolGuid.
  // If the count exceeds an expected baseline, a bootkit may have installed
  // itself as a DXE driver before PBL ran. The count is included in the
  // platform_state_digest so the server can flag anomalies.
  UINT32    LoadedImageCount;
  // D-213: Aggregate hash identifying WHICH images are loaded — SHA-256 over
  // the sorted set of per-image hashes, where each per-image hash covers
  // DevicePath(image->DeviceHandle) || image->FilePath. Sorting makes the
  // digest independent of LocateHandleBuffer enumeration order; the count
  // alone could not distinguish a changed image set from a baseline shift.
  UINT8     LoadedImageDigest[32];

  // C2 §1.3: device_id
  UINT8     DeviceId[32];     // SHA-256(AK public Area)
} PBL_PLATFORM_STATE;

// BootPathFlags bitmask (PBL_PLATFORM_STATE.BootPathFlags)
#define PBL_BPF_SHELL_IN_BOOT_ENTRY  0x01  // a Boot#### loader path is *shell*.efi
#define PBL_BPF_BOOTNEXT_SET         0x02  // BootNext variable present (one-shot override)
#define PBL_BPF_SHELL_AS_BOOTNEXT    0x04  // BootNext target's loader is a shell
#define PBL_BPF_SHELL_ON_ESP         0x08  // *shell*.efi file found on an ESP volume

// NG-T5: BCD object-type dwords (Description\Type value).
#define PBL_BCD_OBJTYPE_OSLOADER     0x10200003  // Windows OS loader
// BCD device-blob element IDs (device format, class 1=library / 2=app).
#define PBL_BCD_E_DEVICE             0x11000001  // `device`  (library class)
#define PBL_BCD_E_OSDEVICE           0x21000001  // `osdevice`(application)

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
  OUT PBL_PLATFORM_STATE  *State,
  IN  EFI_HANDLE          ImageHandle
  );

// Bcd.c — REQ-09 BCD registry hive parser
EFI_STATUS
PblBcdParse (
  IN  CONST UINT8       *BcdData,
  IN  UINTN              BcdSize,
  OUT PBL_PLATFORM_STATE *State
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
// Trusted reports whether the variable was written with TIME_BASED_
// AUTHENTICATED attributes; PBL's own writes are unauthenticated (B-004),
// so callers must treat the value as advisory-only telemetry.
EFI_STATUS
PblReadBootmgrSvn (
  OUT UINT32   *Svn,
  OUT BOOLEAN  *Trusted
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

// Locks MemoryOverwriteRequestControl so the OS cannot clear it before
// reboot (MemoryOverwriteRequestControlLock, Microsoft Secure MOR).
EFI_STATUS
PblLockMor (
  VOID
  );

// Fve.c — D-120: FVE volume metadata inspection (BitLocker lock state)
//        + boot-volume binding via device-path disk-prefix match
VOID
PblCheckFve (
  IN OUT PBL_PLATFORM_STATE *State,
  IN     EFI_HANDLE         ImageHandle
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

// TpmClient.c — S1.1: TPM restart-counter boot-ID (TPM2_ReadClock)
EFI_STATUS
PblTpmReadRestartCounter (
  OUT UINT32   *RestartCount,
  OUT UINT32   *ResetCount,
  OUT BOOLEAN  *ClockSafe
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
  UINT8    SessionKey[32];    // KDFa session key (empty when unbound)
  UINT8    SessionKeySize;    // Size of session key (0 when bind=NULL + no salt)
  UINT8    NonceCaller[32];   // Our nonce (from EFI_RNG)
  UINT8    NonceTpm[32];      // TPM's nonce (from StartAuthSession response)
  UINT32   BindHandle;        // The NV index this session is bound to
  UINT8    BindAuth[64];      // Auth value of the bound entity (NV index)
  UINT8    BindAuthSize;      // Size of BindAuth (0 when bind=RH_NULL)
  UINT8    BoundEntityName[34]; // Name of bind entity captured at StartAuthSession
  UINT8    BoundEntityNameSize; // 0 when session is unbound (bind=TPM_RH_NULL)
  BOOLEAN  IncludeAuth;         // TPM includeAuth for the in-flight command/response
  UINT8    CmdAuthValue[64];    // authValue of the entity authorized by session 0
  UINT8    CmdAuthValueSize;    // Size of CmdAuthValue
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

// D-206: Refresh a cached NV index name/attributes via TPM2_NV_ReadPublic.
//        Required because TPMA_NV_WRITTEN changes the entity Name, which
//        affects both cpHash and the bound-session includeAuth decision.
EFI_STATUS
PblTpmNvRefreshName (
  IN UINT32  NvIndex
  );

// D-206: Mark an NV index written after a successful NV_Write/NV_Increment
//        so the cached attributes include TPMA_NV_WRITTEN.
VOID
PblTpmNvMarkWritten (
  IN UINT32  NvIndex
  );

// D-206: Get the TPM NAME for a handle (NV indices from the name cache with
//        current attributes; hierarchy handles are the handle itself).
EFI_STATUS
PblTpmGetHandleName (
  IN  UINT32  Handle,
  OUT UINT8  *Name,
  OUT UINT8  *NameSize
  );

// D-206: Get the NV HMAC session state (parallel to PblTpmGetPcrSession).
PBL_TPM_SESSION *
PblTpmGetSession (
  VOID
  );

// D-206: Get session key size (0 for unbound sessions — no KDFa)
UINT8
PblTpmGetSessionKeySize (
  VOID
  );

// D-215: Return TRUE when AES-256-CFB parameter encryption is implemented.
//        FALSE uses HMAC-only sessions (bound session still KDFa-derived).
BOOLEAN
PblTpmParameterEncryptionEnabled (
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
  IN UINT32        BootId,         // S1.1 TPM reset counter
  IN UINT16        FveProtectionMask,   // S1.3 BitLocker VMK mask
  IN CONST UINT8  *LoadedImageDigest,   // S1.3 loaded-image digest (32)
  IN UINT8         BootPathFlags,       // S1.3 PBL_BPF_* bitmask
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
