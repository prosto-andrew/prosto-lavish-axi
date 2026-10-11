import assert from "node:assert/strict";
import { closeSync, writeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openServerLog } from "../src/server-log.js";

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-server-log-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// What the detached server does with the fd: write through it, then the CLI closes its copy.
function appendThrough(fd, text) {
  assert.notEqual(fd, null, "the log could not be opened");
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

test("a server.log over the limit moves to server.log.1 and the server writes a fresh one", async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "server.log");
    await writeFile(log, "eleven byte");

    appendThrough(openServerLog(log, { maxBytes: 10 }), "new\n");

    assert.equal(await readFile(`${log}.1`, "utf8"), "eleven byte");
    assert.equal(await readFile(log, "utf8"), "new\n");
  });
});

test("a server.log at the limit is appended to and not rotated", async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "server.log");
    await writeFile(log, "ten bytes\n");

    appendThrough(openServerLog(log, { maxBytes: 10 }), "new\n");

    assert.equal(await readFile(log, "utf8"), "ten bytes\nnew\n");
    await assert.rejects(stat(`${log}.1`), { code: "ENOENT" });
  });
});

test("a missing server.log is created", async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "server.log");

    appendThrough(openServerLog(log, { maxBytes: 10 }), "first\n");

    assert.equal(await readFile(log, "utf8"), "first\n");
  });
});

test("rotation replaces the previous server.log.1", async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "server.log");
    await writeFile(`${log}.1`, "oldest run\n");
    await writeFile(log, "previous run\n");

    appendThrough(openServerLog(log, { maxBytes: 10 }), "new\n");

    assert.equal(await readFile(`${log}.1`, "utf8"), "previous run\n");
    assert.equal(await readFile(log, "utf8"), "new\n");
  });
});

// Logging must never stop a server from starting: a rename that fails (here server.log.1 is a
// directory; on Windows, a reader holding it open) only postpones the rotation to the next start.
test("a server.log that cannot be rotated is still opened for appending", async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "server.log");
    await mkdir(`${log}.1`);
    await writeFile(log, "previous run\n");

    appendThrough(openServerLog(log, { maxBytes: 10 }), "new\n");

    assert.equal(await readFile(log, "utf8"), "previous run\nnew\n");
  });
});

test("a server.log that cannot be opened yields no fd instead of an error", async () => {
  await withTempDir(async (dir) => {
    // Windows opens a directory for appending, so the unopenable path sits in a missing one.
    const fd = openServerLog(path.join(dir, "missing", "server.log"), { maxBytes: 10 });
    if (fd !== null) closeSync(fd);

    assert.equal(fd, null);
  });
});

// POSIX file modes have no Windows equivalent (chmod there only toggles a read-only flag).
const posixOnly = { skip: process.platform === "win32" ? "POSIX file modes" : false };

test("server.log is created private to the owner", posixOnly, async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "server.log");

    appendThrough(openServerLog(log, { maxBytes: 10 }), "first\n");

    // Session warnings and crash traces name the user's files; under the usual 0022 umask the log
    // would otherwise land 0644 and be readable by every other local user.
    assert.equal((await stat(log)).mode & 0o777, 0o600);
  });
});

test("a pre-hardening world-readable server.log is tightened, rotated or not", posixOnly, async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "server.log");
    await writeFile(log, "small\n");
    await chmod(log, 0o644);

    appendThrough(openServerLog(log, { maxBytes: 10 }), "new\n");

    assert.equal((await stat(log)).mode & 0o777, 0o600, "appended log");
  });
  await withTempDir(async (dir) => {
    const log = path.join(dir, "server.log");
    await writeFile(log, "previous run\n");
    await chmod(log, 0o644);

    appendThrough(openServerLog(log, { maxBytes: 10 }), "new\n");

    assert.equal((await stat(`${log}.1`)).mode & 0o777, 0o600, "rotated log");
    assert.equal((await stat(log)).mode & 0o777, 0o600, "fresh log");
  });
});
