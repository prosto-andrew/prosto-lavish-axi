import assert from "node:assert/strict";
import test from "node:test";

import {
  createHtmlAppPayload,
  createHtmlAppUpdatePayload,
  createUnpublishedPageHtml,
  hostRejectedShareWrite,
  htmlAppApiUrl,
  htmlAppIncompleteResponseError,
  normalizeSiteId,
  publishedDespiteError,
  publishToHtmlApp,
  updateHtmlApp,
} from "../src/html-app.js";

// LAVISH-HARDENED: the transport this file used to exercise - POST /v1/sites, PUT
// /v1/sites/{id}, the bearer credential, the timeout around the response body - is
// deleted from the source. Seventeen tests drove it through an injected fetch and
// asserted the wire shape of each outcome. What is asserted now is that both entry
// points refuse without touching the network, and that the pure helpers the CLI still
// calls to shape payloads and classify errors are unchanged.

test("publishing and republishing refuse, and never call the fetch they are handed", async () => {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    throw new Error("the network must not be reached");
  };

  await assert.rejects(
    () => publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: {}, password: "s", token: "t" }),
    /publishing is disabled in this hardened build/,
  );
  await assert.rejects(
    () => updateHtmlApp("abc123", "<h1>Hi</h1>", { fetch: fetchImpl, env: {}, updateKey: "uk" }),
    /publishing is disabled in this hardened build/,
  );
  // Called with no arguments at all, the way an older caller might.
  await assert.rejects(() => publishToHtmlApp(), /publishing is disabled/);
  await assert.rejects(() => updateHtmlApp(), /publishing is disabled/);

  assert.equal(called, 0, "a refusal must not go near the wire");
});

test("no third-party endpoint is baked into the build", () => {
  // The stock default was the hosting service's API. An empty default means a build
  // that somehow reached the transport would have nowhere to send anything.
  assert.equal(htmlAppApiUrl({}), "");
  assert.equal(htmlAppApiUrl({ LAVISH_AXI_HTML_APP_API_URL: "http://127.0.0.1:9/" }), "http://127.0.0.1:9");
});

test("createHtmlAppPayload sends html_content and only adds a password when provided", () => {
  assert.deepEqual(createHtmlAppPayload("<h1>Hi</h1>"), { html_content: "<h1>Hi</h1>" });
  assert.deepEqual(createHtmlAppPayload("<h1>Hi</h1>", { password: "  secret " }), {
    html_content: "<h1>Hi</h1>",
    password: "secret",
  });
  assert.deepEqual(createHtmlAppPayload("<h1>Hi</h1>", { password: "   " }), { html_content: "<h1>Hi</h1>" });
});

test("createHtmlAppUpdatePayload omits the password to preserve it and sends one to rotate it", () => {
  assert.deepEqual(createHtmlAppUpdatePayload("<h1>Hi</h1>"), { html_content: "<h1>Hi</h1>" });
  assert.deepEqual(createHtmlAppUpdatePayload("<h1>Hi</h1>", { password: "secret" }), {
    html_content: "<h1>Hi</h1>",
    password: "secret",
  });
});

test("createHtmlAppUpdatePayload never sends an empty password the host accepts and ignores", () => {
  // Probed live against the stock service: PUT with password "" answered 200 and left the
  // original password working, so sending one would report a page as public while gated.
  for (const password of ["", "   ", null, undefined]) {
    assert.deepEqual(createHtmlAppUpdatePayload("<h1>Hi</h1>", { password }), { html_content: "<h1>Hi</h1>" });
  }
});

test("normalizeSiteId accepts an id and explains that a URL is not one", () => {
  assert.equal(normalizeSiteId(" abc123 "), "abc123");
  assert.throws(() => normalizeSiteId("https://abc123.example/"), /site_id/);
  assert.throws(() => normalizeSiteId("abc/../123"), /site_id/);
  assert.throws(() => normalizeSiteId(""), /site_id/);
});

test("normalizeSiteId refuses a dot segment that would resolve away from the site path", () => {
  // `..` survives encodeURIComponent, so /v1/sites/.. would collapse to the collection root.
  assert.throws(() => normalizeSiteId("."), /not a valid site_id/);
  assert.throws(() => normalizeSiteId(".."), /not a valid site_id/);
  assert.throws(() => normalizeSiteId(" .. "), /not a valid site_id/);
  assert.throws(() => normalizeSiteId("..."), /not a valid site_id/);
  assert.equal(normalizeSiteId("..abc"), "..abc");
});

test("hostRejectedShareWrite separates an answered rejection from an unknown outcome", () => {
  // A pure classifier over the error's status: 4xx means the host answered and refused,
  // anything else means the outcome is unknown and must never be reported as a failure.
  for (const [status, rejected] of [
    [400, true],
    [404, true],
    [422, true],
    [499, true],
    [500, false],
    [503, false],
    [undefined, false],
  ]) {
    const error = new Error("boom");
    if (status !== undefined) Object.defineProperty(error, "status", { value: status });
    assert.equal(hostRejectedShareWrite(error), rejected, `status ${status}`);
  }
  assert.equal(hostRejectedShareWrite("not an error"), false);
});

test("an incomplete 200 stays distinguishable from a lost response", () => {
  const landed = htmlAppIncompleteResponseError("malformed body", {
    url: "https://x.example/",
    siteId: "",
    updateKey: "uk_secret",
  });
  // Empty fields are dropped so the caller never offers a row it cannot fill.
  assert.deepEqual(publishedDespiteError(landed), { url: "https://x.example/", updateKey: "uk_secret" });

  const lost = new Error("socket hang up");
  assert.equal(publishedDespiteError(lost), null, "a lost response proves nothing landed");
  assert.equal(hostRejectedShareWrite(lost), false, "and it is not a host rejection either");
  assert.equal(publishedDespiteError("not an error"), null);
});

test("the unpublished placeholder is a self-contained page that says the content is gone", () => {
  const html = createUnpublishedPageHtml();

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /unpublished/i);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});
