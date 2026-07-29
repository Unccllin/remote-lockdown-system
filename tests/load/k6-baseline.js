/**
 * k6 Baseline Load Test — Agent Polling
 *
 * Simulates a fleet of agents performing their periodic checkin against
 * POST /api/agent/checkin. Each virtual user (VU) acts as a single device:
 *   1. Sends a checkin request with device credentials (x-agent-key header).
 *   2. Sleeps for the configured poll interval (default 30s).
 *   3. Repeats for the test duration.
 *
 * Configuration (env vars):
 *   K6_VUS            — number of virtual users (default 1000)
 *   K6_DURATION       — total test duration (default 2m)
 *   K6_POLL_INTERVAL  — seconds between checkins per VU (default 30)
 *   K6_BASE_URL       — target server base URL (default http://localhost:3001)
 *   K6_AGENT_KEY      — agent API key sent in x-agent-key header
 *                       (default: test-agent-key; set AGENT_SHARED_KEY on the
 *                        server to match, or provision per-device keys)
 *
 * Thresholds:
 *   p95 < 500ms, p99 < 1000ms, error rate < 1%
 *
 * Usage:
 *   k6 run tests/load/k6-baseline.js
 *   K6_VUS=500 K6_DURATION=5m k6 run tests/load/k6-baseline.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3001';
const VUS = parseInt(__ENV.K6_VUS || '1000', 10);
const DURATION = __ENV.K6_DURATION || '2m';
const POLL_INTERVAL = parseFloat(__ENV.K6_POLL_INTERVAL || '30');
const AGENT_KEY = __ENV.K6_AGENT_KEY || 'test-agent-key';

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

/**
 * Build a checkin request body for a given VU. Each VU gets a stable
 * hostname / hardware identity so the server treats it as a distinct device.
 */
function checkinPayload(vuId) {
  const idx = String(vuId).padStart(5, '0');
  return {
    hostname: `load-test-device-${idx}`,
    mac_address: `02:00:00:${String((vuId >> 16) & 0xff).padStart(2, '0')}:${String((vuId >> 8) & 0xff).padStart(2, '0')}:${String(vuId & 0xff).padStart(2, '0')}`,
    hardware_uuid: `00000000-0000-4000-8000-${String(vuId).padStart(12, '0')}`,
  };
}

export default function () {
  const vuId = __VU;
  const url = `${BASE_URL}/api/agent/checkin`;
  const payload = JSON.stringify(checkinPayload(vuId));

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-agent-key': AGENT_KEY,
    },
  };

  const res = http.post(url, payload, params);

  check(res, {
    'checkin status is 200': (r) => r.status === 200,
    'response has device_id': (r) => {
      try {
        const body = r.json();
        return body && body.device_id !== undefined;
      } catch (e) {
        return false;
      }
    },
  });

  // Simulate the agent's poll interval before the next checkin.
  sleep(POLL_INTERVAL);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data),
  };
}

// Minimal text summary helper (k6 provides a default summary; this augments it).
function textSummary(data) {
  const metrics = data.metrics || {};
  const duration = metrics.http_req_duration || {};
  const failed = metrics.http_req_failed || {};
  const reqs = metrics.http_reqs || {};
  return (
    `\n--- Baseline Load Test Summary ---\n` +
    `VUs: ${VUS} | Duration: ${DURATION} | Poll interval: ${POLL_INTERVAL}s\n` +
    `Requests: ${reqs.count || 0} (${(reqs.rate || 0).toFixed(2)} req/s)\n` +
    `http_req_duration p95: ${((duration['p(95)'] || 0) / 1000).toFixed(2)}ms\n` +
    `http_req_duration p99: ${((duration['p(99)'] || 0) / 1000).toFixed(2)}ms\n` +
    `http_req_failed rate: ${((failed.rate || 0) * 100).toFixed(2)}%\n` +
    `Thresholds: ${data.thresholds ? 'evaluated' : 'n/a'}\n`
  );
}
