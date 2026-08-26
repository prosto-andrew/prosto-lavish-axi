// LAVISH-HARDENED: this module is inert. The stock build POSTed usage events to a
// third-party analytics host; the HTTP client that did it, its endpoint builder and
// the build-time host/site-id defines that fed it are DELETED from this source, not
// switched off. There is no code left here that can open a socket, so re-enabling
// telemetry would take a code change and a rebuild, which the launcher's hardening
// markers and verify-hardening.mjs both check for.

export function resolveTelemetryConfig(..._ignored) {
  // Deliberately ignores every argument. No environment variable, build-time define
  // or config value can turn this on.
  return { enabled: false, host: "", websiteID: "" };
}

export function createTelemetryClient(..._ignored) {
  return new NoopTelemetryClient();
}

let defaultClient = null;

export function initDefaultTelemetry(..._ignored) {
  defaultClient = createTelemetryClient();
  return defaultClient;
}

export function getDefaultTelemetry() {
  return defaultClient || new NoopTelemetryClient();
}

export function resetDefaultTelemetryForTests() {
  defaultClient = null;
}

class NoopTelemetryClient {
  // Rest params so the stock call shapes still type-check at every call site; the
  // arguments are accepted and dropped on the floor.
  track(..._ignored) {}

  pageview(..._ignored) {}

  async close(..._ignored) {}
}
