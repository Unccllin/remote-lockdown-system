"""
State Cryptography Module
--------------------------
Encrypts and signs the agent's local state files (deadman, sentinel) using:
  1. Windows DPAPI (CryptProtectData) — binds data to the machine
  2. HMAC-SHA256 — detects tampering

On non-Windows (Linux/macOS), falls back to a simple XOR + HMAC (for testing).
The HMAC key is derived from the machine GUID, so encrypted state can only
be decrypted on the same machine it was encrypted on.

File format:
  [4 bytes: magic "LDS1"] [32 bytes: HMAC] [rest: DPAPI ciphertext]

Usage:
    from state_crypto import save_encrypted_state, load_encrypted_state

    save_encrypted_state(Path(".deadman"), {"status": "stolen", "last_seen": 123})
    state = load_encrypted_state(Path(".deadman"))  # None if missing/corrupt/tampered
"""

import hashlib
import hmac
import json
import logging
import platform
import subprocess
from pathlib import Path

log = logging.getLogger("lockdown-agent")

# File format magic + version
_MAGIC = b"LDS1"
_MAGIC_LEN = len(_MAGIC)
_HMAC_LEN = 32  # SHA-256 = 32 bytes

# DPAPI constants (Windows)
# CryptProtectData flags
CRYPTPROTECT_UI_FORBIDDEN = 0x01
CRYPTPROTECT_LOCAL_MACHINE = 0x00


def _is_windows() -> bool:
    return platform.system() == "Windows"


