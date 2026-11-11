/** @file
  Host shim for PblApp.h — enough of EDK2's base types to compile the pure
  parsing modules (CborDecode.c) with a desktop compiler.

  This exists so `firmware/PblPkg/PblApp/CborDecode.c` can be unit-tested on the
  build host, which is what D-117 asked for and never got: before S265 every PBL
  module was verified by QEMU end-to-end runs and compilation only.

  The shim deliberately does NOT define the parsed structs. They are generated
  from the real ../PblApp/PblApp.h by extract-decls.py, so a field rename in the
  firmware header cannot leave the host tests testing a stale shape.

  Include order: this directory must be searched before PblApp/ (see Makefile).
**/

#ifndef PBL_HOST_APP_H
#define PBL_HOST_APP_H

/* Only <stdint.h>: the shim declares the EDK II base types and the lib funcs it
   uses, so it needs no libc headers. Pulling in <stdlib.h>/<string.h> here made
   clangd (which analyses this file alongside the EDK II headers) report a NULL
   redefinition — EDK2 and libc define NULL differently. Callers include what they
   need themselves. */
#include <stddef.h> /* size_t for UINTN */
#include <stdint.h>

/* ---- EDK2 base types (MdePkg/Base.h) ---------------------------------- */
/* clangd analyses this header with firmware/PblPkg/compile_commands.json, which
   pulls in the real EDK II headers (MDE_CPU_X64 + the Base.h typedefs). The host
   build never includes them, so the typedefs below are the only definitions there
   — but guard on EDK2's own marker so an analysis with both cannot redefine them. */
#ifndef MDE_CPU_X64
typedef uint8_t  UINT8;
typedef int8_t   INT8;
typedef uint16_t UINT16;
typedef int16_t  INT16;
typedef uint32_t UINT32;
typedef int32_t  INT32;
typedef uint64_t UINT64;
typedef int64_t  INT64;
typedef char     CHAR8;
typedef uint16_t CHAR16;
typedef uint8_t  BOOLEAN;
typedef size_t   UINTN;
typedef intptr_t INTN;
typedef void     VOID;
#endif /* !MDE_CPU_X64 */

#ifndef TRUE
#  define TRUE  ((BOOLEAN)1)
#endif
#ifndef FALSE
#  define FALSE ((BOOLEAN)0)
#endif

#  define IN
#  define OUT
#  define OPTIONAL
#  define CONST const
#  define STATIC static
#  define EFIAPI

/* ---- EFI_STATUS (MdePkg/Base.h, X64 encoding) -------------------------- */
typedef UINT64 EFI_STATUS;

/* #ifndef guards: clangd analyses this file with firmware/PblPkg/compile_commands.json,
   which pulls in the real EDK II headers, so these names can already be defined. */
#ifndef MAX_BIT
#  define MAX_BIT 0x8000000000000000ULL
#endif
#ifndef ENCODE_ERROR
#  define ENCODE_ERROR(StatusCode) ((EFI_STATUS)(MAX_BIT | (StatusCode)))
#endif

/* EDK II EFI_STATUS values (MdePkg/Include/Base.h). These numbers are part of the firmware
   contract — CoseVerify.c returns EFI_PROTOCOL_ERROR for a malformed envelope and
   EFI_SECURITY_VIOLATION for a bad signature, and the host tests assert on those names. A
   shim that invented its own numbering (an earlier revision had PROTOCOL_ERROR as 11) would
   still let the tests pass while describing codes the firmware never returns. */
