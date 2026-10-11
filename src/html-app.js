// LAVISH-HARDENED: what remains of the hosted-sharing module. The stock version
// POSTed a self-contained artifact to a third-party host and PUT updates back to it
// with a once-issued secret; that host, its request builders, the HTTP transport and
// the payload and error helpers around them are DELETED from this source. Nothing in
// this build calls `publishToHtmlApp` or `updateHtmlApp`; they stay as exports that
// throw, so an upstream merge that wires a caller back up gets a refusal rather than
// a missing export.

/**
 * Always throws in this build. Every argument the stock signature took - the HTML, a
 * password, a bearer token, an API base override - is accepted and ignored, so callers
 * written against the old shape still type-check and still get a refusal.
 * @param {...unknown} _ignored
 * @returns {Promise<{ url: string, site_id: string, update_key: string, status: string }>}
 */
export async function publishToHtmlApp(..._ignored) {
  // LAVISH-HARDENED: publishing to a third-party host is removed from this build.
  throw new Error("publishing is disabled in this hardened build of lavish-axi");
}

/**
 * Always throws in this build, for the same reason as publishToHtmlApp: the transport
 * that would have carried a republish is gone from this source.
 * @param {...unknown} _ignored
 * @returns {Promise<{ url: string, site_id: string, status: string }>}
 */
export async function updateHtmlApp(..._ignored) {
  // LAVISH-HARDENED: republishing to a third-party host is removed from this build.
  throw new Error("publishing is disabled in this hardened build of lavish-axi");
}
