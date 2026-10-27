#!/usr/bin/env node
/**
 * verify-meshcentral-connector.mjs — exercise the real connector against a real
 * MeshCentral, so its error path stops being mock-only.
 *
 * Called by scripts/verify-meshcentral-connector.sh, which owns the container
 * lifecycle. Each case re-reads process.env, because the connector reads its
 * configuration per call (so one process can test several configurations).
 *
 * Cases:
 *   1. not configured            -> ConnectorNotConfigured
 *   2. unreachable upstream      -> ConnectorUpstreamError
 *   3. wrong credentials         -> ConnectorUpstreamError (a real HTTP failure)
 *   4. correct credentials       -> inventory in OUR normalized shape
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// fileURLToPath (not .pathname) so a checkout path containing spaces or escapes
// resolves correctly. createRequire lets this ESM file load the CommonJS
// connector without a duplicate ESM wrapper.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);
const connector = require(path.join(ROOT, 'server/src/integrations/meshcentral.js'));

const BASE = process.env.MC_BASE;          // e.g. https://127.0.0.1:8443
const USER = process.env.MC_USER || 'admin';
const PASS = process.env.MC_PASS;

let failures = 0;
const pass = (label, detail = '') => console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => { failures++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); };

function resetEnv(overrides = {}) {
  delete process.env.MESHCENTRAL_URL;
  delete process.env.MESHCENTRAL_TOKEN;
  delete process.env.MESHCENTRAL_USER;
  delete process.env.MESHCENTRAL_PASS;
  delete process.env.INTEGRATIONS_MESHCENTRAL;
  Object.assign(process.env, overrides);
}

async function expectError(label, expectedClass) {
  try {
    const result = await connector.getDevices();
    fail(label, `expected ${expectedClass.name}, got a result: ${JSON.stringify(result).slice(0, 120)}`);
  } catch (err) {
    if (err instanceof expectedClass) pass(label, `${err.name}: ${err.message.slice(0, 90)}`);
    else fail(label, `expected ${expectedClass.name}, got ${err.name}: ${err.message}`);
  }
}

async function main() {
  if (!BASE) {
    console.error('MC_BASE is required (e.g. https://127.0.0.1:8443)');
    process.exit(2);
  }
  console.log(`MeshCentral under test: ${BASE}\n`);

  // 1. Nothing configured — the connector must refuse, not guess.
  resetEnv();
  await expectError('unconfigured connector refuses to run', connector.ConnectorNotConfigured);

  // 2. Configured but unreachable — a real socket failure, not a mock.
  resetEnv({ MESHCENTRAL_URL: 'http://127.0.0.1:1', MESHCENTRAL_TOKEN: 'irrelevant' });
  await expectError('unreachable upstream surfaces as UPSTREAM_ERROR', connector.ConnectorUpstreamError);

  // 3. Reachable MeshCentral, wrong password. MeshCentral 1.3.x exposes no REST
  //    endpoint that could reject credentials, so this exercises the
  //    "upstream answered with something unusable" path — the same code path a
  //    401 takes. It proves we fail soft, not that auth rejection is exercised.
  resetEnv({
    MESHCENTRAL_URL: BASE,
    MESHCENTRAL_USER: USER,
    MESHCENTRAL_PASS: 'definitely-the-wrong-password',
  });
  await expectError('wrong credentials surface as UPSTREAM_ERROR', connector.ConnectorUpstreamError);

  // 4. Real credentials — real login, real /api/nodes, our normalized shape.
  if (!PASS) {
    console.log('SKIP  real inventory — MC_PASS not set');
  } else if (process.env.MC_EXPECT_REST === '0') {
    // Verified finding (S142): MeshCentral 1.3.1 is WebSocket-only. There is no
    // REST inventory to read, so asserting success here would be theatre. The
    // failure paths above are the ones this harness can honestly prove.
    console.log('SKIP  real inventory — this MeshCentral build exposes no REST API (WebSocket-only)');
  } else {
    resetEnv({ MESHCENTRAL_URL: BASE, MESHCENTRAL_USER: USER, MESHCENTRAL_PASS: PASS });
    try {
      const { devices, fetchedAt } = await connector.getDevices();
      if (!Array.isArray(devices)) {
        fail('real login + inventory', 'devices is not an array');
      } else if (!fetchedAt || Number.isNaN(Date.parse(fetchedAt))) {
        fail('real login + inventory', 'fetchedAt is not an ISO timestamp');
      } else {
        pass('real login + inventory', `${devices.length} device(s), fetchedAt=${fetchedAt}`);
        const bad = devices.find((d) => d.source !== 'meshcentral' || typeof d.online !== 'boolean');
        if (bad) fail('inventory normalization', `unexpected shape: ${JSON.stringify(bad)}`);
        else pass('inventory is in our normalized shape');
      }
    } catch (err) {
      fail('real login + inventory', `${err.name}: ${err.message}`);
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