#ifndef EFI_SUCCESS
#  define EFI_SUCCESS 0
#endif
#ifndef EFI_LOAD_ERROR
#  define EFI_LOAD_ERROR           ENCODE_ERROR (1)
#  define EFI_INVALID_PARAMETER    ENCODE_ERROR (2)
#  define EFI_UNSUPPORTED          ENCODE_ERROR (3)
#  define EFI_BAD_BUFFER_SIZE      ENCODE_ERROR (4)
#  define EFI_BUFFER_TOO_SMALL     ENCODE_ERROR (5)
#  define EFI_NOT_READY            ENCODE_ERROR (6)
#  define EFI_DEVICE_ERROR         ENCODE_ERROR (7)
#  define EFI_WRITE_PROTECTED      ENCODE_ERROR (8)
#  define EFI_OUT_OF_RESOURCES     ENCODE_ERROR (9)
#  define EFI_VOLUME_CORRUPTED     ENCODE_ERROR (10)
#  define EFI_VOLUME_FULL          ENCODE_ERROR (11)
#  define EFI_NO_MEDIA             ENCODE_ERROR (12)
#  define EFI_MEDIA_CHANGED        ENCODE_ERROR (13)
#  define EFI_NOT_FOUND            ENCODE_ERROR (14)
#  define EFI_ACCESS_DENIED        ENCODE_ERROR (15)
#  define EFI_NO_RESPONSE          ENCODE_ERROR (16)
#  define EFI_NO_MAPPING           ENCODE_ERROR (17)
#  define EFI_TIMEOUT              ENCODE_ERROR (18)
#  define EFI_NOT_STARTED          ENCODE_ERROR (19)
#  define EFI_ALREADY_STARTED      ENCODE_ERROR (20)
#  define EFI_ABORTED              ENCODE_ERROR (21)
#  define EFI_ICMP_ERROR           ENCODE_ERROR (22)
#  define EFI_TFTP_ERROR           ENCODE_ERROR (23)
#  define EFI_PROTOCOL_ERROR       ENCODE_ERROR (24)
#  define EFI_INCOMPATIBLE_VERSION ENCODE_ERROR (25)
#  define EFI_SECURITY_VIOLATION   ENCODE_ERROR (26)
#  define EFI_CRC_ERROR            ENCODE_ERROR (27)
#  define EFI_END_OF_MEDIA         ENCODE_ERROR (28)
#  define EFI_END_OF_FILE          ENCODE_ERROR (31)
#  define EFI_INVALID_LANGUAGE     ENCODE_ERROR (32)
#  define EFI_COMPROMISED_DATA     ENCODE_ERROR (33)
#  define EFI_HTTP_ERROR           ENCODE_ERROR (35)
#endif

#ifndef EFI_ERROR
#  define EFI_ERROR(Status) (((EFI_STATUS)(Status)) & MAX_BIT)
#endif

/* ---- BaseMemoryLib / BaseLib subset (host_efi.c) ----------------------- */
VOID *
EFIAPI
CopyMem (
  OUT VOID       *Destination,
  IN  CONST VOID *Source,
  IN  UINTN       Length
  );

VOID *
EFIAPI
ZeroMem (
  OUT VOID  *Buffer,
  IN  UINTN  Length
  );

VOID *
EFIAPI
SetMem (
  OUT VOID  *Buffer,
  IN  UINTN  Length,
  IN  UINT8  Value
  );

INTN
EFIAPI
CompareMem (
  IN CONST VOID  *DestinationBuffer,
  IN CONST VOID  *SourceBuffer,
  IN UINTN        Length
  );

INTN
EFIAPI
AsciiStrCmp (
  IN CONST CHAR8  *FirstString,
  IN CONST CHAR8  *SecondString
  );

UINTN
EFIAPI
AsciiStrLen (
  IN CONST CHAR8  *String
  );

VOID *
EFIAPI
AllocatePool (
  IN UINTN  AllocationSize
  );

VOID *
EFIAPI
AllocateZeroPool (
  IN UINTN  AllocationSize
  );

VOID
EFIAPI
FreePool (
  IN VOID  *Buffer
  );

/* ---- BaseLib extras (host_efi.c) --------------------------------------- */
UINT16
EFIAPI
SwapBytes16 (
  IN UINT16  Value
  );

UINT32
EFIAPI
SwapBytes32 (
  IN UINT32  Value
  );

UINT64
EFIAPI
SwapBytes64 (
  IN UINT64  Value
  );

/* EDK II's Print takes a CHAR16 format. On the host CHAR16 is uint16_t while a wide
   literal is wchar_t* (4 bytes here), so the parameter is VOID* and the implementation
   decides: it narrows the format and writes to stderr. Declaring it `CONST CHAR16 *`
   would make every `Print (L"...")` in the firmware a pointer-type error under -Werror. */
VOID
EFIAPI
Print (
  IN CONST VOID  *Format,
  ...
  );

