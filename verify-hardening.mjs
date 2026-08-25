#!/usr/bin/env node
// Verify that this lavish-axi checkout is the hardened build and that the
// compiled output actually carries the hardening. Run from the checkout root:
//   node verify-hardening.mjs
// Exit code 0 = all checks pass, 1 = something is wrong (details printed).

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Locate the checkout from this file's own location, not the shell's cwd, so the
// verifier checks the tree it belongs to no matter where it is invoked from.
const root = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i += 1) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
})();
const results = [];
let failed = 0;

function check(name, fn) {
  try {
    const detail = fn();
    results.push(["PASS", name, detail || ""]);
  } catch (error) {
    failed += 1;
    results.push(["FAIL", name, error.message]);
  }
}

function read(rel) {
  const p = path.join(root, rel);
  if (!existsSync(p)) throw new Error(`missing file: ${rel}`);
  return readFileSync(p, "utf8");
}

function mustNotContain(text, needle, where) {
  if (text.includes(needle)) throw new Error(`${where} still contains ${needle}`);
}

function mustContain(text, needle, where) {
  if (!text.includes(needle)) throw new Error(`${where} does not contain ${needle}`);
}

check("checkout is the audited version 0.1.62", () => {
  const pkg = JSON.parse(read("package.json"));
  if (pkg.version !== "0.1.62") throw new Error(`version is ${pkg.version}, expected 0.1.62`);
  return "0.1.62";
});

check("source: telemetry permanently disabled", () => {
  const src = read("src/telemetry.js");
  mustContain(src, "export function resolveTelemetryConfig() {", "src/telemetry.js");
  mustNotContain(src, "a.kunchenguid.com", "src/telemetry.js");
  return "no config path can enable it";
});

check("source: loopback-only, no tailscale", () => {
  const paths = read("src/paths.js");
  mustContain(paths, "export function resolveListenHosts() {", "src/paths.js");
  mustNotContain(paths, "tailscale?.ipv4", "src/paths.js");
  const ts = read("src/tailscale.js");
  mustContain(ts, "export async function detectTailscale() {", "src/tailscale.js");
  return "127.0.0.1 only; tailscale never probed";
});

check("source: publishing removed", () => {
  const cli = read("src/cli.js");
  mustContain(cli, 'share: disabledCommand("share")', "src/cli.js");
  const app = read("src/html-app.js");
  mustContain(app, "publishing is disabled in this hardened build", "src/html-app.js");
  mustNotContain(app, "https://api.ht-ml.app", "src/html-app.js");
  const server = read("src/server.js");
  mustContain(server, "publishing is disabled in this hardened build", "src/server.js");
  const chrome = read("src/chrome-client.js");
  mustNotContain(chrome, "shareArtifactButton.onclick = openShareDialog;", "src/chrome-client.js");
  return "CLI, HTTP route, browser action and network layer";
});

check("source: setup / hook installation removed", () => {
  const cli = read("src/cli.js");
  mustContain(cli, 'setup: disabledCommand("setup")', "src/cli.js");
  return "no persistent hooks or plugin registration";
});

check("source: assets served locally, not from a CDN", () => {
  const design = read("src/design-reference.js");
  mustNotContain(design, "cdn.jsdelivr.net", "src/design-reference.js");
  mustContain(design, '"/design/mermaid/mermaid.esm.min.mjs"', "src/design-reference.js");
  return "tailwind, daisyui and mermaid come from the local server";
});

check("build exists and is newer than the sources", () => {
  const entry = path.join(root, "dist/cli.mjs");
  if (!existsSync(entry)) throw new Error("dist/cli.mjs missing - run `npm install` once to build");
  const built = statSync(entry).mtimeMs;
  const newest = ["src/cli.js", "src/server.js", "src/telemetry.js", "src/paths.js", "src/design-reference.js"]
    .map((f) => statSync(path.join(root, f)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
  if (built < newest) throw new Error("dist/cli.mjs is older than the patched sources - run `npm run build`");
  return "dist/cli.mjs is up to date";
});

check("build carries the hardening markers", () => {
  const dist = read("dist/cli.mjs");
  mustContain(dist, "LAVISH-HARDENED", "dist/cli.mjs");
  return "markers present";
});

check("build reaches no external host", () => {
  for (const file of ["dist/cli.mjs", "dist/chrome-client.js"]) {
    const text = read(file);
    for (const host of ["a.kunchenguid.com", "api.ht-ml.app", "cdn.jsdelivr.net"]) {
      mustNotContain(text, host, file);
    }
  }
  return "no telemetry, publishing or CDN endpoint in the bundle";
});

check("mermaid is vendored for offline rendering", () => {
  const mod = path.join(root, "dist/design/mermaid/mermaid.esm.min.mjs");
  const chunks = path.join(root, "dist/design/mermaid/chunks/mermaid.esm.min");
  if (!existsSync(mod)) throw new Error("dist/design/mermaid/mermaid.esm.min.mjs missing - run `npm run build`");
  if (!existsSync(chunks)) throw new Error("mermaid chunk directory missing - run `npm run build`");
  return "module and chunk graph present";
});

const width = Math.max(...results.map(([, name]) => name.length));
for (const [status, name, detail] of results) {
  const mark = status === "PASS" ? "  ok  " : " FAIL ";
  console.log(`${mark} ${name.padEnd(width)}  ${detail}`);
}
console.log("");
if (failed) {
  console.log(`${failed} check(s) FAILED - do not use this build until they pass.`);
  process.exit(1);
}
console.log(`All ${results.length} checks passed. This build is hardened.`);
