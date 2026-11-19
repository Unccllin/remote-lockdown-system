/**
 * Tests for the served-enrolment routes on the Worker.
 *
 * Why these exist: `GET /api/enroll/setup.ps1` existed only in the Express
 * surface (`server/src/routes/enroll.js`), so the one-liner the dashboard shows
 * — `iex (irm '<server>/api/enroll/setup.ps1')` — answered 404 for every
 * serverless deployment. Nothing failed, because each surface was asserted
 * separately. These tests pin the ports and the security properties:
 *
 *   * `setup.ps1` and `setup.cmd` are public (the target has no credential yet)
 *     and carry **no secret**: the token is prompted for on the machine, never
 *     placed in the URL (B-070 — query strings reach request logs).
 *   * `setup-command` is operator-gated, because it is the operator's copy-paste
 *     surface and returns server URLs and notes.
 *   * The script delegates to the installer (`--server-url`, `--token`) instead
 *     of re-implementing enrolment, and it checks reachability before
 *     downloading so an unreachable server fails with a sentence.
 */

import { describe, it, expect } from 'vitest';

class MockKV {
  private data: Record<string, string> = {};

  async get(key: string): Promise<string | null> {
    return this.data[key] ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data[key] = value;
  }

  async delete(key: string): Promise<void> {
    delete this.data[key];
  }

  async list(): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
    return { keys: Object.keys(this.data).map((name) => ({ name })), list_complete: true };
  }
}

const BASE = 'https://lockdown.example.com';

function makeEnv(): { ADMIN_TOKEN: string; LOCKDOWN_KV: MockKV } {
  return { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: new MockKV() };
}

async function getWorker() {
  const mod = await import('./worker.js');
  return mod.default as { fetch: (req: Request, env: unknown) => Promise<Response> };
}

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, { method: 'GET', headers });
}

