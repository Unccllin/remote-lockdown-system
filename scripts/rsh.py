#!/usr/bin/env python3
"""Run a command on a test machine via SSH.

Connection details come from the environment. This file is tracked in git and
must never contain credentials — it previously hard-coded a host and a
plaintext password (still present in this repo's history, see S140).

Environment:
  RLS_SSH_HOST      host or IP (required)
  RLS_SSH_USER      username (required)
  RLS_SSH_KEY       path to a private key (preferred)
  RLS_SSH_PASSWORD  password (fallback; prefer keys)
  RLS_SSH_PORT      SSH port (default 22)
  RLS_SSH_INSECURE  set to 1 to accept unknown host keys (default: strict)

Usage:
  RLS_SSH_HOST=192.0.2.10 RLS_SSH_USER=admin python3 scripts/rsh.py 'uname -a'
"""

import os
import sys

import paramiko


def _connection_options():
    host = os.environ.get("RLS_SSH_HOST")
    user = os.environ.get("RLS_SSH_USER")
    if not host or not user:
        sys.exit(
            "RLS_SSH_HOST and RLS_SSH_USER must be set. Credentials are never "
            "stored in this repo — export them (or point RLS_SSH_KEY at a key) "
            "before running this helper."
        )

    password = os.environ.get("RLS_SSH_PASSWORD") or None
    key = os.environ.get("RLS_SSH_KEY") or None
    if not password and not key:
        sys.exit("Set RLS_SSH_KEY (preferred) or RLS_SSH_PASSWORD.")

    return {
        "hostname": host,
        "username": user,
        "port": int(os.environ.get("RLS_SSH_PORT", "22")),
        "key_filename": key,
        "password": password,
    }


def _client():
    ssh = paramiko.SSHClient()
    if os.environ.get("RLS_SSH_INSECURE") == "1":
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    else:
        # Verify the host key by default — an auto-accepting client cannot
        # tell the test box from anything else on the LAN.
        ssh.load_system_host_keys()
        ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
    ssh.connect(timeout=10, **_connection_options())
    return ssh


def run_remote(cmd, timeout=30):
    """Run a command on the test machine and return (stdout, stderr)."""
    ssh = _client()
    try:
        _stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode().strip()
        err = stderr.read().decode().strip()
    finally:
        ssh.close()
    return out, err


if __name__ == "__main__":
    command = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "echo OK"
    out, err = run_remote(command)
    if out:
        print(out)
    if err:
        print(f"STDERR: {err}", file=sys.stderr)
