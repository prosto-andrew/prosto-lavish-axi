import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  decodePngDataUrl,
  isValidDiagramIndex,
  isValidWhiteboardKey,
  loadWhiteboard,
  saveWhiteboard,
  whiteboardDir,
  whiteboardFeedbackPaths,
  writeWhiteboardFeedbackFiles,
} from "../src/whiteboard-store.js";

const KEY = "0123456789abcdef";
// A 1x1 transparent PNG.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-whiteboard-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const onlyWindows = { skip: process.platform !== "win32" && "only Windows refuses to replace a file that is open" };

// Holds `file` open the way a concurrent reader does, runs `write`, and lets go 50 ms in. The handle
// is closed before this returns either way, so the temp dir can still be removed after a failure.
async function writeWhileHeldOpen(file, write) {
  const reader = await open(file, "r");
  const released = new Promise((resolve) => setTimeout(resolve, 50)).then(() => reader.close());
  try {
    return await write();
  } finally {
    await released;
  }
}

test("saveWhiteboard/loadWhiteboard strips persisted theme and canvas background", async () => {
  await withTempDir(async (dir) => {
    const scene = {
      elements: [{ id: "A", type: "rectangle" }],
      appState: { theme: "dark", viewBackgroundColor: "#121212", scrollX: 12 },
      files: {},
    };
    const baseline = { elements: [{ id: "A", type: "rectangle" }] };
    await saveWhiteboard(dir, KEY, 0, { sourceHash: "hash-1", textMetricsVersion: 1, scene, baseline });
    const loaded = await loadWhiteboard(dir, KEY, 0);
    assert.equal(loaded.source_hash, "hash-1");
    assert.equal(loaded.text_metrics_version, 1);
    assert.deepEqual(loaded.scene, {
      ...scene,
      appState: { scrollX: 12 },
    });
    assert.deepEqual(loaded.baseline, baseline);
    assert.ok(loaded.updated_at);
  });
});

test("loadWhiteboard returns null when nothing was saved", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await loadWhiteboard(dir, KEY, 3), null);
  });
});

test("saveWhiteboard overwrites prior state for the same diagram", async () => {
  await withTempDir(async (dir) => {
    await saveWhiteboard(dir, KEY, 1, { sourceHash: "h1", scene: { elements: [] }, baseline: null });
    await saveWhiteboard(dir, KEY, 1, { sourceHash: "h2", scene: { elements: [{ id: "B" }] }, baseline: null });
    const loaded = await loadWhiteboard(dir, KEY, 1);
    assert.equal(loaded.source_hash, "h2");
    assert.equal(loaded.scene.elements.length, 1);
  });
});

test("concurrent saves preserve the most recent scene", async () => {
  await withTempDir(async (dir) => {
    const slowScene = { elements: [{ id: "old", text: "x".repeat(8 * 1024 * 1024) }] };
    const latestScene = { elements: [{ id: "latest" }] };
    await Promise.all([
      saveWhiteboard(dir, KEY, 5, { sourceHash: "old", scene: slowScene, baseline: null }),
      saveWhiteboard(dir, KEY, 5, { sourceHash: "latest", scene: latestScene, baseline: null }),
    ]);
    const loaded = await loadWhiteboard(dir, KEY, 5);
    assert.equal(loaded.source_hash, "latest");
    assert.deepEqual(loaded.scene, latestScene);
  });
});

// `loadWhiteboard` reads the sidecar outside the write queue - a second tab opening the diagram
// while this one autosaves - and on Windows any open handle refuses the replace.
test("on Windows an autosave lands once a reader of the sidecar lets go", onlyWindows, async () => {
  await withTempDir(async (dir) => {
    await saveWhiteboard(dir, KEY, 3, { sourceHash: "old", scene: { elements: [] } });
    const sidecar = path.join(whiteboardDir(dir, KEY), "3.json");

    await writeWhileHeldOpen(sidecar, () =>
      saveWhiteboard(dir, KEY, 3, { sourceHash: "new", scene: { elements: [{ id: "new" }] } }),
    );

    const loaded = await loadWhiteboard(dir, KEY, 3);
    assert.equal(loaded.source_hash, "new");
    assert.deepEqual(loaded.scene, { elements: [{ id: "new" }] });
  });
});

test("store rejects invalid keys and indexes (path traversal guard)", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(() => saveWhiteboard(dir, "../../etc", 0, { sourceHash: "", scene: null }), /invalid/);
    await assert.rejects(() => saveWhiteboard(dir, KEY, "../7", { sourceHash: "", scene: null }), /invalid/);
    await assert.rejects(() => loadWhiteboard(dir, "ZZZZ", 0), /invalid/);
    await assert.rejects(() => writeWhiteboardFeedbackFiles(dir, KEY, -1, { scene: null }), /invalid/);
  });
});

test("isValidWhiteboardKey / isValidDiagramIndex validate shapes", () => {
  assert.equal(isValidWhiteboardKey(KEY), true);
  assert.equal(isValidWhiteboardKey("0123"), false);
  assert.equal(isValidWhiteboardKey("0123456789ABCDEF"), false);
  assert.equal(isValidDiagramIndex(0), true);
  assert.equal(isValidDiagramIndex("12"), true);
  assert.equal(isValidDiagramIndex(1000), false);
  assert.equal(isValidDiagramIndex(-1), false);
  assert.equal(isValidDiagramIndex(1.5), false);
});

