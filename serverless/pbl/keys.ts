/**
 * The isolate-level signing-key cache for the `/v1` firmware routes.
 *
 * Split out of worker.ts (S278) together with the routes: both key getters are per-isolate
 * memoisation of `pbl/signing.ts`, and keeping them next to the routes that use them removes the
 * last worker.ts dependency from the PBL module graph.
 */
import type { Env } from './env';
import { loadOrGenerateSigningKey, loadOrGeneratePolicySigningKey, type SigningKeyPair } from './signing';

// Cache the signing key pair across requests within the same isolate.
let cachedKeys: SigningKeyPair | null = null;
let cachedPolicyKeys: SigningKeyPair | null = null;

/** Reset the signing key cache (D-205: used by key rotation and tests). */
export function resetKeyCache(): void {
  cachedKeys = null;
  cachedPolicyKeys = null;
}

export async function getSigningKeys(env: Env): Promise<SigningKeyPair> {
  if (cachedKeys) return cachedKeys;
  cachedKeys = await loadOrGenerateSigningKey(env.LOCKDOWN_KV, env.PBL_SIGNING_KEY);
  return cachedKeys;
}

// D-205: Separate policy signing key (C4 §1 — different from verdict key)
export async function getPolicySigningKeys(env: Env): Promise<SigningKeyPair> {
  if (cachedPolicyKeys) return cachedPolicyKeys;

  cachedPolicyKeys = await loadOrGeneratePolicySigningKey(env.LOCKDOWN_KV, env.PBL_POLICY_SIGNING_KEY);

  return cachedPolicyKeys;
}
