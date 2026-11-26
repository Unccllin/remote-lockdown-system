/**
 * /api/admin/rearm-requests — who may decide a re-arm, and what the decision records.
 *
 * The re-arm route itself is unauthenticated by necessity, so this is where the authority lives:
 * a super-admin, audited, and single-use. These tests pin the three things that would quietly
 * undo ADR-011 if they regressed — an unauthenticated caller deciding, a non-super-admin deciding,
 * and a decision not being audited.
 */

const request = require('supertest');

const { mockPool, createApp, makeToken } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const rearmRequestsRoutes = require('../src/routes/rearmRequests');

const app = createApp({ 'admin/rearm-requests': rearmRequestsRoutes });

const superAdmin = makeToken('admin-1', 'root', 'super-admin');
const operator = makeToken('admin-2', 'op', 'operator');

beforeEach(() => {
  mockPool.query.reset();
});

describe('GET /api/admin/rearm-requests', () => {
  test('refuses an unauthenticated caller', async () => {
    const res = await request(app).get('/api/admin/rearm-requests');
    expect(res.status).toBe(401);
  });

  test('refuses a non-super-admin', async () => {
    const res = await request(app)
      .get('/api/admin/rearm-requests')
      .set('Authorization', `Bearer ${operator}`);
    expect(res.status).toBe(403);
  });

  test('lists the pending queue for a super-admin', async () => {
    mockPool.query.setResult('FROM rearm_requests r', {
      rows: [{ device_id: 'dev-1', status: 'pending', device_status: 'stolen' }],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/api/admin/rearm-requests')
      .set('Authorization', `Bearer ${superAdmin}`);

    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    // Only pending rows are a queue: approved ones are waiting on the device, not on a human.
    expect(mockPool.query.mock.calls[0][0]).toMatch(/status = 'pending'/);
  });
});

describe('POST /api/admin/rearm-requests/:deviceId/(approve|deny)', () => {
  test('refuses an unauthenticated caller', async () => {
    const res = await request(app).post('/api/admin/rearm-requests/dev-1/approve');
    expect(res.status).toBe(401);
  });

  test('refuses a non-super-admin', async () => {
    const res = await request(app)
      .post('/api/admin/rearm-requests/dev-1/approve')
      .set('Authorization', `Bearer ${operator}`);
    expect(res.status).toBe(403);
  });

  test('approval sets a 15-minute expiry and audits the decision', async () => {
    mockPool.query.setResult('UPDATE rearm_requests', {
      rows: [{ device_id: 'dev-1', status: 'approved' }],
      rowCount: 1,
    });

    const res = await request(app)
      .post('/api/admin/rearm-requests/dev-1/approve')
      .set('Authorization', `Bearer ${superAdmin}`);

    expect(res.status).toBe(200);

    const update = mockPool.query.mock.calls.find((c) => /UPDATE rearm_requests/.test(c[0]));
    const expiresAt = Date.parse(update[1][4]);
    const ttlMinutes = (expiresAt - Date.now()) / 60000;
    expect(ttlMinutes).toBeGreaterThan(13);
    expect(ttlMinutes).toBeLessThan(16);

    const audit = mockPool.query.mock.calls.find((c) => /INSERT INTO audit_log/.test(c[0]));
    expect(audit[1][2]).toBe('rearm_approved');
    expect(audit[1][3].decided_by).toBe('root');
  });

  test('deny audits as a denial and sets no expiry', async () => {
    mockPool.query.setResult('UPDATE rearm_requests', {
      rows: [{ device_id: 'dev-1', status: 'denied' }],
      rowCount: 1,
    });

    const res = await request(app)
      .post('/api/admin/rearm-requests/dev-1/deny')
      .set('Authorization', `Bearer ${superAdmin}`);

    expect(res.status).toBe(200);
    const update = mockPool.query.mock.calls.find((c) => /UPDATE rearm_requests/.test(c[0]));
    expect(update[1][4]).toBeNull();
    const audit = mockPool.query.mock.calls.find((c) => /INSERT INTO audit_log/.test(c[0]));
    expect(audit[1][2]).toBe('rearm_denied');
  });

  test('deciding an already-decided request answers 404, not a second approval', async () => {
    mockPool.query.setResult('UPDATE rearm_requests', { rows: [], rowCount: 0 });

    const res = await request(app)
      .post('/api/admin/rearm-requests/dev-1/approve')
      .set('Authorization', `Bearer ${superAdmin}`);

    expect(res.status).toBe(404);
    expect(mockPool.query.mock.calls.some((c) => /INSERT INTO audit_log/.test(c[0]))).toBe(false);
  });

  test('the UPDATE is scoped to pending rows, so a decision cannot overwrite another', async () => {
    mockPool.query.setResult('UPDATE rearm_requests', { rows: [], rowCount: 0 });

    await request(app)
      .post('/api/admin/rearm-requests/dev-1/approve')
      .set('Authorization', `Bearer ${superAdmin}`);

    const update = mockPool.query.mock.calls.find((c) => /UPDATE rearm_requests/.test(c[0]));
    expect(update[0]).toMatch(/WHERE device_id = \$1 AND status = 'pending'/);
  });
});
