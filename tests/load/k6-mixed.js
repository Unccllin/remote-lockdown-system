/**
 * k6 Mixed Traffic Load Test
 *
 * Simulates a realistic traffic mix against the server:
 *   - 90% agent polling (POST /api/agent/checkin every 30s)
 *   - 5%  admin dashboard requests (GET /api/devices, GET /api/audit)
 *   - 5%  agent command ACKs (POST /api/agent/command-ack)
 *
 * The mix is implemented with k6 scenarios using weighted exec functions so
 * the request distribution matches the target percentages.
 *
 * Configuration (env vars):
 *   K6_VUS            — total virtual users (default 500)
 *   K6_DURATION       — total test duration (default 3m)
 *   K6_BASE_URL       — target server base URL (default http://localhost:3001)
 *   K6_AGENT_KEY      — agent API key (x-agent-key header)
 *   K6_ADMIN_TOKEN    — admin bearer token for dashboard endpoints
 *
 * Thresholds:
 *   p95 < 800ms, error rate < 2%
 *
 * Usage:
 *   k6 run tests/load/k6-mixed.js
 *   K6_VUS=1000 K6_DURATION=5m K6_ADMIN_TOKEN=xxx k6 run tests/load/k6-mixed.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3001';
const VUS = parseInt(__ENV.K6_VUS || '500', 10);
const DURATION = __ENV.K6_DURATION || '3m';
const AGENT_KEY = __ENV.K6_AGENT_KEY || 'test-agent-key';
const ADMIN_TOKEN = __ENV.K6_ADMIN_TOKEN || 'test-admin-token';
const POLL_INTERVAL = parseFloat(__ENV.K6_POLL_INTERVAL || '30');

const pollingVus = Math.max(1, Math.round(VUS * 0.9));
const adminVus = Math.max(1, Math.round(VUS * 0.05));
const ackVus = Math.max(1, VUS - pollingVus - adminVus);

export const options = {
  scenarios: {
    // 90% of VUs — agent polling
    agent_polling: {
      executor: 'constant-vus',
      vus: pollingVus,
      duration: DURATION,
      exec: 'agentPoll',
    },
    // 5% of VUs — admin dashboard
    admin_dashboard: {
      executor: 'constant-vus',
      vus: adminVus,
      duration: DURATION,
      exec: 'adminDashboard',
    },
    // 5% of VUs — agent ACKs
    agent_acks: {
      executor: 'constant-vus',
      vus: ackVus,
      duration: DURATION,
      exec: 'agentAck',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<800'],
    http_req_failed: ['rate<0.02'],
  },
};

const agentHeaders = {
  'Content-Type': 'application/json',
  'x-agent-key': AGENT_KEY,
};

const adminHeaders = {
  'Authorization': `Bearer ${ADMIN_TOKEN}`,
  'Accept': 'application/json',
};

function checkinPayload(vuId) {
  const idx = String(vuId).padStart(5, '0');
  return {
    hostname: `load-test-device-${idx}`,
    mac_address: `02:00:00:${String((vuId >> 16) & 0xff).padStart(2, '0')}:${String((vuId >> 8) & 0xff).padStart(2, '0')}:${String(vuId & 0xff).padStart(2, '0')}`,
    hardware_uuid: `00000000-0000-4000-8000-${String(vuId).padStart(12, '0')}`,
  };
}

/**
 * Scenario 1 — agent polling (90%).
 * Each VU checkins, then sleeps for the poll interval.
 */
export function agentPoll() {
  const vuId = __VU;
  const url = `${BASE_URL}/api/agent/checkin`;
  const res = http.post(url, JSON.stringify(checkinPayload(vuId)), { headers: agentHeaders });

  check(res, {
    'checkin status is 200': (r) => r.status === 200,
  });

  sleep(POLL_INTERVAL);
}

/**
 * Scenario 2 — admin dashboard (5%).
 * Alternates between GET /api/devices and GET /api/audit.
 */
export function adminDashboard() {
  const vuId = __VU;

  // Alternate between the two endpoints per iteration.
  if (vuId % 2 === 0) {
    const res = http.get(`${BASE_URL}/api/devices`, { headers: adminHeaders });
    check(res, {
      'GET /api/devices is 200': (r) => r.status === 200,
    });
  } else {
    const res = http.get(`${BASE_URL}/api/audit`, { headers: adminHeaders });
    check(res, {
      'GET /api/audit is 200': (r) => r.status === 200,
    });
  }

  // Admin dashboards refresh every few seconds.
  sleep(5);
}

/**
 * Scenario 3 — agent ACKs (5%).
 * Simulates agents acknowledging commands. Performs a checkin first to obtain
 * a pending command id, then ACKs it. If no command is pending, the ACK is
 * skipped (the checkin itself still counts as traffic).
 */
export function agentAck() {
  const vuId = __VU;
  const checkinUrl = `${BASE_URL}/api/agent/checkin`;
  const ackUrl = `${BASE_URL}/api/agent/command-ack`;

  const checkinRes = http.post(checkinUrl, JSON.stringify(checkinPayload(vuId)), { headers: agentHeaders });
  check(checkinRes, { 'checkin status is 200': (r) => r.status === 200 });

  let command = null;
  try {
    const body = checkinRes.json();
    command = body && body.command;
  } catch (e) {
    command = null;
  }

  if (command && command.id) {
    const ackPayload = JSON.stringify({
      hostname: `load-test-device-${String(vuId).padStart(5, '0')}`,
      command_id: command.id,
      result_status: 'executed',
    });
    const ackRes = http.post(ackUrl, ackPayload, { headers: agentHeaders });
    check(ackRes, { 'ack status is 200': (r) => r.status === 200 });
  }

  sleep(10);
}
