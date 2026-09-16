#!/usr/bin/env python3
"""Minimal reproduction: bound HMAC session NV_Read on the bound entity.

Hypothesis: for a bound session authorizing its bound entity, the HMAC key is
sessionKey alone (authValue already folded in via KDFa at StartAuthSession).
"""
import hashlib, hmac, os, socket, struct, subprocess, time

STATE_DIR = "/tmp/pbl-min-tpmstate"
SOCK = "/tmp/pbl-min-swtpm.sock"
PIDFILE = "/tmp/pbl-min-swtpm.pid"

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
    body = struct.pack(">I", TPM_RH_NULL) + struct.pack(">I", bind_handle)
    body += struct.pack(">H", 32) + nonce_caller
    body += struct.pack(">H", 0)
    body += struct.pack(">B", TPM_SE_HMAC)
    body += struct.pack(">H", TPM_ALG_AES) + struct.pack(">H", 256) + struct.pack(">H", TPM_ALG_CFB)
    body += struct.pack(">H", TPM_ALG_SHA256)
    cmd = struct.pack(">HII", TPM_ST_NO_SESSIONS, 10 + len(body), TPM_CC_START_AUTH_SESSION) + body
    r = send(sock, cmd)
    ptr = 10
    session_handle = struct.unpack(">I", r[ptr:ptr+4])[0]; ptr += 4
    n = struct.unpack(">H", r[ptr:ptr+2])[0]; ptr += 2
    return session_handle, nonce_caller, r[ptr:ptr+n]

def kdfa(key, label, ctx_u, ctx_v, bits):
    out = b""
    i = 0
    while len(out) * 8 < bits:
        i += 1
        out += hmac.new(key, struct.pack(">I", i) + label + b"\x00" + ctx_u + ctx_v + struct.pack(">I", bits), hashlib.sha256).digest()
    return out[:bits // 8]

def nv_name(nv_index, attrs, data_size):
    public = struct.pack(">IH", nv_index, TPM_ALG_SHA256) + struct.pack(">I", attrs) + struct.pack(">HH", 0, data_size)
    return b"\x00\x0b" + hashlib.sha256(public).digest()

TPMA_NV_WRITTEN = 0x20000000

def nv_read(sock, session_handle, nv_index, hmac_key, nonce_caller, nonce_tpm, written=False):
    name = nv_name(nv_index, ATTRS | (TPMA_NV_WRITTEN if written else 0), 64)
    hash_input = name + name + struct.pack(">HH", 64, 0)
    phash = hashlib.sha256(struct.pack(">I", TPM_CC_NV_READ) + hash_input).digest()
    attrs_b = b"\x01"  # continueSession
    hv = hmac.new(hmac_key, phash + nonce_caller + nonce_tpm + attrs_b, hashlib.sha256).digest()
    body = struct.pack(">I", nv_index) + struct.pack(">I", nv_index)
    auth_area = struct.pack(">I", session_handle) + struct.pack(">H", 32) + nonce_caller + attrs_b + struct.pack(">H", 32) + hv
    body += struct.pack(">I", len(auth_area)) + auth_area
    body += struct.pack(">HH", 64, 0)
    cmd = struct.pack(">HII", TPM_ST_SESSIONS, 10 + len(body), TPM_CC_NV_READ) + body
    return send(sock, cmd)

TPM_CC_NV_WRITE = 0x00000137

def nv_write(sock, session_handle, nv_index, data, hmac_key, nonce_caller, nonce_tpm):
    name = nv_name(nv_index, ATTRS, 64)
    params = name + name + struct.pack(">H", len(data)) + data + struct.pack(">H", 0)
    phash = hashlib.sha256(struct.pack(">I", TPM_CC_NV_WRITE) + params).digest()
    attrs_b = b"\x01"
    hv = hmac.new(hmac_key, phash + nonce_caller + nonce_tpm + attrs_b, hashlib.sha256).digest()
    body = struct.pack(">I", nv_index) + struct.pack(">I", nv_index)
    auth_area = struct.pack(">I", session_handle) + struct.pack(">H", 32) + nonce_caller + attrs_b + struct.pack(">H", 32) + hv
    body += struct.pack(">I", len(auth_area)) + auth_area
    body += struct.pack(">H", len(data)) + data + struct.pack(">H", 0)
    cmd = struct.pack(">HII", TPM_ST_SESSIONS, 10 + len(body), TPM_CC_NV_WRITE) + body
    return send(sock, cmd)

def main():
    start_swtpm()
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(SOCK)
        print("Startup rc:", f"{struct.unpack('>I', startup(s)[6:10])[0]:04x}")
        print("Define rc:", f"{struct.unpack('>I', nv_define(s, PBL_LOCK, ATTRS, 64)[6:10])[0]:04x}")
        sess, nc, nt = start_auth_session(s, PBL_LOCK)
        print(f"Session {sess:08x}")

        sk = kdfa(PBL_AUTH, b"ATH", nt, nc, 256)
        payload = bytes([0x50]) + b"PBL-LOCK-STATE-CACHE-TEST" + bytes(64 - 26)
        r = nv_write(s, sess, PBL_LOCK, payload, sk, os.urandom(32), nt)
        print(f"NV_Write bound-entity key=sk: rc={struct.unpack('>I', r[6:10])[0]:04x}")
        # nonceTPM rolls: parse new nonceTPM from response auth area
        print(f"  write resp len={len(r)} hex={r.hex()}")
        n2 = struct.unpack('>H', r[14:16])[0]  # skip parameterSize(4)
        nt = r[16:16+n2]
        # after write: WRITTEN set -> Name changed -> includeAuth=SET -> key=sk||auth
        r = nv_read(s, sess, PBL_LOCK, sk + PBL_AUTH, os.urandom(32), nt, written=True)
        rc = struct.unpack('>I', r[6:10])[0]
        print(f"NV_Read  post-write key=sk||auth, written-name: rc={rc:04x}")
        if rc == 0:
            n = struct.unpack('>H', r[10:12])[0]
            print(f"  data[0]={r[12]:02x} len={n}")
    finally:
        stop_swtpm()

if __name__ == "__main__":
    main()
