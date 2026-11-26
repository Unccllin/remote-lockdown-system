"""
TPM 2.0 Sealed Storage Module
------------------------------
Seals the lockdown state encryption key to the TPM 2.0, so the state
can only be decrypted on the same machine with the same TPM.

Architecture:
  1. Generate a random AES-256 key (the "data key")
  2. Seal the data key to the TPM using Windows CNG
     (MS_PLATFORM_CRYPTO_PROVIDER = TPM-backed key storage)
  3. Use the data key to encrypt the state (AES-256-GCM)
  4. Store: sealed data key + encrypted state

On read:
  1. Unseal the data key from the TPM
  2. Use it to decrypt the state

If TPM is not available, falls back to DPAPI (Layer 3).

TPM protection:
  - The sealed data key can only be unsealed on the same TPM
  - Survives disk wipe, OS reinstall, drive replacement
  - Does NOT survive TPM clear or motherboard replacement

Windows API (all through PowerShell, so the frozen agent needs no extra dependency):
  - New-SelfSignedCertificate -Provider 'Microsoft Platform Crypto Provider'
    creates the TPM-resident RSA key; the certificate's thumbprint is its address
  - RSACertificateExtensions::GetRSAPrivateKey + RSA::Encrypt/Decrypt (OAEP-SHA256)
  - The provider refuses to export the key, which is what TPM storage looks like

Why a certificate and not a CNG key name: CngKey.Create against the Platform
Crypto Provider returns "The requested operation is not supported" on Windows
10/11 even with a ready TPM 2.0 (measured on MOLE, 2026-11-24). The certificate
path is the supported one, and it is what this module always claimed to do.

Usage:
    from tpm_seal import seal_state, unseal_state, is_tpm_available

    if is_tpm_available():
        sealed = seal_state(b'{"status":"stolen"}')
        plaintext = unseal_state(sealed)  # Only works on same TPM
"""

import base64
import logging
import os
import platform
import re
import struct
import subprocess

log = logging.getLogger("lockdown-agent")

# The seal key used to be addressed by a CNG key name. It is addressed by certificate now
# (S357), because CngKey.Create against the Platform Crypto Provider is not supported; the
# certificate subject declared in the key section below is the address.

# File format: [magic "TPM1"] [4 bytes: sealed_key_len] [sealed_key] [encrypted_state]
_MAGIC = b"TPM1"
_MAGIC_LEN = len(_MAGIC)
_LEN_BYTES = 4


def _is_windows() -> bool:
    return platform.system() == "Windows"


def is_tpm_available() -> bool:
    """Check if TPM 2.0 is available and ready.

    On Windows: checks via PowerShell Get-Tpm cmdlet.
    On non-Windows: returns False (TPM access not implemented).
    """
    if not _is_windows():
        return False

    try:
        returncode, stdout, _ = _run_powershell("(Get-Tpm).TpmReady", timeout=10)
        if returncode == 0:
            return stdout.strip().lower() == "true"
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
        OSError,
    ) as e:
        log.debug("TPM check failed: %s", e)

    return False


# ---------------------------------------------------------------------------
# TPM-backed key, addressed by certificate
# ---------------------------------------------------------------------------
#
# CngKey.Create against 'Microsoft Platform Crypto Provider' returns "The requested
# operation is not supported" on Windows 10/11 even with a ready TPM 2.0 (measured on
# MOLE, 2026-11-24: Infineon IFX, TpmPresent/TpmReady/TpmEnabled/TpmActivated all
# True). New-SelfSignedCertificate with the same provider does create the key, and the
# key it creates is genuinely TPM-resident: exporting it is refused by the provider.
#
# Nothing in the field is sealed this way yet — the old path never created a key, so
# every device has been on the DPAPI fallback — which is why there is no migration.

# The provider that puts the key in the TPM.
NCRYPT_KEY_STORAGE_PROVIDER = "Microsoft Platform Crypto Provider"
NCRYPT_RSA_ALGORITHM = "RSA"

