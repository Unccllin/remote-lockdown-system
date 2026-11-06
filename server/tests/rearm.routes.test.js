/**
 * POST /api/rearm — hardware-UUID-bound re-arm for the PblPersistDxe bootstrap.
 *
 * The route is unauthenticated by necessity (the bootstrap has no credential), so
 * the tests below are mostly about what it must REFUSE: unknown UUIDs and active
 * devices answer the same 404, so it cannot be probed for which machines exist or
 * used to re-key a healthy one.
 */

const request = require('supertest');

const { mockPool, createApp } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const rearmRoutes = require('../src/routes/rearm');

const app = createApp({ rearm: rearmRoutes });

beforeEach(() => {
  mockPool.query.reset();
});

describe('POST /api/rearm', () => {
  test('requires a hardware_uuid', async () => {
    const res = await request(app).post('/api/rearm').send({ hostname: 'PC-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hardware_uuid required/);
  });

  test('answers 404 for an unknown hardware UUID', async () => {
    mockPool.query.setResult('SELECT * FROM devices WHERE hardware_uuid', { rows: [] });

    const res = await request(app).post('/api/rearm').send({ hardware_uuid: 'HW-UNKNOWN' });
    expect(res.status).toBe(404);
  });

  test('answers the same 404 for an ACTIVE device (no re-keying, no probing)', async () => {
    mockPool.query.setResult('SELECT * FROM devices WHERE hardware_uuid', {
      rows: [{ id: 'dev-1', hostname: 'PC-1', status: 'active', hardware_uuid: 'HW-1' }],
    });

    const res = await request(app).post('/api/rearm').send({ hardware_uuid: 'HW-1' });

    expect(res.status).toBe(404);
    // Crucially identical to the unknown-device body.
    expect(res.body.error).toBe('Device not found');
    // And nothing was re-keyed.
    expect(mockPool.query.mock.calls.some((c) => /UPDATE devices SET api_key_hash/.test(c[0]))).toBe(
      false
    );
  });

  test('re-arms a flagged device with a plain-text install script', async () => {
    mockPool.query.setResult('SELECT * FROM devices WHERE hardware_uuid', {
      rows: [
        { id: 'dev-1', hostname: 'PC-STOLEN', status: 'stolen', hardware_uuid: 'HW-1' },
      ],
    });
    mockPool.query.setResult('UPDATE devices SET api_key_hash', {
      rows: [{ id: 'dev-1', hostname: 'PC-STOLEN', status: 'stolen', hardware_uuid: 'HW-1' }],
      rowCount: 1,
    });

    const res = await request(app)
      .post('/api/rearm')
      .send({ hardware_uuid: 'HW-1', hostname: 'PC-STOLEN' });

    expect(res.status).toBe(200);
    // The firmware writes the body straight to a .ps1 file, so it must be the
    // script itself — JSON wrapping it would be written verbatim and never run.
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    // Summary: the bootstrap saves the body as a .ps1 and a browser must never render
    // it as a document — script text reaching an HTML renderer is the XSS the
    // direct-response-write rule warns about (S251).
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toContain('PC-STOLEN');
    expect(res.text.length).toBeGreaterThan(100);

    const update = mockPool.query.mock.calls.find((c) => /UPDATE devices SET api_key_hash/.test(c[0]));
    expect(update).toBeTruthy();
    expect(update[1][0]).toMatch(/^[A-Za-z0-9+/=]{40,}$/); // a fresh key hash

    const audit = mockPool.query.mock.calls.find((c) => /INSERT INTO audit_log/.test(c[0]));
    expect(audit[1][2]).toBe('rearm');
    expect(audit[1][3].hardware_uuid).toBe('HW-1');
  });

  test('every flagged status may re-arm', async () => {
    // Collect failures rather than asserting inside the loop: Jest's expect takes
    // one argument, and a bare loop assertion cannot name the offending status.
    const refused = [];
    for (const status of ['stolen', 'locked', 'recovering', 'tracking']) {
      mockPool.query.reset();
      mockPool.query.setResult('SELECT * FROM devices WHERE hardware_uuid', {
        rows: [{ id: 'dev-1', hostname: 'PC-1', status, hardware_uuid: 'HW-1' }],
      });
      mockPool.query.setResult('UPDATE devices SET api_key_hash', {
        rows: [{ id: 'dev-1', hostname: 'PC-1' }],
        rowCount: 1,
      });

      const res = await request(app).post('/api/rearm').send({ hardware_uuid: 'HW-1' });
      if (res.status !== 200) refused.push(`${status} -> ${res.status}`);
    }
    expect(refused).toEqual([]);
  });
});
