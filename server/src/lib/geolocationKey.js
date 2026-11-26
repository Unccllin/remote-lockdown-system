/**
 * D-230 — the geolocation key this deployment may hand to a device, or null.
 *
 * `GOOGLE_API_KEY` is a deployment secret that every device can read out of its own enrolment
 * response, so it must at least be a real, restricted key (Geolocation API only, with a daily quota —
 * see docs/SERVERLESS-DEPLOY.md). The other half of that rule lives here: a *placeholder* is not a key.
 * The deployment shipped with `ROT-TEST-…`, and serving it told every agent to try a key that cannot
 * work, so BSSID resolution failed and silently fell back to city-level IP location.
 *
 * The Worker has the same two functions in serverless/kv-store.ts. They are duplicated rather than
 * shared because the two backends are separate deployables with no common module — the same reason
 * the HMAC verifier and the timing-safe comparison exist on both sides.
 */

// Deliberately not /test/ anywhere: test suites legitimately use synthetic keys like
// 'test-google-key', and this rule is about a PLACEHOLDER that shipped in a deployment secret —
// the shapes below are the ones that actually appear (ROT-TEST-… is this one).
const PLACEHOLDER_GEOLOCATION_KEY = /^(rot-test|changeme|placeholder|your[-_]?key|example|xxx)/i;

/** The geolocation key this deployment may serve, or null when unset or a placeholder. */
function servedGeolocationKey(env = process.env) {
  const raw = String(env.GOOGLE_API_KEY ?? '').trim();
  if (!raw) return null;
  if (PLACEHOLDER_GEOLOCATION_KEY.test(raw)) return null;
  return raw;
}

/** The `google_api_key` field a response may carry — nothing at all when there is no usable key. */
function geolocationKeyField(env = process.env) {
  const key = servedGeolocationKey(env);
  return key ? { google_api_key: key } : {};
}

module.exports = { servedGeolocationKey, geolocationKeyField, PLACEHOLDER_GEOLOCATION_KEY };
