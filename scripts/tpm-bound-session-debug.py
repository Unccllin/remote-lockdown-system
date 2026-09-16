#!/usr/bin/env python3
"""Debug TPM2 bound HMAC session + NV_Read/NV_Write for PBL lock state."""
import hashlib, hmac, os, socket, struct, subprocess, sys, time

STATE_DIR = "/tmp/pbl-bound-tpmstate"
SOCK = "/tmp/pbl-bound-swtpm.sock"
PIDFILE = "/tmp/pbl-bound-swtpm.pid"

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
TPM_CC_NV_WRITE = 0x00000137
TPM_CC_NV_READ_PUBLIC = 0x00000169

PBL_AUTH = b"PBL_DEV_NV_AUTH_KEY_32B_LONG!!"
PBL_LOCK = 0x01C00001
PBL_POLICY = 0x01C00002
PBL_AK = 0x01C00003
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
    if len(hdr) < 10:
        raise RuntimeError("short response")
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

def nv_read_public(sock, nv_index):
    cmd = struct.pack(">HII", TPM_ST_NO_SESSIONS, 14, TPM_CC_NV_READ_PUBLIC) + struct.pack(">I", nv_index)
    return send(sock, cmd)

def nv_name(sock, nv_index):
    r = nv_read_public(sock, nv_index)
    ptr = 10
    size = struct.unpack(">H", r[ptr:ptr+2])[0]; ptr += 2
    public = r[ptr:ptr+size]; ptr += size
    name_size = struct.unpack(">H", r[ptr:ptr+2])[0]; ptr += 2
    return r[ptr:ptr+name_size]

def start_auth_session(sock, bind_handle):
    nonce_caller = os.urandom(32)
    body = struct.pack(">I", TPM_RH_NULL)
    body += struct.pack(">I", bind_handle)
    body += struct.pack(">H", 32) + nonce_caller
    body += struct.pack(">H", 0)          # salt
    body += struct.pack(">B", TPM_SE_HMAC)
    body += struct.pack(">H", TPM_ALG_AES) + struct.pack(">H", 256) + struct.pack(">H", TPM_ALG_CFB)
    body += struct.pack(">H", TPM_ALG_SHA256)
    cmd = struct.pack(">HII", TPM_ST_NO_SESSIONS, 10 + len(body), TPM_CC_START_AUTH_SESSION) + body
    r = send(sock, cmd)
    ptr = 10
    session_handle = struct.unpack(">I", r[ptr:ptr+4])[0]; ptr += 4
    nonce_size = struct.unpack(">H", r[ptr:ptr+2])[0]; ptr += 2
    nonce_tpm = r[ptr:ptr+nonce_size]; ptr += nonce_size
    return session_handle, nonce_caller, nonce_tpm

