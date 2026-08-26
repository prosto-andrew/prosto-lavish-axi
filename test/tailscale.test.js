import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { detectTailscale, parseTailscaleStatus } from "../src/tailscale.js";

test("parseTailscaleStatus returns the running node IPv4 and MagicDNS name", () => {
  const result = parseTailscaleStatus(
    JSON.stringify({
      BackendState: "Running",
      Self: {
        TailscaleIPs: ["fd7a:115c:a1e0::1", "100.64.12.34"],
        DNSName: "review-phone.tailnet.ts.net.",
      },
    }),
  );
  assert.deepEqual(result, { ipv4: "100.64.12.34", magicDnsName: "review-phone.tailnet.ts.net" });
});

// LAVISH-HARDENED: the four detection tests that stood here drove a fake execFile
// through the candidate list, the macOS bundle fallback and the shared timeout budget.
// None of that code exists any more, so what is asserted is that detection is inert
// and that the module starts no subprocess.
test("detection is inert and the module can start no subprocess", async () => {
  assert.equal(await detectTailscale(), null);
  assert.equal(await detectTailscale({ execFile: () => assert.fail("a subprocess was spawned") }), null);

  const source = await readFile(new URL("../src/tailscale.js", import.meta.url), "utf8");
  for (const symbol of ["child_process", "execFile", "spawn", "tailscaleCommandCandidates"]) {
    assert.ok(!source.includes(symbol), `src/tailscale.js still references ${symbol}`);
  }
});

test("parseTailscaleStatus ignores malformed or non-running status", () => {
  assert.equal(parseTailscaleStatus("not json"), null);
  assert.equal(
    parseTailscaleStatus(
      JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.64.12.34"], DNSName: "bad host" } }),
    ),
    null,
  );
  assert.equal(
    parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["999.1.1.1"] } })),
    null,
  );
});
