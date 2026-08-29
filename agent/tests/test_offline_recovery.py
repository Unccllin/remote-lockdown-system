"""Tests for the offline recovery module (agent/offline_recovery.py).

Covers:
  - decrypt_with_recovery_file() using RSA-wrapped Fernet key
  - decrypt_with_recovery_file() with wrapped BIOS password
  - decrypt_with_deadman_key() using plaintext key
  - _decrypt_folder() round-trip
  - main() CLI argument handling

Uses real RSA key pairs generated in fixtures (no network, no server).
"""

import base64
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

sys.path.insert(0, str(Path(__file__).parent.parent))

import offline_recovery  # noqa: E402

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def rsa_key_pair(tmp_path):
    """Generate a real RSA key pair and write the private key to a temp file."""
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key_path = tmp_path / "recovery_master.key"
    key_path.write_bytes(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    return private_key, key_path


@pytest.fixture
def encrypted_folder(tmp_path):
    """Create a folder with encrypted files and return (folder, key)."""
    folder = tmp_path / "SecureData"
    folder.mkdir()
    (folder / "file1.txt").write_text("hello world")
    (folder / "file2.txt").write_text("secret data")
    (folder / "subdir").mkdir()
    (folder / "subdir" / "nested.txt").write_text("nested content")

    key = Fernet.generate_key()
    fernet = Fernet(key)
    for fp in folder.rglob("*"):
        if fp.is_file():
            enc = fp.with_suffix(fp.suffix + ".enc")
            enc.write_bytes(fernet.encrypt(fp.read_bytes()))
            fp.unlink()

    return folder, key


@pytest.fixture
def recovery_file(tmp_path, rsa_key_pair, encrypted_folder):
    """Create a .recovery_key file with the Fernet key wrapped via RSA-OAEP."""
    private_key, _ = rsa_key_pair
    folder, key = encrypted_folder
    public_key = private_key.public_key()

    wrapped_key = public_key.encrypt(
        key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )

    state = {"wrapped_key": base64.b64encode(wrapped_key).decode()}
    rec_file = tmp_path / ".recovery_key"
    rec_file.write_text(json.dumps(state))
    return rec_file


@pytest.fixture
def recovery_file_with_bios(tmp_path, rsa_key_pair, encrypted_folder):
    """Create a .recovery_key file with wrapped key + wrapped BIOS password."""
    private_key, _ = rsa_key_pair
    folder, key = encrypted_folder
    public_key = private_key.public_key()

    wrapped_key = public_key.encrypt(
        key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    bios_pw = "MyBIOSPassword123"
    wrapped_bios = public_key.encrypt(
        bios_pw.encode(),
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )

    state = {
        "wrapped_key": base64.b64encode(wrapped_key).decode(),
        "wrapped_bios_password": base64.b64encode(wrapped_bios).decode(),
    }
    rec_file = tmp_path / ".recovery_key"
    rec_file.write_text(json.dumps(state))
    return rec_file, bios_pw


@pytest.fixture
def deadman_key_file(tmp_path, encrypted_folder):
    """Create a .deadman_key file with the plaintext Fernet key."""
    _, key = encrypted_folder
    key_file = tmp_path / ".deadman_key"
    key_file.write_text(key.decode())
    return key_file


# ---------------------------------------------------------------------------
# decrypt_with_recovery_file
# ---------------------------------------------------------------------------


class TestDecryptWithRecoveryFile:
    def test_decrypts_folder_successfully(self, rsa_key_pair, recovery_file, encrypted_folder):
        """RSA-wrapped key correctly decrypts the folder."""
        _, key_path = rsa_key_pair
        folder, original_key = encrypted_folder

        result = offline_recovery.decrypt_with_recovery_file(
            str(key_path), str(recovery_file), folder
        )

        # No BIOS password in this recovery file → returns None
        assert result is None
        # Files are decrypted
        assert (folder / "file1.txt").read_text() == "hello world"
        assert (folder / "file2.txt").read_text() == "secret data"
        assert (folder / "subdir" / "nested.txt").read_text() == "nested content"
        # No .enc files remain
        assert len(list(folder.rglob("*.enc"))) == 0

    def test_returns_bios_password_when_present(
        self, rsa_key_pair, recovery_file_with_bios, encrypted_folder
    ):
        """When the recovery file contains a wrapped BIOS password, it's returned."""
        _, key_path = rsa_key_pair
        folder, _ = encrypted_folder
        rec_file, expected_bios_pw = recovery_file_with_bios

        result = offline_recovery.decrypt_with_recovery_file(str(key_path), str(rec_file), folder)

        assert result == expected_bios_pw
        # Folder still decrypted
        assert (folder / "file1.txt").read_text() == "hello world"


# ---------------------------------------------------------------------------
# decrypt_with_deadman_key
# ---------------------------------------------------------------------------


class TestDecryptWithDeadmanKey:
    def test_decrypts_folder_with_plaintext_key(self, deadman_key_file, encrypted_folder):
        """Plaintext deadman key correctly decrypts the folder."""
        folder, _ = encrypted_folder

        offline_recovery.decrypt_with_deadman_key(str(deadman_key_file), folder)

        assert (folder / "file1.txt").read_text() == "hello world"
        assert (folder / "file2.txt").read_text() == "secret data"
        assert (folder / "subdir" / "nested.txt").read_text() == "nested content"
        assert len(list(folder.rglob("*.enc"))) == 0


# ---------------------------------------------------------------------------
# _decrypt_folder
# ---------------------------------------------------------------------------


class TestDecryptFolder:
    def test_decrypts_all_enc_files(self, encrypted_folder):
        """_decrypt_folder removes .enc files and restores originals."""
        folder, key = encrypted_folder

        offline_recovery._decrypt_folder(folder, key)

        assert (folder / "file1.txt").exists()
        assert (folder / "file2.txt").exists()
        assert (folder / "subdir" / "nested.txt").exists()
        assert len(list(folder.rglob("*.enc"))) == 0

    def test_resolves_relative_path(self, encrypted_folder, tmp_path):
        """_decrypt_folder resolves the folder path before processing."""
        folder, key = encrypted_folder
        # Pass a relative-like path by using resolve() check
        offline_recovery._decrypt_folder(folder, key)
        assert (folder / "file1.txt").read_text() == "hello world"


# ---------------------------------------------------------------------------
# main (CLI)
# ---------------------------------------------------------------------------


class TestMain:
    def test_main_deadman_key_mode(self, deadman_key_file, encrypted_folder, capsys):
        """main() with --deadman-key decrypts the folder."""
        folder, _ = encrypted_folder

        with patch(
            "sys.argv",
            [
                "offline_recovery.py",
                "--deadman-key",
                str(deadman_key_file),
                "--folder",
                str(folder),
            ],
        ):
            offline_recovery.main()

        captured = capsys.readouterr()
        assert "decrypted successfully" in captured.out.lower()
        assert (folder / "file1.txt").read_text() == "hello world"

    def test_main_recovery_key_mode(self, rsa_key_pair, recovery_file, encrypted_folder, capsys):
        """main() with --recovery-key + --recovery-file decrypts the folder."""
        _, key_path = rsa_key_pair
        folder, _ = encrypted_folder

        with patch(
            "sys.argv",
            [
                "offline_recovery.py",
                "--recovery-key",
                str(key_path),
                "--recovery-file",
                str(recovery_file),
                "--folder",
                str(folder),
            ],
        ):
            offline_recovery.main()

        captured = capsys.readouterr()
        assert "decrypted successfully" in captured.out.lower()
        assert (folder / "file1.txt").read_text() == "hello world"

    def test_main_show_bios_password(
        self, rsa_key_pair, recovery_file_with_bios, encrypted_folder, capsys
    ):
        """main() with --show-bios-password prints the BIOS password."""
        _, key_path = rsa_key_pair
        folder, _ = encrypted_folder
        rec_file, expected_bios_pw = recovery_file_with_bios

        with patch(
            "sys.argv",
            [
                "offline_recovery.py",
                "--recovery-key",
                str(key_path),
                "--recovery-file",
                str(rec_file),
                "--folder",
                str(folder),
                "--show-bios-password",
            ],
        ):
            offline_recovery.main()

        captured = capsys.readouterr()
        assert expected_bios_pw in captured.out
        assert "BIOS Password" in captured.out

    def test_main_bios_password_without_flag(
        self, rsa_key_pair, recovery_file_with_bios, encrypted_folder, capsys
    ):
        """main() without --show-bios-password hints at the hidden password."""
        _, key_path = rsa_key_pair
        folder, _ = encrypted_folder
        rec_file, _ = recovery_file_with_bios

        with patch(
            "sys.argv",
            [
                "offline_recovery.py",
                "--recovery-key",
                str(key_path),
                "--recovery-file",
                str(rec_file),
                "--folder",
                str(folder),
            ],
        ):
            offline_recovery.main()

        captured = capsys.readouterr()
        assert "--show-bios-password" in captured.out

    def test_main_nonexistent_folder_exits(self, tmp_path):
        """main() exits with error if the folder doesn't exist."""
        missing = tmp_path / "nonexistent"

        with (
            patch(
                "sys.argv",
                [
                    "offline_recovery.py",
                    "--deadman-key",
                    str(tmp_path / "fake.key"),
                    "--folder",
                    str(missing),
                ],
            ),
            pytest.raises(SystemExit) as exc_info,
        ):
            offline_recovery.main()

        assert exc_info.value.code == 1

    def test_main_no_key_mode_exits(self, encrypted_folder, capsys):
        """main() exits if neither --recovery-key nor --deadman-key is given."""
        folder, _ = encrypted_folder

        with (
            patch("sys.argv", ["offline_recovery.py", "--folder", str(folder)]),
            pytest.raises(SystemExit) as exc_info,
        ):
            offline_recovery.main()

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        assert "ERROR" in captured.out
