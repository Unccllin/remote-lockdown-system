#!/usr/bin/env node
/**
 * Post-deploy smoke for the serverless Worker (S351).
 *
 * `make verify-worker` answers "does this bundle build and route?" against local workerd. This
 * answers a different question: "does the thing I just deployed behave?" — with real HTTP, the
 * real bindings, and a token that has to work.
 *
 * Default is read-only: it never writes a device or a backup, so it is safe against production.
 * The two write paths (create a backup, enrol a throwaway device to prove replay rejection) are
 * opt-in flags, because both leave a trace an operator may not want.
 *
 *   node scripts/serverless-smoke.mjs --url https://lockdown.example.com --token "$ADMIN_TOKEN"
 *   node scripts/serverless-smoke.mjs --url ... --token ... --allow-writes
 *
 * Exit codes: 0 all checks passed or skipped with a reason · 1 at least one FAIL.
 */
const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes(name);
}

function value(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const BASE = (value('--url') || process.env.SERVERLESS_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = value('--token') || process.env.SERVERLESS_ADMIN_TOKEN || '';
const ALLOW_WRITES = flag('--allow-writes');

let failures = 0;
let passes = 0;
let skips = 0;

function ok(msg, detail = '') {
  passes += 1;
  console.log(`[OK]   ${msg}${detail ? ` — ${detail}` : ''}`);
}

function fail(msg, detail = '') {
  failures += 1;
  console.error(`[FAIL] ${msg}${detail ? ` — ${detail}` : ''}`);
}

function skip(msg, reason) {
  skips += 1;
  console.log(`[SKIP] ${msg} — ${reason}`);
}

async function request(method, path, { token, body, contentType } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && contentType !== 'raw') headers['Content-Type'] = 'application/json';
  if (contentType && contentType !== 'raw') headers['Content-Type'] = contentType;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

async function main() {
  console.log(`[smoke] target ${BASE}${ALLOW_WRITES ? ' (write checks enabled)' : ' (read-only)'}`);
  if (!TOKEN) {
    fail('no admin token', 'pass --token or set SERVERLESS_ADMIN_TOKEN; every authenticated check will fail');
  }

  // 1. Liveness. If this fails nothing else is meaningful, and the message should say so.
  const health = await request('GET', '/api/health');
  if (health.status === 200) ok('GET /api/health -> 200');
  else fail('GET /api/health', `got ${health.status} — the deployment is not answering`);

  // 2. Setup state decides whether the deployment can be logged into at all.
  const setup = await request('GET', '/api/setup/status');
  if (setup.status === 200) {
    // The route answers { setupComplete, needsSetup, admins } — read the field it actually sends
    // rather than a guessed name, which would print `undefined` and look like a pass.
    const needs = setup.json?.needsSetup;
    const admins = setup.json?.admins;
    ok('GET /api/setup/status -> 200', `needsSetup=${String(needs)} admins=${String(admins)}`);
    if (needs === true) {
      skip('super-admin exists', 'needsSetup=true: only the break-glass token works until the first admin is created');
    }
  } else {
    fail('GET /api/setup/status', `got ${setup.status}`);
  }

  // 3. Authentication must reject, not 404 — a 404 here means the route table is wrong.
  const anon = await request('GET', '/api/devices');
  if (anon.status === 401) ok('GET /api/devices without a token -> 401');
  else fail('unauthenticated /api/devices', `got ${anon.status}, expected 401`);

  const bogus = await request('GET', '/api/devices', { token: 'invalid-example-token' });
  if (bogus.status === 401) ok('GET /api/devices with a bogus token -> 401');
  else fail('bogus-token /api/devices', `got ${bogus.status}, expected 401`);

  const authed = await request('GET', '/api/devices', { token: TOKEN });
  if (authed.status === 200) {
    ok('GET /api/devices with the admin token -> 200', `${Array.isArray(authed.json) ? authed.json.length : '?'} device(s)`);
  } else {
    fail('authenticated /api/devices', `got ${authed.status} — the token does not authenticate`);
  }

  // 4. Firmware surface: routed, and a junk body is refused cleanly rather than crashing.
  const verdict = await request('POST', '/v1/verdict', { body: '{}', contentType: 'application/octet-stream' });
  if (verdict.status === 400 || verdict.status === 200) ok(`POST /v1/verdict -> ${verdict.status}`, 'routed');
  else fail('POST /v1/verdict', `got ${verdict.status}, expected 400 or 200`);

  const policy = await request('GET', '/v1/policy/1');
  if ([200, 404].includes(policy.status)) ok(`GET /v1/policy/1 -> ${policy.status}`, 'routed');
  else fail('GET /v1/policy/1', `got ${policy.status}`);

  // 5. Binary downloads. 404 is correct before the first binary is staged; 200 after.
  const download = await request('GET', '/api/download/agent');
  if (download.status === 200) ok('GET /api/download/agent -> 200', 'agent binary is staged');
  else if (download.status === 404) skip('GET /api/download/agent', 'no binary staged yet — the fleet cannot self-update until one is');
  else fail('GET /api/download/agent', `got ${download.status}`);

  // 6. Backups: list is safe; create is opt-in because it writes an object.
  const backups = await request('GET', '/api/admin/backups', { token: TOKEN });
  if (backups.status === 200) {
    ok('GET /api/admin/backups -> 200', `${Array.isArray(backups.json?.backups) ? backups.json.backups.length : '?'} object(s)`);
  } else {
    fail('GET /api/admin/backups', `got ${backups.status}`);
  }

  if (ALLOW_WRITES) {
    const created = await request('POST', '/api/admin/backups', { token: TOKEN, body: '{}' });
    if (created.status === 201) {
      ok('POST /api/admin/backups -> 201', created.json?.backup?.key || '');
    } else if (created.status === 503) {
      // A refusal is the correct answer when the deployment has no bucket or key — and it is
      // worth seeing the reason rather than assuming the backup path is silently fine.
      skip('POST /api/admin/backups', `refused: ${created.json?.error || created.text.slice(0, 120)}`);
    } else {
      fail('POST /api/admin/backups', `got ${created.status}`);
    }
  } else {
    skip('POST /api/admin/backups', 'read-only run; pass --allow-writes');
  }

  // 7. A restore of a key that does not exist must 404, not restore nothing quietly.
  const missing = await request('POST', '/api/admin/restore', {
    token: TOKEN,
    body: JSON.stringify({ key: 'backups/does-not-exist.rmlb' }),
  });
  if (missing.status === 404) ok('POST /api/admin/restore (missing key) -> 404');
  else fail('restore with a missing key', `got ${missing.status}, expected 404`);

  // 8. Replay protection, proven end to end — opt-in because it creates a device.
  if (ALLOW_WRITES) {
    const enrolled = await request('POST', '/api/enroll', {
      token: TOKEN,
      body: JSON.stringify({ hostname: `smoke-${Date.now()}`, owner_name: 'Smoke Test' }),
    });
    if (enrolled.status !== 200 && enrolled.status !== 201) {
      fail('POST /api/enroll', `got ${enrolled.status} — cannot test replay`);
    } else {
      const apiKey = enrolled.json?.api_key;
      const deviceId = enrolled.json?.device?.id;
      const body = JSON.stringify({ hostname: 'smoke' });
      const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const bodyHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(apiKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}:${nonce}:${bodyHash}`)))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      const headers = {
        'Content-Type': 'application/json',
        'X-Agent-Key': apiKey,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Signature': sig,
        'X-Sig-Version': '1',
      };
      const first = await fetch(`${BASE}/api/agent/checkin`, { method: 'POST', headers, body });
      const second = await fetch(`${BASE}/api/agent/checkin`, { method: 'POST', headers, body });
      if (first.status === 200 && second.status === 401) {
        ok('signed check-in accepted once, identical replay rejected', `device ${deviceId}`);
      } else {
        fail('replay protection', `first=${first.status} second=${second.status} (expected 200 then 401)`);
      }
      console.log(`[note] smoke device ${deviceId} was enrolled and left in place; remove it in the dashboard`);
    }
  } else {
    skip('replay protection end to end', 'read-only run; pass --allow-writes');
  }

  console.log(`\n[smoke] ${passes} passed, ${failures} failed, ${skips} skipped`);
  if (failures > 0) {
    console.error('[smoke] FAILED');
    process.exit(1);
  }
  console.log('[smoke] PASSED');
}

main().catch((error) => {
  console.error(`[smoke] aborted: ${error?.stack || error}`);
  process.exit(1);
});
