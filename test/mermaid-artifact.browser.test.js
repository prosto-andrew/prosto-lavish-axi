import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse } from "parse5";

import { MERMAID_CDN_SNIPPET } from "../src/design-reference.js";
import { defaultMermaidAssetsDir, serve } from "../src/server.js";

// The design snippet imports the vendored Mermaid module from inside the artifact,
// whose document is opaque-origin (the response-level CSP sandbox, like the iframe's,
// has no allow-same-origin). Module scripts and every chunk they import are CORS-mode
// fetches, so a route that forgets Access-Control-Allow-Origin passes every Node-side
// test while real Chromium blocks the import and no diagram, and no inline whiteboard,
// ever appears. Opt-in like the other real-browser suites:
//   LAVISH_AXI_BROWSER_E2E=1 CHROME_PATH=/path/to/chrome node --test test/mermaid-artifact.browser.test.js
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
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

// The built copy when `pnpm run build` has run, otherwise the identical files the build
// copies it from, so the suite does not depend on build order.
function mermaidAssetsDir() {
  const built = defaultMermaidAssetsDir();
  if (existsSync(path.join(built, "mermaid.esm.min.mjs"))) return built;
  return path.join(projectRoot, "node_modules/mermaid/dist");
}

// Dumps the DOM once Chrome considers the page settled, and keeps Chrome's own log
// (which carries console messages such as a CORS block) for the failure message.
function dumpChromeDom(chrome, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
      if (stderr.length < 256 * 1024) stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) {
        finish(new Error("Chrome DOM dump exceeded 8 MB"));
      } else if (stdout.includes("</html>")) {
        finish();
      }
    });
  });
}

function elements(node, predicate, found = []) {
  if (node.nodeName && predicate(node)) found.push(node);
  for (const child of node.childNodes || []) elements(child, predicate, found);
  return found;
}

function hasClass(node, name) {
  const value = node.attrs?.find((attr) => attr.name === "class")?.value || "";
  return value.split(/\s+/).includes(name);
}

test(
  "the design snippet renders vendored Mermaid inside the opaque-origin artifact",
  { skip: !runBrowserE2e, timeout: 120_000 },
  async (t) => {
    const chrome = await chromePath();
    if (!chrome) {
      t.skip("Chrome or Chromium is required (set CHROME_PATH)");
      return;
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-mermaid-artifact-"));
    await mkdir(path.join(dir, "state"));
    const server = await serve({
      port: 0,
      stateFile: path.join(dir, "state", "state.json"),
      version: "9.9.9-test",
      mermaidAssetsDir: mermaidAssetsDir(),
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const artifact = path.join(dir, "artifact.html");
      await writeFile(artifact, "<!doctype html><html><body><p>session artifact</p></body></html>");
      // A sibling page is served by the same /artifact/* route and CSP sandbox, without
      // needing the chrome's artifact_load_token handoff or the injected SDK.
      await writeFile(
        path.join(dir, "diagram.html"),
        `<!doctype html><html><head><meta charset="utf-8"><title>mermaid</title></head><body>
<pre class="mermaid">flowchart TD
  A[Agent writes artifact] --> B[Reviewer opens it]</pre>
${MERMAID_CDN_SNIPPET}
</body></html>`,
      );
      const opened = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: artifact }),
      }).then((res) => res.json());
      const url = `${base}/artifact/${opened.key}/diagram.html`;

      // Without the sandbox the page would be same-origin and the test would prove nothing.
      const head = await fetch(url);
      assert.equal(head.status, 200);
      const csp = head.headers.get("content-security-policy") || "";
      assert.match(csp, /(^|;\s*)sandbox allow-scripts/);
      assert.doesNotMatch(csp, /allow-same-origin/);
      await head.arrayBuffer();

      const { dom, log } = await dumpChromeDom(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${path.join(dir, "chrome-profile")}`,
          "--enable-logging=stderr",
          "--log-level=0",
          "--run-all-compositor-stages-before-draw",
          "--virtual-time-budget=20000",
          "--dump-dom",
          url,
        ],
        90_000,
      );
      const consoleLines = log
        .split("\n")
        .filter((line) => /CORS|blocked|error|failed/i.test(line))
        .join("\n");
      const diagrams = elements(parse(dom), (node) => node.nodeName === "pre" && hasClass(node, "mermaid"));
      assert.equal(diagrams.length, 1, `the diagram container is missing from the dump\n${consoleLines}`);
      const svgs = elements(diagrams[0], (node) => node.nodeName === "svg");
      assert.ok(svgs.length >= 1, `Mermaid did not render an SVG in the artifact\n${consoleLines}`);
      assert.doesNotMatch(consoleLines, /has been blocked by CORS policy/);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