/* ---- EDK II utility macros -------------------------------------------- */
#ifndef BIT0
#  define BIT0   0x00000001U
#  define BIT1   0x00000002U
#  define BIT2   0x00000004U
#  define BIT3   0x00000008U
#  define BIT4   0x00000010U
#  define BIT5   0x00000020U
#  define BIT6   0x00000040U
#  define BIT7   0x00000080U
#  define BIT8   0x00000100U
#  define BIT9   0x00000200U
#  define BIT10  0x00000400U
#  define BIT11  0x00000800U
#  define BIT12  0x00001000U
#  define BIT13  0x00002000U
#  define BIT14  0x00004000U
#  define BIT15  0x00008000U
#  define BIT16  0x00010000U
#  define BIT17  0x00020000U
#  define BIT18  0x00040000U
#  define BIT19  0x00080000U
#  define BIT20  0x00100000U
#  define BIT21  0x00200000U
#  define BIT22  0x00400000U
#  define BIT23  0x00800000U
#  define BIT24  0x01000000U
#  define BIT25  0x02000000U
#  define BIT26  0x04000000U
#  define BIT27  0x08000000U
#  define BIT28  0x10000000U
#  define BIT29  0x20000000U
#  define BIT30  0x40000000U
#  define BIT31  0x80000000U
#  define BIT(n)  (1U << (n))
#endif

#ifndef ARRAY_SIZE
#  define ARRAY_SIZE(Array)  (sizeof (Array) / sizeof ((Array)[0]))
#endif

/* EDK II's STATIC_ASSERT is C11 `_Static_assert` on gcc/clang (MdePkg/Include/Base.h:818)
   and takes TWO arguments — expression and message. The host build mirrors that exactly
   rather than substituting a C99 typedef trick, so a struct-size or array-size invariant
   the firmware rejects at build time is rejected here too, with the same diagnostic.
   Consequence: these binaries are built as C11, not C99 (see run-host-tests.sh). */
#ifndef STATIC_ASSERT
#  define STATIC_ASSERT(Expression, Message)  _Static_assert ((Expression), Message)
#endif

#ifndef OFFSET_OF
#  define OFFSET_OF(TYPE, Field)  ((UINTN) &(((TYPE *)0)->Field))
#endif

/* ---- PCDs, generated from PblPkg.dec ---------------------------------- */
/* Nothing here is hardcoded: gen-host-pcd.py parses the real .dec, so a default change
   (for example PcdPblTpmUsePlatformHierarchy) flows into the tests and into every byte
   they assert on. FixedPcdGet* mirror the firmware's accessors. */
#include "pbl_pcd.generated.h"

#define FixedPcdGet8(Name)     ((UINT8)HOST_PCD_##Name)
#define FixedPcdGet16(Name)    ((UINT16)HOST_PCD_##Name)
#define FixedPcdGet32(Name)    ((UINT32)HOST_PCD_##Name)
#define FixedPcdGet64(Name)    ((UINT64)HOST_PCD_##Name)
#define FixedPcdGetBool(Name)  ((BOOLEAN)HOST_PCD_##Name)
#define FixedPcdGetPtr(Name)   ((CONST VOID *)HOST_PCD_##Name)
#define FixedPcdGetSize(Name)  (HOST_PCD_##Name##_SIZE)
#define PcdGet8(Name)          FixedPcdGet8 (Name)
#define PcdGet16(Name)         FixedPcdGet16 (Name)
#define PcdGet32(Name)         FixedPcdGet32 (Name)
#define PcdGet64(Name)         FixedPcdGet64 (Name)
#define PcdGetBool(Name)       FixedPcdGetBool (Name)
#define PcdGetPtr(Name)        FixedPcdGetPtr (Name)
#define PcdGetSize(Name)       FixedPcdGetSize (Name)

/* ---- EFI protocols the TPM client reaches (MdePkg) --------------------- */
typedef UINT8  BOOLEAN_T;           /* placeholder kept out of the EDK II namespace */
typedef VOID                      *EFI_HANDLE;
typedef VOID                      *EFI_EVENT;
typedef struct {
  UINT32  Data1;
  UINT16  Data2;
  UINT16  Data3;
  UINT8   Data4[8];
} EFI_GUID;

