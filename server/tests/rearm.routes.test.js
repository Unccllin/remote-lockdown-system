/**
 * POST /api/rearm — the firmware bootstrap asks for a fresh agent install.
 *
 * The route is unauthenticated by necessity (the bootstrap carries no credential), so most of these
 * tests are about what it must REFUSE. Since ADR-011 (D-226) that includes refusing to issue a key
 * at all: the hardware UUID is printed in firmware setup and readable from Windows, so it identifies
 * a machine without authenticating one. A request is recorded, an administrator approves, and the
 * next call consumes the approval.
 */

const request = require('supertest');

const { mockPool, createApp } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const rearmRoutes = require('../src/routes/rearm');

const app = createApp({ rearm: rearmRoutes });

const FLAGGED = { id: 'dev-1', hostname: 'PC-STOLEN', status: 'stolen', hardware_uuid: 'HW-1' };
const ACTIVE = { id: 'dev-2', hostname: 'PC-OK', status: 'active', hardware_uuid: 'HW-2' };

function approvedRequest(overrides = {}) {
  return {
    rows: [{
      device_id: 'dev-1',
      hardware_uuid: 'HW-1',
      hostname: 'PC-STOLEN',
      status: 'approved',
      decided_by: 'admin-1',
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      ...overrides,
    }],
    rowCount: 1,
  };
}

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
    mockPool.query.setResult('SELECT * FROM devices WHERE hardware_uuid', { rows: [ACTIVE] });

    const res = await request(app).post('/api/rearm').send({ hardware_uuid: 'HW-2' });

    expect(res.status).toBe(404);
    // Crucially identical to the unknown-device body.
    expect(res.body.error).toBe('Device not found');
    // And nothing was re-keyed, and no approval was asked for.
    const sqls = mockPool.query.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => /UPDATE devices SET api_key_hash/.test(s))).toBe(false);
    expect(sqls.some((s) => /INSERT INTO rearm_requests/.test(s))).toBe(false);
  });

  test('a flagged device is recorded as pending and gets 409 — no key', async () => {
    mockPool.query.setResult('SELECT * FROM devices WHERE hardware_uuid', { rows: [FLAGGED] });
    // No existing request → requestApproval inserts one.

    const res = await request(app).post('/api/rearm').send({ hardware_uuid: 'HW-1' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/administrator approval/i);

    const sqls = mockPool.query.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => /UPDATE devices SET api_key_hash/.test(s))).toBe(false);
    const insert = mockPool.query.mock.calls.find((c) => /INSERT INTO rearm_requests/.test(c[0]));
    expect(insert).toBeTruthy();
    expect(insert[1][0]).toBe('dev-1');
    const audit = mockPool.query.mock.calls.find((c) => /INSERT INTO audit_log/.test(c[0]));
    expect(audit[1][2]).toBe('rearm_requested');
  });

  test('an approved request issues exactly one plain-text install script', async () => {
    mockPool.query.setResult('SELECT * FROM devices WHERE hardware_uuid', { rows: [FLAGGED] });
    mockPool.query.setResult('SELECT * FROM rearm_requests WHERE device_id', approvedRequest());
    mockPool.query.setResult('UPDATE devices SET api_key_hash', { rows: [FLAGGED], rowCount: 1 });

    const res = await request(app)
      .post('/api/rearm')
      .send({ hardware_uuid: 'HW-1', hostname: 'PC-STOLEN' });

    expect(res.status).toBe(200);
    // The firmware writes the body straight to a .ps1 file, so it must be the script itself.
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    // …and a browser must never render it as a document (S251).
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toContain('PC-STOLEN');
    expect(res.text.length).toBeGreaterThan(100);

    const sqls = mockPool.query.mock.calls.map((c) => c[0]);
    // Consumed before issuing, so a second caller cannot be served from the same approval.
    expect(sqls.some((s) => /DELETE FROM rearm_requests/.test(s))).toBe(true);

    const update = mockPool.query.mock.calls.find((c) => /UPDATE devices SET api_key_hash/.test(c[0]));
    expect(update[1][0]).toMatch(/^[A-Za-z0-9+/=]{40,}$/); // a fresh key hash

    const audit = mockPool.query.mock.calls.find((c) => /INSERT INTO audit_log/.test(c[0]));
    expect(audit[1][2]).toBe('rearm_approval_used');
  });

  test('a stale approval is not honoured — it re-asks instead', async () => {
    mockPool.query.setResult('SELECT * FROM devices WHERE hardware_uuid', { rows: [FLAGGED] });
    mockPool.query.setResult(
      'SELECT * FROM rearm_requests WHERE device_id',
      approvedRequest({ expires_at: new Date(Date.now() - 60 * 1000).toISOString() })
    );

    const res = await request(app).post('/api/rearm').send({ hardware_uuid: 'HW-1' });

    expect(res.status).toBe(409);
    expect(mockPool.query.mock.calls.some((c) => /UPDATE devices SET api_key_hash/.test(c[0]))).toBe(false);
  });

  test('a denied request is refused with 403', async () => {
    mockPool.query.setResult('SELECT * FROM devices WHERE hardware_uuid', { rows: [FLAGGED] });
    mockPool.query.setResult('SELECT * FROM rearm_requests WHERE device_id', {
      rows: [{ device_id: 'dev-1', status: 'denied' }],
      rowCount: 1,
    });

    const res = await request(app).post('/api/rearm').send({ hardware_uuid: 'HW-1' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/denied/i);
    expect(mockPool.query.mock.calls.some((c) => /UPDATE devices SET api_key_hash/.test(c[0]))).toBe(false);
  });

  test('every flagged status may ASK (409), not receive a key', async () => {
    const unexpected = [];
    for (const status of ['stolen', 'locked', 'recovering', 'tracking']) {
      mockPool.query.reset();
      mockPool.query.setResult('SELECT * FROM devices WHERE hardware_uuid', {
        rows: [{ ...FLAGGED, status }],
      });

      const res = await request(app).post('/api/rearm').send({ hardware_uuid: 'HW-1' });
      if (res.status !== 409) unexpected.push(`${status} -> ${res.status}`);
    }
    expect(unexpected).toEqual([]);
  });
});
