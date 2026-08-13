const jwt = require('jsonwebtoken');

// Phase 0: explicit algorithm allowlist prevents alg-confusion attacks
// (e.g., attacker setting alg: "none" or using RS256 public key as HMAC secret).
const JWT_ALGORITHMS = ['HS256'];

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header. Include a Bearer token: Authorization: Bearer <jwt>.' });
  }
  const token = header.slice(7);
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET, { algorithms: JWT_ALGORITHMS });
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired. Log in again to get a new token.' });
  }
}

// Phase 16: RBAC role hierarchy.
// viewer (0) < operator (1) < super-admin (2).
// requireRole(minRole) returns middleware that rejects requests whose
// authenticated admin (set by requireAuth on req.admin.role) is below
// the required level. Must be mounted AFTER requireAuth so req.admin is
// populated.
const ROLE_HIERARCHY = { viewer: 0, operator: 1, 'super-admin': 2 };

function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'Unauthorized. Include a valid Bearer token in the Authorization header.' });
    const userLevel = ROLE_HIERARCHY[req.admin.role] ?? 0;
    const requiredLevel = ROLE_HIERARCHY[minRole] ?? 99;
    if (userLevel < requiredLevel) {
      return res.status(403).json({ error: `Insufficient permissions. This endpoint requires the '${minRole}' role. Your current role is '${req.admin.role}'. Contact a super-admin to upgrade your role.` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, ROLE_HIERARCHY };
