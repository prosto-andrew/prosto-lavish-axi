import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { serve } from "../src/server.js";

// LAVISH-HARDENED: the review chrome is a same-origin page that shows artifact-chosen content
// (its tab icon) and frames the artifact, so its own policy decides what it may fetch and where
// that frame may go. Only a real browser can judge a policy: a header with a wrong script hash
// or one that forgets the live-event WebSocket passes every Node-side test and leaves the chrome
// dead. Opt-in like the other real-browser suites:
//   LAVISH_AXI_BROWSER_E2E=1 CHROME_PATH=/path/to/chrome node --test test/chrome-csp.browser.test.js
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";

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

// A second loopback server on its own port is another origin, so it stands in for the internet:
// every request that reaches it is one the review page let out.
async function startOutside() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.end("");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    hits,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Dumps the chrome page's DOM once Chrome considers it settled, keeping Chrome's own log, which
// carries every "Refused to ... Content Security Policy" console message from the page.
function dumpChromeDom(chrome, profileDir, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--no-first-run",
        `--user-data-dir=${profileDir}`,
        "--enable-logging=stderr",
        "--log-level=0",
        "--virtual-time-budget=20000",
        "--dump-dom",
        url,
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      if (error) reject(error);
      else resolve({ dom: stdout, log: stderr });
    };
    const timer = setTimeout(() => finish(new Error(`Chrome did not dump the DOM in time\n${stderr}`)), timeoutMs);
    child.on("error", finish);
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`Chrome exited before dumping the DOM (${code})\n${stderr}`));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 1024 * 1024) stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("</html>")) finish();
    });
  });
}

// Chrome logs each refusal in the console of the document that made the request, quoting the
// directive that refused it, and one log entry can span several lines.
function policyRefusals(log) {
  return log.split(/\r?\n(?=\[\d+:\d+:)/).filter((entry) => /Content Security Policy/.test(entry));
}

// The chrome's own requests are logged from the chrome page or from chrome-client.js, whichever
// made them. The artifact frame logs its own policy's refusals too - such as the icon link this
// test puts in the artifact's <head> - and those say nothing about the chrome's policy.
function chromePageRefusals(log) {
  return policyRefusals(log).filter((entry) => !/source: \S+\/artifact\//.test(entry));
}

async function openReview(chrome, dir, base, file, name) {
  const { key } = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  }).then((res) => res.json());
  return dumpChromeDom(chrome, path.join(dir, `profile-${name}`), `${base}/session/${key}`, 90_000);
}

test(
  "the review chrome boots under its policy and lets nothing reach another origin",
  { skip: !runBrowserE2e, timeout: 240_000 },
  async (t) => {
    const chrome = await chromePath();
    if (!chrome) {
      t.skip("Chrome or Chromium is required (set CHROME_PATH)");
      return;
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-chrome-csp-"));
    const outside = await startOutside();
    const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      // An artifact naming a tab icon on another origin: the chrome adopts artifact icons.
      const iconic = path.join(dir, "iconic.html");
      await writeFile(
        iconic,
        `<!doctype html><html><head><title>iconic</title><link rel="icon" href="${outside.origin}/favicon.ico"></head><body><p>iconic artifact</p></body></html>`,
      );
      const booted = await openReview(chrome, dir, base, iconic, "iconic");
      assert.deepEqual(outside.hits, [], "the review page fetched from another origin");
      assert.deepEqual(chromePageRefusals(booted.log), [], "the policy refused one of the chrome's own resources");
      // chrome-client.js is what moves data-artifact-src into src, and the inline boot failsafe
      // is what would retitle the gate had that script not run to completion.
      assert.match(
        booted.dom,
        /<iframe id="artifact"[^>]*\ssrc="\/artifact\//,
        "chrome-client.js never loaded the artifact",
      );
      const gateTitle = /id="layoutGateTitle">([^<]*)/.exec(booted.dom)?.[1] ?? "";
      assert.doesNotMatch(gateTitle, /could not finish loading/, "chrome-client.js never finished booting");

      // An artifact that walks its own frame to another origin as soon as it runs. Only the
      // chrome's frame-src can stop it: the artifact's own policy has no say over where its
      // frame navigates. The refusal is logged from the artifact, which started the navigation,
      // and names the chrome's directive.
      const roaming = path.join(dir, "roaming.html");
      await writeFile(
        roaming,
        `<!doctype html><html><head><title>roaming</title></head><body><p>roaming artifact</p><script>location.href = "${outside.origin}/navigated";</script></body></html>`,
      );
      const roamed = await openReview(chrome, dir, base, roaming, "roaming");
      assert.deepEqual(outside.hits, [], "the artifact frame navigated to another origin");
      const refusals = policyRefusals(roamed.log);
      assert.ok(
        refusals.some((entry) => entry.includes(`"frame-src 'self'"`) && entry.includes(outside.origin)),
        `the frame navigation was not refused by the chrome's frame-src\n${refusals.join("\n")}`,
      );
    } finally {
      await server.close();
      await outside.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);
