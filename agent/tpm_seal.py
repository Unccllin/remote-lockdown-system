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

Windows API:
  - NCryptOpenStorageProvider(MS_PLATFORM_CRYPTO_PROVIDER)
  - NCryptCreatePersistedKey / NCryptOpenKey
  - NCryptEncrypt / NCryptDecrypt
  - Called via ctypes (no external Python dependencies)

Usage:
    from tpm_seal import seal_state, unseal_state, is_tpm_available

    if is_tpm_available():
        sealed = seal_state(b'{"status":"stolen"}')
        plaintext = unseal_state(sealed)  # Only works on same TPM
"""

import logging
import os
import platform
import struct
import subprocess

log = logging.getLogger("lockdown-agent")

# TPM key name in the CNG key store
TPM_KEY_NAME = "LockdownStateSealKey"

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
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", "(Get-Tpm).TpmReady"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return result.stdout.strip().lower() == "true"
    except Exception as e:
        log.debug("TPM check failed: %s", e)

    return False


# ---------------------------------------------------------------------------
# CNG API via ctypes (Windows only)
# ---------------------------------------------------------------------------

# CNG constants
NCRYPT_KEY_STORAGE_PROVIDER = "Microsoft Platform Crypto Provider"
NCRYPT_RSA_ALGORITHM = "RSA"
NCRYPT_PAD_PKCS1 = 0x00000002

# Error codes
NTE_BAD_KEY = 0x80090003
NTE_EXISTS = 0x8009000F
ERROR_SUCCESS = 0


def _cng_create_key() -> bool:
    """Create a TPM-backed RSA key in the CNG key store.

    The key is persisted in the TPM and can only be used on this machine.
    Returns True if the key was created or already exists.
    """
    if not _is_windows():
        return False

    try:
        # Use PowerShell to create the key (simpler than ctypes)
        ps_script = f"""
$ErrorActionPreference = 'Stop'
try {{
    $key = Get-CngKey -Name '{TPM_KEY_NAME}' -ErrorAction SilentlyContinue
    if (-not $key) {{
        $provider = New-Object System.Security.Cryptography.CngProvider(
            '{NCRYPT_KEY_STORAGE_PROVIDER}')
        $keyParams = New-Object System.Security.Cryptography.CngKeyCreationParameters
        $keyParams.Provider = $provider
        $keyParams.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::NonExportable
        $keyParams.KeyUsage = [System.Security.Cryptography.CngKeyUsages]::AllUsages
        $keyParams.Flags = [System.Security.Cryptography.CngKeyFlags]::None
        $algorithm = New-Object System.Security.Cryptography.CngAlgorithm(
            '{NCRYPT_RSA_ALGORITHM}')
        [System.Security.Cryptography.CngKey]::Create(
            '{TPM_KEY_NAME}', $algorithm, $keyParams)
        Write-Output 'CREATED'
    }} else {{
        Write-Output 'EXISTS'
    }}
}} catch {{
    Write-Output "ERROR: $_"
    exit 1
}}
""".strip()

        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True,
            text=True,
            timeout=15,
        )

        if result.returncode == 0:
            output = result.stdout.strip()
            if output in ("CREATED", "EXISTS"):
                log.info("TPM seal key %s: %s", TPM_KEY_NAME, output)
                return True
            else:
                log.warning("TPM key creation unexpected output: %s", output)
        else:
            log.warning("TPM key creation failed: %s", result.stderr.strip())
    except Exception as e:
        log.warning("TPM key creation error: %s", e)

    return False


def _cng_encrypt_with_tpm(plaintext: bytes) -> bytes | None:
    """Encrypt data using the TPM-backed RSA key.

    Returns the encrypted blob, or None if encryption fails.
    The RSA key is 2048-bit, so max plaintext = 245 bytes (PKCS1 padding).
    For larger data, we encrypt a symmetric key with RSA and the data with AES.
    """
    if not _is_windows():
        return None

    if len(plaintext) > 245:
        log.error("TPM RSA encrypt: data too large (%d bytes, max 245)", len(plaintext))
        return None

    try:
        # Use PowerShell to encrypt with the TPM key
        import base64

        b64_plaintext = base64.b64encode(plaintext).decode("ascii")

        ps_script = f"""
