/**
 * Shared connector errors.
 *
 * Every connector maps its upstream's failures onto these two, so the route
 * layer can translate them to 503/502 without knowing which upstream is behind
 * it. This is what makes the route upstream-agnostic (see
 * docs/adr/INTEGRATION-OWNERSHIP.md).
 */

/** The connector is switched off or lacks credentials — nothing to call. */
class ConnectorNotConfigured extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConnectorNotConfigured';
    this.code = 'NOT_CONFIGURED';
  }
}

/** The upstream is configured but unusable right now. */
class ConnectorUpstreamError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ConnectorUpstreamError';
    this.code = 'UPSTREAM_ERROR';
    this.cause = cause;
  }
}

module.exports = { ConnectorNotConfigured, ConnectorUpstreamError };
