/**
 * Connector registry — the upstreams this server can read inventory from.
 *
 * The route layer talks to this registry, never to a specific connector, which
 * is what lets us change upstream without changing our API. Order here is the
 * order the dashboard sees.
 *
 * Adding a connector means: create the module, export { id, status(),
 * getDevices() }, and register it below. It must be READ-ONLY — see
 * docs/adr/INTEGRATION-OWNERSHIP.md.
 */

const graph = require('./graph');
const meshcentral = require('./meshcentral');
const { ConnectorNotConfigured, ConnectorUpstreamError } = require('./errors');

const connectors = [graph, meshcentral];

// Fail fast on a badly shaped connector rather than at request time.
for (const connector of connectors) {
  for (const required of ['id', 'status', 'getDevices']) {
    if (!connector || typeof connector[required] === 'undefined') {
      throw new Error(`Integration connector is missing "${required}"`);
    }
  }
}

const byId = new Map(connectors.map((c) => [c.id, c]));

/** All registered connectors (for the status listing). */
function list() {
  return connectors;
}

/** Look up one connector, or undefined. */
function get(id) {
  return byId.get(id);
}

module.exports = {
  list,
  get,
  ConnectorNotConfigured,
  ConnectorUpstreamError,
};
