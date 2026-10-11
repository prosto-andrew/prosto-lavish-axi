import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { serve } from "../src/server.js";

// LAVISH-HARDENED: a file beside an artifact is served only under the current load's token, which
// the artifact document's relative URLs carry in their path, and an attachment only to the review
// page itself. Only a real browser shows that the artifact still loads its own files that way -
// through @import, from inside the review frame - and that a page on another loopback port or one
// opened from disk gets nothing, while a Node-side test proves only what the server answers.
// Opt-in like the other real-browser suites:
//   LAVISH_AXI_BROWSER_E2E=1 CHROME_PATH=/path/to/chrome node --test test/artifact-assets.browser.test.js
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";

// A 2x1 PNG.
const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8BQz0BkYGAAADAAA/8W1p0AAAAASUVORK5CYII=",
  "base64",
);

async function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return "";
}

function chromeArgs(profileDir, url, extra = []) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--no-first-run",
    `--user-data-dir=${profileDir}`,
    ...extra,
    url,
  ];
}

// Chrome leaves helper processes behind a killed browser process on Windows, so take the tree.
function stopChrome(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

// Dumps the DOM once Chrome considers the page settled.
function dumpChromeDom(chrome, profileDir, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      chrome,
      chromeArgs(profileDir, url, [
        "--enable-logging=stderr",
        "--log-level=0",
        "--virtual-time-budget=10000",
        "--dump-dom",
      ]),
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopChrome(child);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => finish(new Error(`Chrome did not dump the DOM in time\n${stderr}`)), timeoutMs);
    child.on("error", finish);
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`Chrome exited before dumping the DOM (${code})\n${stderr}`));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 256 * 1024) stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("</html>")) finish();
    });
  });
}

