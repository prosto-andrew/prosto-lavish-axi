import assert from "node:assert/strict";
import test from "node:test";

import { publishToHtmlApp, updateHtmlApp } from "../src/html-app.js";

// LAVISH-HARDENED: the transport this file used to exercise - POST /v1/sites, PUT
// /v1/sites/{id}, the bearer credential, the timeout around the response body - is
// deleted from the source, and so are the payload and error helpers around it. What is
// asserted now is that both remaining entry points refuse without touching the network.

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
