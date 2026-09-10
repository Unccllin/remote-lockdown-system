#!/usr/bin/env python3
"""prepare-live-test.py — Prepare a USB drive for live PBL testing.

Downloads PblApp.efi and the server's signing key from the live
serverless Worker, builds a matching policy blob, enrolls a test
device, and prepares a USB drive image for booting on real hardware.

Usage:
    python3 prepare-live-test.py --server https://lockdown-serverless.mainacollins196.workers.dev
    python3 prepare-live-test.py --server https://... --output /tmp/pbl-usb.img
    python3 prepare-live-test.py --server https://... --device-id auto
    python3 prepare-live-test.py --server https://... --status locked

Requirements:
    pip install cryptography cbor2 requests

After running:
    - Flash the output image to a USB drive (dd or balenaEtcher)
    - Boot the target machine from the USB drive
    - PBL will fetch a live verdict from the serverless Worker
"""

import argparse
import hashlib
import json
import os
import struct
import subprocess
import sys
import time
from datetime import datetime, timezone

import cbor2
import requests

# ============================================================================
# Constants
# ============================================================================

COSE_ALG_ES256 = -7
DEFAULT_OUTPUT = "/tmp/pbl-live-test.img"
DEFAULT_DEVICE_ID = "test-device-0001"


# ============================================================================
# Server communication
# ============================================================================

def fetch_signing_key(server_url):
    """Fetch the server's verdict signing key info."""
    print(f"[...] Fetching signing key from {server_url}/v1/signing-key")
    resp = requests.get(f"{server_url}/v1/signing-key", timeout=10)
    resp.raise_for_status()
    key_info = resp.json()
    print(f"  [OK] kid: {key_info['kid_hex']}")
    print(f"  [OK] algorithm: {key_info['algorithm']}")
    print(f"  [OK] SPKI: {len(key_info['spki_base64'])} base64 chars")
    return key_info


def download_firmware(server_url, output_path):
    """Download PblApp.efi from the server."""
    print(f"[...] Downloading firmware from {server_url}/v1/firmware")
    resp = requests.get(f"{server_url}/v1/firmware", timeout=30)
    if resp.status_code == 404:
        print("  [ERROR] Firmware not uploaded to server.")
        print("         Run: base64 -w0 PblApp.efi | wrangler kv key put ...")
        sys.exit(1)
    resp.raise_for_status()
    with open(output_path, "wb") as f:
        f.write(resp.content)
    print(f"  [OK] Downloaded {len(resp.content)} bytes -> {output_path}")
    return output_path


def enroll_device(server_url, device_id):
    """Enroll a test device on the server."""
    print(f"[...] Enrolling device {device_id} on {server_url}")
    # Generate a fake device_id (32 bytes) from the string
    device_id_bytes = hashlib.sha256(device_id.encode()).digest()

    # Build CBOR enroll request
    enroll_request = cbor2.dumps({
        1: device_id_bytes,  # device_id (bstr 32)
        # ek_cert, ak_public, smbios are optional
    })

    resp = requests.post(
        f"{server_url}/v1/enroll",
        data=enroll_request,
        headers={"Content-Type": "application/cbor"},
        timeout=10,
    )

    if resp.status_code == 200:
        print(f"  [OK] Device enrolled: {device_id}")
        return device_id_bytes
    else:
        print(f"  [WARN] Enroll returned {resp.status_code}: {resp.text[:200]}")
        return device_id_bytes


def set_device_status(server_url, device_id_bytes, status):
    """Set device status (locked, active, tracking) via admin API."""
    device_id_hex = device_id_bytes.hex()
    print(f"[...] Setting device status to '{status}'")

    # Try the lock/unlock/track endpoints
    status_map = {
        "locked": "lock",
        "active": "unlock",
        "tracking": "track",
    }

    action = status_map.get(status)
    if not action:
        print(f"  [WARN] Unknown status '{status}' — skipping")
        return

    # These endpoints require admin auth — try without first
    resp = requests.post(
        f"{server_url}/v1/devices/{device_id_hex}/{action}",
        timeout=10,
    )

    if resp.status_code == 200:
        print(f"  [OK] Device status set to '{status}'")
    elif resp.status_code == 401:
        print(f"  [WARN] Admin auth required — device will default to 'active' (UNLOCKED)")
        print(f"         To lock: curl -X POST -H 'Authorization: Bearer <token>' {server_url}/v1/devices/{device_id_hex}/lock")
    else:
        print(f"  [WARN] Status set returned {resp.status_code}: {resp.text[:200]}")


