#!/usr/bin/env python3
"""Run a command on the test machine via SSH."""
import paramiko
import sys

def run_remote(cmd, timeout=30):
    """Run a command on the test machine and return output."""
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect('192.168.1.219', username='Hp', key_filename='/home/cllin/.ssh/id_ed25519', timeout=10)
    except Exception:
        # Fall back to password
        ssh.connect('192.168.1.219', username='Hp', password='***REMOVED-CREDENTIAL-S140***', timeout=10)
    
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    ssh.close()
    return out, err

if __name__ == '__main__':
    cmd = ' '.join(sys.argv[1:]) if len(sys.argv) > 1 else 'echo OK'
    out, err = run_remote(cmd)
    if out: print(out)
    if err: print(f"STDERR: {err}", file=sys.stderr)