/* Only the EFI_TCG2_PROTOCOL surface TpmClient.c touches is declared: GetCapability and
   SubmitCommand. SubmitCommand is the seam the tests drive — see host_tpm.c. */
typedef struct _EFI_TCG2_PROTOCOL EFI_TCG2_PROTOCOL;

typedef struct {
  UINT8   Size;
  UINT8   StructureVersion;
  UINT8   ProtocolVersion;
  UINT8   HashAlgorithmBitmap;
  UINT32  SupportedEventLogs;
  BOOLEAN TPMPresentFlag;
  UINT16  MaxCommandSize;
  UINT16  MaxResponseSize;
  UINT32  ManufacturerID;
  UINT32  NumberOfPcrBanks;
  UINT32  ActivePcrBanks;
} EFI_TCG2_BOOT_SERVICE_CAPABILITY;

typedef EFI_STATUS (EFIAPI *EFI_TCG2_GET_CAPABILITY) (
  IN     EFI_TCG2_PROTOCOL               *This,
  IN OUT EFI_TCG2_BOOT_SERVICE_CAPABILITY *ProtocolCapability
  );

typedef EFI_STATUS (EFIAPI *EFI_TCG2_SUBMIT_COMMAND) (
  IN  EFI_TCG2_PROTOCOL  *This,
  IN  UINT32              InputParameterBlockSize,
  IN  UINT8               *InputParameterBlock,
  IN  UINT32              OutputParameterBlockSize,
  IN  UINT8               *OutputParameterBlock
  );

struct _EFI_TCG2_PROTOCOL {
  EFI_TCG2_GET_CAPABILITY GetCapability;
  EFI_TCG2_SUBMIT_COMMAND SubmitCommand;
};

extern EFI_GUID  gEfiTcg2ProtocolGuid;

typedef EFI_STATUS (EFIAPI *EFI_LOCATE_PROTOCOL) (
  IN  EFI_GUID  *Protocol,
  IN  VOID      *Registration OPTIONAL,
  OUT VOID     **Interface
  );

/* The firmware reaches the TPM through gBS->LocateProtocol; host_tpm.c installs a fake
   boot services table whose LocateProtocol yields the test's TCG2 protocol. */
typedef struct {
  EFI_LOCATE_PROTOCOL LocateProtocol;
} EFI_BOOT_SERVICES;

extern EFI_BOOT_SERVICES  *gBS;

/* ---- TPM 2.0 wire format, vendored verbatim from EDK II ------------------ */
/* include/IndustryStandard/{Tpm12,Tpm20}.h are byte-identical copies of MdePkg's; the test
   runner `cmp`s them against the EDK II checkout when one exists, so they cannot drift.

   The shim includes the *generated* fold of that pair, not the pair itself: Tpm20.h does
   `#include <IndustryStandard/Tpm12.h>` with an angled include, which only resolves when the
   whole MdePkg/Include tree is on the search path. gen-host-tpm.py concatenates the two and
   drops that one nested line mechanically, so the host build needs no include-path
   cooperation and the upstream files stay byte-identical for the drift check. */
#include "pbl_tpm_wire.generated.h"

/* ---- BaseCryptLib subset (host_crypto.c, over OpenSSL) ----------------- */
#define CRYPTO_NID_NULL             0x0000
#define CRYPTO_NID_SHA256           0x0001
#define CRYPTO_NID_SHA384           0x0002
#define CRYPTO_NID_SHA512           0x0003

/* Signatures copied from CryptoPkg/Include/Library/BaseCryptLib.h. Note EcDsaVerify takes
   raw r||s (not DER): CryptoPkg's implementation converts via ECDSA_SIG_set0 after
   rejecting any SigSize != 2 * curve-half-size (CryptEc.c:1060). host_crypto.c must keep
   that contract or the COSE test would prove something the firmware does not do. */
BOOLEAN
EFIAPI
Sha256HashAll (
  IN   CONST VOID  *Data,
  IN   UINTN       DataSize,
  OUT  UINT8       *HashValue
  );

VOID *
EFIAPI
HmacSha256New (
  VOID
  );

