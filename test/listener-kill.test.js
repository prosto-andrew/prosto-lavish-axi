import assert from "node:assert/strict";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import { shutdownServerOnPort } from "../src/cli.js";

// An older Lavish server that answers /health but never exits on /shutdown - the case `stop` and an
// upgrade fall back to killing by PID for. Its /health body and its address come from the
// environment, so the only "lavish-axi" on its command line is in the marker arguments a test passes.
// It prints its port once listening, or "unavailable" when the address cannot be bound.
const STUCK_SERVER = `
const server = require("node:http").createServer((req, res) => {
  if (req.url.startsWith("/health")) {
    res.setHeader("content-type", "application/json");
    res.end(process.env.STUCK_SERVER_HEALTH);
    return;
  }
  req.resume();
  req.on("end", () => res.end("{}"));
});
server.on("error", () => {
  console.log("unavailable");
  process.exit(0);
});
const { STUCK_SERVER_HOST: host, STUCK_SERVER_PORT: port } = process.env;
server.listen(Number(port), host, () => console.log(server.address().port));
`;
const OLDER_LAVISH_HEALTH = JSON.stringify({ ok: true, app: "lavish-axi", version: "0.0.1" });
// What a Lavish server's command line carries: a server entry followed by the `server` command.
const LAVISH_SERVER_ARGS = ["/opt/lavish-axi/dist/server.mjs", "server"];

// CI runners ship lsof (it is in the Ubuntu server image the Linux runner is built from), so on CI a
// missing lsof fails these tests instead of skipping them: a silent skip there would leave the POSIX
// listener lookup unexercised on Linux with nobody noticing.
const canIdentifyListeners = process.platform === "win32" || spawnSync("lsof", ["-v"]).error === undefined;
const needsListenerLookup = {
  skip: !canIdentifyListeners && !process.env.CI && "identifying a listening process needs lsof here",
};

async function startStuckServer(markerArgs, { host = "127.0.0.1", port = 0 } = {}) {
  const child = spawn(process.execPath, ["-e", STUCK_SERVER, ...markerArgs], {
    env: {
      ...process.env,
      STUCK_SERVER_HEALTH: OLDER_LAVISH_HEALTH,
      STUCK_SERVER_HOST: host,
      STUCK_SERVER_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
  const printed = String(await new Promise((resolve) => child.stdout.once("data", resolve))).trim();
  const bound = printed === "unavailable" ? null : Number(printed);
  return { child, port: bound, exited, baseUrl: `http://${host}:${bound}` };
}

function within(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(false), ms))]);
}

test(
  "stop kills an older Lavish server that ignores /shutdown, found at its exact address",
  needsListenerLookup,
  async () => {
    const server = await startStuckServer(LAVISH_SERVER_ARGS);
    try {
      const output = await shutdownServerOnPort(server.port, { baseUrl: server.baseUrl, currentVersion: "0.1.82" });

      assert.deepEqual(output, { server: { status: "stopped", port: server.port } });
      assert.equal(await within(server.exited, 5000), true, "the stuck server process was killed");
    } finally {
      server.child.kill();
    }
  },
);

// Never by port alone: whatever a listener answers on /health, it is signalled only when its own
// command line identifies it as Lavish.
test("stop never kills a listener it cannot identify as Lavish", needsListenerLookup, async () => {
  const server = await startStuckServer(["stuck-server"]);
  try {
    await assert.rejects(
      shutdownServerOnPort(server.port, { baseUrl: server.baseUrl, currentVersion: "0.1.82" }),
      /no Lavish process listening there could be identified/,
    );
    assert.equal(await within(server.exited, 500), false, "the unidentified listener is left running");
  } finally {
    server.child.kill();
  }
});