# ============================================================================
# Policy blob generation
# ============================================================================

def build_protected_header(alg, kid):
    """Build a COSE protected header (CBOR map)."""
    return cbor2.dumps({1: alg, 4: kid})


def generate_policy(server_url, key_info, device_id_bytes):
    """Generate a policy blob matching the server's signing key."""
    print(f"[...] Building policy blob for {server_url}")

    kid = bytes.fromhex(key_info["kid_hex"])
    spki_der = bytes.fromhex(
        "".join(f"{b:02x}" for b in __import__("base64").b64decode(key_info["spki_base64"]))
    )

    # Build the policy payload (CBOR map)
    # Key 1: version (uint)
    # Key 2: issued_at (uint)
    # Key 70: lock_service_uri (tstr)
    # Key 71: lock_service_cert_pin (bstr 32) = kid = SHA-256 of SPKI
    # Key 76: verdict_signing_key_spki (bstr) = SPKI DER
    # Key 77: signing_cert_chain (array of bstr) = [spki_der as placeholder]
    #         Note: the server doesn't have a cert chain — it uses raw SPKI.
    #         The firmware will use the SPKI directly if no cert chain is provided.
    policy_payload = cbor2.dumps({
        1: 1,                    # version
        2: 0,                    # issued_at (uint)
        70: f"{server_url}/v1/verdict",  # lock_service_uri
        71: kid,                 # lock_service_cert_pin
        76: spki_der,            # verdict_signing_key_spki
        # Key 77: empty array — firmware will use SPKI from key 76
        77: [],                  # signing_cert_chain (empty — use pinned SPKI)
    })

    # Wrap in COSE_Sign1 with a dummy signature (policy signing key not provisioned)
    protected_header = build_protected_header(COSE_ALG_ES256, kid)
    dummy_sig = b"\x00" * 64

    policy_cose = cbor2.dumps([protected_header, {}, policy_payload, dummy_sig])

    print(f"  [OK] Policy blob: {len(policy_cose)} bytes")
    print(f"  [OK] lock_service_uri: {server_url}/v1/verdict")
    print(f"  [OK] kid: {kid.hex()}")
    print(f"  [OK] SPKI: {len(spki_der)} bytes")

    return policy_cose


# ============================================================================
# USB image creation
# ============================================================================

def create_usb_image(output_path, efi_path, policy_path):
    """Prepare files for a bootable USB drive with PBL firmware and policy.

    Creates a directory structure that can be copied to a FAT32-formatted
    USB drive. If mtools (mmd/mcopy) is available, also creates a complete
    USB image.
    """
    print(f"[...] Preparing USB files...")

    # Create output directory
    out_dir = os.path.dirname(output_path) or "."
    staging_dir = os.path.join(out_dir, "pbl-usb-staging")
    os.makedirs(os.path.join(staging_dir, "EFI/BOOT"), exist_ok=True)
    os.makedirs(os.path.join(staging_dir, "EFI/PBL"), exist_ok=True)

    # Copy files to staging directory
    import shutil
    shutil.copy2(efi_path, os.path.join(staging_dir, "EFI/BOOT/BOOTX64.EFI"))
    shutil.copy2(policy_path, os.path.join(staging_dir, "EFI/PBL/policy.cose"))

    print(f"  [OK] Files staged in: {staging_dir}/")
    print(f"       EFI/BOOT/BOOTX64.EFI  ({os.path.getsize(efi_path)} bytes)")
    print(f"       EFI/PBL/policy.cose   ({os.path.getsize(policy_path)} bytes)")

    # Try to create a full USB image
    # Method 1: mtools (mmd/mcopy) — no root required
    # Method 2: Docker with pbl-qemu image — no root required
    # Method 3: Manual copy — user copies files to a FAT32 USB drive

    has_mtools = False
    try:
        subprocess.run(["which", "mmd"], capture_output=True, check=True)
        has_mtools = True
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    has_docker = False
    try:
        subprocess.run(["which", "docker"], capture_output=True, check=True)
        has_docker = True
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    if has_mtools:
        print(f"  [...] Creating USB image with mtools: {output_path}")
        return _create_usb_image_mtools(output_path, efi_path, policy_path, staging_dir)

    if has_docker:
        print(f"  [...] Creating USB image with Docker: {output_path}")
        return _create_usb_image_docker(output_path, staging_dir)

    print(f"  [INFO] mtools/Docker not available — manual copy required")
    print(f"         1. Format a USB drive as FAT32 with GPT partition table")
    print(f"         2. Copy {staging_dir}/EFI/ to the USB drive root")
    print(f"         Or install mtools: sudo apt install mtools")
    return staging_dir