BOOLEAN
EFIAPI
HmacSha256SetKey (
  OUT  VOID         *HmacSha256Context,
  IN   CONST UINT8  *Key,
  IN   UINTN        KeySize
  );

BOOLEAN
EFIAPI
HmacSha256Update (
  IN OUT  VOID        *HmacSha256Context,
  IN      CONST VOID  *Data,
  IN      UINTN       DataSize
  );

BOOLEAN
EFIAPI
HmacSha256Final (
  IN OUT  VOID   *HmacSha256Context,
  OUT     UINT8  *HmacValue
  );

VOID
EFIAPI
HmacSha256Free (
  IN OUT  VOID  *HmacSha256Context
  );

BOOLEAN
EFIAPI
HmacSha256All (
  IN   CONST VOID   *Data,
  IN   UINTN        DataSize,
  IN   CONST UINT8  *Key,
  IN   UINTN        KeySize,
  OUT  UINT8        *HmacValue
  );

UINTN
EFIAPI
AesGetContextSize (
  VOID
  );

BOOLEAN
EFIAPI
AesInit (
  OUT  VOID         *AesContext,
  IN   CONST UINT8  *Key,
  IN   UINTN        KeyLength
  );

BOOLEAN
EFIAPI
AesCbcEncrypt (
  IN   VOID         *AesContext,
  IN   CONST UINT8  *Input,
  IN   UINTN        InputSize,
  IN   CONST UINT8  *Ivec,
  OUT  UINT8        *Output
  );

BOOLEAN
EFIAPI
EcGetPublicKeyFromX509 (
  IN   CONST UINT8  *Cert,
  IN   UINTN        CertSize,
  OUT  VOID         **EcContext
  );

BOOLEAN
EFIAPI
EcDsaVerify (
  IN  VOID         *EcContext,
  IN  UINTN        HashNid,
  IN  CONST UINT8  *MessageHash,
  IN  UINTN        HashSize,
  IN  CONST UINT8  *Signature,
  IN  UINTN        SigSize
  );

VOID
EFIAPI
EcFree (
  IN  VOID  *EcContext
  );

BOOLEAN
EFIAPI
X509VerifyCertChain (
  IN CONST UINT8  *RootCert,
  IN UINTN         RootCertLength,
  IN CONST UINT8  *CertChain,
  IN UINTN         CertChainLength
  );

/* ---- Parsed structs, macros and firmware prototypes --------------------- */
/* Generated at build time from the real PblApp.h + PblPkg.dec (both gitignored), so the
   host tests cannot describe a shape or a signature the firmware no longer has. */
#include "pbl_decls.generated.h"

/* These two assertions are not decoration: they fail the build when a generator silently
   emitted nothing (a changed .dec or PblApp.h format a parser no longer matches), which
   would otherwise show up as a wall of unrelated `undeclared identifier` errors — or worse,
   as tests that quietly assert on a PCD default that never made it across. */
STATIC_ASSERT (PBL_NV_INDEX_COUNT > 0, "extract-decls.py emitted no PBL_NV_* macros");
STATIC_ASSERT (HOST_PCD_PcdPblTpmNvAuthValue_SIZE > 1, "gen-host-pcd.py emitted no NV auth value");

/* Pin the wire-format facts every byte-level test in test_tpm_command.c depends on.
   Measured, not assumed: an earlier version of this block claimed TPMS_AUTH_COMMAND was 9
   bytes (the serialized size of an empty auth area) and the assertion rejected the build —
   the struct is 137 because TPM2B_* are fixed-size *buffers* (2-byte length + 64 max), not
   variable-length values. That distinction is the whole reason the client writes explicit
   SwapBytes16 length fields instead of memcpy'ing these structs, so it is worth pinning. */
STATIC_ASSERT (sizeof (TPM2_COMMAND_HEADER) == 10, "TPM 2.0 command header must be 10 bytes");
STATIC_ASSERT (sizeof (TPM2_RESPONSE_HEADER) == 10, "TPM 2.0 response header must be 10 bytes");
STATIC_ASSERT (
  sizeof (TPM2B_DIGEST) == 66,
  "TPM2B is a fixed 66-byte buffer: its wire form is 2 + size, never sizeof()"
  );

#endif /* PBL_HOST_APP_H */
