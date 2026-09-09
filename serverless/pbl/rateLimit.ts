/**
 * Rate limiting for PBL endpoints (D-210).
 *
 * Two strategies based on caller model:
 *
 * 1. Per-device rate limiting for firmware endpoints (verdict, attest,
 *    enroll). These are called by the UEFI PBL app at boot time and
 *    include a device_id in the request body. Per-device is NAT-safe:
 *    hundreds of devices behind one corporate IP won't trip the limit.
 *
 * 2. IP-based rate limiting for admin endpoints (devices list/detail/
 *    lock/unlock/track/delete). These are human-driven from the dashboard
 *    and have no device_id in list/health requests.
 *
 * Policy GET and health are NOT rate limited:
 * - Policy is a public signed blob with Cache-Control: max-age=300 and
 *   Cloudflare edge caching. Rate limiting adds a KV read cost for no
 *   benefit.
 * - Health returns a trivial constant response with no KV access.
 *
 * The override challenge/response endpoints already have per-device
 * rate limiting (5/3600s) in override.ts — that is unchanged.
 */

/** Rate limit configuration. */
export interface RateLimitConfig {
  /** Maximum requests allowed within the window. */
  maxRequests: number;
  /** Window size in seconds. */
  windowSeconds: number;
}

/** Per-device rate limits for firmware endpoints. */
export const DEVICE_RATE_LIMITS: Record<string, RateLimitConfig> = {
  // Boot-time calls: 60/min per device (1/sec — generous for boot retries)
  verdict: { maxRequests: 60, windowSeconds: 60 },
  attest: { maxRequests: 60, windowSeconds: 60 },
  // Enrollment: 10/min per device (one-time, but retries happen)
  enroll: { maxRequests: 10, windowSeconds: 60 },
};

/** IP-based rate limits for admin endpoints. */
export const IP_RATE_LIMITS: Record<string, RateLimitConfig> = {
  // Admin dashboard: 60/min per IP (human-driven UI with auto-refresh)
  devices: { maxRequests: 60, windowSeconds: 60 },
};

const DEVICE_PREFIX = 'pbl_rl_dev:';
const IP_PREFIX = 'pbl_rl_ip:';

/** Extract client IP from request headers. */
function getClientIP(request: Request): string {
  const cfIP = request.headers.get('CF-Connecting-IP');
  if (cfIP) return cfIP;
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

/** Check a rate limit against a KV-backed sliding window.
 *
 * Returns { allowed: true } if within the limit,
 * or { allowed: false, retryAfter: seconds } if exceeded.
 */
async function checkLimit(
  kv: KVNamespace,
  key: string,
  config: RateLimitConfig,
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const now = Date.now();
  const windowMs = config.windowSeconds * 1000;

  const data = await kv.get(key, 'json') as { count: number; window_start: number } | null;

  if (!data || (now - data.window_start > windowMs)) {
    await kv.put(key, JSON.stringify({ count: 1, window_start: now }));
    return { allowed: true };
  }

  if (data.count >= config.maxRequests) {
    const retryAfter = Math.ceil((data.window_start + windowMs - now) / 1000);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }

  await kv.put(key, JSON.stringify({ count: data.count + 1, window_start: data.window_start }));
  return { allowed: true };
}

/** Check per-device rate limit.
 *
 * @param deviceId - TPM-derived device ID (hex string)
 */
export async function checkDeviceRateLimit(
  kv: KVNamespace,
  deviceId: string,
  endpoint: string,
  config: RateLimitConfig,
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  return checkLimit(kv, `${DEVICE_PREFIX}${endpoint}:${deviceId}`, config);
}

/** Check IP-based rate limit. */
export async function checkIpRateLimit(
  kv: KVNamespace,
  request: Request,
  endpoint: string,
  config: RateLimitConfig,
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const ip = getClientIP(request);
  return checkLimit(kv, `${IP_PREFIX}${endpoint}:${ip}`, config);
}

/** Create a 429 Too Many Requests response with Retry-After header. */
export function rateLimitResponse(retryAfter: number): Response {
  return new Response(
    JSON.stringify({
      error: 'rate limit exceeded',
      retry_after: retryAfter,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
      },
    },
  );
}