def _create_usb_image_mtools(output_path, efi_path, policy_path, staging_dir):
    """Create USB image using mtools (mmd/mcopy)."""
    img_size = 50 * 1024 * 1024
    with open(output_path, "wb") as f:
        f.truncate(img_size)

    print("  [...] Creating GPT partition table...")
    result = subprocess.run(
        ["sgdisk", "--clear", "--new=1:2048:0", "--typecode=1:EF00",
         "--change-name=1:ESP", output_path],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"  [WARN] sgdisk failed: {result.stderr}")
        print(f"         Copy files manually from {staging_dir}/ to a FAT32 USB drive")
        return staging_dir

    print("  [...] Creating FAT32 filesystem...")
    esp_img = output_path + ".esp"
    result = subprocess.run(
        ["mkfs.fat", "-F", "32", "-n", "PBLTEST", "-C", esp_img, "50176"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"  [WARN] mkfs.fat failed: {result.stderr}")
        print(f"         Copy files manually from {staging_dir}/ to a FAT32 USB drive")
        return staging_dir

    print("  [...] Copying firmware and policy to ESP...")
    for cmd in [
        ["mmd", "-i", esp_img, "::/EFI"],
        ["mmd", "-i", esp_img, "::/EFI/BOOT"],
        ["mmd", "-i", esp_img, "::/EFI/PBL"],
        ["mcopy", "-i", esp_img, efi_path, "::/EFI/BOOT/BOOTX64.EFI"],
        ["mcopy", "-i", esp_img, policy_path, "::/EFI/PBL/policy.cose"],
    ]:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"  [WARN] {cmd[0]} failed: {result.stderr}")
            print(f"         Copy files manually from {staging_dir}/ to a FAT32 USB drive")
            return staging_dir

    print("  [...] Writing ESP to image...")
    with open(esp_img, "rb") as f:
        esp_data = f.read()
    with open(output_path, "r+b") as f:
        f.seek(2048 * 512)
        f.write(esp_data)

    os.unlink(esp_img)
    print(f"  [OK] USB image created: {output_path}")
    print(f"       Flash to USB: dd if={output_path} of=/dev/sdX bs=4M")
    return output_path