# The seal key lives in this machine-wide certificate. The subject is the address: the
# thumbprint is resolved from it per process, so a new process (or the recovery tool)
# finds the same TPM key without being told where it is.
TPM_CERT_SUBJECT = "CN=LockdownStateSealKey"
_CERT_STORE = r"Cert:\LocalMachine\My"
_CERT_LIFETIME_YEARS = 10
_KEY_BITS = 2048
_THUMBPRINT_RE = re.compile(r"\A[0-9A-Fa-f]{40}\Z")

# RSA-2048 OAEP-SHA256 carries 256 - 2*32 - 2 = 190 bytes. The payload is a 32-byte
# AES-256 key, so the ceiling is never near; it is checked to fail loudly rather than
# at the TPM with an opaque error.
_MAX_SEALED_KEY_BYTES = 190
_CIPHERTEXT_BYTES = _KEY_BITS // 8

# Resolved thumbprint, cached for the life of the process (the certificate outlives it).
_tpm_thumbprint: str | None = None


def _run_powershell(script: str, timeout: int = 15) -> tuple[int, str, str]:
    """Run a generated PowerShell script; return (returncode, stdout, stderr).

    `-NonInteractive` is load-bearing: the agent runs as LocalSystem in session 0, where a
    prompt cannot be answered and would hang a check-in instead of failing it.
    """
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return result.returncode, result.stdout, result.stderr


def _failure_detail(returncode: int, stdout: str, stderr: str) -> str:
    """Describe a failed script run with the reason the script actually printed.

    Every generated script writes `ERROR: ...` to STDOUT and exits non-zero. Logging
    stderr alone printed "TPM key creation failed: " with nothing after it, on every
    check-in, for months (S355) — so stdout is read first, by contract.
    """
    return f"(rc={returncode}): {stdout.strip() or stderr.strip() or 'no output'}"


def _parse_fields(stdout: str) -> dict[str, str]:
    """Parse the `NAME=value` lines a generated script emits."""
    fields: dict[str, str] = {}
    for line in stdout.splitlines():
        name, sep, value = line.partition("=")
        if sep:
            fields[name.strip()] = value.strip()
    return fields


def _seal_cert_thumbprint(create: bool = True) -> str | None:
    """Return the thumbprint of the TPM-backed seal certificate.

    Creates the certificate when it is missing, unless `create` is False: the read path
    must never mint a new TPM key, because a new key cannot decrypt an old blob and would
    quietly replace the key that blob was sealed with.

    Returns None when the certificate is absent (`create=False`) or cannot be created.
    """
    global _tpm_thumbprint
    if _tpm_thumbprint is not None and create:
        return _tpm_thumbprint
    if not _is_windows():
        return None

    if create:
        ps_script = f"""
$ErrorActionPreference = 'Stop'
try {{
    $certs = @(Get-ChildItem '{_CERT_STORE}' |
        Where-Object {{ $_.Subject -eq '{TPM_CERT_SUBJECT}' }} |
        Sort-Object NotAfter -Descending)
    Write-Output ('MATCHES=' + $certs.Count)
    if ($certs.Count -gt 0) {{
        $cert = $certs[0]
        Write-Output 'STATE=EXISTS'
    }} else {{
        $cert = New-SelfSignedCertificate -Subject '{TPM_CERT_SUBJECT}' `
            -Provider '{NCRYPT_KEY_STORAGE_PROVIDER}' `
            -KeyAlgorithm '{NCRYPT_RSA_ALGORITHM}' `
            -KeyLength {_KEY_BITS} `
            -KeyUsage KeyEncipherment, DataEncipherment `
            -CertStoreLocation '{_CERT_STORE}' `
            -NotAfter (Get-Date).AddYears({_CERT_LIFETIME_YEARS})
        Write-Output 'STATE=CREATED'
    }}
    Write-Output ('THUMBPRINT=' + $cert.Thumbprint)
}} catch {{
    Write-Output ("ERROR: " + $_)
    exit 1
}}
""".strip()
    else:
        ps_script = f"""
$ErrorActionPreference = 'Stop'
try {{
    $certs = @(Get-ChildItem '{_CERT_STORE}' |
        Where-Object {{ $_.Subject -eq '{TPM_CERT_SUBJECT}' }} |
        Sort-Object NotAfter -Descending)
    Write-Output ('MATCHES=' + $certs.Count)
    if ($certs.Count -eq 0) {{
        Write-Output 'STATE=ABSENT'
        exit 0
    }}
    $cert = $certs[0]
    Write-Output 'STATE=EXISTS'
    Write-Output ('THUMBPRINT=' + $cert.Thumbprint)
}} catch {{
    Write-Output ("ERROR: " + $_)
    exit 1
}}
""".strip()

    try:
        returncode, stdout, stderr = _run_powershell(ps_script, timeout=30)
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
        OSError,
    ) as e:
        log.warning("TPM seal certificate: powershell failed: %s", e)
        return None

    if returncode != 0:
        log.warning(
            "TPM seal certificate unavailable %s", _failure_detail(returncode, stdout, stderr)
        )
        return None

    fields = _parse_fields(stdout)
    state = fields.get("STATE", "")
    if state == "ABSENT":
        log.error("TPM seal certificate %s is missing — cannot unseal", TPM_CERT_SUBJECT)
        return None

    thumbprint = fields.get("THUMBPRINT", "")
    if not _THUMBPRINT_RE.match(thumbprint):
        log.warning("TPM seal certificate: unusable output %r", stdout.strip())
        return None

    matches = fields.get("MATCHES", "")
    try:
        match_count = int(matches)
    except ValueError:
        match_count = 0
    if match_count > 1:
        log.warning(
            "TPM seal certificate: %s certificates have subject %s; using the newest (%s)",
            matches,
            TPM_CERT_SUBJECT,
            thumbprint,
        )
    log.info("TPM seal certificate %s (%s)", thumbprint, state)
    _tpm_thumbprint = thumbprint
    return thumbprint