describe('served enrolment (the dashboard one-liner)', () => {
  it('serves setup.ps1 publicly, without a token in the URL', async () => {
    const worker = await getWorker();
    const resp = await worker.fetch(req('/api/enroll/setup.ps1'), makeEnv());
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Content-Type')).toContain('text/plain');
    expect(resp.headers.get('Cache-Control')).toBe('no-store');

    const body = await resp.text();
    // The script builds the URL from its $u variable, so assert the paths it names.
    expect(body).toContain('/api/download/installer');
    // The installer looks for the agent BESIDE itself (installer.py find_agent_exe),
    // so the script must stage it under exactly that name or the run dies.
    expect(body).toContain('/api/download/agent');
    expect(body).toContain('lockdown-agent.exe');
    // The frozen installer cannot install the service on its own: it copies only the
    // agent, and service_installer needs a frozen lockdown-service.exe in the install
    // dir. Without this the install "succeeds" (exit 0) and the device never checks in.
    expect(body).toContain('/api/download/service');
    // ... but it is NOT copied into place here. The script did that until S270, and a
    // copy over a RUNNING service fails with "used by another process": with
    // $ErrorActionPreference='Stop' that aborted the run before the installer started,
    // exiting 1. installer.py::install_files owns the staging now — it stops the service
    // to replace the image and step 6 recreates and starts it.
    expect(body).not.toContain("Copy-Item (Join-Path $stage 'lockdown-service.exe')");
    // Downloads happen inside the elevated session, into a machine-wide staging
    // directory: elevation can switch accounts, and %TEMP% then belongs to someone
    // else — which is how "Cannot find lockdown-agent.exe" came back after staging.
    expect(body).toContain('LockdownAgent/staging');
    expect(body).toContain('lockdown-service.exe');
    expect(body).toContain('Test-NetConnection');
    // Silent install is the default — one command, no wizard.
    expect(body).toContain('LOCKDOWN_ENROLL_TOKEN');
    expect(body).toContain("Read-Host 'Enrollment token");
    expect(body).toContain('--silent');
    // The one property worth failing on: no secret may travel in the URL.
    expect(body).not.toMatch(/token=/);
  });

  it('served setup.ps1 contains no google_api_key even when env var is set (B-070)', async () => {
    const worker = await getWorker();
    const env = { ...makeEnv(), GOOGLE_API_KEY: 'secret-google-key-value' };
    const resp = await worker.fetch(req('/api/enroll/setup.ps1'), env);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).not.toContain('secret-google-key-value');
    expect(body).not.toContain('google_api_key');
  });

  it('still offers the wizard when INSTALLER_GUI=true', async () => {
    const worker = await getWorker();
    const env = { ...makeEnv(), INSTALLER_GUI: 'true' };
    const resp = await worker.fetch(req('/api/enroll/setup.ps1'), env);
    const body = await resp.text();
    expect(body).toContain('setup wizard');
    expect(body).toContain('Set-Clipboard');
    expect(body).not.toContain('--silent');
  });

  it('serves setup.cmd as an attachment that runs the same one-liner', async () => {
    const worker = await getWorker();
    const resp = await worker.fetch(req('/api/enroll/setup.cmd'), makeEnv());
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Content-Disposition')).toContain('lockdown-setup.cmd');

    const body = await resp.text();
    expect(body).toContain(`iex (irm '${BASE}/api/enroll/setup.ps1')`);
    // A script must not change the host's execution policy to run itself.
    expect(body).not.toContain('Set-ExecutionPolicy');
  });

  it('refuses setup-command without an admin credential', async () => {
    const worker = await getWorker();
    const resp = await worker.fetch(req('/api/enroll/setup-command'), makeEnv());
    expect(resp.status).toBe(401);
  });

  it('returns the one-liner and both URLs to an operator', async () => {
    const worker = await getWorker();
    const resp = await worker.fetch(
      req('/api/enroll/setup-command', { Authorization: 'Bearer test-admin-token' }),
      makeEnv(),
    );
    expect(resp.status).toBe(200);

    const data = (await resp.json()) as Record<string, string>;
    expect(data.server_url).toBe(BASE);
    expect(data.one_liner).toBe(`iex (irm '${BASE}/api/enroll/setup.ps1')`);
    expect(data.ps1_url).toBe(`${BASE}/api/enroll/setup.ps1`);
    expect(data.cmd_url).toBe(`${BASE}/api/enroll/setup.cmd`);
    expect(data.mode).toBe('silent');
  });

  it('passes the TLS decision to the installer and verifies what it wrote', async () => {
    const worker = await getWorker();
    // Same handler, different request origin — the script is composed from the
    // origin the target actually reached, not from a fixed setting.
    const plain = new Request('http://10.0.0.5:8787/api/enroll/setup.ps1', { method: 'GET' });
    const resp = await worker.fetch(plain, makeEnv());
    const body = await resp.text();

    // The agent refuses a plain-HTTP server unless its config says verify_tls false
    // ("key material must be transported over TLS"), and the installer owns that —
    // --allow-insecure-http is its flag. The Express surface has passed it for
    // months; this one did not, so every plain-HTTP lab install failed at the check
    // while the script's own post-install config patch sat unreachable behind it
    // (S270, MOLE: the installer printed "FAILED: this server URL is http://" and the
    // agent then refused to start).
    // Only the plain-HTTP branch of the verify_tls check may run. The marker is
    // substituted at compose time, so an https response says 'no' here and the branch
    // is unreachable rather than merely unexecuted.
    expect(body).toContain(".Replace('__PLAIN__', 'yes')")

    // And then the result is read back, not announced. The script no longer edits
    // config.json: takeown + icacls + a JSON rewrite was a manual step after install,
    // it fights tamper protection, and it cannot run when the install fails.
    expect(body).toContain('verify_tls in config: ');
    expect(body).toContain('FAILED: plain-HTTP server but verify_tls is not false');
    expect(body).not.toContain('takeown.exe');
    expect(body).not.toContain('[IO.File]::WriteAllText($cfg');
    expect(body).not.toContain('could not set verify_tls');
    expect(body).toContain('Restart-Service LockdownAgent');

    // The remedy has to name a real path. A backslash in a template literal is an
    // escape and JS drops unknown ones, so this line once rendered
    // "%PROGRAMDATA%LockdownAgentconfig.json" — advice that points at no file.
    expect(body).toContain('ProgramData');
    expect(body).toContain('LockdownAgent/install.log');
    expect(body).toContain('config.json');
    expect(body).not.toContain('LockdownAgentconfig');
  });

  it('does not weaken TLS for an https server', async () => {
    const worker = await getWorker();
    const resp = await worker.fetch(req('/api/enroll/setup.ps1'), makeEnv());
    const body = await resp.text();
    // The flag is plain-HTTP-only: an https deployment must never carry a switch that
    // turns certificate verification off. Asserted on the ARGUMENT form, because the
    // comment explaining it is part of the served text — and on the branch gate, since
    // the verify_tls text itself is present in both variants.
    expect(body).not.toContain(",'--allow-insecure-http'");
    expect(body).toContain(".Replace('__PLAIN__', 'no')");
  });
});

