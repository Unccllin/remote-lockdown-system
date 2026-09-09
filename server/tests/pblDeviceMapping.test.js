/**
 * D-206: PBL device identity mapping — server-side tests.
 *
 * Tests the Express endpoints for linking/unlinking PBL device IDs to
 * agent device records, and looking up agent devices by PBL device_id.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');

const { mockPool, makeToken, JWT_SECRET, createApp: _createApp } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const devicesRoutes = require('../src/routes/devices');

function createApp() {
  return _createApp({ devices: devicesRoutes });
}

beforeEach(() => {
  mockPool.query.reset();
});

const PBL_DEVICE_ID = 'd2060001'.repeat(8);
const AGENT_DEVICE_ID = 'device-uuid-1234';

describe('D-206: PBL device identity mapping', () => {
  describe('POST /api/devices/:id/link-pbl', () => {
    it('rejects without auth', async () => {
      const app = createApp();
      const resp = await request(app)
        .post(`/api/devices/${AGENT_DEVICE_ID}/link-pbl`)
        .send({ pbl_device_id: PBL_DEVICE_ID });
      expect(resp.status).toBe(401);
    });

    it('rejects invalid pbl_device_id format', async () => {
      const app = createApp();
      const resp = await request(app)
        .post(`/api/devices/${AGENT_DEVICE_ID}/link-pbl`)
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ pbl_device_id: 'short' });
      expect(resp.status).toBe(400);
    });

    it('rejects missing pbl_device_id', async () => {
      const app = createApp();
      const resp = await request(app)
        .post(`/api/devices/${AGENT_DEVICE_ID}/link-pbl`)
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({});
      expect(resp.status).toBe(400);
    });

    it('returns 404 for non-existent agent device', async () => {
      mockPool.query.setResult('SELECT * FROM devices WHERE id = $1', { rows: [] });
      const app = createApp();
      const resp = await request(app)
        .post(`/api/devices/${AGENT_DEVICE_ID}/link-pbl`)
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ pbl_device_id: PBL_DEVICE_ID });
      expect(resp.status).toBe(404);
    });

    it('links PBL device to agent device', async () => {
      mockPool.query.setResult('SELECT * FROM devices WHERE id = $1', {
        rows: [{ id: AGENT_DEVICE_ID, hostname: 'test-host' }],
      });
      mockPool.query.setResult('SELECT * FROM devices WHERE pbl_device_id = $1', {
        rows: [],
      });
      mockPool.query.setResult('UPDATE devices SET pbl_device_id', {
        rows: [{ id: AGENT_DEVICE_ID, pbl_device_id: PBL_DEVICE_ID }],
      });
      mockPool.query.setResult('INSERT INTO audit_log', { rows: [] });

      const app = createApp();
      const resp = await request(app)
        .post(`/api/devices/${AGENT_DEVICE_ID}/link-pbl`)
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ pbl_device_id: PBL_DEVICE_ID });
      expect(resp.status).toBe(200);
      expect(resp.body.linked).toBe(true);
      expect(resp.body.pbl_device_id).toBe(PBL_DEVICE_ID);
    });

    it('returns 409 when PBL device_id already linked to another device', async () => {
      mockPool.query.setResult('SELECT * FROM devices WHERE id = $1', {
        rows: [{ id: AGENT_DEVICE_ID, hostname: 'test-host' }],
      });
      mockPool.query.setResult('SELECT * FROM devices WHERE pbl_device_id = $1', {
        rows: [{ id: 'other-device-id' }],
      });

      const app = createApp();
      const resp = await request(app)
        .post(`/api/devices/${AGENT_DEVICE_ID}/link-pbl`)
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ pbl_device_id: PBL_DEVICE_ID });
      expect(resp.status).toBe(409);
      expect(resp.body.linked_device_id).toBe('other-device-id');
    });
  });

  describe('POST /api/devices/:id/unlink-pbl', () => {
    it('rejects without auth', async () => {
      const app = createApp();
      const resp = await request(app)
        .post(`/api/devices/${AGENT_DEVICE_ID}/unlink-pbl`);
      expect(resp.status).toBe(401);
    });

    it('returns 404 for non-existent device', async () => {
      mockPool.query.setResult('SELECT * FROM devices WHERE id = $1', { rows: [] });
      const app = createApp();
      const resp = await request(app)
        .post(`/api/devices/${AGENT_DEVICE_ID}/unlink-pbl`)
        .set('Authorization', `Bearer ${makeToken()}`);
      expect(resp.status).toBe(404);
    });

    it('returns 400 when device has no PBL link', async () => {
      mockPool.query.setResult('SELECT * FROM devices WHERE id = $1', {
        rows: [{ id: AGENT_DEVICE_ID, pbl_device_id: null }],
      });
      const app = createApp();
      const resp = await request(app)
        .post(`/api/devices/${AGENT_DEVICE_ID}/unlink-pbl`)
        .set('Authorization', `Bearer ${makeToken()}`);
      expect(resp.status).toBe(400);
    });

    it('unlinks PBL device from agent device', async () => {
      mockPool.query.setResult('SELECT * FROM devices WHERE id = $1', {
        rows: [{ id: AGENT_DEVICE_ID, pbl_device_id: PBL_DEVICE_ID }],
      });
      mockPool.query.setResult('UPDATE devices SET pbl_device_id = NULL', {
        rows: [{ id: AGENT_DEVICE_ID, pbl_device_id: null }],
      });
      mockPool.query.setResult('INSERT INTO audit_log', { rows: [] });

      const app = createApp();
      const resp = await request(app)
        .post(`/api/devices/${AGENT_DEVICE_ID}/unlink-pbl`)
        .set('Authorization', `Bearer ${makeToken()}`);
      expect(resp.status).toBe(200);
      expect(resp.body.unlinked).toBe(true);
    });
  });

  describe('GET /api/devices/by-pbl/:pblDeviceId', () => {
    it('rejects without auth', async () => {
      const app = createApp();
      const resp = await request(app)
        .get(`/api/devices/by-pbl/${PBL_DEVICE_ID}`);
      expect(resp.status).toBe(401);
    });

    it('rejects invalid pbl_device_id format', async () => {
      const app = createApp();
      const resp = await request(app)
        .get('/api/devices/by-pbl/short')
        .set('Authorization', `Bearer ${makeToken()}`);
      expect(resp.status).toBe(400);
    });

    it('returns 404 when no agent device is linked', async () => {
      mockPool.query.setResult('SELECT * FROM devices WHERE pbl_device_id = $1 LIMIT 1', {
        rows: [],
      });
      const app = createApp();
      const resp = await request(app)
        .get(`/api/devices/by-pbl/${PBL_DEVICE_ID}`)
        .set('Authorization', `Bearer ${makeToken()}`);
      expect(resp.status).toBe(404);
    });

    it('returns the linked agent device', async () => {
      mockPool.query.setResult('SELECT * FROM devices WHERE pbl_device_id = $1 LIMIT 1', {
        rows: [{ id: AGENT_DEVICE_ID, hostname: 'test-host', pbl_device_id: PBL_DEVICE_ID }],
      });
      const app = createApp();
      const resp = await request(app)
        .get(`/api/devices/by-pbl/${PBL_DEVICE_ID}`)
        .set('Authorization', `Bearer ${makeToken()}`);
      expect(resp.status).toBe(200);
      expect(resp.body.id).toBe(AGENT_DEVICE_ID);
      expect(resp.body.pbl_device_id).toBe(PBL_DEVICE_ID);
    });
  });
});