// A path that merely contains "lavish-axi" - a test run or an editor in a checkout - is not a Lavish
// server, however its listener answers /health.
test("stop never kills a listener whose command line only mentions lavish-axi", needsListenerLookup, async () => {
  const server = await startStuckServer(["/home/u/prosto-lavish-axi/test/cli-output.test.js"]);
  try {
    await assert.rejects(
      shutdownServerOnPort(server.port, { baseUrl: server.baseUrl, currentVersion: "0.1.82" }),
      /no Lavish process listening there could be identified/,
    );
    assert.equal(await within(server.exited, 500), false, "the listener is left running");
  } finally {
    server.child.kill();
  }
});

// The same port at another address is another process's listener, even when that one is Lavish.
test(
  "stop never kills a Lavish process listening on the same port at another address",
  needsListenerLookup,
  async (t) => {
    const server = await startStuckServer(["stuck-server"]);
    const neighbour = await startStuckServer(LAVISH_SERVER_ARGS, { host: "127.0.0.2", port: server.port });
    try {
      if (neighbour.port === null) {
        t.skip("127.0.0.2 cannot be bound here");
        return;
      }
      await assert.rejects(
        shutdownServerOnPort(server.port, { baseUrl: server.baseUrl, currentVersion: "0.1.82" }),
        /no Lavish process listening there could be identified/,
      );
      assert.equal(
        await within(neighbour.exited, 500),
        false,
        "the Lavish process at the other address is left running",
      );
    } finally {
      server.child.kill();
      neighbour.child.kill();
    }
  },
);

// On a CPU-starved Windows machine (16 threads, 48 busy processes) the PowerShell listener lookup
// took up to 23 s; a lookup cut short identifies nothing, and `stop` would turn away a server it can
// control. PowerShell is replaced by a double that answers the way spawnSync does when the lookup
// needs that long: the listener's line if the call's timeout outlasts it, a killed child otherwise.
test("a Windows listener lookup as slow as on a starved CPU still identifies a pre-handshake server", async (t) => {
  const LOOKUP_MS = 23_000;
  const listenerPid = process.pid + 1;
  const listenerLine = `${listenerPid}\t"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\u\\lavish\\dist\\server.mjs server\r\n`;
  const realSpawnSync = childProcess.spawnSync;
  const lookups = [];
  const spawnSyncSpy = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    if (command !== "powershell.exe") return realSpawnSync(command, args, options);
    lookups.push(options);
    if (options?.timeout > 0 && options.timeout <= LOOKUP_MS) {
      const error = Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), {
        code: "ETIMEDOUT",
        syscall: "spawnSync powershell.exe",
        path: "powershell.exe",
        spawnargs: args,
      });
      return { pid: 4242, output: [null, "", ""], stdout: "", stderr: "", status: null, signal: "SIGTERM", error };
    }
    return { pid: 4242, output: [null, listenerLine, ""], stdout: listenerLine, stderr: "", status: 0, signal: null };
  });
  syncBuiltinESMExports();
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const port = 4399;
  const shutdowns = [];
  try {
    // A pre-handshake server's /health names neither the app nor a version, so only its listener's
    // command line can tell `stop` that it is Lavish. Nothing here dials the port.
    const output = await shutdownServerOnPort(port, {
      baseUrl: `http://127.0.0.1:${port}`,
      fetchHealth: async () => ({ ok: true }),
      requestShutdown: async (_baseUrl, options) => {
        shutdowns.push(options);
      },
      waitForPortFree: async () => true,
    });

    assert.equal(lookups.length, 1, "the PowerShell lookup ran once");
    // A lookup that never ends would hang the CLI, so the longer wait is still a bound.
    assert.ok(Number.isFinite(lookups[0].timeout) && lookups[0].timeout > 0, "the lookup is still bounded");
    assert.deepEqual(output, { server: { status: "stopped", port } });
    assert.deepEqual(shutdowns, [{ reason: "stop" }]);
  } finally {
    Object.defineProperty(process, "platform", platform);
    spawnSyncSpy.mock.restore();
    syncBuiltinESMExports();
  }
});
