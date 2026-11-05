/**
 * GET /api/download/<name> — public binary downloads (Worker parity).
 *
 * The Worker has always served these paths and `deploy-agent.sh` fetches from them,
 * but Express only had per-device `/api/installer/:id`, so the same URL answered 404
 * on a self-hosted deployment (S210). The responses carry a digest of exactly the
 * bytes served, because a client should be able to refuse a bad body before running
 * it.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const { mockPool, createApp } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const downloadRoutes = require('../src/routes/downloads');

const app = createApp({ download: downloadRoutes });

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'downloads-'));
  fs.writeFileSync(path.join(tmp, 'lockdown-setup.exe'), Buffer.from('MZ-setup'));
  fs.writeFileSync(path.join(tmp, 'lockdown-agent.exe'), Buffer.from('MZ-win-agent'));
  fs.writeFileSync(path.join(tmp, 'lockdown-agent'), Buffer.from('\x7fELF-linux-agent'));
  fs.writeFileSync(path.join(tmp, 'lockdown-lockscreen.exe'), Buffer.from('MZ-lock'));
  process.env.AGENT_BINARIES_DIR = tmp;
});

afterEach(() => {
  delete process.env.AGENT_BINARIES_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sha = (text) => crypto.createHash('sha256').update(Buffer.from(text)).digest('hex');

describe('GET /api/download/:name', () => {
  test('serves the GUI installer with the digest of the bytes actually sent', async () => {
    const res = await request(app).get('/api/download/installer');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/octet-stream/);
    expect(res.headers['content-disposition']).toContain('lockdown-setup.exe');
    expect(res.headers['x-content-sha256']).toBe(sha('MZ-setup'));
    expect(res.body.toString()).toBe('MZ-setup');
  });

  test('picks the agent binary by platform', async () => {
    const win = await request(app).get('/api/download/agent?platform=win');
    expect(win.body.toString()).toBe('MZ-win-agent');
    expect(win.headers['x-content-sha256']).toBe(sha('MZ-win-agent'));

    const linux = await request(app).get('/api/download/agent?platform=linux');
    expect(linux.body.toString()).toBe('\x7fELF-linux-agent');
  });

  test('refuses to guess a platform for the agent binary', async () => {
    // Guessing delivered the Linux ELF to a Windows installer, which failed at launch
    // with "[WinError 216] not compatible with the version of Windows" (S216).
    const res = await request(app).get('/api/download/agent');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/\?platform= is required/);
    expect(res.body.error).toMatch(/win or linux/);
  });

  test('serves the lock-screen helper', async () => {
    const res = await request(app).get('/api/download/lockscreen');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-sha256']).toBe(sha('MZ-lock'));
  });

  test('404 names the missing artefact and where it must come from', async () => {
    const res = await request(app).get('/api/download/agent-installer');

    expect(res.status).toBe(404);
    // lockdown-installer.exe is deliberately absent from the fixture directory.
    expect(res.body.error).toMatch(/lockdown-installer\.exe is not staged/);
    // The remedy matters more than the failure: name the directory and the env var.
    expect(res.body.error).toContain(tmp);
    expect(res.body.error).toMatch(/AGENT_BINARIES_DIR/);
  });

  test('404 for an unknown name lists what is available', async () => {
    const res = await request(app).get('/api/download/deploy.ps1');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No download named "deploy\.ps1"/);
    expect(res.body.error).toMatch(/agent, agent-installer, installer, lockscreen/);
  });
});
