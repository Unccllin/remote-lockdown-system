const request = require('supertest');
const express = require('express');
const bcrypt = require('bcryptjs');
const { mockPool } = require('./mockPool');
jest.mock('../src/db/pool', () => mockPool);

const { __resetLoginAttemptsForTests } = require('../src/middleware/loginRateLimit');
const authRouter = require('../src/routes/auth');

function makeApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

describe('login lockout (D-228) server', () => {
  beforeEach(() => {
    __resetLoginAttemptsForTests();
  });

  it('5 wrong -> 6th refused 429 even correct', async () => {
    const hash = bcrypt.hashSync('correctpw', 4);
    mockPool.query.setResult('SELECT * FROM admins', { rows: [{ id: 1, username: 'admin', password_hash: hash, role: 'super-admin' }] });
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').set('X-Forwarded-For', '1.2.3.4').send({ username: 'admin', password: 'wrong' });
    }
    const r = await request(app).post('/api/auth/login').set('X-Forwarded-For', '1.2.3.4').send({ username: 'admin', password: 'correctpw' });
    expect(r.status).toBe(429);
  });

  it('correct during lockout refused', async () => {
    const hash = bcrypt.hashSync('correctpw', 4);
    mockPool.query.setResult('SELECT * FROM admins', { rows: [{ id: 1, username: 'admin', password_hash: hash, role: 'super-admin' }] });
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').set('X-Forwarded-For', '1.2.3.4').send({ username: 'admin', password: 'wrong' });
    }
    const r = await request(app).post('/api/auth/login').set('X-Forwarded-For', '1.2.3.4').send({ username: 'admin', password: 'correctpw' });
    expect(r.status).toBe(429);
  });

  it('after window succeeds and resets counter', async () => {
    const hash = bcrypt.hashSync('correctpw', 4);
    mockPool.query.setResult('SELECT * FROM admins', { rows: [{ id: 1, username: 'admin', password_hash: hash, role: 'super-admin' }] });
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').set('X-Forwarded-For', '1.2.3.4').send({ username: 'admin', password: 'wrong' });
    }
    const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
    const r = await request(app).post('/api/auth/login').set('X-Forwarded-For', '1.2.3.4').send({ username: 'admin', password: 'correctpw' });
    expect(r.status).toBe(200);
    spy.mockRestore();
    // reset proven: one wrong then correct succeeds
    __resetLoginAttemptsForTests();
    mockPool.query.setResult('SELECT * FROM admins', { rows: [{ id: 1, username: 'admin', password_hash: hash, role: 'super-admin' }] });
    await request(app).post('/api/auth/login').set('X-Forwarded-For', '1.2.3.4').send({ username: 'admin', password: 'wrong' });
    const r2 = await request(app).post('/api/auth/login').set('X-Forwarded-For', '1.2.3.4').send({ username: 'admin', password: 'correctpw' });
    expect(r2.status).toBe(200);
  });

  it('unknown vs wrong 401 bodies identical', async () => {
    const hash = bcrypt.hashSync('correctpw', 4);
    mockPool.query.setResult('SELECT * FROM admins', { rows: [{ id: 1, username: 'admin', password_hash: hash, role: 'super-admin' }] });
    const app = makeApp();
    const r1 = await request(app).post('/api/auth/login').set('X-Forwarded-For', '9.9.9.9').send({ username: 'admin', password: 'wrong' });
    mockPool.query.setResult('SELECT * FROM admins', { rows: [] });
    const r2 = await request(app).post('/api/auth/login').set('X-Forwarded-For', '9.9.9.9').send({ username: 'nope', password: 'wrong' });
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(JSON.stringify(r1.body)).toBe(JSON.stringify(r2.body));
  });

  it('case/whitespace shared key', async () => {
    const hash = bcrypt.hashSync('correctpw', 4);
    mockPool.query.setResult('SELECT * FROM admins', { rows: [{ id: 1, username: 'admin', password_hash: hash, role: 'super-admin' }] });
    const app = makeApp();
    for (let i = 0; i < 4; i++) {
      await request(app).post('/api/auth/login').set('X-Forwarded-For', '2.2.2.2').send({ username: 'Admin ', password: 'wrong' });
    }
    await request(app).post('/api/auth/login').set('X-Forwarded-For', '2.2.2.2').send({ username: ' admin', password: 'wrong' });
    const r = await request(app).post('/api/auth/login').set('X-Forwarded-For', '2.2.2.2').send({ username: 'admin', password: 'correctpw' });
    expect(r.status).toBe(429);
  });
});