def _tpm_seal_key(thumbprint: str, plaintext: bytes) -> bytes | None:
    """Encrypt the data key with the TPM-resident RSA key (OAEP-SHA256).

    Returns the ciphertext, or None if the TPM refuses. The ciphertext is bound to this
    machine: another machine's key cannot reproduce it, and this key cannot be exported.
    OAEP-SHA256 replaces the PKCS#1 v1.5 padding the old path chose; both round-trip on the
    Platform Crypto Provider (measured on MOLE, 2026-11-26), so the stronger one is used.
    """
    if not _is_windows():
        return None
    if len(plaintext) > _MAX_SEALED_KEY_BYTES:
        log.error(
            "TPM seal: payload too large (%d bytes, max %d with RSA-%d OAEP-SHA256)",
            len(plaintext),
            _MAX_SEALED_KEY_BYTES,
            _KEY_BITS,
        )
        return None

    b64_plaintext = base64.b64encode(plaintext).decode("ascii")

    ps_script = f"""
$ErrorActionPreference = 'Stop'
try {{
    $cert = Get-Item '{_CERT_STORE}\\{thumbprint}'
    $ext = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]
    $rsa = $ext::GetRSAPrivateKey($cert)
    if ($null -eq $rsa) {{ throw 'certificate has no private key' }}
    $plaintext = [Convert]::FromBase64String('{b64_plaintext}')
    $sealed = $rsa.Encrypt($plaintext, `
        [System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
    [Convert]::ToBase64String($sealed)
}} catch {{
    Write-Output ("ERROR: " + $_)
    exit 1
}}
""".strip()

    try:
        returncode, stdout, stderr = _run_powershell(ps_script, timeout=15)
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
        OSError,
    ) as e:
        log.warning("TPM seal error: %s", e)
        return None

    if returncode != 0:
        log.warning("TPM seal failed %s", _failure_detail(returncode, stdout, stderr))
        return None

    try:
        sealed = base64.b64decode(stdout.strip(), validate=True)
    except ValueError as e:
        log.warning("TPM seal: unusable output %r (%s)", stdout.strip(), e)
        return None

    if len(sealed) != _CIPHERTEXT_BYTES:
        log.warning("TPM seal: unexpected ciphertext length %d", len(sealed))
        return None
    return sealed


