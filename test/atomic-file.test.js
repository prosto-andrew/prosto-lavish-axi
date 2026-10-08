import assert from "node:assert/strict";
import { mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeFileAtomically } from "../src/atomic-file.js";

async function withFile(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-atomic-"));
  try {
    const file = path.join(dir, "state.json");
    await writeFile(file, "old\n");
    return await fn(file, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function failingRename(code, counter) {
  const error = Object.assign(new Error(`${code}: rename failed`), { code });
  return {
    error,
    renameFile: async () => {
      counter.attempts += 1;
      throw error;
    },
  };
}

test("replaces the file with the new contents and leaves no temporary file", async () => {
  await withFile(async (file, dir) => {
    await writeFileAtomically(file, "new\n");

    assert.equal(await readFile(file, "utf8"), "new\n");
    assert.deepEqual(await readdir(dir), ["state.json"]);
  });
});

test("a replace that fails keeps the previous file and removes the temporary file", async () => {
  await withFile(async (file, dir) => {
    const counter = { attempts: 0 };
    const { error, renameFile } = failingRename("EIO", counter);

    await assert.rejects(writeFileAtomically(file, "new\n", { renameFile }), error);
    assert.equal(await readFile(file, "utf8"), "old\n");
    assert.deepEqual(await readdir(dir), ["state.json"]);
  });
});

test(
  "on Windows a replace held up by an open handle lands once the handle closes",
  { skip: process.platform !== "win32" && "only Windows refuses to replace a file that is open" },
  async () => {
    await withFile(async (file, dir) => {
      // Any open handle blocks the replace there, a plain reader of the same file included - which is
      // exactly what a CLI listing sessions does to a server writing state at the same moment.
      const reader = await open(file, "r");
      const released = new Promise((resolve) => setTimeout(resolve, 50)).then(() => reader.close());

      await writeFileAtomically(file, "new\n");
      await released;

      assert.equal(await readFile(file, "utf8"), "new\n");
      assert.deepEqual(await readdir(dir), ["state.json"]);
    });
  },
);

test("on Windows gives up after a bounded number of retries with the error that blocked it", async () => {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    await withFile(async (file, dir) => {
      const counter = { attempts: 0 };
      const { error, renameFile } = failingRename(code, counter);

      await assert.rejects(
        writeFileAtomically(file, "new\n", { platform: "win32", delaysMs: [0, 0, 0], renameFile }),
        error,
      );
      assert.equal(counter.attempts, 4, `${code} is retried once per delay`);
      assert.equal(await readFile(file, "utf8"), "old\n");
      assert.deepEqual(await readdir(dir), ["state.json"]);
    });
  }
});

test("retries only on Windows and only for the errors an open handle causes", async () => {
  for (const [platform, code] of [
    ["linux", "EPERM"],
    ["darwin", "EBUSY"],
    ["win32", "ENOENT"],
    ["win32", "EXDEV"],
  ]) {
    await withFile(async (file) => {
      const counter = { attempts: 0 };
      const { error, renameFile } = failingRename(code, counter);

      await assert.rejects(writeFileAtomically(file, "new\n", { platform, delaysMs: [0, 0, 0], renameFile }), error);
      assert.equal(counter.attempts, 1, `${code} on ${platform} is not retried`);
    });
  }
});
