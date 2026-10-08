import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { run, stopCommand, VERSION } from "../src/cli.js";
import { stateId } from "../src/paths.js";
import { serve } from "../src/server.js";

// 192.0.2.0/24 is TEST-NET-1: assigned to no interface, so binding it fails with EADDRNOTAVAIL.
const UNBINDABLE_HOST = "192.0.2.1";

// A second concrete address on this machine, standing in for the Tailscale or LAN address one
// agent pins with LAVISH_AXI_HOST while another agent on the same machine sets nothing.
function otherLocalIpv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal && entry.address !== "127.0.0.1") return entry.address;
    }
  }
  return null;
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-discovery-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Windows refuses a symlink without Developer Mode or an elevated shell. Any account can create a
// junction, and realpath resolves one exactly like a symlink, so directory links use it there.
function linkDirectory(target, link) {
  return symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

async function writeArtifact(dir, name = "artifact.html") {
  const artifact = path.join(dir, name);
  await writeFile(artifact, "<!doctype html><html><body>review</body></html>");
  // Session identity is the canonical path, and tmpdir() is behind a symlink on macOS.
  return realpath(artifact);
}

async function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  const previousExitCode = process.exitCode;
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    process.exitCode = previousExitCode;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function cliEnv(dir, port, host) {
  return {
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_HOST: host,
    LAVISH_AXI_STATE_DIR: dir,
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_IDLE_TIMEOUT_MS: "60000",
  };
}

// The CLI prints its TOON result to stdout; these tests assert on server and state effects instead.
async function runCli(args) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await run(args);
  } finally {
    process.stdout.write = write;
  }
}

async function captureCli(args) {
  const write = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    await run(args);
  } finally {
    process.stdout.write = write;
  }
  return output;
}

async function freePort(host = "127.0.0.1") {
  const probe = createServer();
  await new Promise((resolve) => probe.listen({ port: 0, host }, () => resolve(undefined)));
  const { port } = /** @type {{ port: number }} */ (probe.address());
  await new Promise((resolve) => probe.close(() => resolve(undefined)));
  return port;
}

async function listenRaw(host, port) {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => resolve(undefined));
  });
  return server;
}

function closeRaw(server) {
  return new Promise((resolve) => server.close(() => resolve(undefined)));
}

async function health(host, port, query = "") {
  const response = await fetch(`http://${host}:${port}/health${query}`, { signal: AbortSignal.timeout(3000) });
  return response.json();
}

async function reachable(host, port) {
  try {
    await health(host, port);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function isResolved(promise) {
  return Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 50))]);
}

async function stateSessions(dir) {
  const raw = await readFile(path.join(dir, "state.json"), "utf8").catch(() => "{}");
  const state = JSON.parse(raw);
  return Object.values(state.sessions || {}).map((session) => session.file);
}

test("a second server for a port whose loopback a Lavish server owns refuses to start", async (t) => {
  const otherHost = otherLocalIpv4();
  if (!otherHost) {
    t.skip("host has no non-loopback IPv4 address");
    return;
  }
  await withTempDir(async (dir) => {
    const owner = await serve({
      port: 0,
      stateFile: path.join(dir, "state.json"),
      version: "9.9.9-test",
      env: {},
      detectTailscale: null,
      hosts: ["127.0.0.1"],
      log: () => {},
      idleTimeoutMs: null,
    });
    try {
      await assert.rejects(
        serve({
          port: owner.port,
          stateFile: path.join(dir, "state.json"),
          version: "9.9.9-test",
          env: { LAVISH_AXI_HOST: otherHost },
          log: () => {},
          idleTimeoutMs: null,
        }),
        /Another Lavish server .* already owns port/,
      );
      // The loser must not have taken the other address on its way out: a split daemon pair on one
      // port is exactly what the loopback owner check exists to prevent.
      const probe = await listenRaw(otherHost, owner.port);
      await closeRaw(probe);
    } finally {
      await owner.close();
    }
  });
});

test("a foreign loopback listener prevents a pinned server from claiming the same port", async (t) => {
  const otherHost = otherLocalIpv4();
  if (!otherHost) {
    t.skip("host has no non-loopback IPv4 address");
    return;
  }
  await withTempDir(async (dir) => {
    const loopback = await listenRaw("127.0.0.1", 0);
    const port = /** @type {import('node:net').AddressInfo} */ (loopback.address()).port;
    try {
      const contender = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: "9.9.9-test",
        env: { LAVISH_AXI_HOST: otherHost },
        log: () => {},
        idleTimeoutMs: null,
      }).then(
        (server) => ({ server, error: null }),
        (error) => ({ server: null, error }),
      );
      try {
        assert.match(contender.error?.message || "", /loopback.*already in use|already in use.*loopback/i);
        const available = await listenRaw(otherHost, port);
        await closeRaw(available);
      } finally {
        await contender.server?.close();
      }
    } finally {
      await closeRaw(loopback);
    }
  });
});

