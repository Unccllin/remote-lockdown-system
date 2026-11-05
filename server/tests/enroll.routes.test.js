/**
 * Token enrolment — POST /api/enroll/token (admin) + POST /api/enroll/claim (device).
 *
 * The Worker has had this flow all along and both the dashboard's Enroll page and
 * `agent/installer.py --token` are written against it, but the Express server
 * implemented neither endpoint: token enrolment 404'd on self-hosted deployments
 * (S204). These tests pin the contract the two clients already assume.
 */

const request = require('supertest');

const { mockPool, makeToken, createApp } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const enrollRoutes = require('../src/routes/enroll');
const { hashApiKey } = require('../src/db/apiKey');

const app = createApp({ enroll: enrollRoutes });

const HASH_64 = /^[0-9a-f]{64}$/;

beforeEach(() => {
  mockPool.query.reset();
});

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

describe('POST /api/enroll/token', () => {
  test('requires auth', async () => {
    const res = await request(app).post('/api/enroll/token');
    expect(res.status).toBe(401);
  });

  test('requires at least operator', async () => {
    const res = await request(app)
      .post('/api/enroll/token')
      .set('Authorization', `Bearer ${makeToken('admin-1', 'viewer', 'viewer')}`);
    expect(res.status).toBe(403);
  });

  test('issues a 15-minute token and stores only its hash', async () => {
    const res = await request(app)
      .post('/api/enroll/token')
      .set('Authorization', `Bearer ${makeToken('admin-1')}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThanOrEqual(40); // 32 random bytes, base64
    expect(res.body.expires_in).toBe(900);

    const ttlMs = new Date(res.body.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(890_000);
    expect(ttlMs).toBeLessThanOrEqual(900_000);

    const insert = mockPool.query.mock.calls.find((c) =>
      /INSERT INTO enrollment_tokens/.test(c[0])
    );
    expect(insert).toBeTruthy();
    const [, params] = insert;
    // params: [id, token_hash, created_by, created_at, expires_at]
    expect(params[1]).toMatch(HASH_64);
    // The stored value must NOT be the token itself — a DB read is not a replay.
    expect(params[1]).not.toBe(res.body.token);
    expect(params[2]).toBe('admin-1'); // provenance for the audit row
  });
});

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

describe('POST /api/enroll/claim', () => {
  const futureIso = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();

  function tokenRow(overrides = {}) {
    return {
      id: 'tok-1',
      token_hash: 'x'.repeat(64),
      created_by: 'admin-1',
      created_at: new Date().toISOString(),
      expires_at: futureIso(),
      used_at: null,
      ...overrides,
    };
  }

  test('rejects a request without a token', async () => {
    const res = await request(app).post('/api/enroll/claim').send({ hostname: 'PC-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token required/i);
  });

  test('rejects a request without a hostname', async () => {
    const res = await request(app).post('/api/enroll/claim').send({ token: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hostname required/i);
  });

  test('distinguishes an unknown token from one that was already used', async () => {
    // "invalid" and "spent" need different operator actions: one is a typo, the
    // other needs a fresh token. Merging them made a retry look like a bad token.
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', { rows: [] });
    const unknown = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'nope', hostname: 'PC-1' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe('Invalid enrollment token');

    mockPool.query.reset();
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', {
      rows: [tokenRow({ used_at: new Date().toISOString() })],
    });
    const used = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'spent', hostname: 'PC-2' });
    expect(used.status).toBe(401);
    expect(used.body.error).toMatch(/already used — generate a new one/);
  });

  test('trims whitespace around the token before hashing it', async () => {
    // A token copied out of the dashboard and pasted into a shell arrives padded
    // more often than not; hashing " abc" never matches.
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', { rows: [tokenRow()] });
    mockPool.query.setResult('UPDATE enrollment_tokens', { rows: [], rowCount: 1 });
    mockPool.query.setResult('INSERT INTO devices', {
      rows: [{ id: 'dev-9', hostname: 'PC-9', status: 'active' }],
    });

    const res = await request(app)
      .post('/api/enroll/claim')
      .send({ token: '  padded-token  ', hostname: 'PC-9' });

    expect(res.status).toBe(201);
    const lookup = mockPool.query.mock.calls.find((c) =>
      /SELECT \* FROM enrollment_tokens/.test(c[0])
    );
    // The hash must be of the trimmed value, not of the padded one.
    const { createHash } = require('crypto');
    expect(lookup[1][0]).toBe(createHash('sha256').update('padded-token').digest('hex'));
  });

  test('rejects an unknown token', async () => {
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', { rows: [] });

    const res = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'nope', hostname: 'PC-1' });

    expect(res.status).toBe(401);
    // Deliberately not "or already-used": an unknown token is a different problem
    // from a spent one, and the two need different operator actions (S211).
    expect(res.body.error).toBe('Invalid enrollment token');
  });

  test('rejects an already-used token', async () => {
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', {
      rows: [tokenRow({ used_at: new Date().toISOString() })],
    });

    const res = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'used', hostname: 'PC-1' });

    expect(res.status).toBe(401);
  });

  test('rejects an expired token', async () => {
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', {
      rows: [tokenRow({ expires_at: new Date(Date.now() - 1000).toISOString() })],
    });

    const res = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'stale', hostname: 'PC-1' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  test('rejects when the single-use update loses the race', async () => {
    // Another claim consumed the token between the SELECT and the UPDATE.
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', { rows: [tokenRow()] });
    mockPool.query.setResult('UPDATE enrollment_tokens', { rows: [], rowCount: 0 });

    const res = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'race', hostname: 'PC-1' });

    expect(res.status).toBe(401);
  });

  test('creates the device and returns a key whose hash was stored', async () => {
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', { rows: [tokenRow()] });
    mockPool.query.setResult('UPDATE enrollment_tokens', { rows: [], rowCount: 1 });
    mockPool.query.setResult('INSERT INTO devices', {
      rows: [{ id: 'dev-9', hostname: 'PC-9', owner_name: 'Ops', status: 'active' }],
    });

    const res = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'good', hostname: 'PC-9', owner_name: 'Ops', serial_number: 'SN-9' });

    expect(res.status).toBe(201);
    expect(res.body.device.id).toBe('dev-9');
    expect(typeof res.body.api_key).toBe('string');

    const insert = mockPool.query.mock.calls.find((c) => /INSERT INTO devices/.test(c[0]));
    const params = insert[1];
    // The plaintext key is returned, never stored; what lands in the row is its hash.
    expect(params).toContain(hashApiKey(res.body.api_key));
    expect(params).toContain('SN-9');
    expect(params).not.toContain(res.body.api_key);

    const audit = mockPool.query.mock.calls.find((c) => /INSERT INTO audit_log/.test(c[0]));
    expect(audit[1][2]).toBe('device_enrolled');
    // Provenance: the admin who minted the token authorised this enrolment.
    expect(audit[1][1]).toBe('admin-1');
    expect(audit[1][3].via).toBe('enrollment_token');
  });

  test('re-associates an existing machine instead of duplicating it', async () => {
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', { rows: [tokenRow()] });
    mockPool.query.setResult('UPDATE enrollment_tokens', { rows: [], rowCount: 1 });
    mockPool.query.setResult('SELECT * FROM devices WHERE hardware_uuid', {
      rows: [{ id: 'dev-1', hardware_uuid: 'HW-1' }],
    });
    mockPool.query.setResult('UPDATE devices', {
      rows: [{ id: 'dev-1', hostname: 'PC-1', hardware_uuid: 'HW-1', status: 'active' }],
    });

    const res = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'good', hostname: 'PC-1', hardware_uuid: 'HW-1' });

    expect(res.status).toBe(200);
    expect(res.body.reassociated).toBe(true);
    expect(res.body.device.id).toBe('dev-1');
    // No second row is created for the same hardware.
    expect(
      mockPool.query.mock.calls.some((c) => /INSERT INTO devices/.test(c[0]))
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/enroll/setup-command (S214)
//
// The command is composed server-side because both past failures came from the
// browser composing it: a URL only this machine could resolve, and a hostname the
// operator mistyped out of a chat window.
// ---------------------------------------------------------------------------

describe('GET /api/enroll/setup-command', () => {
  const originalPublic = process.env.PUBLIC_SERVER_URL;
  const originalSilent = process.env.INSTALLER_SILENT;

  afterEach(() => {
    if (originalPublic === undefined) delete process.env.PUBLIC_SERVER_URL;
    else process.env.PUBLIC_SERVER_URL = originalPublic;
    if (originalSilent === undefined) delete process.env.INSTALLER_SILENT;
    else process.env.INSTALLER_SILENT = originalSilent;
  });

  test('requires auth', async () => {
    const res = await request(app).get('/api/enroll/setup-command');
    expect(res.status).toBe(401);
  });

  test('requires operator', async () => {
    const res = await request(app)
      .get('/api/enroll/setup-command')
      .set('Authorization', `Bearer ${makeToken('admin-1', 'v', 'viewer')}`);
    expect(res.status).toBe(403);
  });

  test('uses PUBLIC_SERVER_URL, not whatever host the admin browsed', async () => {
    process.env.PUBLIC_SERVER_URL = 'https://desktop-g4pcdhh.tail06a7e9.ts.net';

    const res = await request(app)
      .get('/api/enroll/setup-command')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.server_url).toBe('https://desktop-g4pcdhh.tail06a7e9.ts.net');
    // The URL appears as a literal, so nothing has to be transcribed.
    expect(res.body.command).toContain("$u = 'https://desktop-g4pcdhh.tail06a7e9.ts.net'");
    // Reachability is checked first, with the host and port derived from that URL.
    expect(res.body.command).toContain(
      "Test-NetConnection 'desktop-g4pcdhh.tail06a7e9.ts.net' -Port 443"
    );
    expect(res.body.command).toContain('/api/download/installer');
    expect(res.body.mode).toBe('gui');
  });

  test('the GUI variant puts the URL on the clipboard', async () => {
    process.env.PUBLIC_SERVER_URL = 'https://lockdown.example.com';
    const res = await request(app)
      .get('/api/enroll/setup-command')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.body.command).toContain('Set-Clipboard');
    expect(res.body.command).not.toContain('--silent');
  });

  test('the silent variant prompts for the token and reports an exit code', async () => {
    process.env.PUBLIC_SERVER_URL = 'https://lockdown.example.com';
    process.env.INSTALLER_SILENT = 'true';

    const res = await request(app)
      .get('/api/enroll/setup-command')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.body.mode).toBe('silent');
    expect(res.body.command).toContain('Read-Host');
    expect(res.body.command).toContain("'--silent'");
    expect(res.body.command).toContain('ExitCode');
    // The token must never be embedded in the command.
    expect(res.body.command).not.toMatch(/--token\s+[A-Za-z0-9+/=]{20,}/);
  });

  test('a malformed PUBLIC_SERVER_URL names the bad value instead of 500ing blindly', async () => {
    process.env.PUBLIC_SERVER_URL = 'desktop-g4pcdhh.tail06a7e9.ts.net'; // no scheme

    const res = await request(app)
      .get('/api/enroll/setup-command')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('PUBLIC_SERVER_URL');
    expect(res.body.error).toContain('desktop-g4pcdhh.tail06a7e9.ts.net');
    expect(res.body.error).toMatch(/scheme:\/\/host/);
  });

  test('falls back to the request host when no override is configured', async () => {
    delete process.env.PUBLIC_SERVER_URL;
    const res = await request(app)
      .get('/api/enroll/setup-command')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.server_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

// ---------------------------------------------------------------------------
// GET /api/enroll/setup.ps1 + setup.cmd — the MeshCentral-style one-liner (S215)
//
// The script carries no secret (the token is prompted for on the target), so it is
// public; a ?token= would have been written to this server's request log.
// ---------------------------------------------------------------------------

describe('GET /api/enroll/setup.ps1 and setup.cmd', () => {
  const originalPublic = process.env.PUBLIC_SERVER_URL;
  const originalSilent = process.env.INSTALLER_SILENT;

  afterEach(() => {
    if (originalPublic === undefined) delete process.env.PUBLIC_SERVER_URL;
    else process.env.PUBLIC_SERVER_URL = originalPublic;
    if (originalSilent === undefined) delete process.env.INSTALLER_SILENT;
    else process.env.INSTALLER_SILENT = originalSilent;
  });

  test('the script is public and carries no token', async () => {
    process.env.PUBLIC_SERVER_URL = 'https://lockdown.example.com';

    const res = await request(app).get('/api/enroll/setup.ps1'); // no auth header

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain("$u = 'https://lockdown.example.com'");
    expect(res.text).toContain('Test-NetConnection');
    expect(res.text).toContain('/api/download/installer');
    // The token is never served: in this (GUI) mode the wizard asks for it, and in
    // silent mode the script prompts with Read-Host (covered below).
    expect(res.text).toContain('Paste the server URL');
    expect(res.text).not.toMatch(/--token\s+[A-Za-z0-9+/=]{20,}/);
  });

  test('the GUI variant puts the URL on the clipboard and opens the wizard', async () => {
    delete process.env.INSTALLER_SILENT;
    process.env.PUBLIC_SERVER_URL = 'https://lockdown.example.com';

    const res = await request(app).get('/api/enroll/setup.ps1');

    expect(res.text).toContain('Set-Clipboard');
    expect(res.text).toContain('Start-Process $e -Verb RunAs');
    expect(res.text).not.toContain('--silent');
  });

  test('INSTALLER_SILENT=true serves the automated variant', async () => {
    process.env.PUBLIC_SERVER_URL = 'https://lockdown.example.com';
    process.env.INSTALLER_SILENT = 'true';

    const res = await request(app).get('/api/enroll/setup.ps1');

    expect(res.text).toContain("'--silent'");
    expect(res.text).toContain('ExitCode');
    expect(res.text).not.toContain('Set-Clipboard');
  });

  test('a malformed PUBLIC_SERVER_URL is explained, not thrown', async () => {
    process.env.PUBLIC_SERVER_URL = 'lockdown.example.com'; // no scheme

    const res = await request(app).get('/api/enroll/setup.ps1');

    expect(res.status).toBe(500);
    expect(res.text).toMatch(/PUBLIC_SERVER_URL/);
  });

  test('setup.cmd wraps the one-liner and is downloaded as a file', async () => {
    process.env.PUBLIC_SERVER_URL = 'https://lockdown.example.com';

    const res = await request(app).get('/api/enroll/setup.cmd');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('lockdown-setup.cmd');
    // Served as a file, so the body is binary — supertest leaves res.text undefined.
    const cmd = res.body.toString();
    expect(cmd).toContain('@echo off');
    // Bypass is scoped to this invocation; the machine policy is untouched.
    expect(cmd).toContain('-ExecutionPolicy Bypass');
    expect(cmd).not.toMatch(/Set-ExecutionPolicy/i);
    expect(cmd).toContain("https://lockdown.example.com/api/enroll/setup.ps1");
    expect(cmd).toContain('iex (irm ');
    expect(cmd).not.toContain('| iex');
  });

  test('/setup-command advertises the one-liner and both file URLs', async () => {
    process.env.PUBLIC_SERVER_URL = 'https://lockdown.example.com';

    const res = await request(app)
      .get('/api/enroll/setup-command')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.body.one_liner).toContain('https://lockdown.example.com/api/enroll/setup.ps1');
    // Parenthesised, not a nested `powershell -Command "... | iex"`: pasting that into
    // an existing prompt has the quotes eaten and feeds iex an array with empty strings.
    expect(res.body.one_liner).toMatch(/^iex \(irm '/);
    expect(res.body.one_liner).not.toContain('powershell -');
    expect(res.body.ps1_url).toBe('https://lockdown.example.com/api/enroll/setup.ps1');
    expect(res.body.cmd_url).toBe('https://lockdown.example.com/api/enroll/setup.cmd');
  });
});
