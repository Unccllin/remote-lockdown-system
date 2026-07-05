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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DB mode: ${process.env.DATABASE_URL ? 'DATABASE_URL (cloud)' : 'individual vars (local)'}`);
});
