#!/bin/bash
#
# tpm-seal-test.sh — TPM 2.0 Seal/Unseal Prototype
#
# Tests the full TPM 2.0 seal/unseal cycle using swtpm (software TPM emulator)
# and tpm2-tools. This is the Linux equivalent of what the Windows service
# would do using TBS API + TSS.MSR.
#
# The test:
# 1. Starts swtpm (software TPM 2.0 emulator)
# 2. Initializes the TPM (TPM2_Startup)
# 3. Creates a primary key (storage parent)
# 4. Reads PCR values (platform state)
# 5. Creates a PCR policy (binds to current platform state)
# 6. Seals a secret key into the TPM (bound to PCR policy)
# 7. Unseals the key (PCRs match → SUCCESS)
# 8. Modifies a PCR (simulates firmware tampering)
# 9. Attempts unseal again (PCRs changed → DENIED)
#
# Usage:
#   bash tpm-seal-test.sh
#
# Requirements:
#   - swtpm and tpm2-tools extracted in /tmp/tpm-pkgs/extract
#   - Or installed system-wide

set -euo pipefail

# --- Configuration ---
TPM_EXTRACT="${TPM_EXTRACT:-/tmp/tpm-pkgs/extract}"
SWTPM_DIR="${SWTPM_DIR:-/tmp/swtpm-seal-test}"
SECRET="${1:-ANTI-THEFT-DEVICE-KEY-7A3F9B2C}"
PCR_SELECTION="sha256:0,1,2,3"

# --- Environment setup ---
export LD_LIBRARY_PATH="$TPM_EXTRACT/usr/lib/x86_64-linux-gnu:$TPM_EXTRACT/usr/lib/x86_64-linux-gnu/swtpm:${LD_LIBRARY_PATH:-}"
export PATH="$TPM_EXTRACT/usr/bin:$PATH"
chmod +x "$TPM_EXTRACT/usr/bin/swtpm" "$TPM_EXTRACT/usr/bin/tpm2"* 2>/dev/null || true

# --- Functions ---
cleanup() {
    if [ -f "$SWTPM_DIR/swtpm.pid" ]; then
        kill "$(cat "$SWTPM_DIR/swtpm.pid")" 2>/dev/null || true
    fi
}
trap cleanup EXIT

start_swtpm() {
    echo "[1] Starting swtpm (TPM 2.0 emulator)..."
    rm -rf "$SWTPM_DIR"
    mkdir -p "$SWTPM_DIR"

    swtpm socket \
        --tpm2 \
        --tpmstate dir="$SWTPM_DIR" \
        --ctrl type=unixio,path="$SWTPM_DIR/swtpm.sock.ctrl" \
        --server type=unixio,path="$SWTPM_DIR/swtpm.sock" \
        --flags not-need-init \
        --daemon \
        --pid file="$SWTPM_DIR/swtpm.pid" \
        --log level=10,file="$SWTPM_DIR/swtpm.log"

    sleep 1
    echo "    PID: $(cat "$SWTPM_DIR/swtpm.pid")"
}

init_tpm() {
    echo "[2] Initializing TPM (TPM2_Startup)..."
    TPM2TOOLS_TCTI="swtpm:path=$SWTPM_DIR/swtpm.sock" tpm2_startup -c 2>&1
    echo "    TPM started"
}

create_primary() {
    echo "[3] Creating primary key (ECC, SHA-256, owner hierarchy)..."
    cd "$SWTPM_DIR"
    tpm2_createprimary -C o -g sha256 -G ecc 2>&1 | grep -E "^y:" || true
    echo "    Primary key created (handle 0x80000000)"
}

create_pcr_policy() {
    echo "[4] Reading PCRs and creating PCR policy..."
    echo "    PCR selection: $PCR_SELECTION"
    tpm2_pcrread -o pcr.bin "$PCR_SELECTION" 2>&1
    tpm2_createpolicy --policy-pcr -l "$PCR_SELECTION" -f pcr.bin -L pcr.policy 2>&1
    echo "    PCR policy created"
}

seal_secret() {
    echo "[5] Sealing secret into TPM..."
    echo "    Secret: '$SECRET'"
    echo "    Object type: keyedhash (sealed data)"
    echo "    Policy: PCR-bound ($PCR_SELECTION)"
    echo -n "$SECRET" | tpm2_create \
        -C 0x80000000 \
        -L pcr.policy \
        -i- \
        -u seal.pub \
        -r seal.priv \
        2>&1 | grep -E "keyedhash|policy" || true
    echo "    Secret sealed"
}

load_and_unseal() {
    echo "[6] Loading sealed object and unsealing..."
    tpm2_load -C 0x80000000 -u seal.pub -r seal.priv -c seal.ctx 2>&1 | grep -E "^name:" || true
    UNSEALED=$(tpm2_unseal -c seal.ctx -p "pcr:$PCR_SELECTION" 2>&1)
    echo "    Unsealed: '$UNSEALED'"

    if [ "$UNSEALED" = "$SECRET" ]; then
        echo "    [PASS] Seal/Unseal cycle SUCCESSFUL!"
        return 0
    else
        echo "    [FAIL] Data mismatch!"
        return 1
    fi
}

test_tamper_detection() {
    echo "[7] Testing tamper detection..."
    echo "    Extending PCR 0 (simulating firmware modification)..."
    EXTEND_HASH=$(echo -n "malicious-firmware-modification" | sha256sum | cut -d' ' -f1)
    tpm2_pcrextend 0:sha256="$EXTEND_HASH" 2>&1

    echo "    Attempting unseal after tampering..."
    if tpm2_unseal -c seal.ctx -p "pcr:$PCR_SELECTION" 2>/dev/null; then
        echo "    [FAIL] Unseal succeeded after tampering — policy not enforced!"
        return 1
    else
        echo "    [PASS] Unseal correctly DENIED after platform tampering!"
        echo "    The sealed key is protected against unauthorized platform changes."
        return 0
    fi
}

# --- Main ---
echo "========================================"
echo "  TPM 2.0 Seal/Unseal Prototype"
echo "  Anti-Theft Key Storage"
echo "========================================"
echo ""

export TPM2TOOLS_TCTI="swtpm:path=$SWTPM_DIR/swtpm.sock"

start_swtpm
echo ""
init_tpm
echo ""
create_primary
echo ""
create_pcr_policy
echo ""
seal_secret
echo ""
load_and_unseal
SEAL_RESULT=$?
echo ""
test_tamper_detection
TAMPER_RESULT=$?
echo ""

echo "========================================"
echo "  Results:"
echo "    Seal/Unseal:  $( [ $SEAL_RESULT -eq 0 ] && echo 'PASS' || echo 'FAIL' )"
echo "    Tamper detect: $( [ $TAMPER_RESULT -eq 0 ] && echo 'PASS' || echo 'FAIL' )"
echo "========================================"
echo ""
echo "Next steps:"
echo "  - Integrate with QEMU+OVMF for firmware-level TPM measurement"
echo "  - Port to Windows using TBS API (Tbsip_Submit_Command) or TSS.MSR"
echo "  - Seal to PCR-7 (Secure Boot state) for production use"