def _create_usb_image_docker(output_path, staging_dir):
    """Create USB image using Docker (pbl-qemu image has mtools)."""
    out_dir = os.path.dirname(os.path.abspath(output_path)) or "."
    out_name = os.path.basename(output_path)

    # Ensure output directory is writable by Docker
    os.makedirs(out_dir, exist_ok=True)

    cmd = [
        "docker", "run", "--rm",
        "-v", f"{staging_dir}:/staging",
        "-v", f"{out_dir}:/output",
        "pbl-qemu:latest",
        "bash", "-c", f"""
set -e
OUTPUT="/output/{out_name}"
dd if=/dev/zero of="$OUTPUT" bs=1M count=50 status=none
sgdisk --clear --new=1:2048:0 --typecode=1:EF00 --change-name=1:ESP "$OUTPUT" 2>&1 | grep -v "^Warning" || true
ESP_IMG="/tmp/pbl-esp.img"
mkfs.fat -F 32 -n "PBLTEST" -C "$ESP_IMG" 50176 2>&1
mmd -i "$ESP_IMG" ::/EFI
mmd -i "$ESP_IMG" ::/EFI/BOOT
mmd -i "$ESP_IMG" ::/EFI/PBL
mcopy -i "$ESP_IMG" /staging/EFI/BOOT/BOOTX64.EFI ::/EFI/BOOT/BOOTX64.EFI
mcopy -i "$ESP_IMG" /staging/EFI/PBL/policy.cose ::/EFI/PBL/policy.cose
dd if="$ESP_IMG" of="$OUTPUT" bs=512 seek=2048 conv=notrunc status=none
rm "$ESP_IMG"
echo "USB image created: $OUTPUT"
""",
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        print(f"  [WARN] Docker USB image creation failed: {result.stderr}")
        print(f"         Copy files manually from {staging_dir}/ to a FAT32 USB drive")
        return staging_dir

    print(f"  [OK] USB image created: {output_path}")
    print(f"       Flash to USB: dd if={output_path} of=/dev/sdX bs=4M")
    return output_path


# ============================================================================
# Main
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description="Prepare live PBL test USB")
    parser.add_argument("--server", required=True,
                        help="Serverless Worker URL (e.g. https://lockdown-serverless.mainacollins196.workers.dev)")
    parser.add_argument("--output", default=DEFAULT_OUTPUT,
                        help=f"Output USB image path (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--device-id", default=DEFAULT_DEVICE_ID,
                        help=f"Test device ID (default: {DEFAULT_DEVICE_ID})")
    parser.add_argument("--status", default="active",
                        choices=["active", "locked", "tracking"],
                        help="Device status to set (default: active = UNLOCKED verdict)")
    parser.add_argument("--efi-path",
                        help="Path to PblApp.efi (if not downloading from server)")
    parser.add_argument("--skip-enroll", action="store_true",
                        help="Skip device enrollment (use if already enrolled)")
    args = parser.parse_args()

    server_url = args.server.rstrip("/")

    # Step 1: Download firmware
    efi_path = args.efi_path
    if efi_path is None:
        efi_path = "/tmp/PblApp.efi"
        download_firmware(server_url, efi_path)
    else:
        print(f"[OK] Using local firmware: {efi_path}")

    # Step 2: Fetch signing key
    key_info = fetch_signing_key(server_url)

    # Step 3: Enroll device
    device_id_bytes = hashlib.sha256(args.device_id.encode()).digest()
    if not args.skip_enroll:
        enroll_device(server_url, args.device_id)

    # Step 4: Set device status
    if args.status != "active":
        set_device_status(server_url, device_id_bytes, args.status)

    # Step 5: Build policy blob
    policy_path = "/tmp/pbl-live-policy.cose"
    policy_cose = generate_policy(server_url, key_info, device_id_bytes)
    with open(policy_path, "wb") as f:
        f.write(policy_cose)

    # Step 6: Create USB image
    create_usb_image(args.output, efi_path, policy_path)

    print()
    print("=" * 60)
    print("Live test USB prepared successfully!")
    print("=" * 60)
    print(f"Server:      {server_url}")
    print(f"Device ID:   {args.device_id}")
    print(f"Status:      {args.status}")
    print(f"USB image:   {args.output}")
    print()
    print("Next steps:")
    print(f"  1. Flash to USB: dd if={args.output} of=/dev/sdX bs=4M")
    print("  2. Boot target machine from USB (disable Secure Boot)")
    print("  3. PBL will fetch a live verdict from the server")
    print(f"  4. Expected verdict: {args.status.upper()}")
    if args.status == "active":
        print("     (UNLOCKED — but BLOCK due to missing BitLocker/DMA)")
    elif args.status == "locked":
        print("     (LOCKED — lock screen displayed)")
    elif args.status == "tracking":
        print("     (TRACKING — boots normally, agent reports location)")


if __name__ == "__main__":
    main()
