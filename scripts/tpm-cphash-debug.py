#!/usr/bin/env python3
"""Test cpHash variations for bound HMAC NV_Read."""
import hashlib, hmac, os, socket, struct, subprocess, sys, time

STATE_DIR = "/tmp/pbl-cphash-tpmstate"
SOCK = "/tmp/pbl-cphash-swtpm.sock"
PIDFILE = "/tmp/pbl-cphash-swtpm.pid"

TPM_RH_NULL = 0x40000007
TPM_RH_PLATFORM = 0x4000000C
TPM_RS_PW = 0x40000009
TPM_ST_SESSIONS = 0x8002
TPM_ST_NO_SESSIONS = 0x8001
TPM_SE_HMAC = 0x00
TPM_ALG_AES = 0x0006
TPM_ALG_CFB = 0x0043
TPM_ALG_SHA256 = 0x000B
TPM_SU_CLEAR = 0x0000
TPM_CC_STARTUP = 0x00000144
TPM_CC_START_AUTH_SESSION = 0x00000176
TPM_CC_NV_DEFINE_SPACE = 0x0000012A
TPM_CC_NV_READ = 0x0000014E

PBL_AUTH = b"PBL_DEV_NV_AUTH_KEY_32B_LONG!!"
PBL_LOCK = 0x01C00001
PBL_POLICY = 0x01C00002
ATTRS = 0x420D000D

def start_swtpm():
    subprocess.run(["rm", "-rf", STATE_DIR, SOCK, PIDFILE], check=False)
    os.makedirs(STATE_DIR, exist_ok=True)
    subprocess.run([
        "swtpm", "socket",
        "--tpmstate", f"dir={STATE_DIR}",
        "--server", f"type=unixio,path={SOCK}",
        "--tpm2", "--flags", "not-need-init",
        "--daemon", "--pid", f"file={PIDFILE}",
    ], check=True)
    for _ in range(20):
        if os.path.exists(SOCK):
            break
        time.sleep(0.1)

def stop_swtpm():
    try:
        with open(PIDFILE) as f:
            os.kill(int(f.read().strip()), 15)
    except Exception:
        pass

def send(sock, payload):
    sock.sendall(payload)
    hdr = sock.recv(10)
    tag, size, code = struct.unpack(">HII", hdr)
    rest = b""
    while len(rest) < size - 10:
        rest += sock.recv(size - 10 - len(rest))
    return hdr + rest

def startup(sock):
    return send(sock, struct.pack(">HIIH", TPM_ST_NO_SESSIONS, 12, TPM_CC_STARTUP, TPM_SU_CLEAR))

def nv_define(sock, nv_index, attrs, data_size):
    body = struct.pack(">I", TPM_RH_PLATFORM)
    auth_area = struct.pack(">I", TPM_RS_PW) + struct.pack(">H", 0) + b"\x00" + struct.pack(">H", 0)
    body += struct.pack(">I", len(auth_area)) + auth_area
    body += struct.pack(">H", len(PBL_AUTH)) + PBL_AUTH
    public = struct.pack(">IH", nv_index, TPM_ALG_SHA256)
    public += struct.pack(">I", attrs)
    public += struct.pack(">HH", 0, data_size)
    body += struct.pack(">H", len(public)) + public
    cmd = struct.pack(">HII", TPM_ST_SESSIONS, 10 + len(body), TPM_CC_NV_DEFINE_SPACE) + body
    return send(sock, cmd)

def start_auth_session(sock, bind_handle):
    nonce_caller = os.urandom(32)
    body = struct.pack(">I", TPM_RH_NULL)
    body += struct.pack(">I", bind_handle)
    body += struct.pack(">H", 32) + nonce_caller
    body += struct.pack(">H", 0)
    body += struct.pack(">B", TPM_SE_HMAC)
    body += struct.pack(">H", TPM_ALG_AES) + struct.pack(">H", 256) + struct.pack(">H", TPM_ALG_CFB)
    body += struct.pack(">H", TPM_ALG_SHA256)
    cmd = struct.pack(">HII", TPM_ST_NO_SESSIONS, 10 + len(body), TPM_CC_START_AUTH_SESSION) + body
    r = send(sock, cmd)
    ptr = 10
    session_handle = struct.unpack(">I", r[ptr:ptr+4])[0]; ptr += 4
    nonce_size = struct.unpack(">H", r[ptr:ptr+2])[0]; ptr += 2
    nonce_tpm = r[ptr:ptr+nonce_size]
    return session_handle, nonce_caller, nonce_tpm

