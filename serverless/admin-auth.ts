/**
 * Admin authentication: password hashing, session tokens and the role gate.
 *
 * Extracted from worker.ts (S277), same goal as `http.ts`: get the Worker under the 5000-line
 * analysis limit so harness diagnostics can see it again. The hashing parameters are load-bearing
 * and recorded in ADR-001 — PBKDF2 at 100,000 iterations is the Workers WebCrypto ceiling, and
 * 210,000 is the legacy count that never ran on the live Worker.
 */
import type { Env } from './pbl/env';
import {
  b64decode, b64encode, errorResponse, generateId, hmacSha256, jsonResponse, parseKvJson, sha256,
} from './http';
export interface AdminClaims {
  id: string;
  username: string;
  role: AdminRole;
}

export async function resolveAdminAuth(request: Request, env: Env): Promise<AdminClaims | null> {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }
  const token = auth.slice(7);

  // Break-glass: the env ADMIN_TOKEN maps to a synthetic super-admin so the
  // Worker is usable before any admin is created (bootstrap / recovery).
  if (token === env.ADMIN_TOKEN) {
    return { id: 'admin-token', username: 'admin', role: 'super-admin' };
  }

  // Otherwise verify a signed session token.
  return verifyAdminToken(env, token);
}

/**
 * Role gate — mirrors the Express server's requireRole(minRole).
 * Returns the admin claims if authorized, or a Response (401/403) to return.
 */
export async function requireRole(
  request: Request,
  env: Env,
  minRole: AdminRole,
): Promise<AdminClaims | Response> {
  const admin = await resolveAdminAuth(request, env);
  if (!admin) {
    return errorResponse('Admin authentication required', 401);
  }
  const level = ROLE_HIERARCHY[admin.role] ?? 0;
  if (level < ROLE_HIERARCHY[minRole]) {
    return errorResponse(
      `Insufficient permissions. This endpoint requires the '${minRole}' role.`,
      403,
    );
  }
  return admin;
}

// ---------------------------------------------------------------------------
// KV storage helpers
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// S4-serverless: multi-admin RBAC on KV (end-state serverless auth).
//
// The end goal is a fully-serverless system; the Worker is the deployed
// authority. This layer ports the Express server's admin model (username +
// password + role) onto KV so the dashboard and admin-plane endpoints work
// without Postgres.
//
// - admins[] stored in a single KV key (low-cardinality, mirrors devices).
// - Passwords hashed with PBKDF2-SHA256 (native WebCrypto, NIST floor).
// - Sessions are stateless HMAC-signed tokens ({id, username, role, exp}).
// - ADMIN_TOKEN remains as a break-glass super-admin fallback so the Worker
//   still works before any admin is created (bootstrap / recovery).
// ---------------------------------------------------------------------------

export type AdminRole = 'viewer' | 'operator' | 'super-admin';

export interface Admin {
  id: string;
  username: string;
  password_hash: string; // base64 PBKDF2
  salt: string;          // base64
  // PBKDF2 iteration count used for password_hash. Optional for backward
  // compat — admins created before this field existed used the then-current
  // PBKDF2_ITERATIONS default. Recording it per-admin lets us change the
  // cost without invalidating existing hashes.
  pbkdf2_iterations?: number;
  role: AdminRole;
  created_at: string;
}

export const ADMINS_KEY = 'admins';
// Cloudflare Workers' WebCrypto caps PBKDF2 at 100,000 iterations
// (NotSupportedError above that). 210k was the NIST floor we targeted but it
// crashes on the real Workers runtime (error 1101 on create-admin). 100k is
// the platform max and still a strong PBKDF2-SHA256 cost.
export const PBKDF2_ITERATIONS = 100_000;
// Iteration count used for admins created before pbkdf2_iterations was
// recorded (they were hashed at the original 210k — which only ever ran in
// Node tests, never on the live Worker, so no live admin uses it).
export const LEGACY_PBKDF2_ITERATIONS = 210_000;
export const TOKEN_TTL_SECONDS = 8 * 3600; // match server's JWT_EXPIRES_IN default (8h)

export const ROLE_HIERARCHY: Record<AdminRole, number> = {
  viewer: 0,
  operator: 1,
  'super-admin': 2,
};




export async function listAdmins(env: Env): Promise<Admin[]> {
  const data = await env.LOCKDOWN_KV.get(ADMINS_KEY);
  return data ? parseKvJson<Admin[]>(data, ADMINS_KEY) : [];
}

export async function saveAdmins(env: Env, admins: Admin[]): Promise<void> {
  await env.LOCKDOWN_KV.put(ADMINS_KEY, JSON.stringify(admins));
}



/** PBKDF2-SHA256 password hash (base64) for a given salt + iteration count. */
export async function pbkdf2Hash(password: string, saltB64: string, iterations: number = PBKDF2_ITERATIONS): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: b64decode(saltB64) as BufferSource,
      iterations,
    },
    keyMaterial,
    256,
  );
  return b64encode(bits);
}

/** Create an admin record with a fresh random salt + PBKDF2 hash. */
export async function makeAdmin(username: string, password: string, role: AdminRole): Promise<Admin> {
  const salt = b64encode(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const password_hash = await pbkdf2Hash(password, salt, PBKDF2_ITERATIONS);
  return {
    id: generateId(),
    username,
    password_hash,
    salt,
    pbkdf2_iterations: PBKDF2_ITERATIONS,
    role,
    created_at: new Date().toISOString(),
  };
}

export function b64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

/** Issue a stateless HMAC-signed session token (JWT-shape: header.payload.sig). */
export async function signAdminToken(env: Env, admin: Admin): Promise<string> {
  const secret = env.JWT_SECRET || env.ADMIN_TOKEN || 'dev-secret';
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64urlEncode(
    JSON.stringify({
      id: admin.id,
      username: admin.username,
      role: admin.role,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    }),
  );
  const sig = await hmacSha256(secret, `${header}.${payload}`);
  return `${header}.${payload}.${b64urlEncode(sig)}`;
}

/** Verify a signed token; returns the embedded admin claims or null. */
export async function verifyAdminToken(
  env: Env,
  token: string,
): Promise<{ id: string; username: string; role: AdminRole } | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const secret = env.JWT_SECRET || env.ADMIN_TOKEN || 'dev-secret';
  const expected = await hmacSha256(secret, `${parts[0]}.${parts[1]}`);
  const sig = b64urlDecode(parts[2]);
  // Constant-time comparison.
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(b64urlDecode(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null; // expired
    if (!payload.id || !payload.role) return null;
    return { id: payload.id, username: payload.username, role: payload.role };
  } catch {
    return null;
  }
}
