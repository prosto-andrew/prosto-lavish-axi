import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomically } from "./atomic-file.js";
import { sanitizeWhiteboardScene } from "./whiteboard-core.js";

// Sidecar persistence for whiteboard scenes, kept out of `state.json` on
// purpose: `SessionStore` rewrites the whole state file on every operation, so
// multi-hundred-KB Excalidraw scenes autosaving every second would turn each
// unrelated store write into a large rewrite. Scenes live as one JSON file per
// (session key, diagram index) under `<state-dir>/whiteboards/`, next to the
// published `.excalidraw`/`.png` feedback files the agent reads.

const KEY_RE = /^[0-9a-f]{16}$/;
const writeTails = new Map();

// A scene is whatever the reviewer drew, so like attachments these files are owner-only: under
// the usual 0022 umask they would otherwise land 0644 in 0755 dirs, readable by every other local
// user. A file gets its mode at creation and the atomic rename keeps it.
const WHITEBOARD_FILE_MODE = 0o600;
const WHITEBOARD_DIR_MODE = 0o700;

export function isValidWhiteboardKey(key) {
  return KEY_RE.test(String(key || ""));
}

export function isValidDiagramIndex(index) {
  const number = Number(index);
  return Number.isInteger(number) && number >= 0 && number <= 999;
}

function assertValidRef(key, index) {
  if (!isValidWhiteboardKey(key)) throw new Error(`invalid whiteboard session key: ${key}`);
  if (!isValidDiagramIndex(index)) throw new Error(`invalid whiteboard diagram index: ${index}`);
}

export function whiteboardDir(stateDir, key) {
  return path.join(stateDir, "whiteboards", String(key));
}

function workingFile(stateDir, key, index) {
  return path.join(whiteboardDir(stateDir, key), `${Number(index)}.json`);
}

// `mkdir` applies its mode only to dirs it creates, so the modes are also re-asserted: an install
// that saved scenes before this hardening already has 0755 dirs on disk.
async function ensureWhiteboardDir(stateDir, key) {
  const dir = whiteboardDir(stateDir, key);
  await mkdir(dir, { recursive: true, mode: WHITEBOARD_DIR_MODE });
  for (const target of [path.join(stateDir, "whiteboards"), dir]) {
    // Best effort, as for attachments: a dir owned by another user can't be chmod'ed.
    await chmod(target, WHITEBOARD_DIR_MODE).catch(() => {});
  }
}

function writeQueueKey(stateDir, key, index) {
  return `${path.resolve(stateDir)}\u0000${key}\u0000${Number(index)}`;
}

function queueWhiteboardWrite(stateDir, key, index, operation) {
  const queueKey = writeQueueKey(stateDir, key, index);
  const prior = writeTails.get(queueKey) || Promise.resolve();
  const result = prior.catch(() => {}).then(operation);
  const tail = result.catch(() => {});
  writeTails.set(queueKey, tail);
  tail.finally(() => {
    if (writeTails.get(queueKey) === tail) writeTails.delete(queueKey);
  });
  return result;
}

export function whiteboardFeedbackPaths(stateDir, key, index) {
  assertValidRef(key, index);
  const dir = whiteboardDir(stateDir, key);
  return {
    scenePath: path.join(dir, `${Number(index)}.excalidraw`),
    previewPath: path.join(dir, `${Number(index)}.png`),
  };
}

// Working state: the editable scene, the conversion baseline used for edit
// summaries, and the hash of the Mermaid source the scene was converted from.
export async function saveWhiteboard(
  stateDir,
  key,
  index,
  { sourceHash, textMetricsVersion = 0, scene, baseline = null },
) {
  assertValidRef(key, index);
  const record = {
    source_hash: String(sourceHash || ""),
    text_metrics_version: Math.max(0, Math.floor(Number(textMetricsVersion) || 0)),
    updated_at: new Date().toISOString(),
    scene: sanitizeWhiteboardScene(scene),
    baseline: baseline ?? null,
  };
  return queueWhiteboardWrite(stateDir, key, index, async () => {
    await ensureWhiteboardDir(stateDir, key);
    await writeFileAtomically(workingFile(stateDir, key, index), `${JSON.stringify(record)}\n`, {
      mode: WHITEBOARD_FILE_MODE,
    });
    return record;
  });
}

export async function loadWhiteboard(stateDir, key, index) {
  assertValidRef(key, index);
  try {
    const raw = await readFile(workingFile(stateDir, key, index), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      source_hash: String(parsed.source_hash || ""),
      text_metrics_version: Math.max(0, Math.floor(Number(parsed.text_metrics_version) || 0)),
      updated_at: String(parsed.updated_at || ""),
      scene: parsed.scene ?? null,
      baseline: parsed.baseline ?? null,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

// Publish the agent-facing feedback files: a standalone `.excalidraw` scene
// JSON and a PNG preview. Called at queue time so the paths embedded in the
// queued prompt always point at the exact reviewed state.
export async function writeWhiteboardFeedbackFiles(stateDir, key, index, { scene, pngDataUrl = "" }) {
  assertValidRef(key, index);
  const { scenePath, previewPath } = whiteboardFeedbackPaths(stateDir, key, index);
  const sanitizedScene = sanitizeWhiteboardScene(scene);
  const sceneJson = {
    type: "excalidraw",
    version: 2,
    source: "lavish-axi",
    elements: Array.isArray(sanitizedScene?.elements) ? sanitizedScene.elements : [],
    appState: sanitizedScene?.appState || {},
    files: sanitizedScene?.files && typeof sanitizedScene.files === "object" ? sanitizedScene.files : {},
  };
  const png = decodePngDataUrl(pngDataUrl);
  return queueWhiteboardWrite(stateDir, key, index, async () => {
    await ensureWhiteboardDir(stateDir, key);
    await writeFileAtomically(scenePath, `${JSON.stringify(sceneJson, null, 2)}\n`, { mode: WHITEBOARD_FILE_MODE });
    if (png) {
      await writeFileAtomically(previewPath, png, { mode: WHITEBOARD_FILE_MODE });
      return { scenePath, previewPath };
    }
    return { scenePath, previewPath: "" };
  });
}

export function decodePngDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}