test("a symlinked state directory adopts the daemon started at its target", async () => {
  await withTempDir(async (dir) => {
    const alias = path.join(dir, "alias");
    await linkDirectory(dir, alias);
    const artifact = await writeArtifact(dir);
    const port = await freePort();
    const owner = await serve({
      port,
      stateFile: path.join(dir, "state.json"),
      version: VERSION,
      env: { LAVISH_AXI_HOST: "127.0.0.1" },
      detectTailscale: null,
      log: () => {},
      idleTimeoutMs: null,
    });
    try {
      await withEnv(cliEnv(alias, port, "127.0.0.1"), async () => {
        await runCli(["open", artifact, "--no-open"]);
      });
      assert.equal(await isResolved(owner.done), false, "the original daemon was replaced");
      const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
      assert.equal(health.state_id, stateId(path.join(alias, "state.json")));
      assert.equal(health.version, VERSION);
    } finally {
      await owner.close();
    }
  });
});

async function setAsideStateFiles(dir) {
  return (await readdir(dir)).filter((name) => name.startsWith("state.json.corrupt-"));
}

test("an unreadable state.json is set aside and the next open tells the agent where it went", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "state.json"), "{ not json");
    const artifact = await writeArtifact(dir);
    const port = await freePort();
    const logged = [];
    const owner = await serve({
      port,
      stateFile: path.join(dir, "state.json"),
      version: VERSION,
      env: { LAVISH_AXI_HOST: "127.0.0.1" },
      detectTailscale: null,
      log: (line) => logged.push(line),
      idleTimeoutMs: null,
    });
    try {
      const first = await withEnv(cliEnv(dir, port, "127.0.0.1"), () => captureCli(["open", artifact, "--no-open"]));
      const [aside] = await setAsideStateFiles(dir);
      assert.ok(aside, `nothing was set aside: ${first}`);
      assert.match(first, /state_warning/);
      // TOON escapes backslashes in quoted Windows paths.
      assert.ok(first.includes(path.join(dir, aside).replaceAll("\\", "\\\\")), first);
      assert.ok(
        logged.some((line) => line.includes("WARNING") && line.includes(aside)),
        `the server log does not say where it went:\n${logged.join("\n")}`,
      );

      const second = await withEnv(cliEnv(dir, port, "127.0.0.1"), () => captureCli(["open", artifact, "--no-open"]));
      assert.doesNotMatch(second, /state_warning/, "the warning is given once");
      assert.deepEqual(await stateSessions(dir), [artifact]);
    } finally {
      await owner.close();
    }
  });
});

test("listing sessions sets an unreadable state.json aside and says so on stderr", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "state.json"), "{ not json");
    const port = await freePort();
    let stderr = "";
    const write = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderr += String(chunk);
      return true;
    };
    let output;
    try {
      output = await withEnv(cliEnv(dir, port, "127.0.0.1"), () => captureCli([]));
    } finally {
      process.stderr.write = write;
    }

    const [aside] = await setAsideStateFiles(dir);
    assert.ok(aside, `nothing was set aside: ${output}`);
    assert.ok(stderr.includes(aside), `stderr does not say where it went: ${stderr}`);
  });
});

test("another installation's server on loopback is never used or stopped", { timeout: 20_000 }, async () => {
  await withTempDir(async (dir) => {
    const artifact = await writeArtifact(dir);
    const otherInstallDir = await mkdtemp(path.join(tmpdir(), "lavish-discovery-other-"));
    const port = await freePort();
    const otherInstall = await serve({
      port,
      stateFile: path.join(otherInstallDir, "state.json"),
      version: VERSION,
      env: {},
      detectTailscale: null,
      hosts: ["127.0.0.1"],
      log: () => {},
      idleTimeoutMs: null,
    });
    try {
      const output = await withEnv(cliEnv(dir, port, undefined), () => captureCli(["open", artifact, "--no-open"]));
      assert.match(output, /SERVER_ERROR/);
      // TOON escapes backslashes in quoted Windows paths.
      assert.ok(
        output.includes(otherInstallDir.replaceAll("\\", "\\\\")),
        `expected the other state directory in ${output}`,
      );
      await withEnv(cliEnv(dir, port, undefined), () => assert.rejects(stopCommand([]), { code: "SERVER_ERROR" }));
      assert.equal(await isResolved(otherInstall.done), false, "another installation's server was stopped");
      assert.deepEqual(await stateSessions(otherInstallDir), []);
    } finally {
      await otherInstall.close();
      await rm(otherInstallDir, { recursive: true, force: true });
    }
  });
});

