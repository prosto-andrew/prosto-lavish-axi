import { chmodSync, fchmodSync, openSync, renameSync, statSync } from "node:fs";

// server.log is appended to across restarts. Once it passes this size, the next detached start
// moves it to server.log.1 (replacing the one before) and starts a fresh log, so at most two runs'
// worth stay on disk. The server stops itself when idle, so starts come often.
const SERVER_LOG_MAX_BYTES = 1024 * 1024;
// Session warnings and crash traces name the user's files, so the log is owner-only like
// state.json; under the usual 0022 umask it would otherwise land 0644.
const SERVER_LOG_MODE = 0o600;

/**
 * Open server.log for the detached server's stdout and stderr, rotating it first when it has
 * outgrown `maxBytes`. Every step is best effort: logging must never stop a server from starting,
 * so a failed rotation only postpones it to the next start.
 * @param {string} file
 * @param {{ maxBytes?: number }} [options]
 * @returns {number | null} the fd, or null when the log cannot be opened
 */
export function openServerLog(file, { maxBytes = SERVER_LOG_MAX_BYTES } = {}) {
  try {
    if (statSync(file).size > maxBytes) {
      // On Windows the rename works even while a replaced server still writes to the log (its
      // last lines follow the file into .1), but fails while a reader holds server.log.1 open.
      renameSync(file, `${file}.1`);
      chmodSync(`${file}.1`, SERVER_LOG_MODE);
    }
  } catch {
    // Missing log, or the rotation failed: append to whatever is there.
  }
  let fd;
  try {
    fd = openSync(file, "a", SERVER_LOG_MODE);
  } catch {
    // If logging cannot be initialized, keep the server behavior unchanged.
    return null;
  }
  try {
    // The create mode covers only a new log; this tightens one written before this hardening.
    fchmodSync(fd, SERVER_LOG_MODE);
  } catch {
    // Best effort, as for the state dir's other files.
  }
  return fd;
}

/**
 * Stamp a server log line with a UTC timestamp. server.log is append-only across restarts, so an
 * undated line cannot be correlated with an outage after the fact.
 * @param {string} line
 * @param {Date} [now]
 * @returns {string}
 */
export function formatServerLogLine(line, now = new Date()) {
  return `${now.toISOString()} ${line}`;
}

const STDIO_STAMPED = Symbol.for("lavish-axi.stdio-timestamped");

export function serverStdioIsTimestamped() {
  return Boolean(globalThis[STDIO_STAMPED]);
}

function createTimestampedWrite(write, now = () => new Date()) {
  let atLineStart = true;
  return function timestampedWrite(chunk, encoding, callback) {
    let enc = encoding;
    let cb = callback;
    if (typeof encoding === "function") {
      cb = encoding;
      enc = undefined;
    }
    const str = chunkToString(chunk, enc);
    let out = "";
    for (let i = 0; i < str.length; i += 1) {
      if (atLineStart) {
        out += formatServerLogLine("", now());
        atLineStart = false;
      }
      const ch = str[i];
      out += ch;
      if (ch === "\n") atLineStart = true;
    }
    return write(out, enc, cb);
  };
}

export function installServerStdioTimestamps() {
  if (serverStdioIsTimestamped()) return;
  globalThis[STDIO_STAMPED] = true;
  process.stdout.write = createTimestampedWrite(process.stdout.write.bind(process.stdout));
  process.stderr.write = createTimestampedWrite(process.stderr.write.bind(process.stderr));
}

function chunkToString(chunk, encoding) {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) {
    const bufferEncoding = /** @type {BufferEncoding} */ (typeof encoding === "string" ? encoding : "utf8");
    return chunk.toString(bufferEncoding);
  }
  return String(chunk);
}
