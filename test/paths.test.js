import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bindHost,
  clientHost,
  ensureStateDir,
  extraAllowedHosts,
  hostForUrl,
  LOOPBACK_HOST,
  linkHost,
  resolveListenHosts,
} from "../src/paths.js";

// LAVISH-HARDENED: LAVISH_AXI_HOST is ignored. The stock build let it name any
// interface to bind to - a LAN address, a VPN address, a wildcard - and these three
// tests asserted exactly that. Here the value is read by nothing, so what is pinned is
// that no environment can move the server off loopback.
test("no environment value can move the bind address off loopback", () => {
  const attempts = [
    {},
    { LAVISH_AXI_HOST: "" },
    { LAVISH_AXI_HOST: "  " },
    { LAVISH_AXI_HOST: "100.64.0.1" },
    { LAVISH_AXI_HOST: " 0.0.0.0 " },
    { LAVISH_AXI_HOST: "::" },
    { LAVISH_AXI_HOST: "192.168.1.10" },
  ];
  for (const env of attempts) {
    assert.equal(bindHost(env), LOOPBACK_HOST, JSON.stringify(env));
    assert.equal(clientHost(env), LOOPBACK_HOST, JSON.stringify(env));
  }
});

test("the listen set is loopback and nothing else", () => {
  for (const env of [{}, { LAVISH_AXI_HOST: "100.64.0.1" }]) {
    assert.deepEqual(resolveListenHosts({ env }), [LOOPBACK_HOST]);
  }
  // A detected tailnet used to be appended here; nothing detects one any more, and an
  // injected one is ignored too.
  assert.deepEqual(resolveListenHosts({ tailscale: { ipv4: "100.64.0.1" } }), [LOOPBACK_HOST]);
});

test("extraAllowedHosts parses the whitespace-separated opt-in list", () => {
  assert.deepEqual(extraAllowedHosts({}), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "" }), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "  " }), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "proxy.example" }), ["proxy.example"]);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "  a.example   b.example\tc.example  " }), [
    "a.example",
    "b.example",
    "c.example",
  ]);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "*" }), ["*"]);
});

test("linkHost still names a hostname for the URL, but never a second bind address", () => {
  // LAVISH_AXI_LINK_HOST is cosmetic: it only changes the hostname written into session
  // URLs (a reverse proxy in front of loopback). It cannot widen what the server listens
  // on, so the bind address stays loopback whatever it says.
  assert.equal(linkHost({}), LOOPBACK_HOST);
  assert.equal(linkHost({ LAVISH_AXI_LINK_HOST: "host.example" }), "host.example");
  assert.equal(linkHost({ LAVISH_AXI_LINK_HOST: "  " }), LOOPBACK_HOST);
  // The stock build fell back to the bind address here; that address is now always loopback.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "100.64.0.1" }), LOOPBACK_HOST);
  assert.equal(linkHost({ LAVISH_AXI_HOST: "::" }), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_LINK_HOST: "host.example" }), LOOPBACK_HOST);
});

test("hostForUrl brackets IPv6 literals but leaves IPv4 and hostnames alone", () => {
  assert.equal(hostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(hostForUrl("host.example"), "host.example");
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(hostForUrl("[::1]"), "[::1]");
});

// POSIX file modes have no Windows equivalent (chmod there only toggles a read-only flag).
const posixOnly = { skip: process.platform === "win32" ? "POSIX file modes" : false };

async function withStateDirEnv(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-paths-"));
  const previous = process.env.LAVISH_AXI_STATE_DIR;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.LAVISH_AXI_STATE_DIR;
    else process.env.LAVISH_AXI_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("ensureStateDir creates the state dir private to the owner", posixOnly, async () => {
  await withStateDirEnv(async (root) => {
    const stateDir = path.join(root, "state");
    process.env.LAVISH_AXI_STATE_DIR = stateDir;

    await ensureStateDir();

    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  });
});

// LAVISH_AXI_STATE_DIR may name a dir the user shares on purpose, so its mode stays theirs; the
// files Lavish keeps in it are owner-only one by one.
test("ensureStateDir leaves the mode of an existing state dir alone", posixOnly, async () => {
  await withStateDirEnv(async (root) => {
    const stateDir = path.join(root, "shared");
    await mkdir(stateDir);
    await chmod(stateDir, 0o755);
    process.env.LAVISH_AXI_STATE_DIR = stateDir;

    await ensureStateDir();

    assert.equal((await stat(stateDir)).mode & 0o777, 0o755);
  });
});
