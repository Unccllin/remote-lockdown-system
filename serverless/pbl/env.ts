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
  /**
   * How often an ACTIVE device polls, in seconds (default 60 when unset).
   *
   * Declared on Env rather than reached for with `as unknown as Record<…>` at each call
   * site: the agent learns about a queued command only when it polls, so this number is
   * the difference between "flag a device" taking a second and taking five minutes.
   */
  ACTIVE_POLL_SECONDS?: string;
  /**
   * "true" serves the GUI setup wizard instead of the silent installer.
   *
   * Declared here for the same reason as ACTIVE_POLL_SECONDS: these are wrangler `[vars]`
   * and each call site used to reach for them with `as unknown as Record<…>`.
   */
  INSTALLER_GUI?: string;
  /**
   * How many location reports one device keeps (ADR-004; default 500 when unset).
   *
   * Declared on Env for the same reason as ACTIVE_POLL_SECONDS — and because a retention limit
   * that cannot be exercised is one nobody has watched work: the pruning path is only reachable
   * by crossing it.
   */
  LOCATION_HISTORY_LIMIT?: string;
}
