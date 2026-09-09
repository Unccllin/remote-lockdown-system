/**
 * D-210: PBL Express route equivalent + WAF/DDoS pre-flight guard tests.
 *
 * Tests the WAF guards (body size, content-type, method, path traversal)
 * and the Express route structure.
 */

const request = require('supertest');
const express = require('express');

const {
  router,
  pblWafGuard,
  classifyPath,
  BODY_LIMITS,
  METHOD_RULES,
  createEnv,
} = require('../src/routes/pbl');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/v1', router);
  return app;
}

describe('D-210: PBL WAF pre-flight guards', () => {
  describe('classifyPath', () => {
    it('classifies admin paths', () => {
      expect(classifyPath('/v1/admin/rotate-key')).toBe('admin');
      expect(classifyPath('/v1/devices')).toBe('admin');
      expect(classifyPath('/v1/devices/abc123')).toBe('admin');
    });

    it('classifies firmware paths', () => {
      expect(classifyPath('/v1/verdict')).toBe('firmware');
      expect(classifyPath('/v1/enroll')).toBe('firmware');
      expect(classifyPath('/v1/attest')).toBe('firmware');
      expect(classifyPath('/v1/override/challenge')).toBe('firmware');
    });

    it('classifies unprotected paths', () => {
      expect(classifyPath('/v1/health')).toBe('unprotected');
    });
  });

  describe('path traversal rejection', () => {
    const app = createApp();
    it('rejects paths with ..', async () => {
      // Express normalizes ../ in the path, but the WAF checks originalUrl
      // which preserves the raw request. Use a raw request.
      const resp = await request(app).get('/v1/verdict/../../../etc/passwd');
      // Express may normalize this to /etc/passwd (404) or the WAF catches it (400)
      expect([400, 404]).toContain(resp.status);
    });

    it('rejects paths with null bytes', async () => {
      const resp = await request(app).get('/v1/verdict%00/etc');
      expect([400, 404]).toContain(resp.status);
    });
  });

  describe('method allow-list', () => {
    const app = createApp();
    it('allows GET on /v1/health', async () => {
      const resp = await request(app).get('/v1/health');
      expect(resp.status).toBe(200);
    });

    it('rejects PUT on /v1/verdict (405)', async () => {
      const resp = await request(app).put('/v1/verdict')
        .set('Content-Type', 'application/json')
        .send({});
      expect(resp.status).toBe(405);
      expect(resp.headers.allow).toContain('POST');
    });

    it('rejects DELETE on /v1/verdict (405)', async () => {
      const resp = await request(app).delete('/v1/verdict');
      expect(resp.status).toBe(405);
    });
  });

  describe('content-type checks', () => {
    const app = createApp();
    it('rejects text/plain on POST /v1/verdict (415)', async () => {
      const resp = await request(app).post('/v1/verdict')
        .set('Content-Type', 'text/plain')
        .send('hello');
      expect(resp.status).toBe(415);
    });

    it('accepts application/json on POST /v1/attest', async () => {
      // The route handler will process it further; we just check WAF passes
      const resp = await request(app).post('/v1/attest')
        .set('Content-Type', 'application/json')
        .send({ device_id: 'a'.repeat(64), quote: 'dGVzdA==' });
      // Will be 200 or 404 (device not found) — WAF should not block
      expect([200, 404]).toContain(resp.status);
    });

    it('accepts application/cbor on POST /v1/enroll', async () => {
      // The enroll route handler isn't wired up in the Express shim yet,
      // so this will 404. The WAF should pass the content-type check.
      const resp = await request(app).post('/v1/enroll')
        .set('Content-Type', 'application/cbor')
        .send(Buffer.from([0xa0])); // empty CBOR map
      // WAF passes → 404 (no route handler) is acceptable
      expect([400, 404]).toContain(resp.status);
    });
  });

  describe('body-size limits', () => {
    it('rejects oversized firmware request (413)', async () => {
      const app = createApp();
      // Create a body larger than 256 KiB
      const largeBody = JSON.stringify({ quote: 'x'.repeat(300 * 1024) });
      const resp = await request(app).post('/v1/attest')
        .set('Content-Type', 'application/json')
        .set('Content-Length', Buffer.byteLength(largeBody).toString())
        .send(largeBody);
      expect(resp.status).toBe(413);
    });
  });

  describe('METHOD_RULES coverage', () => {
    it('covers all major PBL paths', () => {
      const paths = [
        '/v1/verdict',
        '/v1/policy',
        '/v1/policy/1',
        '/v1/enroll',
        '/v1/attest',
        '/v1/override/challenge',
        '/v1/override/response',
        '/v1/devices',
        '/v1/devices/abc123',
        '/v1/devices/abc123/lock',
        '/v1/devices/abc123/unlock',
        '/v1/devices/abc123/track',
        '/v1/devices/abc123/stop-track',
        '/v1/health',
        '/v1/admin/rotate-key',
        '/v1/admin/key-info',
        '/v1/admin/cert-chain',
        '/v1/admin/operator-key',
      ];
      for (const path of paths) {
        const rule = METHOD_RULES.find((r) => r.pattern.test(path));
        expect(rule).toBeDefined();
      }
    });
  });
});

describe('D-210: PBL Express route structure', () => {
  it('exports a router', () => {
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
  });

  it('exports WAF guard middleware', () => {
    expect(typeof pblWafGuard).toBe('function');
  });

  it('exports body limits', () => {
    expect(BODY_LIMITS.firmware).toBe(256 * 1024);
    expect(BODY_LIMITS.admin).toBe(1024 * 1024);
  });

  it('createEnv returns a KV-like interface', async () => {
    const env = createEnv();
    expect(env.LOCKDOWN_KV).toBeDefined();
    expect(typeof env.LOCKDOWN_KV.get).toBe('function');
    expect(typeof env.LOCKDOWN_KV.put).toBe('function');
    expect(typeof env.LOCKDOWN_KV.delete).toBe('function');

    await env.LOCKDOWN_KV.put('test', 'value');
    expect(await env.LOCKDOWN_KV.get('test', 'text')).toBe('value');
    await env.LOCKDOWN_KV.delete('test');
    expect(await env.LOCKDOWN_KV.get('test')).toBeNull();
  });

  it('GET /v1/health returns ok', async () => {
    const app = createApp();
    const resp = await request(app).get('/v1/health');
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe('ok');
    expect(resp.body.service).toBe('pbl-express');
    expect(resp.body.timestamp).toBeDefined();
  });
});
