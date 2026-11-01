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

// LAVISH-HARDENED: upstream 0.1.96 resolves each Tailscale command to an executable file before it
// runs one (#467). This build has no probe for that to guard (specs/2026-10-13-upstream-sync-0.1.87-design.md
// 13.3, 15.4), so the module keeps its single import and no part of #467's lookup comes back with a
// later merge, not even as a function nothing calls.
test("upstream's executable lookup before the Tailscale probe (#467) is not in this build", async () => {
  const source = await readFile(new URL("../src/tailscale.js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import\b[^;]*?\bfrom\s+"([^"]+)";/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:net"]);
  for (const name of ["resolveTailscaleCommand", "resolveCommand", "X_OK"]) {
    assert.ok(!source.includes(name), `src/tailscale.js carries #467's ${name}`);
  }
});
