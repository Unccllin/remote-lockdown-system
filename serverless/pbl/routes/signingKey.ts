/**
 * GET /v1/signing-key — Returns the server's verdict signing key info.
 *
 * Returns JSON with the server's public key info so clients can build
 * policy blobs that match the server's signing key:
 *   - kid: SHA-256 of SPKI (hex) — for C4 key 71 (lock_service_cert_pin)
 *   - spki: base64-encoded SPKI bytes — for C4 key 76 (verdict_signing_key_spki)
 *   - algorithm: 'ES256' or 'Ed25519'
 *
 * Response: application/json
 *   {
 *     "kid_hex": "...",
 *     "spki_base64": "...",
 *     "algorithm": "ES256"
 *   }
 *
 * No auth required — this is public key info, not secret material.
 */

import { loadOrGenerateSigningKey } from '../signing';

export async function handleSigningKey(
  _request: Request,
  env: { LOCKDOWN_KV: KVNamespace; PBL_SIGNING_KEY?: string },
): Promise<Response> {
  try {
    const keys = await loadOrGenerateSigningKey(env.LOCKDOWN_KV, env.PBL_SIGNING_KEY);

    const kidHex = Array.from(keys.kid)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const spkiBase64 = Buffer.from(keys.spki).toString('base64');

    return new Response(
      JSON.stringify({
        kid_hex: kidHex,
        spki_base64: spkiBase64,
        algorithm: keys.algorithm,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e), stack: e instanceof Error ? e.stack : undefined }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}
