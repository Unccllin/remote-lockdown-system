"""
Offline Recovery Tool — Remote Device Lockdown System
=====================================================

Standalone script for recovering a locked device when the server is
unavailable (destroyed, DB corrupted, KMS unreachable). Uses the
RSA-wrapped recovery key file (.recovery_key) written by the agent
during lockdown, combined with IT's offline master private key.

NO server connection, NO network, NO agent imports beyond decrypt_folder.
Works against a mounted disk image or the physical device.

PREREQUISITES:
  - IT holds the RSA private key (recovery_master.key) in a safe/HSM.
  - The locked device has a .recovery_key file in the agent install dir.
  - Python 3.10+ with `cryptography` installed.

USAGE:
  # Recover from a .recovery_key file (normal lockdown):
  python offline_recovery.py \\
      --recovery-key /safe/recovery_master.key \\
      --recovery-file /mnt/device/agent/.recovery_key \\
      --folder /mnt/device/SecureData

  # Recover from a .deadman_key file (deadman lockdown, plaintext key):
  python offline_recovery.py \\
      --deadman-key /mnt/device/agent/.deadman_key \\
      --folder /mnt/device/SecureData

  # Also print BIOS password if it was wrapped in the recovery file:
  python offline_recovery.py \\
      --recovery-key /safe/recovery_master.key \\
      --recovery-file /mnt/device/agent/.recovery_key \\
      --folder /mnt/device/SecureData \\
      --show-bios-password
"""

import argparse
import base64
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives import hashes
from cryptography.fernet import Fernet


def decrypt_with_recovery_file(recovery_key_path: str, recovery_file_path: str, folder: Path) -> str | None:
    """Decrypt folder using RSA-wrapped recovery key file."""
    # Load IT's private key
    private_key = serialization.load_pem_private_key(
        Path(recovery_key_path).read_bytes(),
        password=None,  # Assumes key is unencrypted; for encrypted keys, prompt for passphrase
    )

    # Load recovery file
    state = json.loads(Path(recovery_file_path).read_text())
    wrapped_key = base64.b64decode(state["wrapped_key"])

    # RSA-OAEP-decrypt to get the Fernet data key
    fernet_key = private_key.decrypt(
        wrapped_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )

    # Decrypt the folder
    _decrypt_folder(folder, fernet_key)
    print(f"Folder decrypted successfully: {folder}")

    # Return BIOS password if present
    if "wrapped_bios_password" in state:
        wrapped_bios = base64.b64decode(state["wrapped_bios_password"])
        bios_password = private_key.decrypt(
            wrapped_bios,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        ).decode()
        return bios_password
    return None


def decrypt_with_deadman_key(deadman_key_path: str, folder: Path) -> None:
    """Decrypt folder using plaintext deadman key file."""
    key_material = Path(deadman_key_path).read_text().strip()
    fernet_key = key_material.encode()
    _decrypt_folder(folder, fernet_key)
    print(f"Folder decrypted successfully: {folder}")


def _decrypt_folder(folder: Path, key: bytes) -> None:
    """Decrypt all .enc files inside `folder`."""
    folder = folder.resolve()
    fernet = Fernet(key)
    for enc_path in folder.rglob("*.enc"):
        if enc_path.is_file():
            data = enc_path.read_bytes()
            decrypted = fernet.decrypt(data)
            original_path = enc_path.with_suffix("")
            original_path.write_bytes(decrypted)
            enc_path.unlink()
            print(f"  Decrypted: {original_path.name}")


def main():
    parser = argparse.ArgumentParser(
        description="Offline recovery tool for Remote Device Lockdown System"
    )
    parser.add_argument(
        "--recovery-key", type=str,
        help="Path to IT's RSA private key (PEM format)"
    )
    parser.add_argument(
        "--recovery-file", type=str,
        help="Path to the .recovery_key file from the locked device"
    )
    parser.add_argument(
        "--deadman-key", type=str,
        help="Path to the .deadman_key file (plaintext Fernet key, alternative to --recovery-key)"
    )
    parser.add_argument(
        "--folder", type=str, required=True,
        help="Path to the encrypted folder to decrypt"
    )
    parser.add_argument(
        "--show-bios-password", action="store_true",
        help="Print the BIOS password if it was wrapped in the recovery file"
    )

    args = parser.parse_args()
    folder = Path(args.folder)

    if not folder.exists():
        print(f"ERROR: folder does not exist: {folder}")
        sys.exit(1)

    bios_password = None

    if args.deadman_key:
        # Plaintext deadman key mode
        decrypt_with_deadman_key(args.deadman_key, folder)
    elif args.recovery_key and args.recovery_file:
        # RSA-wrapped recovery key mode
        bios_password = decrypt_with_recovery_file(
            args.recovery_key, args.recovery_file, folder
        )
    else:
        print("ERROR: must specify either --recovery-key + --recovery-file OR --deadman-key")
        sys.exit(1)

    if bios_password and args.show_bios_password:
        print(f"\nBIOS Password (for manual UEFI/BCD lockdown removal): {bios_password}")
        print("NOTE: You must manually clear the BIOS password in UEFI setup.")
    elif bios_password:
        print("\nBIOS password was wrapped in the recovery file. Use --show-bios-password to display it.")


if __name__ == "__main__":
    main()
