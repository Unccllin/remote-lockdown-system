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
  /**
   * How long a location report is kept, in days (default 90, hard ceiling 180).
   *
   * Distinct from LOCATION_HISTORY_LIMIT, which is a count. The history cap evicts the oldest
   * once a device is full; a quiet device never fills, so its oldest report would otherwise sit
   * forever. The Node server enforces this with a scheduler loop; a Worker has no process to
   * host one, so the cron trigger calls the purge and this variable carries the policy.
   */
  LOCATION_RETENTION_DAYS?: string;
  /**
   * Replay protection for signed agent requests (default on; set "off" only for a staged
   * rollout). The nonce is recorded for HMAC_TIMESTAMP_WINDOW_SECONDS.
   */
  REPLAY_PROTECTION?: string;
  /** Signature freshness window in seconds (default 300, matching the Node server). */
  HMAC_TIMESTAMP_WINDOW_SECONDS?: string;
  /** A device is stale when its last check-in is older than this (default 600). */
  STALE_DEVICE_THRESHOLD_SEC?: string;
  /** How long before the same stale device alerts again (default 24 hours). */
  ALERT_REPEAT_HOURS?: string;
  /** Generic webhook: receives POST { eventType, timestamp, payload }. */
  NOTIFICATION_WEBHOOK_URL?: string;
  /** Slack incoming webhook: receives POST { text }. */
  SLACK_WEBHOOK_URL?: string;
  /**
   * Optional relational binding (D1). When present it is preferred for replay protection, where
   * a UNIQUE constraint is authoritative and a key-value store is not.
   *
   * Optional on purpose, like R2: a deployment that never creates the database keeps working on
   * KV. Schema and staged cutover plan: serverless/d1/schema.sql, docs/SERVERLESS-D1-CUTOVER.md.
   */
  DB?: D1Database;
  /**
   * How many audit entries are retained (ADR-005; default 1000 when unset).
   *
   * Same reasoning as the location cap: retention is only exercised by crossing it.
   */
  AUDIT_HISTORY_LIMIT?: string;
  /**
   * R2 bucket for artifacts that do not fit a KV value.
   *
   * Cloudflare caps a KV value at 27 MiB, and the generic NSIS installer — which embeds
   * `lockdown-agent.exe` plus `lockdown-installer.exe` — crossed it at 33 MB of payload (S291:
   * "content size of 41203591 bytes exceeds maximum allowed size of 27MiB"). Optional on
   * purpose: with no binding, `readBinary()` behaves exactly as the KV-only code did, so a
   * deployment that has not enabled R2 keeps working unchanged.
   */
  BINARIES?: R2Bucket;
  /**
   * R2 bucket for encrypted backups. Optional: with no binding the backup pass records that it
   * skipped, rather than failing the cron tick that also runs retention and alerting.
   *
   * Deliberately a separate bucket from BINARIES: a backup is the only object in this system that
   * contains every credential hash at once, so it should be able to carry its own lifecycle and
   * access rules without exposing the download bucket to them.
   */
  BACKUPS?: R2Bucket;
  /**
   * 64 hex characters (32 bytes) for AES-256-GCM backup encryption. Required to write or read a
   * backup — with no key the pass refuses, because a plaintext backup is a credential dump.
   */
  BACKUP_ENCRYPT_KEY?: string;
  /** Backup retention in days (default 30). */
  BACKUP_RETENTION_DAYS?: string;
  /**
   * Google Geolocation key, provisioned into the enrolment response at install
   * time (ruling C, S306 — see docs/adr/ADR-008-geolocation-key-delivery.md).
   * Optional on purpose: unset means the response omits google_api_key entirely.
   */
  GOOGLE_API_KEY?: string;
}
