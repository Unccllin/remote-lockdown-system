/**
 * Env — the Worker's binding contract, in one place.
 *
 * Previously this interface existed only inside worker.ts and was not exported,
 * while pbl/routes/*.ts referenced `Env` in their signatures. Nothing
 * type-checked the Worker (no tsconfig, no @cloudflare/workers-types), so the
 * gap was invisible: `tsc --noEmit` reported "Cannot find name 'Env'" in seven
 * places the first time it was ever run (S141).
 *
 * Keep this in sync with wrangler.toml. Optional secrets are marked optional so
 * a deployment that omits them still type-checks; the runtime guards they need
 * belong at the call site, not in the type.
 */
export interface Env {
  ADMIN_TOKEN: string;
  LOCKDOWN_KV: KVNamespace;
  /** PKCS8 base64 of the ES256 private key used to sign PBL verdicts. */
  PBL_SIGNING_KEY?: string;
  /** D-205: PKCS8 base64 of the ES256 key for policy signing (separate from verdict). */
  PBL_POLICY_SIGNING_KEY?: string;
  /** S4-serverless: HMAC secret for admin session tokens. */
  JWT_SECRET?: string;
}