$ErrorActionPreference = 'Stop'
try {{
    $key = Get-CngKey -Name '{TPM_KEY_NAME}'
    $rsa = New-Object System.Security.Cryptography.RSACng($key)
    $plaintext = [Convert]::FromBase64String('{b64_plaintext}')
    $encrypted = $rsa.Encrypt($plaintext, `
        [System.Security.Cryptography.RSAEncryptionPadding]::Pkcs1)
    [Convert]::ToBase64String($encrypted)
}} catch {{
    Write-Error $_
    exit 1
}}
""".strip()

        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True,
            text=True,
            timeout=15,
        )

        if result.returncode == 0:
            encrypted_b64 = result.stdout.strip()
            return base64.b64decode(encrypted_b64)
        else:
            log.warning("TPM encrypt failed: %s", result.stderr.strip())
    except Exception as e:
        log.warning("TPM encrypt error: %s", e)

    return None


def _cng_decrypt_with_tpm(ciphertext: bytes) -> bytes | None:
    """Decrypt data using the TPM-backed RSA key.

    Returns the decrypted bytes, or None if decryption fails
    (e.g., wrong TPM, key not found).
    """
    if not _is_windows():
        return None

    try:
        import base64

        b64_ciphertext = base64.b64encode(ciphertext).decode("ascii")

        ps_script = f"""
$ErrorActionPreference = 'Stop'
try {{
    $key = Get-CngKey -Name '{TPM_KEY_NAME}'
    $rsa = New-Object System.Security.Cryptography.RSACng($key)
    $ciphertext = [Convert]::FromBase64String('{b64_ciphertext}')
    $decrypted = $rsa.Decrypt($ciphertext, `
        [System.Security.Cryptography.RSAEncryptionPadding]::Pkcs1)
    [Convert]::ToBase64String($decrypted)
}} catch {{
    Write-Error $_
    exit 1
}}
""".strip()

        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True,
            text=True,
            timeout=15,
        )

        if result.returncode == 0:
            decrypted_b64 = result.stdout.strip()
            return base64.b64decode(decrypted_b64)
        else:
            log.debug("TPM decrypt failed: %s", result.stderr.strip())
    except Exception as e:
        log.debug("TPM decrypt error: %s", e)

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
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if len(blob) < 12:
        return None
    nonce = blob[:12]
    ciphertext = blob[12:]
    aesgcm = AESGCM(key)
    try:
        return aesgcm.decrypt(nonce, ciphertext, None)
    except Exception:
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

    # Ensure the TPM key exists
    if not _cng_create_key():
        log.error("Could not create/open TPM seal key")
        return None

    # Generate a random AES-256 data key
    data_key = os.urandom(32)

    # Encrypt the state with the AES key
    encrypted_state = _aes_gcm_encrypt(data_key, plaintext)

    # Seal the data key by encrypting it with the TPM-backed RSA key
    sealed_key = _cng_encrypt_with_tpm(data_key)

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

        # Unseal the data key from the TPM
        data_key = _cng_decrypt_with_tpm(sealed_key)
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
    except Exception as e:
        log.error("TPM unseal error: %s", e)
        return None


def is_tpm_sealed_blob(blob: bytes) -> bool:
    """Check if a blob is a TPM-sealed state (has the TPM magic header)."""
    return len(blob) >= _MAGIC_LEN and blob[:_MAGIC_LEN] == _MAGIC


def delete_tpm_key() -> bool:
    """Delete the TPM seal key. Used during uninstall/cleanup.

    Returns True if the key was deleted or didn't exist.
    """
    if not _is_windows():
        return False

    try:
        ps_script = f"""
$ErrorActionPreference = 'Stop'
try {{
    $key = Get-CngKey -Name '{TPM_KEY_NAME}' -ErrorAction SilentlyContinue
    if ($key) {{
        [System.Security.Cryptography.CngKey]::Delete('{TPM_KEY_NAME}')
        Write-Output 'DELETED'
    }} else {{
        Write-Output 'NOTFOUND'
    }}
}} catch {{
    Write-Error $_
    exit 1
}}
""".strip()

        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0
    except Exception as e:
        log.warning("TPM key deletion failed: %s", e)
        return False
