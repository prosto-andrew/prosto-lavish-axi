import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync, gzipSync } from "node:zlib";
import test from "node:test";

import { serve } from "../src/server.js";

// LAVISH-HARDENED: nothing in this build sends a compressed request body - not the CLI, not the
// review page - so the JSON parser never decompresses one (`inflate: false` in src/server.js).
// Request decompression has carried its own bugs (GHSA-27r3-jxmh-p828: bytes after the compressed
// frame crashed the process on some Node versions), and a body that is never inflated cannot reach
// them.

function post(port, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: pathname,
        headers: { ...headers, "content-length": String(body.length) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("a compressed request body is refused before it is decompressed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-compressed-body-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>review</body></html>");
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    env: {},
    hosts: ["127.0.0.1"],
    idleTimeoutMs: null,
  });
  try {
    const json = Buffer.from(JSON.stringify({ file: artifact }));
    // The same body uncompressed opens the session, so the parser still reads JSON.
    const plain = await post(server.port, "/api/sessions", { "content-type": "application/json" }, json);
    assert.equal(plain.status, 200);
    assert.match(JSON.parse(plain.body).url, /\/session\//);

    // Both JSON parsers: the default one and the larger whiteboard-write one, which runs before
    // that route's own same-origin check.
    for (const pathname of ["/api/sessions", "/api/0123456789abcdef/whiteboard/0"]) {
      for (const { encoding, compress } of [
        { encoding: "gzip", compress: gzipSync },
        { encoding: "deflate", compress: deflateSync },
      ]) {
        const compressed = await post(
          server.port,
          pathname,
          { "content-type": "application/json", "content-encoding": encoding },
          compress(json),
        );
        assert.equal(compressed.status, 415, `a ${encoding} body to ${pathname} is refused`);
      }
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
