const request = require('supertest');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { startStaticServer } = require('../server-starter');

// Create a temporary dashboard dist directory for testing
let tmpDir;
let distDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-test-'));
  distDir = path.join(tmpDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  // Create a minimal dashboard dist structure
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!DOCTYPE html><html><head><title>Test</title></head><body><div id="root">Dashboard</div></body></html>');
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'assets', 'index-abc123.js'), 'console.log("test bundle");');
  fs.writeFileSync(path.join(distDir, 'assets', 'index-def456.css'), 'body { margin: 0; }');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('startStaticServer (serverless mode)', () => {
  let serverInfo;

  beforeAll(async () => {
    process.env.PORT = '0';
    serverInfo = await startStaticServer({ dashboardDistPath: distDir });
  });

  afterAll(async () => {
    if (serverInfo) {
      await new Promise((resolve) => serverInfo.server.close(resolve));
    }
  });

  it('starts and returns a port', () => {
    expect(serverInfo).toBeDefined();
    expect(serverInfo.port).toBeGreaterThan(0);
    expect(serverInfo.server).toBeDefined();
    expect(serverInfo.pool).toBeNull(); // no database in serverless mode
  });

  it('serves index.html at root', async () => {
    const res = await request(serverInfo.server).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
    expect(res.headers['cache-control']).toContain('no-cache');
  });

  it('serves static assets with immutable cache headers', async () => {
    const res = await request(serverInfo.server).get('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.text).toBe('console.log("test bundle");');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['cache-control']).toContain('max-age=31536000');
  });

  it('serves CSS assets with immutable cache headers', async () => {
    const res = await request(serverInfo.server).get('/assets/index-def456.css');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('returns index.html for SPA routes (client-side routing fallback)', async () => {
    const res = await request(serverInfo.server).get('/devices');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
  });

  it('returns index.html for nested SPA routes', async () => {
    const res = await request(serverInfo.server).get('/devices/abc-123/detail');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
  });

  it('does NOT have API routes (serverless mode — API goes to Worker)', async () => {
    // /api/health should fall through to the SPA fallback (index.html),
    // NOT return a JSON health response
    const res = await request(serverInfo.server).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<div id="root">');
  });

  it('does NOT have /api/devices route', async () => {
    const res = await request(serverInfo.server).get('/api/devices');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('throws if dashboardDistPath is missing', async () => {
    await expect(startStaticServer({ dashboardDistPath: null })).rejects.toThrow(
      'Dashboard dist path is required'
    );
  });

  it('throws if dashboardDistPath does not exist', async () => {
    await expect(startStaticServer({ dashboardDistPath: '/nonexistent/path' })).rejects.toThrow(
      'Dashboard dist path is required'
    );
  });
});
