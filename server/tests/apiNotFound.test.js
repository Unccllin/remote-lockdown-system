/**
 * The /api/* 404 must name the routes that actually exist — derived, not typed.
 *
 * The message used to be a hardcoded sentence ("Available routes are under
 * /api/devices, /api/agent, ..."), and it went stale the moment
 * /api/hw-test-artifact, /api/installer and /api/integrations were mounted. A
 * developer following that error was told their endpoint did not exist when the
 * list simply predated it (S203).
 *
 * index.js starts a server on import and exports nothing, so this is a
 * source-level invariant (the same shape as the Worker's route-contract test):
 * the 404 must derive the list, and every /api group must be mounted through the
 * helper that records it. A hardcoded list or a bypassing mount fails here.
 */

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

describe('API 404 route list', () => {
  test('the 404 derives its list from the mounts', () => {
    const handler = source.slice(source.indexOf("app.all('/api/*'"));
    expect(handler).toContain('mountedApiPrefixes.join');
    // The old shape: a literal sentence naming routes. That is what went stale.
    expect(handler).not.toMatch(/Available routes are under \/api\/devices/);
  });

  test('every /api group is mounted through mountApi (so it is always listed)', () => {
    const direct = [...source.matchAll(/app\.use\('(\/api\/[^']+)'/g)].map((m) => m[1]);
    expect(direct).toEqual([]); // no API group may bypass the recorder
  });

  test('the groups the hardcoded sentence had missed are recorded', () => {
    const recorded = [...source.matchAll(/mountApi\('(\/api\/[^']+)'/g)].map((m) => m[1]);
    expect(recorded).toEqual(
      expect.arrayContaining([
        '/api/auth',
        '/api/setup',
        '/api/devices',
        '/api/agent',
        '/api/audit',
        '/api/installer',
        '/api/health',
        '/api/admins',
        '/api/hw-test-artifact',
        '/api/integrations',
      ])
    );
  });
});
