import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// LAVISH-HARDENED: a foreign page can make the browser send any GET to the loopback port with no
// Origin or Referer (an <img>, a hidden <iframe>, a no-cors fetch), so a GET route must not change
// state unless it demands proof a browser cannot forge. Every GET route is listed here with why it
// is safe; a route added by an upstream merge fails this test until someone has decided that.
const REVIEWED_GET_ROUTES = new Map([
  ['"/"', "read-only: static landing page"],
  ['"/health"', "idempotent: reconcile_network=1 only retries failed loopback binds"],
  ['"/api/poll"', "CLI-only: refused without the x-lavish-client header before any claim or take"],
  ['"/api/:key/layout-warnings"', "read-only"],
  ['"/api/:key/export"', "read-only on the server; the download is the browser's"],
  ['"/session/:key"', "read-only: renders from describeReviewerLoad; the handoff comes from the POST"],
  ['"/artifact/:key"', "read-only: redirect"],
  ["/^\\/artifact\\/([^/]+)\\/index\\.html$/", "read-only: verifies the current load token"],
  ["/^\\/artifact\\/([^/]+)\\/(.+)$/", "read-only: confined asset file"],
  ['"/events/:key"', "read-only: one legacy SSE reload message"],
  ['"/chrome-client.js"', "read-only: static asset"],
  ['"/chrome.css"', "read-only: static asset"],
  ["/^\\/design\\/mermaid\\/(.+)$/", "read-only: vendored asset"],
  ['"/design/:asset"', "read-only: static asset"],
  ['"/sdk.js"', "read-only: verifies the current load token"],
  ['"/whiteboard-frame"', "read-only: the channel token is a stateless HMAC"],
  ["/^\\/whiteboard-assets\\/(.+)$/", "read-only: vendored asset"],
  ['"/api/:key/mermaid-sources"', "read-only"],
  ['"/api/:key/whiteboard/:index"', "read-only"],
  ['"/api/:key/attachments/:id"', "read-only"],
]);

// The first argument of each `app.get(` as written: a string literal or a regex literal, whose
// character classes may hold an unescaped `/`.
const GET_ROUTE = /app\.get\(\s*("(?:[^"\\]|\\.)*"|\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\[])+\/[a-z]*)/g;

test("every GET route is classified as read-only, idempotent, or CLI-only", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const routes = [...source.matchAll(GET_ROUTE)].map((match) => match[1]);
  // A route written any other way (single quotes, a template literal, a constant, an array) would
  // otherwise slip past the list unseen.
  assert.equal(
    (source.match(/\bapp\.get\(/g) || []).length,
    routes.length,
    "an app.get( call is not written as a double-quoted string or a regex literal; list its route here by hand",
  );

  for (const route of routes) {
    assert.ok(
      REVIEWED_GET_ROUTES.has(route),
      `GET ${route} is not classified: decide whether it changes state, then list it in test/get-routes.test.js`,
    );
  }
  for (const route of REVIEWED_GET_ROUTES.keys()) {
    assert.ok(routes.includes(route), `GET ${route} is listed but no longer registered; remove it from the list`);
  }
  // These would answer GET too, outside the list above: catch-all methods, a mounted router, and a
  // middleware scoped to a path.
  assert.doesNotMatch(source, /app\.(all|route)\(/);
  assert.doesNotMatch(source, /\bRouter\(/);
  assert.doesNotMatch(source, /\bapp\.use\(\s*["'`/[]/);
});