def kdfa(key, label, context_u, context_v, bits):
    result = b""
    counter = 0
    remaining = bits
    while remaining > 0:
        counter += 1
        msg = struct.pack(">I", counter) + label + b"\x00" + context_u + context_v + struct.pack(">I", bits)
        result += hmac.new(key, msg, hashlib.sha256).digest()
        remaining -= 256
    return result[:bits//8]

def compute_hmac(session_key, bind_auth, nonce_caller, nonce_tpm, session_attrs, cmd_code, hash_input):
    phash = hashlib.sha256(struct.pack(">I", cmd_code) + hash_input).digest()
    hmac_input = phash + nonce_caller + nonce_tpm + bytes([session_attrs])
    key = session_key + bind_auth
    return hmac.new(key, hmac_input, hashlib.sha256).digest()

def nv_name(nv_index, attrs, data_size):
    public = struct.pack(">IH", nv_index, TPM_ALG_SHA256)
    public += struct.pack(">I", attrs)
    public += struct.pack(">HH", 0, data_size)
    return b"\x00\x0b" + hashlib.sha256(public).digest()

def nv_read(sock, session_handle, nv_index, size, offset, session_key, bind_auth, nonce_caller, nonce_tpm, hash_input):
    session_attrs = 0x01
    hmac_val = compute_hmac(session_key, bind_auth, nonce_caller, nonce_tpm, session_attrs, TPM_CC_NV_READ, hash_input)
    body = struct.pack(">I", nv_index) + struct.pack(">I", nv_index)
    auth_area = struct.pack(">I", session_handle) + struct.pack(">H", 32) + nonce_caller + bytes([session_attrs]) + struct.pack(">H", 32) + hmac_val
    body += struct.pack(">I", len(auth_area)) + auth_area
    body += struct.pack(">HH", size, offset)
    cmd = struct.pack(">HII", TPM_ST_SESSIONS, 10 + len(body), TPM_CC_NV_READ) + body
    return send(sock, cmd)

def main():
    start_swtpm()
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(SOCK)
        print("Startup rc:", struct.unpack(">I", startup(s)[6:10])[0])
        for idx, attrs, size in [(PBL_LOCK, ATTRS, 64), (PBL_POLICY, ATTRS | (1 << 4), 8)]:
            r = nv_define(s, idx, attrs, size)
            print(f"Define {idx:08x} rc={struct.unpack('>I', r[6:10])[0]:04x}")

        sess, nc, nt = start_auth_session(s, PBL_LOCK)
        print(f"Session handle: {sess:08x}, nonceTPM len: {len(nt)}")

        session_key = kdfa(PBL_AUTH, b"ATH", nt, nc, 256)
        print(f"Session key: {session_key.hex()}")

        name_lock = nv_name(PBL_LOCK, ATTRS, 64)
        name_policy = nv_name(PBL_POLICY, ATTRS | (1 << 4), 8)
        params_lock = struct.pack(">HH", 64, 0)
        params_policy = struct.pack(">HH", 8, 0)

        # Test different cpHash inputs for LOCK_STATE
        tests = [
            ("two names", name_lock + name_lock + params_lock),
            ("one name", name_lock + params_lock),
            ("no names", params_lock),
            ("handle bytes", struct.pack(">II", PBL_LOCK, PBL_LOCK) + params_lock),
        ]
        for label, hi in tests:
            nc2 = os.urandom(32)
            r = nv_read(s, sess, PBL_LOCK, 64, 0, session_key, PBL_AUTH, nc2, nt, hi)
            rc = struct.unpack(">I", r[6:10])[0]
            print(f"LOCK_STATE {label}: rc={rc:04x}")

        # Test POLICY_VERSION with two names (control)
        nc2 = os.urandom(32)
        hi = name_policy + name_policy + params_policy
        r = nv_read(s, sess, PBL_POLICY, 8, 0, session_key, PBL_AUTH, nc2, nt, hi)
        rc = struct.unpack(">I", r[6:10])[0]
        print(f"POLICY_VERSION two names: rc={rc:04x}")
    finally:
        stop_swtpm()

if __name__ == "__main__":
    main()
