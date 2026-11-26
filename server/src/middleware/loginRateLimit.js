// D-228: admin login attempt limiting + lockout (rate limiting only; MFA deferred).
//
// In-process Map, following the hmacAuth.js nonceCache precedent: the codebase
// already accepts this single-instance trade for replay protection, the Express
// deployment is one process behind Caddy, and a migration would add no security
// gain here. Limitation: a process restart clears the counters (documented
// fallback: a 021_login_attempts.sql migration if the parent overrides).
const LIMIT_USER = 5;
const LIMIT_IP = 20;
const WINDOW_MS = 15 * 60 * 1000;

const store = new Map(); // key -> { count, lockedUntil }

function now() { return Date.now(); }

function normUser(u) { return String(u ?? '').trim().toLowerCase(); }

function keyUser(u) { return `user:${normUser(u)}`; }
function keyIp(ip) { return `ip:${String(ip ?? 'unknown')}`; }

function get(key) {
  const v = store.get(key);
  if (!v) return { count: 0, lockedUntil: 0 };
  return v;
}

function isLocked(key) {
  const v = get(key);
  return v.lockedUntil > now();
}

function record(key) {
  const v = get(key);
  v.count += 1;
  const limit = key.startsWith('user:') ? LIMIT_USER : LIMIT_IP;
  if (v.count >= limit) v.lockedUntil = now() + WINDOW_MS;
  store.set(key, v);
}

function clear(key) { store.delete(key); }

const loginRateLimit = (req, res, next) => {
  const username = req.body && req.body.username;
  const ip = req.ip;
  // IP lockout checked first (no existence leak).
  if (isLocked(keyIp(ip))) {
    const v = get(keyIp(ip));
    const mins = Math.ceil((v.lockedUntil - now()) / 60000);
    return res.status(429).json({ error: `Too many failed login attempts. Try again in ${mins} minutes.` });
  }
  // username lockout
  if (isLocked(keyUser(username))) {
    const v = get(keyUser(username));
    const mins = Math.ceil((v.lockedUntil - now()) / 60000);
    return res.status(429).json({ error: `Too many failed login attempts. Try again in ${mins} minutes.` });
  }
  req.loginAttemptKeys = { user: keyUser(username), ip: keyIp(ip) };
  next();
};

function recordLoginFailure(req) {
  if (!req.loginAttemptKeys) return;
  record(req.loginAttemptKeys.user);
  record(req.loginAttemptKeys.ip);
}

function clearLoginFailures(req) {
  if (!req.loginAttemptKeys) return;
  clear(req.loginAttemptKeys.user);
  clear(req.loginAttemptKeys.ip);
}

function __resetLoginAttemptsForTests() { store.clear(); }

module.exports = { loginRateLimit, recordLoginFailure, clearLoginFailures, __resetLoginAttemptsForTests, now };
