// LAVISH-HARDENED: what remains of the hosted-sharing module. The stock version
// POSTed a self-contained artifact to a third-party host and PUT updates back to it
// with a once-issued secret; that host, its two request builders and the whole HTTP
// transport are DELETED from this source. `publishToHtmlApp` and `updateHtmlApp` are
// kept as exports that throw, because the CLI and the server still import them and a
// missing export would be a crash rather than a refusal. The payload shapers and
// error classifiers below are pure functions with no I/O, kept so the refusal paths
// and their tests still describe the contract that was removed.

// LAVISH-HARDENED: third-party publishing host removed; no default endpoint remains.
const DEFAULT_API_URL = "";
const SITE_ID_RE = /^[A-Za-z0-9._-]+$/;

export function htmlAppApiUrl(env = process.env) {
  return String(env.LAVISH_AXI_HTML_APP_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

export function createHtmlAppPayload(html, options = {}) {
  const body = { html_content: String(html ?? "") };
  const password = optionalString(options.password);
  if (password) body.password = password;
  return body;
}

/**
 * Update payload. An absent password preserves the site's current one; a present one sets or
 * rotates it. There is no way to remove a page's password, so this never sends an empty one.
 *
 * Probed against the live ht-ml.app host, republishing one real private page three ways:
 * - No `password` key: the page still refused an uncredentialed request and still opened with the
 *   ORIGINAL password, while serving the new HTML. Preservation is observed, not assumed.
 * - `password: "<new>"`: the old password stopped working and the new one opened the page.
 * - `password: ""`: answered 200 and changed nothing - the original password still opened the
 *   page. The host silently ignores a clear despite documenting one, which is why Lavish has no
 *   clear-password path: reporting a page as public while it is still gated is the worse failure.
 *
 * The none -> set transition was probed separately, on a page published with NO password, because
 * both `--unpublish`'s lock and a `--private`/`--password` republish depend on it:
 * - `password: "<new>"` on a page that had none takes effect at the ORIGIN - the site's details
 *   GET answered 404 uncredentialed and 200 with the update_key, matching a known-private site.
 * - But it is not instant at the EDGE: that page's viewer subdomain kept answering uncredentialed
 *   requests from CloudFront for at least ~3 minutes afterwards (cache age climbing, no
 *   cache-control on the response). WHICH body it served matters and was observed: the PUT
 *   invalidated the cached copy, so the edge served the NEW post-PUT HTML without asking for the
 *   password. It did not keep serving the pre-PUT content. So the content swap is immediate and
 *   only the GATE lags, which is why the surfaces say a newly locked page may still be readable
 *   rather than that the old page stays visible.
 *
 * That last one is a property of the public -> private TRANSITION, not of the command that
 * performs it: `--unpublish` and a `--private`/`--password` republish both hit it, so EVERY
 * surface reporting a page as newly gated carries the caveat. It is also no wider than that - a
 * page that was already private has no publicly cached copy, so rotating its password leaks
 * nothing, and Lavish cannot tell the two apart because it persists no site state.
 *
 * The PUT response shape was observed in the same probes: a successful update answers 200 with
 * `url`, `site_id`, `status`, and `update_key`, so the republish and unpublish surfaces get a real
 * URL from the host on the default base. `options.url` stays as the defensive fallback for a
 * response that omits one; nothing synthesizes a URL, because the API base is configurable.
 * @param {string} html
 * @param {{ password?: string | null }} [options]
 */
export function createHtmlAppUpdatePayload(html, options = {}) {
  const body = { html_content: String(html ?? "") };
  const password = optionalString(options.password);
  if (password) body.password = password;
  return body;
}

/**
 * Validate the site identifier the host returned at create time. A URL is the thing users have
 * in hand and the thing that is not a site_id, so it gets its own message instead of a generic
 * rejection; everything else is refused because it would be interpolated into the request path.
 * @param {string} value
 * @returns {string}
 */
export function normalizeSiteId(value) {
  const siteId = optionalString(value);
  if (!siteId) throw new Error("a site_id is required");
  if (/^[a-z]+:\/\//i.test(siteId)) {
    throw new Error(`expected a site_id (such as abc123) rather than a URL: ${siteId}`);
  }
  if (!SITE_ID_RE.test(siteId) || /^\.+$/.test(siteId)) {
    throw new Error(`not a valid site_id: ${siteId}`);
  }
  return siteId;
}

/**
 * The page an unpublished share is replaced with. ht-ml.app has no delete endpoint, so the page
 * keeps existing at its URL; this is what a visitor finds there afterwards.
 */
export function createUnpublishedPageHtml() {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    "<title>Unpublished</title>" +
    "<style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;" +
    "font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}" +
    "p{max-width:30rem;padding:2rem;text-align:center}</style>" +
    "</head><body><p>This page has been unpublished. Its contents are no longer available.</p></body></html>"
  );
}

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

// A caller that changes a live page needs to tell "the host refused, nothing was written" from
// "the outcome is unknown". Only a response the host actually returned proves the former, so the
// status rides on the error: absent means no answer reached us (transport failure or timeout).
/**
 * Every caller that changes hosted state splits its reporting here. A 4xx is an answer the host
 * returned, so nothing was written; anything else can follow a request the origin already
 * committed and must be reported as an outcome that may already be live.
 * @param {unknown} error
 */
export function hostRejectedShareWrite(error) {
  const status = error instanceof Error ? Number(/** @type {any} */ (error).status) : Number.NaN;
  return Number.isInteger(status) && status >= 400 && status < 500;
}

/**
 * A 200 whose body is missing required fields is NOT an unknown outcome: the page landed. The
 * caller needs to say so and to surface whatever fields did arrive, because a url with no
 * update_key is a live (public by default) page whose only write credential is gone for good.
 * @param {string} message
 * @param {{ url?: string, siteId?: string, updateKey?: string, status?: string }} received
 */
export function htmlAppIncompleteResponseError(message, received = {}) {
  const error = new Error(message);
  const present = Object.fromEntries(Object.entries(received).filter(([, value]) => value));
  Object.defineProperty(error, "published", { value: true, enumerable: true });
  Object.defineProperty(error, "received", { value: present, enumerable: true });
  return error;
}

/**
 * @param {unknown} error
 * @returns {{ url?: string, siteId?: string, updateKey?: string, status?: string } | null}
 */
export function publishedDespiteError(error) {
  if (!(error instanceof Error) || /** @type {any} */ (error).published !== true) return null;
  return /** @type {any} */ (error).received || {};
}

function optionalString(value) {
  return String(value ?? "").trim();
}
