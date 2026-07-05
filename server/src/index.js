require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const devicesRoutes = require('./routes/devices');
const agentRoutes = require('./routes/agent');
const auditRoutes = require('./routes/audit');

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use(limiter);

app.use('/api/auth', authRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/audit', auditRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const pool = require('./db/pool');
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DB mode: ${process.env.DATABASE_URL ? 'DATABASE_URL (cloud)' : 'individual vars (local)'}`);
  console.log(`DATABASE_URL prefix: ${process.env.DATABASE_URL ? process.env.DATABASE_URL.substring(0, 30) : 'NOT SET'}`);
  try {
    await pool.query('SELECT 1');
    console.log('DB connection: OK');
  } catch (err) {
    console.error('DB connection FAILED:', err.message);
    console.error('DB error code:', err.code);
    console.error('DB error detail:', JSON.stringify(err));
  }
});