test("stopping a pre-handshake server signals only the process at its own address", { timeout: 30_000 }, async (t) => {
  const otherHost = otherLocalIpv4();
  if (!otherHost || !lsofAvailable()) {
    t.skip("host needs a non-loopback IPv4 address and lsof");
    return;
  }
  await withTempDir(async (dir) => {
    const port = await freePort(otherHost);
    // Answers /health with no app or version and has no /shutdown, like the oldest releases.
    const preHandshake = await spawnListener(
      dir,
      "lavish-axi-pre-handshake.mjs",
      "127.0.0.1",
      port,
      `import { createServer } from "node:http";
const [host, port] = process.argv.slice(2);
createServer((req, res) => {
  if (req.url.startsWith("/health")) res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  else res.writeHead(404).end();
}).listen({ host, port: Number(port) }, () => console.log("listening"));
`,
    );
    const unrelated = await spawnListener(
      dir,
      "unrelated-service.mjs",
      otherHost,
      port,
      `import { createServer } from "node:net";
const [host, port] = process.argv.slice(2);
createServer((socket) => socket.destroy()).listen({ host, port: Number(port) }, () => console.log("listening"));
`,
    );
    try {
      const output = await withEnv(cliEnv(dir, port, undefined), () => stopCommand([]));
      assert.equal(output.server.status, "stopped");
      assert.ok(await waitFor(() => exited(preHandshake)), "the pre-handshake server was not stopped");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(exited(unrelated), false, "a process at another address on the same port was signalled");
    } finally {
      preHandshake.kill();
      unrelated.kill();
    }
  });
});

function lsofAvailable() {
  return spawnSync("lsof", ["-v"]).error === undefined;
}

// A child process listening at host:port. The script's file name is what `ps` shows, so a
// pre-handshake Lavish server is one whose name says lavish-axi and an unrelated one is not.

async function spawnListener(dir, name, host, port, source) {
  const script = path.join(dir, name);
  await writeFile(script, source);
  const child = spawn(process.execPath, [script, host, String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  const [line] = await once(child.stdout, "data");
  assert.equal(String(line).trim(), "listening");
  return child;
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

test(
  "discovery never dials a local interface address, so a blackholed one cannot delay the CLI",
  { timeout: 30_000 },
  async () => {
    await withTempDir(async (dir) => {
      // Upstream discovery dialed every local interface address, and a Tailscale IPv6 address that
      // drops connections to itself kept the CLI alive until the OS gave up. This build probes
      // loopback only, so an interface address that routes nowhere is never dialed at all.
      const preload = path.join(dir, "blackhole-interface.mjs");
      await writeFile(
        preload,
        `import os from "node:os";
const networkInterfaces = os.networkInterfaces;
os.networkInterfaces = () => ({ ...networkInterfaces(), blackhole: [{ address: "${UNBINDABLE_HOST}", family: "IPv4", internal: false }] });
`,
      );
      const port = await freePort();
      const started = Date.now();
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "stop", "--port", String(port)],
        {
          env: {
            ...process.env,
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
            LAVISH_AXI_STATE_DIR: dir,
            LAVISH_AXI_TELEMETRY: "0",
            LAVISH_AXI_HOST: "127.0.0.1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      const [code] = await once(child, "exit");
      const elapsedMs = Date.now() - started;
      assert.equal(code, 0);
      assert.match(stdout, /not-running/);
      assert.ok(elapsedMs < 5000, `the CLI took ${elapsedMs}ms to exit`);
    });
  },
);

// LAVISH-HARDENED: upstream 0.1.78 (#374) taught the CLI to find and replace servers on every
// local interface address and to pass `--also-listen <host>` to a replacement so it kept serving
// them. Servers of this build listen on loopback only, so neither path exists here. These two
// tests pin that down; the loopback ownership and installation-identity tests above are upstream's.
test("discovery never adopts a Lavish server reachable only at another local address", async (t) => {
  const otherHost = otherLocalIpv4();
  if (!otherHost) {
    t.skip("host has no non-loopback IPv4 address");
    return;
  }
  await withTempDir(async (dir) => {
    const port = await freePort(otherHost);
    const elsewhere = createHttpServer((req, res) => {
      if (req.url?.startsWith("/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            app: "lavish-axi",
            version: VERSION,
            state_id: stateId(path.join(dir, "state.json")),
          }),
        );
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise((resolve) => elsewhere.listen({ host: otherHost, port }, () => resolve(undefined)));
    let requests = 0;
    elsewhere.on("request", () => (requests += 1));
    try {
      const output = await withEnv(cliEnv(dir, port, otherHost), () => stopCommand([]));
      assert.equal(output.server.status, "not-running");
      assert.equal(requests, 0, "the CLI dialed a non-loopback address");
    } finally {
      await new Promise((resolve) => elsewhere.close(() => resolve(undefined)));
    }
  });
});

test("`server --also-listen` is refused and binds nothing", async () => {
  await withTempDir(async (dir) => {
    const port = await freePort();
    for (const args of [
      ["server", "--port", String(port), "--also-listen", UNBINDABLE_HOST],
      ["server", "--port", String(port), `--also-listen=${UNBINDABLE_HOST}`],
    ]) {
      const output = await withEnv(cliEnv(dir, port, undefined), () => captureCli(args));
      assert.match(output, /--also-listen.*removed/);
      assert.equal(await reachable("127.0.0.1", port), false, "a server started despite the refusal");
    }
  });
});
