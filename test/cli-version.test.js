import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isVersionOnlyArgv, VERSION } from "../src/cli.js";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

// A regression to the pre-fast-path behavior costs the full telemetry drain (up to
// 1000ms) plus process startup. Windows process startup is substantially slower on
// hosted runners, so give it more headroom while staying below the drain timeout.
const VERSION_BUDGET_MS = process.platform === "win32" ? 750 : 500;

// Accepts the telemetry connection and never answers, so a regression pays the whole
// drain timeout instead of a fast connection refusal.
async function startBlackHoleTelemetry() {
  const sockets = new Set();
  const requests = [];
  const server = createServer((req) => {
    requests.push(req.url);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    requests,
    host: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("isVersionOnlyArgv matches exactly the SDK's version-flag shapes", () => {
  for (const flag of ["--version", "-v", "-V"]) {
    assert.equal(isVersionOnlyArgv([flag]), true);
  }
  for (const argv of [[], ["--help"], ["open"], ["--version", "extra"], ["open", "--version"]]) {
    assert.equal(isVersionOnlyArgv(argv), false);
  }
});

test("--version prints the version fast and skips state-dir init", async (t) => {
  const telemetry = await startBlackHoleTelemetry();
  const stateParent = await mkdtemp(path.join(tmpdir(), "lavish-version-"));
  const stateDir = path.join(stateParent, "state");
  t.after(async () => {
    await telemetry.close();
    await rm(stateParent, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_TELEMETRY: "1",
    LAVISH_AXI_UMAMI_WEBSITE_ID: "version-fast-path-test",
    LAVISH_AXI_UMAMI_HOST: telemetry.host,
  };

  for (const flag of ["--version", "-v", "-V"]) {
    // Best of three. The budget is a real guard against the fast path regressing into
    // the heavy init, but a single wall-clock sample taken while the rest of the suite
    // runs in parallel measures scheduler noise as much as this process.
    let bestMs = Infinity;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = process.hrtime.bigint();
      const { stdout } = await execFileAsync(process.execPath, [BIN, flag], { env });
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      assert.equal(stdout, `${VERSION}\n`);
      bestMs = Math.min(bestMs, elapsedMs);
      if (bestMs < VERSION_BUDGET_MS) break;
    }
    assert.ok(
      bestMs < VERSION_BUDGET_MS,
      `\`${flag}\` took ${Math.round(bestMs)}ms at best, over the ${VERSION_BUDGET_MS}ms budget`,
    );
  }

  // The heavy init is provably skipped: the state directory was never created.
  assert.equal(existsSync(stateDir), false);
  assert.deepEqual(telemetry.requests, []);
});

// LAVISH-HARDENED: the control test asserted the opposite of what this build does - that a
// non-version command DOES send telemetry, which is how it proved the fast path was the
// only thing skipping it. The transport is deleted, so the control now proves the other
// half instead: the heavy init still runs (the state directory appears), and nothing is
// sent even with every telemetry variable set and a listener waiting for it.
test("a non-version invocation still runs the heavy init, and still sends nothing", async (t) => {
  const telemetry = await startBlackHoleTelemetry();
  const stateParent = await mkdtemp(path.join(tmpdir(), "lavish-version-control-"));
  const stateDir = path.join(stateParent, "state");
  t.after(async () => {
    await telemetry.close();
    await rm(stateParent, { recursive: true, force: true });
  });

  await execFileAsync(process.execPath, [BIN, "design"], {
    env: {
      ...process.env,
      LAVISH_AXI_STATE_DIR: stateDir,
      LAVISH_AXI_TELEMETRY: "1",
      LAVISH_AXI_UMAMI_WEBSITE_ID: "version-fast-path-test",
      LAVISH_AXI_UMAMI_HOST: telemetry.host,
    },
  });

  assert.equal(existsSync(stateDir), true, "the control command must still do the init the fast path skips");
  assert.deepEqual(telemetry.requests, [], "no environment can make this build report anything");
});
