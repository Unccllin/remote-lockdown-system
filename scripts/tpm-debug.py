#!/usr/bin/env python3
"""Minimal TPM2 swtpm debug: define PBL NV indices and read their public names."""
import os, socket, struct, subprocess, sys, time

STATE_DIR = "/tmp/pbl-debug-tpmstate"
SOCK = "/tmp/pbl-debug-swtpm.sock"
PIDFILE = "/tmp/pbl-debug-swtpm.pid"

def start_swtpm():
    subprocess.run(["rm", "-rf", STATE_DIR, SOCK, PIDFILE], check=False)
    os.makedirs(STATE_DIR, exist_ok=True)
    cmd = [
        "swtpm", "socket",
        "--tpmstate", f"dir={STATE_DIR}",
        "--server", f"type=unixio,path={SOCK}",
        "--tpm2",
        "--flags", "not-need-init",
        "--daemon",
        "--pid", f"file={PIDFILE}",
    ]
    subprocess.run(cmd, check=True)
    for _ in range(20):
        if os.path.exists(SOCK):
            break
        time.sleep(0.1)
    if not os.path.exists(SOCK):
        print("swtpm socket not created")
        sys.exit(1)

def stop_swtpm():
    try:
        with open(PIDFILE) as f:
            pid = int(f.read().strip())
        os.kill(pid, 15)
    except Exception:
        pass

def send_cmd(sock, payload):
    sock.sendall(payload)
    # Read header first
    hdr = sock.recv(10)
    if len(hdr) < 10:
        raise RuntimeError(f"short response: {hdr.hex()}")
    tag, size, code = struct.unpack(">HII", hdr)
    rest = b""
    while len(rest) < size - 10:
        chunk = sock.recv(size - 10 - len(rest))
        if not chunk:
            break
        rest += chunk
    return hdr + rest

def tpm_startup(sock):
    # TPM2_Startup(TPM_SU_CLEAR=0x0000)
    cmd = struct.pack(">HIIH", 0x8001, 12, 0x00000144, 0x0000)
    resp = send_cmd(sock, cmd)
    return resp

def tpm_nv_define(sock, nv_index, attrs, data_size, auth):
    # TPM2_NV_DefineSpace(authHandle, auth, publicInfo)
    # authHandle = TPM_RH_PLATFORM (0x4000000C)
    # TPM_ST_SESSIONS + 1 handle + TPM_RS_PW auth (empty)
    body = struct.pack(">I", 0x4000000C)          # authHandle
    auth_area = struct.pack(">I", 0x40000009)      # TPM_RS_PW
    auth_area += struct.pack(">H", 0)              # nonce size
    auth_area += b"\x00"                           # session attributes
    auth_area += struct.pack(">H", 0)              # hmac size
    body += struct.pack(">I", len(auth_area)) + auth_area
    # params
    body += struct.pack(">H", len(auth)) + auth    # TPM2B_AUTH
    # TPM2B_NV_PUBLIC: size=14 + TPMS_NV_PUBLIC
    public = struct.pack(">IH", nv_index, 0x000B)
    public += struct.pack(">I", attrs)
    public += struct.pack(">HH", 0, data_size)
    body += struct.pack(">H", len(public)) + public
    cmd = struct.pack(">HII", 0x8002, 10 + len(body), 0x0000012A) + body
    return send_cmd(sock, cmd)

def tpm_nv_read_public(sock, nv_index):
    cmd = struct.pack(">HII", 0x8001, 14, 0x00000169) + struct.pack(">I", nv_index)
    return send_cmd(sock, cmd)

def parse_nv_public(resp):
    # response: header(10) + TPM2B_NV_PUBLIC + TPM2B_NAME
    ptr = 10
    size = struct.unpack(">H", resp[ptr:ptr+2])[0]
    ptr += 2
    public = resp[ptr:ptr+size]
    ptr += size
    name_size = struct.unpack(">H", resp[ptr:ptr+2])[0]
    ptr += 2
    name = resp[ptr:ptr+name_size]
    return public, name

def compute_name(public):
    # Name = nameAlg(2) || SHA256(public)
    import hashlib
    return b"\x00\x0b" + hashlib.sha256(public).digest()

def main():
    start_swtpm()
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(SOCK)
        print("Startup:", tpm_startup(s).hex())

        auth = b"PBL_DEV_NV_AUTH_KEY_32B_LONG!!"
        attrs = 0x420D000D
        indices = [
            ("LOCK_STATE", 0x01C00001, attrs, 64),
            ("POLICY_VERSION", 0x01C00002, attrs | (1 << 4), 8),
            ("AK_NAME", 0x01C00003, attrs, 34),
        ]
        for label, idx, a, size in indices:
            r = tpm_nv_define(s, idx, a, size, auth)
            print(f"{label} define rc={struct.unpack('>I', r[6:10])[0]:04x}")
            r2 = tpm_nv_read_public(s, idx)
            if len(r2) < 14:
                print(f"{label} readpublic short")
                continue
            public, name = parse_nv_public(r2)
            print(f"{label} actual name: {name.hex()}")
            print(f"{label} computed name: {compute_name(public).hex()}")
            print(f"{label} match: {name == compute_name(public)}")
    finally:
        stop_swtpm()

if __name__ == "__main__":
    main()
