#!/usr/bin/env python3
"""SSH/SFTP helper for a spare test machine.

Connection details come from the environment — never hard-coded here (see S140;
this helper used to embed a host, a username and a six-character password).

Environment:
  RLS_SSH_HOST      host or IP (required)
  RLS_SSH_USER      username (required)
  RLS_SSH_KEY       path to a private key (preferred)
  RLS_SSH_PASSWORD  password (fallback; prefer keys)
  RLS_SSH_PORT      SSH port (default 22)
  RLS_SSH_INSECURE  set to 1 to accept unknown host keys (default: strict)

Usage:
  RLS_SSH_HOST=192.0.2.10 RLS_SSH_USER=admin \\
    python3 scripts/hp_ssh.py 'powercfg /a'
"""

import argparse
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
        ssh.load_system_host_keys()
        ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
    ssh.connect(timeout=10, **_connection_options())
    return ssh


def run_command(cmd, timeout=30):
    """Run a command on the test machine and return (stdout, stderr)."""
    ssh = _client()
    try:
        _stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode().strip()
        err = stderr.read().decode().strip()
    finally:
        ssh.close()
    return out, err


def upload_file(local_path, remote_path):
    """Upload a file to the test machine via SFTP."""
    ssh = _client()
    try:
        sftp = ssh.open_sftp()
        try:
            sftp.put(local_path, remote_path)
        finally:
            sftp.close()
    finally:
        ssh.close()


def download_file(remote_path, local_path):
    """Download a file from the test machine via SFTP."""
    ssh = _client()
    try:
        sftp = ssh.open_sftp()
        try:
            sftp.get(remote_path, local_path)
        finally:
            sftp.close()
    finally:
        ssh.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run commands on a test machine")
    parser.add_argument("command", help="Command to run")
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args()

    out, err = run_command(args.command, args.timeout)
    if out:
        print(out)
    if err:
        print("STDERR:", err, file=sys.stderr)
