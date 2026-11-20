/**
 * Response, hashing and KV-parsing helpers shared by the Worker and its modules.
 *
 * Extracted from worker.ts (S277): that file crossed the 5000-line analysis limit, which made the
 * whole Worker invisible to harness diagnostics — not just the newest code. These are the
 * zero-dependency primitives every other module needs, so they move first; the modules that depend
 * on THIS one (admin auth, storage) can then be extracted without a cycle.
 */

/**
 * Bearer-token API with no cookie sessions, so a wildcard origin exposes no credentials: a hostile
 * page can send the request but cannot attach a token it does not have. Stated once, here, so the
 * decision is reviewable rather than repeated as a bare literal.
 */
export const TOKEN_API_CORS_ORIGIN = '*';

export async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
/**
 * SHA-256 of raw bytes, lowercase hex.
 *
 * Used to label binary downloads with x-content-sha256 so a client can prove the
 * body it received is the body this Worker served. It is transport integrity,
 * not authenticity — a hash delivered alongside the bytes is self-certifying
 * (see the same caveat in agent/agent.py's update path). Authenticity needs a
 * signature; the installer binaries are not Authenticode-signed yet.
 */
export async function sha256HexBytes(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
/** Constant-time string comparison (length + byte-wise). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function hmacSha256(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function generateId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function generateApiKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': TOKEN_API_CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Key, X-Timestamp, X-Nonce, X-Signature, X-Sig-Version',
    },
  });
}
export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
/**
 * Parse a JSON blob read from KV.
 *
 * KV is external storage: a truncated or hand-edited value would otherwise raise
 * a bare SyntaxError from deep inside a handler with no clue which key was bad.
 * This names the key and re-throws. It deliberately does NOT fall back to an empty
 * collection — silently treating corruption as "no data" would make a tampered
 * fleet look empty, which is the wrong direction for an anti-theft system.
 */
export function parseKvJson<T>(raw: string, key: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`corrupt KV value at "${key}" — refusing to treat it as empty`);
  }
}
/**
 * Parse a request body that was already read as text (agent HMAC verification
 * needs the raw bytes, so the handlers cannot re-read the stream).
 *
 * Returns null instead of throwing: a malformed body from an authenticated agent
 * is the caller's bug, and the honest answer is 400. Before this, the throw
 * escaped the handler and the runtime turned it into a 500 with no explanation.
 */
export function parseJsonBody(text: string): any | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
/**
 * The request's URL.
 *
 * `Request.url` is absolute by construction, so a throw here means the Request
 * itself is malformed and never reached a handler. Centralised so the seven call
 * sites do not each need a try/catch, and so a hypothetical malformed URL
 * degrades to empty route params rather than a 500.
 */
export function requestUrl(request: Request): URL {
  try {
    return new URL(request.url);
  } catch {
    return new URL('https://invalid.invalid/');
  }
}
export function b64encode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
export function b64decode(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
