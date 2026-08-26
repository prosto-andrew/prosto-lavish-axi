import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "node:fs/promises";

import {
  createTelemetryClient,
  getDefaultTelemetry,
  initDefaultTelemetry,
  resetDefaultTelemetryForTests,
  resolveTelemetryConfig,
} from "../src/telemetry.js";

// LAVISH-HARDENED: the stock suite drove a real Umami client through a fetch spy and
// asserted the shape of the event payloads it sent. That client is deleted from this
// build, so what is asserted now is that nothing can send anything - including through
// the argument shapes the stock code used to honour.

test("no argument shape can turn telemetry on", () => {
  const attempts = [
    undefined,
    {},
    { env: { LAVISH_AXI_TELEMETRY: "1" } },
    { env: { LAVISH_AXI_UMAMI_HOST: "https://env.example", LAVISH_AXI_UMAMI_WEBSITE_ID: "env-id" } },
    { buildHost: "https://build.example", buildWebsiteID: "build-id" },
    {
      env: { LAVISH_AXI_TELEMETRY: "1", LAVISH_AXI_UMAMI_HOST: "https://env.example" },
      buildHost: "https://build.example",
      buildWebsiteID: "build-id",
    },
  ];
  for (const attempt of attempts) {
    assert.deepEqual(resolveTelemetryConfig(attempt), { enabled: false, host: "", websiteID: "" });
  }
});

test("the client is a no-op and never calls the fetch it is handed", async () => {
  let called = 0;
  const client = createTelemetryClient({
    enabled: true,
    host: "https://a.example.com/umami/",
    websiteID: "site-1",
    app: "axi",
    version: "1.2.3",
    fetch: async () => {
      called += 1;
      return new Response(null, { status: 200 });
    },
  });

  client.track("command", { command: "poll", status: "success" });
  client.pageview("/poll", { command: "poll" });
  await client.close(500);

  assert.equal(called, 0, "the no-op client used the fetch it was given");
});

test("the default client is the same no-op", async () => {
  resetDefaultTelemetryForTests();
  assert.doesNotThrow(() => getDefaultTelemetry().track("command", {}));

  const client = initDefaultTelemetry({ app: "axi", version: "1.2.3" });
  assert.doesNotThrow(() => client.track("command", {}));
  await assert.doesNotReject(() => client.close(10));
  assert.equal(getDefaultTelemetry(), client);

  resetDefaultTelemetryForTests();
});

test("the module carries no transport at all", async () => {
  const source = await readFile(new URL("../src/telemetry.js", import.meta.url), "utf8");
  for (const symbol of ["fetch", "HttpTelemetryClient", "api/send", "kunchenguid", "http://", "https://"]) {
    assert.ok(!source.includes(symbol), `src/telemetry.js still references ${symbol}`);
  }
});
