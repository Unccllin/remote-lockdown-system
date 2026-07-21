const jwt = require('jsonwebtoken');

// Phase 0: explicit algorithm allowlist prevents alg-confusion attacks
// (e.g., attacker setting alg: "none" or using RS256 public key as HMAC secret).
const JWT_ALGORITHMS = ['HS256'];

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET, { algorithms: JWT_ALGORITHMS });
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired' });
  }
}

module.exports = { requireAuth };
