import { useEffect, useState } from 'react';
import { getHealth } from '../api/health';

/**
 * Detects whether the dashboard is talking to the Cloudflare Worker
 * (serverless mode) or the full Express server.
 *
 * The Worker's /health response includes `serverless: true`; the Express
 * server's does not. The result is cached at module scope so multiple
 * components can call this hook without re-fetching.
 *
 * @returns {{ serverless: boolean|null, loading: boolean }}
 *   - serverless: null while unknown, true/false once resolved
 *   - loading: true until the first health check completes
 */
let cachedServerless = null;

export function useServerlessMode() {
  const [serverless, setServerless] = useState(cachedServerless);
  const [loading, setLoading] = useState(cachedServerless === null);

  useEffect(() => {
    if (cachedServerless !== null) {
      setServerless(cachedServerless);
      setLoading(false);
      return;
    }
    let cancelled = false;
    getHealth()
      .then((res) => {
        const val = !!res.data?.serverless;
        cachedServerless = val;
        if (!cancelled) {
          setServerless(val);
          setLoading(false);
        }
      })
      .catch(() => {
        // Health check failed — assume Express server (not serverless).
        cachedServerless = false;
        if (!cancelled) {
          setServerless(false);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { serverless, loading };
}

/** Reset the cache — used by tests. */
export function _resetServerlessCache() {
  cachedServerless = null;
}