test("writeWhiteboardFeedbackFiles writes a standalone .excalidraw and a PNG", async () => {
  await withTempDir(async (dir) => {
    const { scenePath, previewPath } = await writeWhiteboardFeedbackFiles(dir, KEY, 2, {
      scene: { elements: [{ id: "A", type: "rectangle" }], appState: { theme: "light" }, files: {} },
      pngDataUrl: PNG_DATA_URL,
    });
    assert.deepEqual({ scenePath, previewPath }, whiteboardFeedbackPaths(dir, KEY, 2));
    const scene = JSON.parse(await readFile(scenePath, "utf8"));
    assert.equal(scene.type, "excalidraw");
    assert.equal(scene.version, 2);
    assert.equal(scene.source, "lavish-axi");
    assert.equal(scene.elements[0].id, "A");
    assert.deepEqual(scene.appState, {});
    const png = await readFile(previewPath);
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });
});

test("writeWhiteboardFeedbackFiles tolerates a missing or invalid preview", async () => {
  await withTempDir(async (dir) => {
    const { scenePath, previewPath } = await writeWhiteboardFeedbackFiles(dir, KEY, 4, {
      scene: { elements: [] },
      pngDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    });
    assert.ok(scenePath.endsWith("4.excalidraw"));
    assert.equal(previewPath, "");
  });
});

// The agent reads the published preview while the user queues the next note on the same diagram.
test("on Windows republishing feedback files lands once a reader of the preview lets go", onlyWindows, async () => {
  await withTempDir(async (dir) => {
    const { previewPath } = await writeWhiteboardFeedbackFiles(dir, KEY, 6, {
      scene: { elements: [{ id: "first" }] },
      pngDataUrl: PNG_DATA_URL,
    });

    const secondPng = Buffer.concat([decodePngDataUrl(PNG_DATA_URL), Buffer.from("second")]);

    const { scenePath } = await writeWhileHeldOpen(previewPath, () =>
      writeWhiteboardFeedbackFiles(dir, KEY, 6, {
        scene: { elements: [{ id: "second" }] },
        pngDataUrl: `data:image/png;base64,${secondPng.toString("base64")}`,
      }),
    );

    assert.equal(JSON.parse(await readFile(scenePath, "utf8")).elements[0].id, "second");
    assert.deepEqual(await readFile(previewPath), secondPng);
  });
});

// POSIX file modes have no Windows equivalent (chmod there only toggles a read-only flag).
const posixOnly = { skip: process.platform === "win32" ? "POSIX file modes" : false };

// Both writers create the session's whiteboard dir on their own, so each is checked in a fresh
// state dir.
const WHITEBOARD_WRITERS = [
  {
    name: "saveWhiteboard",
    write: (dir) => saveWhiteboard(dir, KEY, 0, { sourceHash: "hash", scene: { elements: [] } }),
    files: ["0.json"],
  },
  {
    name: "writeWhiteboardFeedbackFiles",
    write: (dir) => writeWhiteboardFeedbackFiles(dir, KEY, 0, { scene: { elements: [] }, pngDataUrl: PNG_DATA_URL }),
    files: ["0.excalidraw", "0.png"],
  },
];

test("whiteboard files and dirs are created private to the owner", posixOnly, async () => {
  for (const { name, write, files } of WHITEBOARD_WRITERS) {
    await withTempDir(async (dir) => {
      await write(dir);
      // A scene is whatever the reviewer drew. Under the usual 0022 umask these would otherwise
      // land 0644/0755 and be readable by every other local user.
      for (const file of files) {
        assert.equal((await stat(path.join(whiteboardDir(dir, KEY), file))).mode & 0o777, 0o600, `${name}: ${file}`);
      }
      assert.equal((await stat(whiteboardDir(dir, KEY))).mode & 0o777, 0o700, `${name}: session dir`);
      assert.equal((await stat(path.join(dir, "whiteboards"))).mode & 0o777, 0o700, `${name}: whiteboards root`);
    });
  }
});

test("a whiteboard write tightens the modes of a pre-hardening world-readable dir", posixOnly, async () => {
  for (const { name, write } of WHITEBOARD_WRITERS) {
    await withTempDir(async (dir) => {
      // An install that saved scenes before this hardening already has 0755 dirs on disk, and
      // creating with a mode alone would leave the scenes in them exposed.
      await mkdir(whiteboardDir(dir, KEY), { recursive: true });
      await chmod(path.join(dir, "whiteboards"), 0o755);
      await chmod(whiteboardDir(dir, KEY), 0o755);

      await write(dir);
      assert.equal((await stat(whiteboardDir(dir, KEY))).mode & 0o777, 0o700, `${name}: session dir`);
      assert.equal((await stat(path.join(dir, "whiteboards"))).mode & 0o777, 0o700, `${name}: whiteboards root`);
    });
  }
});

test("decodePngDataUrl only accepts base64 PNG data URLs", () => {
  assert.ok(decodePngDataUrl(PNG_DATA_URL) instanceof Buffer);
  assert.equal(decodePngDataUrl("data:image/jpeg;base64,abcd"), null);
  assert.equal(decodePngDataUrl("not-a-data-url"), null);
  assert.equal(decodePngDataUrl(null), null);
});