def _tpm_unseal_key(thumbprint: str, ciphertext: bytes) -> bytes | None:
    """Decrypt the data key with the TPM-resident RSA key (OAEP-SHA256).

    Returns the decrypted bytes, or None when the TPM refuses — a different machine, a
    cleared TPM, or a blob this key did not produce. Never raises: the caller turns None
    into its fail-secure treatment of the state file.
    """
    if not _is_windows():
        return None

    b64_ciphertext = base64.b64encode(ciphertext).decode("ascii")

    ps_script = f"""
$ErrorActionPreference = 'Stop'
try {{
    $cert = Get-Item '{_CERT_STORE}\\{thumbprint}'
    $ext = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]
    $rsa = $ext::GetRSAPrivateKey($cert)
    if ($null -eq $rsa) {{ throw 'certificate has no private key' }}
    $ciphertext = [Convert]::FromBase64String('{b64_ciphertext}')
    $decrypted = $rsa.Decrypt($ciphertext, `
        [System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
    [Convert]::ToBase64String($decrypted)
}} catch {{
    Write-Output ("ERROR: " + $_)
    exit 1
}}
""".strip()

    try:
        returncode, stdout, stderr = _run_powershell(ps_script, timeout=15)
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
        OSError,
    ) as e:
        log.debug("TPM unseal error: %s", e)
        return None

    if returncode != 0:
        log.debug("TPM unseal failed %s", _failure_detail(returncode, stdout, stderr))
        return None

    try:
        return base64.b64decode(stdout.strip(), validate=True)
    except ValueError as e:
        log.debug("TPM unseal: unusable output %r (%s)", stdout.strip(), e)
        return None


# ---------------------------------------------------------------------------
# AES-256-GCM encryption for the state data
# ---------------------------------------------------------------------------


def _aes_gcm_encrypt(key: bytes, plaintext: bytes) -> bytes:
    """Encrypt with AES-256-GCM. Returns nonce + ciphertext + tag."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(12)
    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)
    return nonce + ciphertext


def _aes_gcm_decrypt(key: bytes, blob: bytes) -> bytes | None:
    """Decrypt AES-256-GCM. Expects nonce + ciphertext + tag."""
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if len(blob) < 12:
        return None
    nonce = blob[:12]
    ciphertext = blob[12:]
    aesgcm = AESGCM(key)
    try:
        return aesgcm.decrypt(nonce, ciphertext, None)
    except (ValueError, TypeError, OSError, InvalidTag):
        return None


# ---------------------------------------------------------------------------
# Public API: seal / unseal
# ---------------------------------------------------------------------------


def seal_state(plaintext: bytes) -> bytes | None:
    """Seal state data to the TPM.

    Process:
      1. Generate a random AES-256 data key
      2. Encrypt the state with the AES key (AES-256-GCM)
      3. Seal the AES key by encrypting it with the TPM-backed RSA key
      4. Return: magic + sealed_key_len + sealed_key + encrypted_state

    Returns None if TPM is not available or sealing fails.
    """
    if not is_tpm_available():
        log.debug("TPM not available — cannot seal state")
        return None

    # Ensure the TPM-backed certificate (and therefore the key) exists
    thumbprint = _seal_cert_thumbprint()
    if thumbprint is None:
        log.error("Could not create/open the TPM seal certificate")
        return None

    # Generate a random AES-256 data key
    data_key = os.urandom(32)

    # Encrypt the state with the AES key
    encrypted_state = _aes_gcm_encrypt(data_key, plaintext)

    # Seal the data key by encrypting it with the TPM-resident RSA key
    sealed_key = _tpm_seal_key(thumbprint, data_key)

    # Zero out the data key from memory
    data_key = b"\x00" * 32

    if sealed_key is None:
        log.error("Failed to seal data key to TPM")
        return None

    # Pack: magic + sealed_key_len (4 bytes) + sealed_key + encrypted_state
    blob = _MAGIC + struct.pack("<I", len(sealed_key)) + sealed_key + encrypted_state
    return blob


def unseal_state(blob: bytes) -> bytes | None:
    """Unseal state data from the TPM.

    Process:
      1. Parse the blob (magic + sealed_key_len + sealed_key + encrypted_state)
      2. Unseal the AES key by decrypting it with the TPM-backed RSA key
      3. Decrypt the state with the AES key

    Returns None if:
      - TPM is not available
      - Blob format is invalid
      - TPM decryption fails (wrong machine, key not found)
      - AES decryption fails (tampered data)

    This is fail-secure: any error returns None.
    """
    if not _is_windows():
        return None

    try:
        # Parse the blob
        if len(blob) < _MAGIC_LEN + _LEN_BYTES:
            log.warning("TPM blob too small")
            return None

        if blob[:_MAGIC_LEN] != _MAGIC:
            log.warning("TPM blob has wrong magic")
            return None

        sealed_key_len = struct.unpack("<I", blob[_MAGIC_LEN : _MAGIC_LEN + _LEN_BYTES])[0]
        offset = _MAGIC_LEN + _LEN_BYTES

        if len(blob) < offset + sealed_key_len:
            log.warning("TPM blob truncated (sealed key)")
            return None

        sealed_key = blob[offset : offset + sealed_key_len]
        offset += sealed_key_len

        encrypted_state = blob[offset:]

        # Unseal the data key from the TPM. The certificate is looked up without creating
        # one: a freshly minted key could not decrypt this blob, and minting it here would
        # replace the key the state file was sealed with.
        thumbprint = _seal_cert_thumbprint(create=False)
        if thumbprint is None:
            log.error("TPM unseal failed — the seal certificate is missing on this machine")
            return None

        data_key = _tpm_unseal_key(thumbprint, sealed_key)
        if data_key is None:
            log.error("TPM unseal failed — wrong machine or key not found")
            return None

        # Decrypt the state with the AES key
        plaintext = _aes_gcm_decrypt(data_key, encrypted_state)

        # Zero out the data key
        data_key = b"\x00" * 32

        if plaintext is None:
            log.error("AES decryption failed — state may be tampered")
            return None

        return plaintext
    except (struct.error, ValueError, TypeError, OSError) as e:
        log.error("TPM unseal error: %s", e)
        return None


def is_tpm_sealed_blob(blob: bytes) -> bool:
    """Check if a blob is a TPM-sealed state (has the TPM magic header)."""
    return len(blob) >= _MAGIC_LEN and blob[:_MAGIC_LEN] == _MAGIC


def delete_tpm_key() -> bool:
    """Delete the TPM seal key and its certificate. Used during uninstall/cleanup.

    Both halves have to go, and they die independently: deleting the certificate leaves the
    persisted CNG key (`te-<guid>` under the Platform Crypto Provider) in the TPM, and
    deleting the key leaves a certificate whose private key can never be used again
    (measured on MOLE, 2026-11-26). The old implementation called
    [CngKey]::Delete('name'), a static overload .NET Framework does not have, so it threw
    and returned False without deleting anything.

    Returns True if the key and certificate are gone (or were never there).
    """
    global _tpm_thumbprint
    if not _is_windows():
        return False

    ps_script = f"""
