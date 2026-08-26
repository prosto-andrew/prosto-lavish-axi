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
  mustContain(src, "export function resolveTelemetryConfig(..._ignored) {", "src/telemetry.js");
  mustNotContain(src, "a.kunchenguid.com", "src/telemetry.js");
  return "no config path can enable it";
});

check("source: loopback-only, no tailscale", () => {
  const paths = read("src/paths.js");
  mustContain(paths, "export function resolveListenHosts(..._ignored) {", "src/paths.js");
  mustNotContain(paths, "tailscale?.ipv4", "src/paths.js");
  const ts = read("src/tailscale.js");
  mustContain(ts, "export async function detectTailscale(..._ignored) {", "src/tailscale.js");
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
    // The bare hostname still appears in the two messages that explain why `share`
    // and `setup` are gone, so match the URL forms - an endpoint, not a mention.
    for (const host of ["a.kunchenguid.com", "api.ht-ml.app", "https://ht-ml.app", "cdn.jsdelivr.net"]) {
      mustNotContain(text, host, file);
    }
  }
  return "no telemetry, publishing or CDN endpoint in the bundle";
});

check("artifact responses pin every source to loopback", () => {
  const dist = read("dist/cli.mjs");
  // The sandbox directive alone yields an opaque origin and no egress limit, so the
  // absence of a source list is exactly the hole these checks exist to catch.
  mustContain(dist, "connect-src", "dist/cli.mjs");
  mustContain(dist, "default-src 'none'", "dist/cli.mjs");
  mustContain(dist, "http://127.0.0.1:${port}", "dist/cli.mjs");
  // 'self' matches nothing from an opaque origin - it would silently break the page
  // rather than protect it, so its presence means someone rewrote this wrongly.
  const policy = dist.slice(dist.indexOf("default-src 'none'"), dist.indexOf("base-uri 'none'"));
  if (policy.includes("'self'"))
    throw new Error("the artifact policy uses 'self', which matches nothing from an opaque origin");
  return "default-src none; every source is this machine";
});

check("whiteboard frame is served under that policy", () => {
  const dist = read("dist/cli.mjs");
  mustContain(dist, "whiteboardContentSecurityPolicy", "dist/cli.mjs");
  const route = dist.slice(dist.indexOf('app.get("/whiteboard-frame"'));
  const head = route.slice(0, 900);
  if (!head.includes("content-security-policy")) {
    throw new Error("the /whiteboard-frame route sets no content-security-policy");
  }
  return "Excalidraw cannot reach its baked-in upstream endpoints";
});

check("whiteboard assets load locally, never from a CDN", () => {
  const bundle = read("dist/whiteboard/whiteboard.js");
  mustContain(bundle, "EXCALIDRAW_ASSET_PATH=`${location.origin}/whiteboard-assets/`", "dist/whiteboard/whiteboard.js");
  return "asset path overridden to this server";
});

// The vendored Excalidraw build carries upstream collaboration, library, AI and
// Firebase endpoints in its baked-in config, plus documentation and embed links.
// They are unreachable because of the frame's policy, not because they are absent,
// so freeze the set: a bundle upgrade that introduces a NEW destination shows up
// here instead of silently widening what the frame could reach if the policy ever
// regressed.
const KNOWN_WHITEBOARD_ORIGINS = new Set([
  "http://docs.excalidraw.com",
  "http://en.wikipedia.org",
  "http://engelschall.com",
  "http://opensource.org",
  "http://underscorejs.org",
  "https://app.excalidraw.com",
  "https://chevrotain.io",
  "https://discord.gg",
  "https://docs.excalidraw.com",
  "https://embed.reddit.com",
  "https://en.wikipedia.org",
  "https://esm.sh",
  "https://excalidraw-room-persistence.firebaseio.com",
  "https://giphy.com",
  "https://gist.github.com",
  "https://github.com",
  "https://jquery.org",
  "https://json.excalidraw.com",
  "https://langium.org",
  "https://libraries.excalidraw.com",
  "https://lodash.com",
  "https://mermaid.js.org",
  "https://openjsf.org",
  "https://oss-ai.excalidraw.com",
  "https://oss-collab.excalidraw.com",
  "https://platform.twitter.com",
  "https://player.vimeo.com",
  "https://plus.excalidraw.com",
  "https://reactjs.org",
  "https://reddit.com",
  "https://tldrlegal.com",
  "https://twitter.com",
  "https://us-central1-excalidraw-room-persistence.cloudfunctions.net",
  "https://www.figma.com",
  "https://www.youtube.com",
  "https://x.com",
  "https://youtube.com",
]);