def _get_machine_guid() -> bytes:
    """Get a machine-specific key for HMAC.

    On Windows: reads the MachineGuid from the registry.
    On Linux: uses /etc/machine-id.
    On macOS: uses IOPlatformUUID.

    This binds the HMAC to the machine — a thief who copies the state file
    to a different machine can't forge a valid HMAC.
    """
    if _is_windows():
        try:
            result = subprocess.run(
                ["reg", "query",
                 r"HKLM\\SOFTWARE\\Microsoft\\Cryptography",
                 "/v", "MachineGuid"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                for line in result.stdout.split("\n"):
                    if "MachineGuid" in line:
                        guid = line.strip().split()[-1]
                        return guid.encode("utf-8")
        except Exception as e:
            log.debug("Could not read MachineGuid: %s", e)

    # Linux: /etc/machine-id
    try:
        mid = Path("/etc/machine-id").read_text().strip()
        if mid:
            return mid.encode("utf-8")
    except Exception as e:
        log.debug("Could not read /etc/machine-id: %s", e)

    # macOS: IOPlatformUUID
    try:
        result = subprocess.run(
            ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            for line in result.stdout.split("\n"):
                if "IOPlatformUUID" in line:
                    uuid = line.split('"')[-2]
                    return uuid.encode("utf-8")
    except Exception as e:
        log.debug("Could not read IOPlatformUUID: %s", e)

    # Fallback: hostname (weak but better than nothing)
    import socket
    return socket.gethostname().encode("utf-8")


def _get_hmac_key() -> bytes:
    """Derive the HMAC key from the machine GUID.

    Uses SHA-256 to derive a fixed-length key from the machine GUID.
    """
    guid = _get_machine_guid()
    return hashlib.sha256(b"lockdown-state-hmac-key:" + guid).digest()


# ---------------------------------------------------------------------------
# DPAPI (Windows only)
# ---------------------------------------------------------------------------

def _dpapi_protect(plaintext: bytes) -> bytes | None:
    """Encrypt data using Windows DPAPI (CryptProtectData).

    Binds the data to the current user + machine. The encrypted blob can
    only be decrypted on the same machine by the same user (or SYSTEM).

    Returns None if DPAPI is not available or encryption fails.
    """
    if not _is_windows():
        return None

    try:
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [
                ("cbData", wintypes.DWORD),
                ("pbData", ctypes.POINTER(ctypes.c_char)),
            ]

        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32

        # Prepare input blob
        in_blob = DATA_BLOB()
        in_blob.cbData = len(plaintext)
        in_blob.pbData = ctypes.cast(
            ctypes.create_string_buffer(plaintext, len(plaintext)),
            ctypes.POINTER(ctypes.c_char),
        )

        # Prepare output blob
        out_blob = DATA_BLOB()

        # Call CryptProtectData
        result = crypt32.CryptProtectData(
            ctypes.byref(in_blob),
            None,  # description
            None,  # optional entropy
            None,  # reserved
            None,  # prompt struct
            CRYPTPROTECT_UI_FORBIDDEN,
            ctypes.byref(out_blob),
        )

        if not result:
            log.error("CryptProtectData failed (GetLastError: %d)",
                      kernel32.GetLastError())
            return None

        # Extract encrypted data
        encrypted = ctypes.string_at(out_blob.pbData, out_blob.cbData)

        # Free the output buffer
        kernel32.LocalFree(out_blob.pbData)

        return encrypted
    except Exception as e:
        log.error("DPAPI encrypt failed: %s", e)
        return None


def _dpapi_unprotect(ciphertext: bytes) -> bytes | None:
    """Decrypt data using Windows DPAPI (CryptUnprotectData).

    Returns None if DPAPI is not available or decryption fails (e.g.,
    data was encrypted on a different machine).
    """
    if not _is_windows():
        return None

    try:
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [
                ("cbData", wintypes.DWORD),
                ("pbData", ctypes.POINTER(ctypes.c_char)),
            ]

        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32

        # Prepare input blob
        in_blob = DATA_BLOB()
        in_blob.cbData = len(ciphertext)
        in_blob.pbData = ctypes.cast(
            ctypes.create_string_buffer(ciphertext, len(ciphertext)),
            ctypes.POINTER(ctypes.c_char),
        )

        # Prepare output blob
        out_blob = DATA_BLOB()

        # Call CryptUnprotectData
        result = crypt32.CryptUnprotectData(
            ctypes.byref(in_blob),
            None,  # description out
            None,  # optional entropy
            None,  # reserved
            None,  # prompt struct
            CRYPTPROTECT_UI_FORBIDDEN,
            ctypes.byref(out_blob),
        )

        if not result:
            log.debug("CryptUnprotectData failed (GetLastError: %d)",
                      kernel32.GetLastError())
            return None

        # Extract decrypted data
        decrypted = ctypes.string_at(out_blob.pbData, out_blob.cbData)

        # Free the output buffer
        kernel32.LocalFree(out_blob.pbData)

        return decrypted
    except Exception as e:
        log.debug("DPAPI decrypt failed: %s", e)
        return None


# ---------------------------------------------------------------------------
# Fallback encryption (non-Windows, for testing)
# ---------------------------------------------------------------------------

def _fallback_encrypt(plaintext: bytes) -> bytes:
    """Simple XOR-based encryption for non-Windows testing.

    NOT secure — only for development/testing on Linux/macOS.
    On Windows, DPAPI is always used.
    """
    key = _get_hmac_key()
    # Simple repeating XOR (test only — not for production)
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(plaintext))


def _fallback_decrypt(ciphertext: bytes) -> bytes:
    """Decrypt the fallback XOR encryption."""
    return _fallback_encrypt(ciphertext)  # XOR is symmetric


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def encrypt_data(plaintext: bytes) -> bytes:
    """Encrypt data using DPAPI (Windows) or fallback (non-Windows)."""
    if _is_windows():
        encrypted = _dpapi_protect(plaintext)
        if encrypted is not None:
            return encrypted
        log.warning("DPAPI failed — falling back to XOR (NOT SECURE)")
    return _fallback_encrypt(plaintext)


def decrypt_data(ciphertext: bytes) -> bytes | None:
    """Decrypt data. Returns None if decryption fails (wrong machine, etc.)."""
    if _is_windows():
        decrypted = _dpapi_unprotect(ciphertext)
        if decrypted is not None:
            return decrypted
        log.warning("DPAPI decrypt failed — trying fallback")
    return _fallback_decrypt(ciphertext)


def save_encrypted_state(path: Path, data: dict) -> bool:
    """Encrypt, sign, and save a state dict to a file.

    File format: [magic] [HMAC] [encrypted JSON]

    Returns True if save succeeded.
    """
    try:
        plaintext = json.dumps(data, default=str).encode("utf-8")
        encrypted = encrypt_data(plaintext)

        # Sign the encrypted data (encrypt-then-MAC)
        key = _get_hmac_key()
        signature = hmac.new(key, encrypted, hashlib.sha256).digest()

        # Write: magic + HMAC + ciphertext
        blob = _MAGIC + signature + encrypted
        path.write_bytes(blob)
        return True
    except Exception as e:
        log.error("Failed to save encrypted state to %s: %s", path, e)
        return False


def load_encrypted_state(path: Path) -> dict | None:
    """Read, verify, and decrypt a state file.

    Returns the decrypted dict, or None if:
    - File doesn't exist
    - File is corrupt (wrong magic, wrong size)
    - HMAC verification fails (tampering detected)
    - Decryption fails (wrong machine, corrupted data)

    This is fail-secure: any error returns None, which the caller
    should treat as "state is missing/corrupt = possible tampering."
    """
    if not path.exists():
        return None

    try:
        blob = path.read_bytes()

        # Check magic
        if len(blob) < _MAGIC_LEN + _HMAC_LEN:
            log.warning("State file %s too small — corrupt", path)
            return None
        if blob[:_MAGIC_LEN] != _MAGIC:
            log.warning("State file %s has wrong magic — not an encrypted state file", path)
            return None

        # Extract HMAC and ciphertext
        stored_hmac = blob[_MAGIC_LEN:_MAGIC_LEN + _HMAC_LEN]
        ciphertext = blob[_MAGIC_LEN + _HMAC_LEN:]

        # Verify HMAC (encrypt-then-MAC)
        key = _get_hmac_key()
        expected_hmac = hmac.new(key, ciphertext, hashlib.sha256).digest()
        if not hmac.compare_digest(stored_hmac, expected_hmac):
            log.error("State file %s HMAC verification FAILED — tampering detected", path)
            return None

        # Decrypt
        plaintext = decrypt_data(ciphertext)
        if plaintext is None:
            log.error("State file %s decryption failed — wrong machine or corrupt", path)
            return None

        # Parse JSON
        return json.loads(plaintext.decode("utf-8"))
    except json.JSONDecodeError as e:
        log.warning("State file %s JSON parse failed: %s", path, e)
        return None
    except Exception as e:
        log.error("Failed to load encrypted state from %s: %s", path, e)
        return None


def is_encrypted_state_file(path: Path) -> bool:
    """Check if a file is an encrypted state file (has the magic header)."""
    if not path.exists():
        return False
    try:
        with open(path, "rb") as f:
            header = f.read(_MAGIC_LEN)
        return header == _MAGIC
    except Exception:
        return False