def kdfa(key, label, context_u, context_v, bits):
    result = b""
    counter = 0
    remaining = bits
    while remaining > 0:
        counter += 1
        msg = struct.pack(">I", counter)
        msg += label + b"\x00"
        msg += context_u + context_v
        msg += struct.pack(">I", bits)
        result += hmac.new(key, msg, hashlib.sha256).digest()
        remaining -= 256
    return result[:bits//8]

def compute_hmac(session_key, bind_auth, nonce_caller, nonce_tpm, session_attrs, cmd_code, hash_input):
    # pHash = SHA256(cmd_code || hash_input)
    phash = hashlib.sha256(struct.pack(">I", cmd_code) + hash_input).digest()
    # HMAC input = pHash || nonceCaller || nonceTPM || sessionAttributes
    hmac_input = phash + nonce_caller + nonce_tpm + bytes([session_attrs])
    key = session_key + bind_auth
    return hmac.new(key, hmac_input, hashlib.sha256).digest()

def nv_read(sock, session_handle, nv_index, size, offset, session_key, bind_auth, nonce_caller, nonce_tpm):
    # handles: authHandle, nvIndex
    name = nv_name(sock, nv_index)
    hash_input = name + name  # both handles same index
    params = struct.pack(">HH", size, offset)
    hash_input += params
    session_attrs = 0x01  # continueSession only
    hmac_val = compute_hmac(session_key, bind_auth, nonce_caller, nonce_tpm, session_attrs, TPM_CC_NV_READ, hash_input)

    body = struct.pack(">I", nv_index) + struct.pack(">I", nv_index)
    auth_area = struct.pack(">I", session_handle)
    auth_area += struct.pack(">H", 32) + nonce_caller
    auth_area += bytes([session_attrs])
    auth_area += struct.pack(">H", 32) + hmac_val
    body += struct.pack(">I", len(auth_area)) + auth_area
    body += params
    cmd = struct.pack(">HII", TPM_ST_SESSIONS, 10 + len(body), TPM_CC_NV_READ) + body
    return send(sock, cmd)

def nv_write(sock, session_handle, nv_index, data, offset, session_key, bind_auth, nonce_caller, nonce_tpm):
    name = nv_name(sock, nv_index)
    hash_input = name + name
    params = struct.pack(">H", len(data)) + data + struct.pack(">H", offset)
    hash_input += params
    session_attrs = 0x01
    hmac_val = compute_hmac(session_key, bind_auth, nonce_caller, nonce_tpm, session_attrs, TPM_CC_NV_WRITE, hash_input)

    body = struct.pack(">I", nv_index) + struct.pack(">I", nv_index)
    auth_area = struct.pack(">I", session_handle)
    auth_area += struct.pack(">H", 32) + nonce_caller
    auth_area += bytes([session_attrs])
    auth_area += struct.pack(">H", 32) + hmac_val
    body += struct.pack(">I", len(auth_area)) + auth_area
    body += params
    cmd = struct.pack(">HII", TPM_ST_SESSIONS, 10 + len(body), TPM_CC_NV_WRITE) + body
    return send(sock, cmd)

def main():
    start_swtpm()
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(SOCK)
        print("Startup rc:", struct.unpack(">I", startup(s)[6:10])[0])

        for idx, attrs, size in [(PBL_LOCK, ATTRS, 64), (PBL_POLICY, ATTRS | (1 << 4), 8), (PBL_AK, ATTRS, 34)]:
            r = nv_define(s, idx, attrs, size)
            print(f"Define {idx:08x} rc={struct.unpack('>I', r[6:10])[0]:04x}")

        # Start bound session to lock state
        sess, nc, nt = start_auth_session(s, PBL_LOCK)
        print(f"Session handle: {sess:08x}, nonceTPM len: {len(nt)}")

        session_key = kdfa(PBL_AUTH, b"ATH", nt, nc, 256)
        print(f"Session key: {session_key.hex()}")

        # Read lock state
        nc = os.urandom(32)
        r = nv_read(s, sess, PBL_LOCK, 64, 0, session_key, PBL_AUTH, nc, nt)
        rc = struct.unpack(">I", r[6:10])[0]
        print(f"NV_Read LOCK_STATE rc={rc:04x}")

        # Read policy version
        nc = os.urandom(32)
        r = nv_read(s, sess, PBL_POLICY, 8, 0, session_key, PBL_AUTH, nc, nt)
        rc = struct.unpack(">I", r[6:10])[0]
        print(f"NV_Read POLICY_VERSION rc={rc:04x}")

        # Write lock state
        nc = os.urandom(32)
        data = b"P" + bytes([1]) + b"\x00" * 62
        r = nv_write(s, sess, PBL_LOCK, data, 0, session_key, PBL_AUTH, nc, nt)
        rc = struct.unpack(">I", r[6:10])[0]
        print(f"NV_Write LOCK_STATE rc={rc:04x}")
    finally:
        stop_swtpm()

if __name__ == "__main__":
    main()