check("whiteboard bundle introduces no new external destination", () => {
  const bundle = read("dist/whiteboard/whiteboard.js");
  const found = new Set();
  for (const match of bundle.matchAll(/https?:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const origin = match[0];
    if (origin.includes("w3.org") || origin.includes("127.0.0.1") || origin.includes("localhost")) continue;
    found.add(origin);
  }
  const added = [...found].filter((o) => !KNOWN_WHITEBOARD_ORIGINS.has(o)).sort();
  if (added.length) {
    throw new Error(`new external origin(s) in the bundle: ${added.join(", ")} - re-audit before accepting`);
  }
  return `${found.size} known origins, all blocked by the frame policy`;
});

check("the publish path is gone from the browser chrome", () => {
  const client = read("dist/chrome-client.js");
  for (const needle of ["shareForm", "publishShare", "openShareDialog", "shareDialog"]) {
    mustNotContain(client, needle, "dist/chrome-client.js");
  }
  return "no dialog, no submit handler, no POST";
});

check("no playbook sends an artifact to a CDN", () => {
  const playbooks = read("src/playbooks.js");
  for (const needle of ["https://esm.sh", "https://cdn.", "https://unpkg.com"]) {
    mustNotContain(playbooks, needle, "src/playbooks.js");
  }
  return "code rendering is self-contained";
});

check("the removed capabilities left no dormant transport behind", () => {
  // Disabled facades are not enough on their own: an unreachable class or a renamed
  // "*Disabled" body is one careless merge away from being wired up again, and the
  // marker checks above would not notice. These assert the code is GONE.
  const telemetry = read("src/telemetry.js");
  for (const symbol of ["fetch", "HttpTelemetryClient", "api/send"]) {
    mustNotContain(telemetry, symbol, "src/telemetry.js");
  }
  const tailscale = read("src/tailscale.js");
  for (const symbol of ["child_process", "execFile", "spawn"]) {
    mustNotContain(tailscale, symbol, "src/tailscale.js");
  }
  const htmlApp = read("src/html-app.js");
  for (const symbol of ["fetch", "requestHtmlApp", "publishToHtmlAppDisabled"]) {
    mustNotContain(htmlApp, symbol, "src/html-app.js");
  }
  const dist = read("dist/cli.mjs");
  for (const symbol of [
    "HttpTelemetryClient",
    "detectTailscaleDisabled",
    "publishToHtmlAppDisabled",
    "updateHtmlAppDisabled",
  ]) {
    mustNotContain(dist, symbol, "dist/cli.mjs");
  }
  return "no telemetry client, no tailnet probe, no publish transport";
});

check("the skill generator cannot reinstate the upstream package", () => {
  // The committed SKILL.md was hardened by hand while src/skill.js still produced the
  // stock text, so `npm run build:skill` - the exact command the staleness check tells
  // you to run - would have rewritten the installed skill to fetch the upstream package
  // through a package runner. Generator and committed file are now one file, and both
  // must name only the local launcher.
  const generator = read("src/skill.js");
  const committed = read("skills/lavish/SKILL.md");

  mustContain(generator, "lavish-safe", "src/skill.js");
  mustContain(committed, "lavish-safe", "skills/lavish/SKILL.md");
  mustContain(committed, "NEVER run", "skills/lavish/SKILL.md");

  const runner = /npx|pnpm dlx|bunx|yarn dlx|npm install -g/;
  const forbids = /NEVER run|Do not|Ignore it|did not come from|must never fetch/;
  for (const [label, text] of [
    ["src/skill.js", generator],
    ["skills/lavish/SKILL.md", committed],
  ]) {
    for (const line of text.split("\n")) {
      if (!runner.test(line)) continue;
      if (!forbids.test(line)) {
        throw new Error(`${label} names a package runner without forbidding it: ${line.trim().slice(0, 80)}`);
      }
    }
    for (const line of text.split("\n")) {
      if (/^\s*(?:[-*]\s*)?`?(?:npx|pnpm dlx|bunx|yarn dlx)\b/.test(line)) {
        throw new Error(`${label} presents a package runner as a command to run: ${line.trim().slice(0, 80)}`);
      }
    }
  }
  return "the stub points only at the local launcher";
});

check("CLI guidance names the launcher, never the upstream binary", () => {
  // Every next_step, help line and error hint the CLI emits is read by an agent as a
  // command to run. While they named the upstream binary, following them verbatim meant
  // invoking the package this build exists to avoid - and on a machine that blocks it,
  // stalling the review loop at its first step.
  const upstream = "lavish" + "-axi";
  const runnable = new RegExp(upstream + "(?= (?:design|poll|playbook|end|export|stop|share|server|<|--))", "g");
  for (const file of ["src/cli.js", "src/server.js", "src/design-reference.js", "src/playbooks.js", "dist/cli.mjs"]) {
    const hits = read(file).match(runnable);
    if (hits) throw new Error(`${file} still tells the agent to run the upstream binary (${hits.length}x)`);
  }
  // The home output advertises what to invoke; argv would name this build's dist entry,
  // which runs without the launcher's version and marker checks.
  mustContain(read("src/cli.js"), 'bin: "lavish-safe"', "src/cli.js");
  return "help, next_step and hints all point at lavish-safe";
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