/**
 * The served install log is evidence, so it must belong to the run that printed it.
 *
 * S270, live on MOLE: a re-install over an installed machine exited 1 while the tail
 * shown read "Installation Complete". The installer had not run at all — `Copy-Item`
 * over the running `lockdown-service.exe` threw, `$ErrorActionPreference = 'Stop'`
 * aborted the script before the installer started, and the log on disk was the
 * PREVIOUS successful run's, which the wrapper printed as this run's output. A stale
 * log cannot be replayed if every run announces itself.
 */
describe('the served install log belongs to the run that prints it', () => {
  async function scriptBody(): Promise<string> {
    const worker = await getWorker();
    const resp = await worker.fetch(req('/api/enroll/setup.ps1'), makeEnv());
    return resp.text();
  }

  it('marks the start and the exit of every run', async () => {
    const body = await scriptBody();
    expect(body).toContain('=== installer run started ');
    expect(body).toContain('=== installer exited ');
    expect(body).toContain('" + $code + "');
    // The verdict is the installer process's own exit code, read from Start-Process —
    // not $LASTEXITCODE, which any later command in this script can overwrite.
    expect(body).toContain('-RedirectStandardOutput');
    expect(body).toContain('-RedirectStandardError');
    expect(body).toContain('$code = $p.ExitCode');
    // Nothing redirects the native call inline: under $ErrorActionPreference = 'Stop'
    // its FIRST stderr line is a terminating error, which aborted the run mid-flight and
    // kept exactly one line of a traceback (measured on MOLE, S270).
    expect(body).not.toContain('*>> $log');
    expect(body).not.toContain('--silent *> $log');
    expect(body).toContain('--- installer stderr ---');
  });

  it('writes an early abort into the log instead of dying silently', async () => {
    const body = await scriptBody();
    // $ErrorActionPreference is Stop, so a failed download or staging step ends the
    // script; without a trap that leaves no trace at all in the log being printed.
    expect(body).toContain('trap {');
    expect(body).toContain('ABORTED before the installer ran: ');
  });

  it('labels the tail as install.log, not as fresh installer output', async () => {
    const body = await scriptBody();
    expect(body).toContain("last 'installer run started' line");
  });
});

/**
 * Recovery must be reachable for a device that is locally locked but reports
 * `active` — the state a real machine got stuck in during S269: the agent held a
 * lock sentinel and re-locked every few seconds, while the server's last check-in
 * said active, and `recover` refused because it only accepted stolen/locked.
 */
describe('recover is usable on an enrolled device', () => {
  it('accepts a bodyless request and answers 400, not 500', async () => {
    const worker = await getWorker();
    const env = makeEnv();
    const req = new Request(`${BASE}/api/devices/does-not-exist/recover`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-token' },
    });
    const resp = await worker.fetch(req, env);
    // No such device → 404. The point is that the handler ran at all: an empty
    // body previously threw inside request.json() and surfaced as a 500.
    expect(resp.status).toBe(404);
  });
});

/**
 * Unlock must be handed the NEWEST escrowed key.
 *
 * After a second lockdown, `keys.find(...)` returned the first match — the oldest
 * key — so the agent decrypted current files with a stale key and failed with
 * cryptography.fernet.InvalidToken, while the correct key sat in KV untouched
 * (S269). Escrow appends, so the newest is the last element.
 */
describe('unlock key selection', () => {
  it('delivers the newest key, never the first match', async () => {
    const { readFileSync } = await import('fs');
    // The two sites that hand out an escrowed key have lived in different files since S280:
    // the check-in that releases it on unlock is in agent-routes.ts, the recover handler that
    // releases the key it rewrote stays in worker.ts. Both are read, so moving one again cannot
    // turn this assertion into a vacuous pass over a file that no longer contains the line.
    const src = ['./worker.ts', './agent-routes.ts']
      .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
      .join('\n');

    expect(src).toContain('deviceKeys[deviceKeys.length - 1]');
    expect(src).toContain('unreleased[unreleased.length - 1]');
    // The defect was a bare find() over the key list, which is first-match.
    expect(/keys\s*\.find\(/.test(src)).toBe(false);
  });
});
