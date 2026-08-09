const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { mockPool } = require('./mockPool');
jest.mock('../src/db/pool', () => mockPool);

const adminsRoutes = require('../src/routes/admins');
const devicesRoutes = require('../src/routes/devices');
const setupRoutes = require('../src/routes/setup');

const JWT_SECRET = 'test-secret-key-that-is-long-enough-for-validation-32';

function makeToken(role = 'super-admin', adminId = 'admin-1', username = 'admin') {
  return jwt.sign({ id: adminId, username, role }, JWT_SECRET, { expiresIn: '1h' });
}

function createAdminsApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admins', adminsRoutes);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

function createDevicesApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/devices', devicesRoutes);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

function createSetupApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/setup', setupRoutes);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

beforeEach(() => {
  mockPool.query.reset();
});

// ---------------------------------------------------------------------------
// GET /api/admins (list)
// ---------------------------------------------------------------------------

describe('GET /api/admins (list)', () => {
  test('super-admin can list admins', async () => {
    const admins = [
      { id: 'admin-1', username: 'root', role: 'super-admin', created_at: '2025-01-01T00:00:00Z' },
      { id: 'admin-2', username: 'viewer1', role: 'viewer', created_at: '2025-01-02T00:00:00Z' },
    ];
    mockPool.query.setResult('SELECT id, username, role, created_at FROM admins', { rows: admins });

    const res = await request(createAdminsApp())
      .get('/api/admins')
      .set('Authorization', `Bearer ${makeToken('super-admin')}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].username).toBe('root');
  });

  test('operator cannot list admins (403)', async () => {
    const res = await request(createAdminsApp())
      .get('/api/admins')
      .set('Authorization', `Bearer ${makeToken('operator')}`);

    expect(res.status).toBe(403);
  });

  test('viewer cannot list admins (403)', async () => {
    const res = await request(createAdminsApp())
      .get('/api/admins')
      .set('Authorization', `Bearer ${makeToken('viewer')}`);

    expect(res.status).toBe(403);
  });

  test('rejects without auth token (401)', async () => {
    const res = await request(createAdminsApp()).get('/api/admins');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admins (create)
// ---------------------------------------------------------------------------

describe('POST /api/admins (create)', () => {
  test('super-admin can create a new admin', async () => {
    const newAdmin = { id: 'admin-new', username: 'newuser', role: 'operator', created_at: '2025-01-03T00:00:00Z' };
    mockPool.query.setResult('INSERT INTO admins', { rows: [newAdmin] });

    const res = await request(createAdminsApp())
      .post('/api/admins')
      .set('Authorization', `Bearer ${makeToken('super-admin')}`)
      .send({ username: 'newuser', password: 'password123', role: 'operator' });

    expect(res.status).toBe(201);
    expect(res.body.username).toBe('newuser');
    expect(res.body.role).toBe('operator');

    // Verify the INSERT included the role
    const insertCall = mockPool.query.mock.calls.find(
      (c) => c[0].includes('INSERT INTO admins')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toContain('operator');

    // Verify password was hashed with bcrypt
    const hash = insertCall[1][2];
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(bcrypt.compareSync('password123', hash)).toBe(true);

    // Verify audit log
    const auditCall = mockPool.query.mock.calls.find(
      (c) => c[0].includes('INSERT INTO audit_log') && c[1].includes('admin_created')
    );
    expect(auditCall).toBeDefined();
  });

  test('operator cannot create admin (403)', async () => {
    const res = await request(createAdminsApp())
      .post('/api/admins')
      .set('Authorization', `Bearer ${makeToken('operator')}`)
      .send({ username: 'newuser', password: 'password123', role: 'viewer' });

    expect(res.status).toBe(403);
  });

  test('viewer cannot create admin (403)', async () => {
    const res = await request(createAdminsApp())
      .post('/api/admins')
      .set('Authorization', `Bearer ${makeToken('viewer')}`)
      .send({ username: 'newuser', password: 'password123', role: 'viewer' });

    expect(res.status).toBe(403);
  });

  test('returns 400 when username missing', async () => {
    const res = await request(createAdminsApp())
      .post('/api/admins')
      .set('Authorization', `Bearer ${makeToken('super-admin')}`)
      .send({ password: 'password123', role: 'viewer' });

    expect(res.status).toBe(400);
  });

  test('returns 400 when password too short', async () => {
    const res = await request(createAdminsApp())
      .post('/api/admins')
      .set('Authorization', `Bearer ${makeToken('super-admin')}`)
      .send({ username: 'newuser', password: 'short', role: 'viewer' });

    expect(res.status).toBe(400);
  });

  test('returns 400 when role is invalid', async () => {
    const res = await request(createAdminsApp())
      .post('/api/admins')
      .set('Authorization', `Bearer ${makeToken('super-admin')}`)
      .send({ username: 'newuser', password: 'password123', role: 'god' });

    expect(res.status).toBe(400);
  });

  test('returns 409 on duplicate username', async () => {
    mockPool.setError('INSERT INTO admins', new Error('UNIQUE constraint failed: admins.username'));

    const res = await request(createAdminsApp())
      .post('/api/admins')
      .set('Authorization', `Bearer ${makeToken('super-admin')}`)
      .send({ username: 'admin', password: 'password123', role: 'viewer' });

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admins/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/admins/:id (delete)', () => {
  test('super-admin can delete another admin', async () => {
    const target = { id: 'admin-2', username: 'other', role: 'viewer' };
    mockPool.query.setResult('SELECT * FROM admins WHERE id', { rows: [target] });

    const res = await request(createAdminsApp())
      .delete('/api/admins/admin-2')
      .set('Authorization', `Bearer ${makeToken('super-admin', 'admin-1')}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe('admin-2');

    const deleteCall = mockPool.query.mock.calls.find(
      (c) => c[0].includes('DELETE FROM admins')
    );
    expect(deleteCall).toBeDefined();
  });

  test('super-admin cannot delete self (403)', async () => {
    const res = await request(createAdminsApp())
      .delete('/api/admins/admin-1')
      .set('Authorization', `Bearer ${makeToken('super-admin', 'admin-1')}`);

    expect(res.status).toBe(403);

    // No DELETE should have been issued
    const deleteCall = mockPool.query.mock.calls.find(
      (c) => c[0].includes('DELETE FROM admins')
    );
    expect(deleteCall).toBeUndefined();
  });

  test('cannot delete the last super-admin (403)', async () => {
    const target = { id: 'admin-2', username: 'lastsuper', role: 'super-admin' };
    mockPool.query.setResult('SELECT * FROM admins WHERE id', { rows: [target] });
    mockPool.query.setResult("SELECT COUNT(*) as count FROM admins WHERE role = 'super-admin'", {
      rows: [{ count: '1' }],
    });

    const res = await request(createAdminsApp())
      .delete('/api/admins/admin-2')
      .set('Authorization', `Bearer ${makeToken('super-admin', 'admin-1')}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/last super-admin/i);

    const deleteCall = mockPool.query.mock.calls.find(
      (c) => c[0].includes('DELETE FROM admins')
    );
    expect(deleteCall).toBeUndefined();
  });

  test('can delete a super-admin when more than one exists', async () => {
    const target = { id: 'admin-2', username: 'secondsuuper', role: 'super-admin' };
    mockPool.query.setResult('SELECT * FROM admins WHERE id', { rows: [target] });
    mockPool.query.setResult("SELECT COUNT(*) as count FROM admins WHERE role = 'super-admin'", {
      rows: [{ count: '2' }],
    });

    const res = await request(createAdminsApp())
      .delete('/api/admins/admin-2')
      .set('Authorization', `Bearer ${makeToken('super-admin', 'admin-1')}`);

    expect(res.status).toBe(200);
  });

  test('returns 404 when admin not found', async () => {
    mockPool.query.setResult('SELECT * FROM admins WHERE id', { rows: [] });

    const res = await request(createAdminsApp())
      .delete('/api/admins/nonexistent')
      .set('Authorization', `Bearer ${makeToken('super-admin', 'admin-1')}`);

    expect(res.status).toBe(404);
  });

  test('operator cannot delete admin (403)', async () => {
    const res = await request(createAdminsApp())
      .delete('/api/admins/admin-2')
      .set('Authorization', `Bearer ${makeToken('operator', 'admin-1')}`);

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/admins/:id (update role)
// ---------------------------------------------------------------------------

describe('PATCH /api/admins/:id (update role)', () => {
  test('super-admin can update another admin role', async () => {
    const target = { id: 'admin-2', username: 'other', role: 'viewer' };
    const updated = { id: 'admin-2', username: 'other', role: 'operator', created_at: '2025-01-01T00:00:00Z' };
    mockPool.query.setResult('SELECT * FROM admins WHERE id', { rows: [target] });
    mockPool.query.setResult('UPDATE admins SET role', { rows: [updated] });

    const res = await request(createAdminsApp())
      .patch('/api/admins/admin-2')
      .set('Authorization', `Bearer ${makeToken('super-admin', 'admin-1')}`)
      .send({ role: 'operator' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('operator');

    const auditCall = mockPool.query.mock.calls.find(
      (c) => c[0].includes('INSERT INTO audit_log') && c[1].includes('admin_role_changed')
    );
    expect(auditCall).toBeDefined();
  });

  test('super-admin cannot change own role (403)', async () => {
    const res = await request(createAdminsApp())
      .patch('/api/admins/admin-1')
      .set('Authorization', `Bearer ${makeToken('super-admin', 'admin-1')}`)
      .send({ role: 'operator' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/own role/i);
  });

  test('cannot demote the last super-admin (403)', async () => {
    const target = { id: 'admin-2', username: 'lastsuper', role: 'super-admin' };
    mockPool.query.setResult('SELECT * FROM admins WHERE id', { rows: [target] });
    mockPool.query.setResult("SELECT COUNT(*) as count FROM admins WHERE role = 'super-admin'", {
      rows: [{ count: '1' }],
    });

    const res = await request(createAdminsApp())
      .patch('/api/admins/admin-2')
      .set('Authorization', `Bearer ${makeToken('super-admin', 'admin-1')}`)
      .send({ role: 'operator' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/last super-admin/i);
  });

  test('returns 400 when role is invalid', async () => {
    const res = await request(createAdminsApp())
      .patch('/api/admins/admin-2')
      .set('Authorization', `Bearer ${makeToken('super-admin', 'admin-1')}`)
      .send({ role: 'god' });

    expect(res.status).toBe(400);
  });

  test('returns 400 when role is missing', async () => {
    const res = await request(createAdminsApp())
      .patch('/api/admins/admin-2')
      .set('Authorization', `Bearer ${makeToken('super-admin', 'admin-1')}`)
      .send({});

    expect(res.status).toBe(400);
  });

  test('returns 404 when admin not found', async () => {
    mockPool.query.setResult('SELECT * FROM admins WHERE id', { rows: [] });

    const res = await request(createAdminsApp())
      .patch('/api/admins/nonexistent')
      .set('Authorization', `Bearer ${makeToken('super-admin', 'admin-1')}`)
      .send({ role: 'operator' });

    expect(res.status).toBe(404);
  });

  test('operator cannot update roles (403)', async () => {
    const res = await request(createAdminsApp())
      .patch('/api/admins/admin-2')
      .set('Authorization', `Bearer ${makeToken('operator', 'admin-1')}`)
      .send({ role: 'operator' });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Role enforcement on device routes
// ---------------------------------------------------------------------------

describe('Role enforcement on device routes', () => {
  test('viewer gets 403 on flag-stolen (destructive route)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(createDevicesApp())
      .post('/api/devices/dev-1/flag-stolen')
      .set('Authorization', `Bearer ${makeToken('viewer')}`)
      .send({ hostname_confirm: 'DEV-001' });

    expect(res.status).toBe(403);
  });

  test('viewer gets 403 on recover (destructive route)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(createDevicesApp())
      .post('/api/devices/dev-1/recover')
      .set('Authorization', `Bearer ${makeToken('viewer')}`)
      .send({ hostname_confirm: 'DEV-001' });

    expect(res.status).toBe(403);
  });

  test('viewer gets 403 on enroll (POST /devices)', async () => {
    const res = await request(createDevicesApp())
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken('viewer')}`)
      .send({ hostname: 'DEV-NEW', owner_name: 'Alice' });

    expect(res.status).toBe(403);
  });

  test('viewer can still view devices (GET)', async () => {
    mockPool.query.setResult('SELECT * FROM devices ORDER BY', {
      rows: [{ id: 'dev-1', hostname: 'DEV-001', status: 'active' }],
    });

    const res = await request(createDevicesApp())
      .get('/api/devices')
      .set('Authorization', `Bearer ${makeToken('viewer')}`);

    expect(res.status).toBe(200);
  });

  test('operator gets 403 on rotate-key (super-admin only)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(createDevicesApp())
      .post('/api/devices/dev-1/rotate-key')
      .set('Authorization', `Bearer ${makeToken('operator')}`);

    expect(res.status).toBe(403);
  });

  test('operator can flag-stolen', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    const cmd = { id: 'cmd-1', command_type: 'lockdown', status: 'pending' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
    mockPool.query.setResult('INSERT INTO commands', { rows: [cmd] });

    const res = await request(createDevicesApp())
      .post('/api/devices/dev-1/flag-stolen')
      .set('Authorization', `Bearer ${makeToken('operator')}`)
      .send({ hostname_confirm: 'DEV-001' });

    expect(res.status).toBe(200);
  });

  test('super-admin can rotate-key', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(createDevicesApp())
      .post('/api/devices/dev-1/rotate-key')
      .set('Authorization', `Bearer ${makeToken('super-admin')}`);

    expect(res.status).toBe(200);
  });

  // --- Newly protected routes (track, locate, stop-track, release, patch, delete) ---

  test('viewer gets 403 on track', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(createDevicesApp())
      .post('/api/devices/dev-1/track')
      .set('Authorization', `Bearer ${makeToken('viewer')}`);

    expect(res.status).toBe(403);
  });

  test('viewer gets 403 on locate', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(createDevicesApp())
      .post('/api/devices/dev-1/locate')
      .set('Authorization', `Bearer ${makeToken('viewer')}`);

    expect(res.status).toBe(403);
  });

  test('viewer gets 403 on stop-track', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'tracking' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(createDevicesApp())
      .post('/api/devices/dev-1/stop-track')
      .set('Authorization', `Bearer ${makeToken('viewer')}`);

    expect(res.status).toBe(403);
  });

  test('viewer gets 403 on release', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(createDevicesApp())
      .delete('/api/devices/dev-1/release')
      .set('Authorization', `Bearer ${makeToken('viewer')}`)
      .send({ hostname_confirm: 'DEV-001' });

    expect(res.status).toBe(403);
  });

  test('viewer gets 403 on PATCH device', async () => {
    const res = await request(createDevicesApp())
      .patch('/api/devices/dev-1')
      .set('Authorization', `Bearer ${makeToken('viewer')}`)
      .send({ owner_name: 'New Owner' });

    expect(res.status).toBe(403);
  });

  test('viewer gets 403 on DELETE device', async () => {
    const res = await request(createDevicesApp())
      .delete('/api/devices/dev-1')
      .set('Authorization', `Bearer ${makeToken('viewer')}`);

    expect(res.status).toBe(403);
  });

  test('operator can PATCH device', async () => {
    mockPool.query.setResult('UPDATE devices SET owner_name', {
      rows: [{ id: 'dev-1', hostname: 'DEV-001', owner_name: 'New Owner', status: 'active' }],
    });

    const res = await request(createDevicesApp())
      .patch('/api/devices/dev-1')
      .set('Authorization', `Bearer ${makeToken('operator')}`)
      .send({ owner_name: 'New Owner' });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Role enforcement on admin management routes (operator)
// ---------------------------------------------------------------------------

describe('Operator role enforcement on admin routes', () => {
  test('operator gets 403 on POST /api/admins', async () => {
    const res = await request(createAdminsApp())
      .post('/api/admins')
      .set('Authorization', `Bearer ${makeToken('operator')}`)
      .send({ username: 'newuser', password: 'password123', role: 'viewer' });

    expect(res.status).toBe(403);
  });

  test('operator gets 403 on DELETE /api/admins/:id', async () => {
    const res = await request(createAdminsApp())
      .delete('/api/admins/admin-2')
      .set('Authorization', `Bearer ${makeToken('operator', 'admin-1')}`);

    expect(res.status).toBe(403);
  });

  test('operator gets 403 on PATCH /api/admins/:id', async () => {
    const res = await request(createAdminsApp())
      .patch('/api/admins/admin-2')
      .set('Authorization', `Bearer ${makeToken('operator', 'admin-1')}`)
      .send({ role: 'viewer' });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// First admin via setup gets super-admin role
// ---------------------------------------------------------------------------

describe('Setup endpoint grants super-admin role', () => {
  test('first admin created via setup has super-admin role', async () => {
    mockPool.query.setResult('SELECT COUNT(*) as count FROM admins', {
      rows: [{ count: '0' }],
    });

    const res = await request(createSetupApp())
      .post('/api/setup/create-admin')
      .send({ username: 'admin', password: 'password123' });

    expect(res.status).toBe(201);

    // Verify the INSERT included role = 'super-admin'
    const insertCall = mockPool.query.mock.calls.find(
      (c) => c[0].includes('INSERT INTO admins')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toContain('super-admin');
    // params: [id, username, password_hash, role] — role is the 4th param
    expect(insertCall[1][3]).toBe('super-admin');
  });
});