// What the page under test wrote into <pre id="results"> once its load event fired.
function resultsFrom(dom) {
  const match = /<pre id="results">([^<]*)<\/pre>/.exec(dom);
  assert.ok(match, `the page wrote no results\n${dom.slice(0, 2000)}`);
  return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

async function waitFor(read, done, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const SHARED_ASSETS = {
  "assets/data.js": 'var ASSET_GLOBAL = "loaded";\n',
  "assets/style.css": '@import url("more.css");\n',
  "assets/more.css": ".imported { color: rgb(1, 2, 3); }\n",
  "assets/img.png": PNG_2x1,
};

async function withServer(files, run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "lavish-artifact-assets-"));
  const dir = path.join(parent, ".lavish");
  for (const [rel, content] of Object.entries({ ...SHARED_ASSETS, ...files })) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  const stateFile = path.join(parent, "state", "state.json");
  await mkdir(path.dirname(stateFile));
  const server = await serve({ port: 0, stateFile, version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  const openSession = async (rel) => {
    const { key } = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: path.join(dir, rel) }),
    }).then((res) => res.json());
    return key;
  };
  try {
    await run({ base, parent, stateFile, openSession });
  } finally {
    await server.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

let loadSequence = 0;

// What the chrome does before it navigates its frame: take the handoff, then begin a load.
async function beginLoad(base, key) {
  const handoff = await fetch(`${base}/api/${key}/chrome-loads/begin`, {
    method: "POST",
    headers: { origin: base },
  }).then((res) => res.json());
  const response = await fetch(`${base}/api/${key}/artifact-loads/begin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: `browser-load-${++loadSequence}`,
      request_sequence: handoff.artifact_load_sequence + 1,
      chrome_load_token: handoff.chrome_load_token,
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function entryUrl(base, key, load) {
  return `${base}/artifact/${key}/index.html?artifact_revision=${load.artifact_revision}&artifact_load_token=${encodeURIComponent(load.artifact_load_token)}`;
}

const browserTest = (name, fn) =>
  test(name, { skip: !runBrowserE2e, timeout: 240_000 }, async (t) => {
    const chrome = await chromePath();
    if (!chrome) {
      t.skip("Chrome or Chromium is required (set CHROME_PATH)");
      return;
    }
    await fn(chrome);
  });

browserTest("an artifact loads its own files through the load path", async (chrome) => {
  const plan = `<!doctype html><html><head><title>assets</title>
<link rel="stylesheet" href="assets/style.css">
<script src="assets/data.js"></script>
</head><body><p class="imported">imported</p><img id="img" src="assets/img.png"><pre id="results"></pre>
<script>
addEventListener("load", () => {
  const img = document.getElementById("img");
  document.getElementById("results").textContent = JSON.stringify({
    global: typeof ASSET_GLOBAL,
    color: getComputedStyle(document.querySelector(".imported")).color,
    img: img.naturalWidth + "x" + img.naturalHeight,
    tokenInPath: location.pathname.split("/")[3],
  });
});
</script></body></html>`;
  await withServer({ "plan.html": plan }, async ({ base, parent, openSession }) => {
    const key = await openSession("plan.html");
    const load = await beginLoad(base, key);
    const dom = await dumpChromeDom(chrome, path.join(parent, "profile-plan"), entryUrl(base, key, load), 90_000);
    assert.deepEqual(resultsFrom(dom), {
      global: "string",
      color: "rgb(1, 2, 3)",
      img: "2x1",
      tokenInPath: load.artifact_load_token,
    });
  });
});

// The page checks its own files at its load event and names the missing image after the verdict, so
// the report the test waits for already says whether every existing file loaded: no failure report
// about one of them can still be on its way.
browserTest("a review reports only the file that is really missing, without the load token", async (chrome) => {
  const review = `<!doctype html><html><head><title>review</title>
<link rel="stylesheet" href="assets/style.css">
<script src="assets/data.js"></script>
</head><body><p class="imported">review</p><img src="assets/img.png">
<script>
addEventListener("load", () => {
  const ownFilesLoaded =
    typeof ASSET_GLOBAL === "string" &&
    getComputedStyle(document.querySelector(".imported")).color === "rgb(1, 2, 3)" &&
    document.querySelector("img").naturalWidth === 2;
  const missing = document.createElement("img");
  missing.src = "missing-r" + new URLSearchParams(location.search).get("artifact_revision") +
    (ownFilesLoaded ? "-own-files-loaded" : "-own-files-failed") + ".png";
  document.body.appendChild(missing);
});
</script></body></html>`;
  await withServer({ "review.html": review }, async ({ base, parent, stateFile, openSession }) => {
    const key = await openSession("review.html");
    const readSession = async () => {
      try {
        return JSON.parse(await readFile(stateFile, "utf8")).sessions[key] || {};
      } catch {
        // Read while the store is replacing the file; the next poll reads it whole.
        return {};
      }
    };
    const revisionOf = (failure) => Number(/missing-r(\d+)-own-files-\w+\.png$/.exec(failure.detail)?.[1] || 0);
    const tokens = [];
    const assertOnlyMissing = (failures) => {
      for (const failure of failures) {
        assert.match(
          failure.detail,
          new RegExp(`^<img> could not load /artifact/${key}/missing-r\\d+-own-files-(loaded|failed)\\.png$`),
        );
        for (const token of tokens) assert.ok(!failure.detail.includes(token), `${failure.detail} names a load token`);
      }
    };

    let newestRevision = 0;
    // The second open renders with the load the first one left active and begins a newer one before
    // it navigates the frame, which must end up on that newer load, whose files still answer.
    for (const run of ["first-open", "reopen"]) {
      const child = spawn(chrome, chromeArgs(path.join(parent, `profile-${run}`), `${base}/session/${key}`), {
        detached: true,
        stdio: "ignore",
      });
      const exited = once(child, "exit");
      try {
        const after = newestRevision;
        const session = await waitFor(
          readSession,
          (current) => (current.artifact_failures || []).some((failure) => revisionOf(failure) > after),
          45_000,
          `a missing-file report from the ${run}`,
        );
        tokens.push(String(session.artifact_load?.artifact_load_token || ""));
        assertOnlyMissing(session.artifact_failures);
        newestRevision = Math.max(...session.artifact_failures.map(revisionOf));
        const newest = session.artifact_failures.find((failure) => revisionOf(failure) === newestRevision);
        assert.match(newest.detail, /-own-files-loaded\.png$/, `the ${run} did not get every file beside it`);
      } finally {
        stopChrome(child);
        await exited;
      }
    }
  });
});

// The controls load under the real token, so a probe that errors proves the token mattered, not that
// such loads fail here anyway. The token-less entry (/artifact/<key>/index.html) is not probed: an
// element pointed at an HTML URL errors (or, as a frame, loads) whatever the status, so a page cannot
// tell its 409 from a 200; the server tests pin that 409.
browserTest("another page and a file from disk get no artifact file and no attachment", async (chrome) => {
  const files = {
    "plan.html": "<!doctype html><html><body><p>plan</p></body></html>",
    "assets/control.js": 'var CONTROL_GLOBAL = "loaded";\n',
  };
  await withServer(files, async (context) => {
    const { base, parent, openSession } = context;
    const key = await openSession("plan.html");
    const load = await beginLoad(base, key);
    const uploaded = await fetch(`${base}/api/${key}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", origin: base },
      body: PNG_2x1,
    }).then((res) => res.json());
    const id = uploaded.attachment.id;
    const token = encodeURIComponent(load.artifact_load_token);
    const probe = (tag, name, url) => {
      const handlers = `onload="hit('${name}','load')" onerror="hit('${name}','error')"`;
      if (tag === "link") return `<link rel="stylesheet" href="${url}" ${handlers}>`;
      if (tag === "script") return `<script src="${url}" ${handlers}></script>`;
      return `<img src="${url}" ${handlers}>`;
    };
    const attack = `<!doctype html><html><head><title>attack</title>
<script>window.probes = {}; function hit(name, outcome) { window.probes[name] = outcome; }</script>
${probe("link", "control-design", `${base}/design/daisyui-themes.css`)}
${probe("link", "style", `${base}/artifact/${key}/assets/style.css`)}
${probe("script", "script", `${base}/artifact/${key}/assets/data.js`)}
${probe("script", "script-forged", `${base}/artifact/${key}/forged-token/assets/data.js`)}
${probe("script", "control-script", `${base}/artifact/${key}/${token}/assets/control.js`)}
</head><body>
${probe("img", "img", `${base}/artifact/${key}/assets/img.png`)}
${probe("img", "img-forged", `${base}/artifact/${key}/forged-token/assets/img.png`)}
${probe("img", "control-token", `${base}/artifact/${key}/${token}/assets/img.png`)}
${probe("img", "attachment", `${base}/api/${key}/attachments/${id}`)}
<pre id="results"></pre>
<script>
addEventListener("load", () => {
  document.getElementById("results").textContent = JSON.stringify({
    ...window.probes,
    global: typeof ASSET_GLOBAL,
    controlGlobal: typeof CONTROL_GLOBAL,
  });
});
</script></body></html>`;
    const expected = {
      "control-design": "load",
      style: "error",
      script: "error",
      "script-forged": "error",
      "control-script": "load",
      img: "error",
      "img-forged": "error",
      "control-token": "load",
      attachment: "error",
      global: "undefined",
      controlGlobal: "string",
    };

    // Another local server: a different port on the same loopback address.
    const outside = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(attack);
    });
    await new Promise((resolve) => outside.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = /** @type {import("node:net").AddressInfo} */ (outside.address());
      const fromPort = await dumpChromeDom(
        chrome,
        path.join(parent, "profile-port"),
        `http://127.0.0.1:${address.port}/attack.html`,
        90_000,
      );
      assert.deepEqual(resultsFrom(fromPort), expected, "a page on another loopback port");
    } finally {
      await new Promise((resolve) => outside.close(resolve));
    }

    // An HTML file opened from disk.
    const attackFile = path.join(parent, "attack.html");
    await writeFile(attackFile, attack);
    const fromDisk = await dumpChromeDom(
      chrome,
      path.join(parent, "profile-file"),
      pathToFileURL(attackFile).href,
      90_000,
    );
    assert.deepEqual(resultsFrom(fromDisk), expected, "an HTML file opened from disk");
  });
});