$ErrorActionPreference = 'Stop'
try {{
    $certs = @(Get-ChildItem '{_CERT_STORE}' |
        Where-Object {{ $_.Subject -eq '{TPM_CERT_SUBJECT}' }})
    if ($certs.Count -eq 0) {{
        Write-Output 'STATE=NOTFOUND'
        exit 0
    }}
    foreach ($cert in $certs) {{
        try {{
            $ext = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]
            $rsa = $ext::GetRSAPrivateKey($cert)
            if ($null -ne $rsa) {{ $rsa.Key.Delete() }}
        }} catch {{
            # The TPM key may already be gone (cleared TPM, or a previous uninstall).
            # The certificate removal below still has to happen either way.
        }}
        Remove-Item -Path ('{_CERT_STORE}\\' + $cert.Thumbprint) -Force
    }}
    Write-Output 'STATE=DELETED'
    Write-Output ('COUNT=' + $certs.Count)
}} catch {{
    Write-Output ("ERROR: " + $_)
    exit 1
}}
""".strip()

    try:
        returncode, stdout, stderr = _run_powershell(ps_script, timeout=15)
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
        OSError,
    ) as e:
        log.warning("TPM key deletion failed: %s", e)
        return False

    if returncode != 0:
        log.warning("TPM key deletion failed %s", _failure_detail(returncode, stdout, stderr))
        return False

    _tpm_thumbprint = None
    fields = _parse_fields(stdout)
    state = fields.get("STATE", "")
    log.info("TPM seal key removed (STATE=%s, count=%s)", state, fields.get("COUNT", "0"))
    return state in ("DELETED", "NOTFOUND")
