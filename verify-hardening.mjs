#!/usr/bin/env node
// Verify that this lavish-axi checkout is the hardened build and that the
// compiled output actually carries the hardening. Run from the checkout root:
//   node verify-hardening.mjs
// Exit code 0 = all checks pass, 1 = something is wrong (details printed).
// The launchers run it with --quiet before every start: nothing is printed when
// every check passes, and only the failed checks when one does not.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
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

function mustNotExist(rel) {
  if (existsSync(path.join(root, rel))) throw new Error(`${rel} still exists`);
}

// The upstream release this tree was last merged from and audited against. The launchers
// defer to this pin through --quiet. Bump it only after re-running every check.
const AUDITED_VERSION = "0.1.85";

check(`checkout is the audited version ${AUDITED_VERSION}`, () => {
  const pkg = JSON.parse(read("package.json"));
  if (pkg.version !== AUDITED_VERSION) throw new Error(`version is ${pkg.version}, expected ${AUDITED_VERSION}`);
  return AUDITED_VERSION;
});

check("source: telemetry permanently disabled", () => {
  const src = read("src/telemetry.js");
  mustContain(src, "export function resolveTelemetryConfig(..._ignored) {", "src/telemetry.js");
  mustNotContain(src, "a.kunchenguid.com", "src/telemetry.js");
  // The build no longer injects an analytics site for the removed client to report to.
  mustNotContain(read("scripts/build.js"), "UMAMI", "scripts/build.js");
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
  // Only the refusals stay. The request parsing, password minting, output builders and payload
  // helpers behind them are deleted, not left unreachable for a merge to wire up again.
  mustNotExist("src/share-password.js");
  for (const needle of [
    'from "./html-app.js"',
    'from "./share-password.js"',
    "resolveShareRequest",
    "createShareOutput",
    "createShareUpdateOutput",
    "createShareUnpublishOutput",
  ]) {
    mustNotContain(cli, needle, "src/cli.js");
  }
  for (const needle of [
    "htmlAppApiUrl",
    "LAVISH_AXI_HTML_APP_API_URL",
    "createHtmlAppPayload",
    "createHtmlAppUpdatePayload",
    "normalizeSiteId",
    "createUnpublishedPageHtml",
    "hostRejectedShareWrite",
    "htmlAppIncompleteResponseError",
    "publishedDespiteError",
  ]) {
    mustNotContain(app, needle, "src/html-app.js");
  }
  mustNotContain(server, "globe: chromeIcon(", "src/server.js");
  const dist = read("dist/cli.mjs");
  for (const needle of ["createShareOutput", "generateSharePassword", "normalizeSiteId"]) {
    mustNotContain(dist, needle, "dist/cli.mjs");
  }
  return "CLI, HTTP route, browser action and network layer; only the refusals remain";
});

check("source: setup / hook installation removed", () => {
  const cli = read("src/cli.js");
  mustContain(cli, 'setup: disabledCommand("setup")', "src/cli.js");
  // plugin.js keeps only the manifest builders scripts/build-plugin.js needs; the client
  // registration helpers and the process spawner they used are deleted.
  mustNotContain(cli, 'from "./plugin.js"', "src/cli.js");
  const plugin = read("src/plugin.js");
  for (const needle of [
    "cross-spawn",
    "spawnPluginClientSync",
    "resolvePluginRoot",
    "readPluginManifest",
    "isStalePluginLocation",
    "computeVsCodePluginLocationsUpdate",
    "resolveVsCodeSettingsFile",
    "resolveCursorLocalPluginsDir",
    "writeTextFileAtomically",
    "linkCursorLocalPlugin",
  ]) {
    mustNotContain(plugin, needle, "src/plugin.js");
  }
  mustNotContain(read("dist/cli.mjs"), "cross-spawn", "dist/cli.mjs");
  return "no persistent hooks or plugin registration, and no code left to do either";
});

check("self-update is refused before it reaches the npm registry", () => {
  // `update` is an axi-sdk-js built-in that runs whenever the tool registers no handler of
  // its own: it fetches the registry and recommends installing the upstream package. The SDK
  // stays an external import, so the bundle scans below never see that code - only the
  // shadowing handler keeps it from running.
  for (const file of ["src/cli.js", "dist/cli.mjs"]) {
    mustContain(read(file), 'update: disabledCommand("update")', file);
  }
  return "the SDK self-updater is shadowed by a refusal";
});

check("source: assets served locally, not from a CDN", () => {
  const design = read("src/design-reference.js");
  mustNotContain(design, "cdn.jsdelivr.net", "src/design-reference.js");
  mustContain(design, '"/design/mermaid/mermaid.esm.min.mjs"', "src/design-reference.js");
  return "tailwind, daisyui and mermaid come from the local server";
});

const REBUILD = "run `npx --yes pnpm@11.1.1 install --frozen-lockfile`";

function filesUnder(rel) {
  return readdirSync(path.join(root, rel), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
}

check("build exists and is newer than every build input", () => {
  // The launchers run dist/, so a `git pull` or an upstream merge that is not rebuilt would
  // otherwise keep running the previous build while the checkout claims to be the new one.
  // Every file the build reads counts, not a hand-picked few.
  const outputs = ["dist/cli.mjs", "dist/server.mjs"];
  for (const rel of outputs) {
    if (!existsSync(path.join(root, rel))) throw new Error(`${rel} missing - ${REBUILD} once to build`);
  }
  const built = Math.min(...outputs.map((rel) => statSync(path.join(root, rel)).mtimeMs));
  const inputs = [
    ...filesUnder("src"),
    ...filesUnder("bin"),
    ...filesUnder("scripts"),
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ];
  const newer = inputs.filter((rel) => statSync(path.join(root, rel)).mtimeMs > built);
  if (newer.length) {
    const more = newer.length > 3 ? ` and ${newer.length - 3} more` : "";
    throw new Error(`dist/ is older than ${newer.slice(0, 3).join(", ")}${more} - ${REBUILD}`);
  }
  return `dist/ is newer than all ${inputs.length} build inputs`;
});

// The supply-chain policy the install docs promise lives in pnpm-workspace.yaml. Every top-level
// key there must be one reviewed here: pnpm keeps adding exemptions (minimumReleaseAgeExclude,
// trustPolicyExclude, dangerouslyAllowAllBuilds, ...), and an unreviewed key could switch a promise
// off without touching the lines checked below. A new pnpm setting is added to this list only
// after deciding it weakens nothing.
const PNPM_WORKSPACE_KEYS = new Set([
  "packages",
  "trustPolicy",
  "blockExoticSubdeps",
  "minimumReleaseAge",
  "minimumReleaseAgeStrict",
  "onlyBuiltDependencies",
  "allowBuilds",
  "overrides",
]);
const MINIMUM_RELEASE_AGE_MINUTES = 7 * 24 * 60;

// No YAML parser is a dependency, so only the shapes the file is written in are read: a top-level
// `key: value`, or `key:` followed by indented lines. Anything else fails rather than being
// skipped, so the policy is never judged on half of the file.
function pnpmWorkspaceSettings() {
  const settings = new Map();
  let current = null;
  for (const line of read("pnpm-workspace.yaml").split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) {
      if (!current) throw new Error(`pnpm-workspace.yaml has an indented line before any key: ${line}`);
      current.items.push(line.trim());
      continue;
    }
    const match = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!match) throw new Error(`pnpm-workspace.yaml has an unrecognized line: ${line}`);
    const [, key, value = ""] = match;
    if (settings.has(key)) throw new Error(`pnpm-workspace.yaml sets ${key} twice`);
    current = { value: value.trim(), items: [] };
    settings.set(key, current);
  }
  return settings;
}

function checkPnpmSupplyChainPolicy() {
  const settings = pnpmWorkspaceSettings();
  const unreviewed = [...settings.keys()].filter((key) => !PNPM_WORKSPACE_KEYS.has(key));
  if (unreviewed.length) {
    throw new Error(`pnpm-workspace.yaml sets ${unreviewed.join(", ")}, which the supply-chain policy does not allow`);
  }
  const scalar = (key) => settings.get(key)?.value ?? "unset";
  const age = Number(scalar("minimumReleaseAge"));
  if (!Number.isInteger(age) || age < MINIMUM_RELEASE_AGE_MINUTES) {
    throw new Error(
      `pnpm-workspace.yaml minimumReleaseAge is ${scalar("minimumReleaseAge")}, expected at least ${MINIMUM_RELEASE_AGE_MINUTES} (7 days)`,
    );
  }
  for (const [key, expected] of [
    ["minimumReleaseAgeStrict", "true"],
    ["trustPolicy", "no-downgrade"],
    ["blockExoticSubdeps", "true"],
  ]) {
    if (scalar(key) !== expected) throw new Error(`pnpm-workspace.yaml ${key} is ${scalar(key)}, expected ${expected}`);
  }
  for (const [key, expected] of [
    ["onlyBuiltDependencies", "- esbuild"],
    ["allowBuilds", "esbuild: true"],
  ]) {
    const setting = settings.get(key);
    if (!setting || setting.value || setting.items.join("\n") !== expected) {
      throw new Error(`pnpm-workspace.yaml ${key} must allow install scripts for esbuild only`);
    }
  }
}

check("dependencies install through pnpm under the documented supply-chain policy", () => {
  // dist/ imports its dependencies from node_modules at run time. Only pnpm applies the
  // committed lockfile and the supply-chain policy in pnpm-workspace.yaml; `npm install` or
  // `npm update` re-resolves every range, and leaves its own lockfiles behind when it does.
  checkPnpmSupplyChainPolicy();
  if (!existsSync(path.join(root, "node_modules"))) throw new Error(`node_modules is missing - ${REBUILD}`);
  if (!existsSync(path.join(root, "node_modules/.modules.yaml"))) {
    throw new Error(`node_modules was not installed by pnpm - delete node_modules, then ${REBUILD}`);
  }
  for (const rel of ["package-lock.json", "node_modules/.package-lock.json"]) {
    if (existsSync(path.join(root, rel))) {
      throw new Error(
        `${rel} exists: npm rewrote this tree - delete node_modules, dist and package-lock.json, then ${REBUILD}`,
      );
    }
  }
  return "pnpm install, no npm lockfile; 7-day release age with no exemptions, no trust downgrade, esbuild-only builds";
});

check("the bundled CLI spawns the bundled server", () => {
  // Upstream spawned bin/lavish-axi-server.js whenever it existed, so the launchers' verified
  // dist/cli.mjs started a server that ran this checkout's src/ - unchecked by every dist
  // check here. The bundle must prefer the sibling dist/server.mjs.
  mustContain(
    read("src/cli.js"),
    'const bundledEntry = fileURLToPath(new URL("./server.mjs", moduleUrl));\n  if (existsSync(bundledEntry)) return bundledEntry;',
    "src/cli.js",
  );
  const bundled =
    /bundledEntry = fileURLToPath\d*\(new URL\("\.\/server\.mjs", moduleUrl\)\);\s*if \(existsSync\d*\(bundledEntry\)\) return bundledEntry;/;
  if (!bundled.test(read("dist/cli.mjs"))) throw new Error(`dist/cli.mjs does not prefer dist/server.mjs - ${REBUILD}`);
  return "the server runs the same verified bundle as the CLI";
});

// scripts/build.js opens both bundles with this line (after the hashbang), so the build says what
// it is on purpose rather than through whichever source comments survive bundling. The version
// ties the bundle to the audited checkout: a dist/ built from another version is caught even when
// its files are newer than every input.
const BUILD_BANNER = `// LAVISH-HARDENED build of lavish-axi ${AUDITED_VERSION}:`;

check("build carries the hardening markers", () => {
  for (const rel of ["dist/cli.mjs", "dist/server.mjs"]) {
    const head = read(rel).split(/\r?\n/, 2);
    if (!head.some((line) => line.startsWith(BUILD_BANNER))) {
      throw new Error(`${rel} does not open with "${BUILD_BANNER}" - ${REBUILD}`);
    }
  }
  return `both bundles open with the ${AUDITED_VERSION} banner`;
});

// Every literal URL origin in the code the server runs and the review page loads, each with why it
// is safe. A new destination fails the check whatever it is, instead of having to be guessed into a
// list of known-bad hosts. The scan reads http, https, ws and wss in any case, IP literals,
// bracketed IPv6 and dotless hosts. A host built at run time (`http://${host}:${port}`) is no
// literal and stays the job of the loopback and CSP checks, and so does a protocol-relative
// `//host`, which a scan cannot tell from a comment. A bare hostname is a mention, not an
// endpoint: the messages explaining why `share` and `setup` are gone still name theirs.
const KNOWN_BUILD_ORIGINS = new Map([
  ["http://127.0.0.1", "loopback, in the artifact policy's source list"],
  ["http://localhost", "loopback, in the artifact policy's source list"],
  ["http://lavish.local", "the base new URL() parses request paths against, never dialed"],
  ["http://www.w3.org", "the SVG namespace of the default favicon, never fetched"],
]);

function literalOrigins(text) {
  const origins = new Set();
  for (const match of text.matchAll(/\b(https?|wss?):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)/gi)) {
    origins.add(`${match[1]}://${match[2]}`.toLowerCase());
  }
  return origins;
}

check("build reaches no external host", () => {
  const found = new Set();
  for (const file of ["dist/cli.mjs", "dist/server.mjs", "dist/chrome-client.js", "dist/chrome.css"]) {
    for (const origin of literalOrigins(read(file))) found.add(origin);
  }
  const unknown = [...found].filter((origin) => !KNOWN_BUILD_ORIGINS.has(origin)).sort();
  if (unknown.length) {
    throw new Error(`external origin(s) in the build: ${unknown.join(", ")} - re-audit before accepting`);
  }
  return `${found.size} literal origins, all loopback or never dialed`;
});

check("artifact responses pin every source to loopback", () => {
  const dist = read("dist/cli.mjs");
  // The sandbox directive alone yields an opaque origin and no egress limit, so the
  // absence of a source list is exactly the hole these checks exist to catch.
  mustContain(dist, "connect-src", "dist/cli.mjs");
  mustContain(dist, "default-src 'none'", "dist/cli.mjs");
  mustContain(dist, "http://127.0.0.1:${port}", "dist/cli.mjs");
  // 'self' matches nothing from an opaque origin - it would silently break the page
  // rather than protect it, so its presence means someone rewrote this wrongly. Anchored on
  // the artifact's own directive list: the chrome page's policy, which rightly uses 'self',
  // is in the same bundle.
  const start = dist.indexOf("function artifactSourceDirectives(");
  if (start === -1) throw new Error(`dist/cli.mjs carries no artifact policy - ${REBUILD}`);
  const policy = dist.slice(start, dist.indexOf("base-uri 'none'", start));
  mustContain(policy, "default-src 'none'", "the artifact policy");
  if (policy.includes("'self'"))
    throw new Error("the artifact policy uses 'self', which matches nothing from an opaque origin");
  return "default-src none; every source is this machine";
});

check("the review chrome loads nothing from another origin", () => {
  // The chrome page adopts the artifact's tab icon and frames the artifact, whose own
  // navigations only the chrome's frame-src can stop. Its policy must fall back to nothing and
  // name no source beyond this server, and an adopted icon must never be a URL it fetches.
  for (const file of ["src/server.js", "dist/cli.mjs"]) {
    mustContain(read(file), "if (iconHref && /^data:/i.test(iconHref)) {", file);
  }
  const dist = read("dist/cli.mjs");
  const route = dist.slice(dist.indexOf('app.get("/session/:key"'));
  if (!route.slice(0, 3000).includes('"content-security-policy", CHROME_CONTENT_SECURITY_POLICY')) {
    throw new Error(`the /session/:key route does not send the chrome policy - ${REBUILD}`);
  }
  const start = dist.indexOf("CHROME_CONTENT_SECURITY_POLICY = [");
  if (start === -1) throw new Error(`dist/cli.mjs carries no chrome policy - ${REBUILD}`);
  const policy = dist.slice(start, dist.indexOf('].join("; ")', start));
  for (const directive of [
    "default-src 'none'",
    "connect-src 'self'",
    "frame-src 'self'",
    "img-src 'self' data: blob:",
    "frame-ancestors 'none'",
  ]) {
    mustContain(policy, directive, "the chrome policy");
  }
  for (const loose of ["http:", "https:", "ws:", "*", "'unsafe-inline'", "'unsafe-eval'"]) {
    if (policy.includes(loose)) throw new Error(`the chrome policy allows ${loose}`);
  }
  return "default-src none; every source is this server; data: icons only";
});

check("whiteboard frame is served under that policy and gets only plain library drawings", () => {
  const dist = read("dist/cli.mjs");
  mustContain(dist, "whiteboardContentSecurityPolicy", "dist/cli.mjs");
  const route = dist.slice(dist.indexOf('app.get("/whiteboard-frame"'));
  const head = route.slice(0, 900);
  if (!head.includes("content-security-policy")) {
    throw new Error("the /whiteboard-frame route sets no content-security-policy");
  }
  // An artifact popup escapes its own sandbox, so it can open /whiteboard-frame as a
  // top-level page at this server's origin, where the embedding iframe's sandbox
  // attribute does not apply. Only a sandbox directive in the response itself keeps
  // that document opaque, so the policy must lead with one that withholds the origin.
  const fn = dist.slice(dist.indexOf("function whiteboardContentSecurityPolicy("));
  const leading = /return \[([\w$]+),/.exec(fn.slice(0, fn.indexOf("}")))?.[1];
  const declaration = leading && new RegExp(`(?<![\\w$])${leading.replace(/\$/g, "\\$")} = "([^"]*)"`);
  const sandbox = declaration && declaration.exec(dist)?.[1];
  if (!sandbox || !sandbox.startsWith("sandbox ")) {
    throw new Error("the whiteboard frame policy carries no sandbox directive");
  }
  for (const token of ["allow-same-origin", "allow-popups-to-escape-sandbox"]) {
    if (sandbox.split(/\s+/).includes(token)) throw new Error(`the whiteboard frame sandbox grants ${token}`);
  }
  // Library items (.excalidrawlib files the user downloads) reach this frame as data, and
  // Excalidraw turns some element types into live content the policy above cannot hold: an
  // `iframe` element's customData.generationData.html becomes a srcdoc document whose WebRTC
  // reaches any host. The parser the server and CLI run keeps only plain drawing elements and drops
  // their customData and link.
  const plainLibraryDrawings = [
    /LIBRARY_ELEMENT_TYPES\d* = (?:\/\* @__PURE__ \*\/ )?new Set\(\["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text"\]\);/,
    /function libraryElements\d*\(elements\) \{\s*return liveElements\d*\(elements\)\s*\.filter\(\(element\) => LIBRARY_ELEMENT_TYPES\d*\.has\(element\.type\)\)\s*\.map\(\(element\) => \{\s*const plain = \{ \.\.\.element \};\s*delete plain\.customData;\s*delete plain\.link;\s*return plain;\s*\}\);\s*\}/,
    /const elements = libraryElements\d*\(item\?\.elements\);/,
  ];
  inOrder(
    read("src/whiteboard-libraries.js"),
    plainLibraryDrawings,
    "the library parser in src/whiteboard-libraries.js",
  );
  try {
    inOrder(dist, plainLibraryDrawings, "the library parser in dist/cli.mjs");
  } catch (error) {
    throw new Error(`${error.message} - ${REBUILD}`, { cause: error });
  }
  return `${sandbox}; Excalidraw cannot reach its baked-in upstream endpoints; library items are plain drawings`;
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

// The subcommands an agent or a reader could run: the CLI's own COMMANDS set, read from src/cli.js
// so that a command an upstream merge adds (0.1.85's `libraries`) is covered without editing a list
// here, plus the SDK-reserved `update`, which this build refuses.
function launcherSubcommands() {
  const set = /\nconst COMMANDS = new Set\(\[([^\]]*)\]\);/.exec(read("src/cli.js"))?.[1];
  const names = set ? [...set.matchAll(/"([^"]*)"/g)].map((match) => match[1]) : [];
  if (names.length === 0) {
    throw new Error("src/cli.js has no COMMANDS set, so the launcher-name checks cannot list the subcommands");
  }
  const odd = names.find((name) => !/^[a-z][a-z-]*$/.test(name));
  if (odd !== undefined) throw new Error(`src/cli.js COMMANDS holds ${JSON.stringify(odd)}, not a plain subcommand`);
  return [...names, "update"];
}

// The upstream binary run with a subcommand, a file argument (`<html-file>`) or a flag.
function upstreamRunPattern(flags) {
  return new RegExp(`${"lavish" + "-axi"}(?= (?:${[...launcherSubcommands(), "<", "--"].join("|")}))`, flags);
}

check("CLI guidance names the launcher, never the upstream binary", () => {
  // Every next_step, help line and error hint the CLI emits is read by an agent as a
  // command to run. While they named the upstream binary, following them verbatim meant
  // invoking the package this build exists to avoid - and on a machine that blocks it,
  // stalling the review loop at its first step.
  const runnable = upstreamRunPattern("g");
  for (const file of ["src/cli.js", "src/server.js", "src/design-reference.js", "src/playbooks.js", "dist/cli.mjs"]) {
    const hits = read(file).match(runnable);
    if (hits) throw new Error(`${file} still tells the agent to run the upstream binary (${hits.length}x)`);
  }
  // The home output advertises what to invoke; argv would name this build's dist entry,
  // which runs without the verifier the launcher runs first.
  mustContain(read("src/cli.js"), 'bin: "lavish-safe"', "src/cli.js");
  return "help, next_step and hints all point at lavish-safe";
});

check("user docs never send the reader to the upstream package", () => {
  // README's Quick Start told the reader to install the upstream skill, which runs the
  // unhardened package through a package runner, and its other sections installed that
  // package globally. These files come from upstream, so a merge can bring such text back.
  // A line that names the upstream package after a runner must be a warning against it.
  const upstream = "lavish" + "-axi";
  const fetches = new RegExp(
    `(?:\\b(?:npx|pnpm dlx|bunx|yarn dlx|npm (?:install|i) (?:-g|--global))\\b[^\\n]*\\b${upstream}\\b)` +
      `|skills add kunchenguid/${upstream}|git clone [^\\n]*kunchenguid/${upstream}`,
  );
  const startsWithRunner = /^\s*(?:[-*>]\s*)?`?(?:npx|pnpm dlx|bunx|yarn dlx|npm (?:install|i) (?:-g|--global))\b/;
  // The same subcommand shapes the CLI guidance check refuses: the upstream binary run with
  // a command, a file argument or a flag. docs/invariants.md keeps upstream's binary name
  // for its internals and says so, so only the reader-facing files are held to this.
  const runs = upstreamRunPattern("");
  const docs = readdirSync(path.join(root, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`);
  const hits = [];
  for (const file of ["README.md", "AGENTS.md", ...docs]) {
    read(file)
      .split("\n")
      .forEach((line, index) => {
        const fetchesUpstream = fetches.test(line);
        if (fetchesUpstream && (startsWithRunner.test(line) || !/\bnever\b/i.test(line))) {
          hits.push(`${file}:${index + 1} fetches the upstream package`);
        } else if (!file.startsWith("docs/") && runs.test(line)) {
          hits.push(`${file}:${index + 1} runs the upstream binary`);
        }
      });
  }
  if (hits.length) {
    throw new Error(`${hits.length} line(s) send the reader to the upstream package: ${hits.slice(0, 3).join("; ")}`);
  }
  return "README, AGENTS.md and docs/ name only the launcher";
});

check("server binds and dials loopback only after the upstream merge", () => {
  // Upstream 0.1.78 added `server --also-listen <host>`, host inheritance across server
  // replacements, and CLI discovery that dialed every local interface address. The flag is
  // now a refusal, and nothing may sweep interfaces or hand extra hosts to serve().
  const cli = read("src/cli.js");
  const server = read("src/server.js");
  mustContain(cli, "`--also-listen` is removed in this hardened build", "src/cli.js");
  mustContain(cli, "function serverCandidateHosts() {\n  return [LOOPBACK_HOST];\n}", "src/cli.js");
  for (const symbol of [
    "local-address",
    "localInterfaceAddresses",
    "inheritedListenHosts",
    "requiredServerHosts",
    "extraListenHosts",
    'push("--also-listen"',
    "networkInterfaces",
  ]) {
    mustNotContain(cli, symbol, "src/cli.js");
  }
  for (const symbol of ["extraListenHosts", "localInterfaceAddresses", "networkInterfaces"]) {
    mustNotContain(server, symbol, "src/server.js");
  }
  if (existsSync(path.join(root, "src/local-address.js"))) throw new Error("src/local-address.js is back");
  for (const file of ["dist/cli.mjs", "dist/server.mjs"]) {
    for (const symbol of ["localInterfaceAddresses", "inheritedListenHosts", "extraListenHosts"]) {
      mustNotContain(read(file), symbol, file);
    }
  }
  return "no --also-listen, no interface sweep, discovery probes 127.0.0.1";
});

check("no helper process is launched for notifications", () => {
  // Upstream 0.1.74 added an opt-in chime that spawned a `herdr` binary from PATH. Like the
  // deleted tailscale probe, this build launches no helper processes.
  for (const file of ["src/cli.js", "src/server.js", "dist/cli.mjs", "dist/server.mjs"]) {
    if (/herdr/i.test(read(file))) throw new Error(`${file} still references herdr`);
  }
  mustNotContain(read("src/server.js"), "Lavish-Poll-State", "src/server.js");
  return "no herdr hook";
});

check("live-event WebSocket upgrades require this server's own Origin", () => {
  // The WebSocket transport (upstream 0.1.65) is not covered by CORS, so the Host allowlist
  // alone would let any page that learned a session key read its live events.
  const server = read("src/server.js");
  mustContain(server, "function handleEventUpgrade(req, socket, head) {", "src/server.js");
  mustContain(
    server,
    "if (!hostAllowed || !req.headers.origin || !isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {",
    "src/server.js",
  );
  return "Host allowlist plus exact Origin";
});

check("the Host allowlist cannot be switched off", () => {
  // Upstream let a lone "*" in LAVISH_AXI_ALLOWED_HOSTS drop the DNS-rebinding guard. This server
  // listens on loopback only, so "*" admitted no legitimate client: it only let a page on an
  // attacker's hostname, same-origin to itself, send the CLI's poll header and read live events.
  const stub = /\nexport function allowsAllHosts\(\.\.\._ignored\) \{\n {2}return false;\n\}\n/;
  if (!stub.test(read("src/server.js"))) throw new Error("src/server.js allowsAllHosts can opt out of the allowlist");
  mustNotContain(read("src/paths.js"), "disables the guard", "src/paths.js");
  if (!/function allowsAllHosts\d*\(\.\.\._ignored\d*\) \{\s*return false;\s*\}/.test(read("dist/cli.mjs"))) {
    throw new Error(`dist/cli.mjs allowsAllHosts can opt out of the allowlist - ${REBUILD}`);
  }
  return 'LAVISH_AXI_ALLOWED_HOSTS="*" is ignored';
});

check("state-changing GETs need proof", () => {
  // A foreign page can make the browser send any GET here with no Origin or Referer (an <img>, a
  // hidden <iframe>), so the poll must demand the CLI's header before it claims or takes feedback,
  // and the review page must not mint the reviewer handoff that displaces the open tab.
  const server = read("src/server.js");
  mustContain(server, "    if (req.get(LAVISH_CLIENT_HEADER) !== LAVISH_CLIENT_CLI) {", "src/server.js");
  const sessionRoute = server.indexOf('app.get("/session/:key"');
  if (sessionRoute < 0) throw new Error("src/server.js has no GET /session/:key route");
  const nextRoute = server.indexOf("\n  app.", sessionRoute);
  const sessionHandler = server.slice(sessionRoute, nextRoute < 0 ? undefined : nextRoute);
  mustNotContain(sessionHandler, "issueReviewerHandoff", "the GET /session/:key handler");
  // dist/server.mjs is only the bootstrap that imports dist/cli.mjs, so both halves live there.
  const dist = read("dist/cli.mjs");
  if (!/if \(req\.get\(LAVISH_CLIENT_HEADER\d*\) !== LAVISH_CLIENT_CLI\d*\) \{/.test(dist)) {
    throw new Error(`dist/cli.mjs does not refuse a poll without the CLI header - ${REBUILD}`);
  }
  // Both poll requests, the plain GET and the reply/takeover POST.
  const getPoll = /: \{ headers: \{ \[LAVISH_CLIENT_HEADER\d*\]: LAVISH_CLIENT_CLI\d* \} \};/;
  const postPoll =
    /headers: \{ "content-type": "application\/json", \[LAVISH_CLIENT_HEADER\d*\]: LAVISH_CLIENT_CLI\d* \}/;
  if (!getPoll.test(dist) || !postPoll.test(dist)) {
    throw new Error(`dist/cli.mjs does not send the CLI header on every poll - ${REBUILD}`);
  }
  return "poll needs the CLI header; the review page mints no handoff";
});

// Each piece must appear in `text`, in this order. A string is matched verbatim, a RegExp across
// whitespace. `label` names the code in the error.
function inOrder(text, pieces, label) {
  let at = 0;
  for (const piece of pieces) {
    const found = typeof piece === "string" ? { index: text.indexOf(piece, at), length: piece.length } : null;
    const match = found ? null : piece.exec(text.slice(at));
    const index = found ? found.index : match ? at + match.index : -1;
    if (index < 0) throw new Error(`${label} lost or reordered ${String(piece).split("\n")[0]}`);
    at = index + (found ? found.length : match[0].length);
  }
}

// The text of the `app.get(<route>, ...)` handler in `source`, up to the next route.
function handlerAt(source, route, file = "src/server.js") {
  const at = source.indexOf(`app.get(${route},`);
  if (at < 0) throw new Error(`${file} has no GET ${route}`);
  const next = source.indexOf("\n  app.", at);
  return source.slice(at, next < 0 ? undefined : next);
}

// The route that serves the files beside an artifact, under the current load's token.
const ARTIFACT_FILES_ROUTE = "/^\\/artifact\\/([^/]+)\\/([^/]+)\\/(.+)$/";

check("other pages cannot read an artifact's files, attachments, export or whiteboard libraries", () => {
  // A foreign page's <script>, <img> or <link> reaches these routes with no header that tells it
  // apart from the artifact's own request: Chrome sends the sandboxed frame's loads with neither
  // Origin nor Referer, exactly like an HTML file opened from disk. So a file beside an artifact is
  // served only under the current load's secret path, and a token-less file route must not return.
  const server = read("src/server.js");
  const where = (handler) => `the ${handler} in src/server.js`;

  // Every route under /artifact, whatever its method or spelling: the path of each app.<method>(
  // call as written - a string in any quotes, or a regex literal with any flags, whose character
  // classes may hold an unescaped `/`. Express matches string routes regardless of case.
  const verbs = "get|head|post|put|patch|delete|options|all|use|route";
  const mountOf = new RegExp(
    `\\bapp\\.(${verbs})\\(\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`|\\/(?:\\\\.|\\[(?:\\\\.|[^\\]\\\\])*\\]|[^/\\n\\\\[])+\\/[a-z]*)`,
    "g",
  );
  const mounts = [...server.matchAll(mountOf)].map((match) => ({ verb: match[1], route: match[2] }));
  // Only a middleware with no path, app.use((req, res, next) => ...), may be written without one: a
  // route held in a constant or built by a call would slip past the list below.
  const calls = server.match(new RegExp(`\\bapp\\.(${verbs})\\(`, "g"))?.length ?? 0;
  const pathless = server.match(/\bapp\.use\(\s*\(/g)?.length ?? 0;
  if (calls !== mounts.length + pathless) {
    throw new Error("src/server.js mounts a route whose path is not a string or regex literal; write it as one");
  }
  const redirectRoute = '"/artifact/:key"';
  const entryRoute = "/^\\/artifact\\/([^/]+)\\/index\\.html$/";
  const documentRoute = "/^\\/artifact\\/([^/]+)\\/([^/]+)\\/index\\.html$/";
  const filesRoute = ARTIFACT_FILES_ROUTE;
  const fallbackRoute = "/^\\/artifact(?:\\/|$)/i";
  const tokenlessRoute = "/^\\/artifact\\/([^/]+)\\/(.+)$/";
  const expected = [redirectRoute, entryRoute, documentRoute, filesRoute, fallbackRoute].map((route) => `get ${route}`);
  const mounted = mounts
    .filter(({ route }) => (route.startsWith("/") ? /artifact/i.test(route) : /^.\/artifact/i.test(route)))
    .map(({ verb, route }) => `${verb} ${route}`);
  if (JSON.stringify(mounted) !== JSON.stringify(expected)) {
    throw new Error(`src/server.js mounts ${mounted.join(", ")} under /artifact, expected ${expected.join(", ")}`);
  }
  // The file handler checks the token first and refuses a retired or forged one with the expired
  // page; only then does it touch the file.
  const filesHandler = handlerAt(server, filesRoute);
  inOrder(
    filesHandler,
    [
      "const verified = await store.verifyArtifactAssetLoad(req.params[0], req.params[1]);",
      /if \(!verified\.valid\) \{\s*sendArtifactLoadExpired\(res\);\s*return;\s*\}/,
      "res.sendFile(",
    ],
    where("/artifact file handler"),
  );

  // Attachments, the export and the whiteboard library list are asked for only by the same-origin
  // review page, so there the browser's own Sec-Fetch-Site does tell them apart, before any disk
  // access; Vary keeps a cached copy from answering a page on another loopback port, which shares
  // the review's cache partition (ports are not part of a site). A framed export would otherwise
  // drop the artifact, local files inlined, into the user's downloads.
  const ownPageRoutes = [
    { route: '"/api/:key/attachments/:id"', label: "attachment GET handler", then: "statAttachmentForServe(" },
    { route: '"/api/:key/export"', label: "export handler", then: "store.findByKey(" },
    // The bundle may suffix both names.
    {
      route: '"/api/whiteboard-libraries"',
      label: "whiteboard library handler",
      then: /loadExcalidrawLibraries\d*\(libraryDir\d*\)/,
    },
  ];
  const ownPageOrder = (guard, then) => [
    'res.vary("Sec-Fetch-Site");',
    new RegExp(`if \\(!${guard}\\(req\\)\\) \\{\\s*res\\.status\\(403\\)[^;]*;\\s*return;\\s*\\}`),
    then,
  ];
  for (const { route, label, then } of ownPageRoutes) {
    inOrder(handlerAt(server, route), ownPageOrder("isOwnPageFetch", then), where(label));
  }
  const attachmentsHandler = handlerAt(server, ownPageRoutes[0].route);
  const ownPageBody = /\nfunction isOwnPageFetch\(req\) \{\n([\s\S]*?)\n\}\n/.exec(server)?.[1];
  const expectedOwnPageBody = [
    '  const site = req.get("sec-fetch-site");',
    '  return site === undefined || site === "same-origin" || site === "none";',
  ].join("\n");
  if (ownPageBody !== expectedOwnPageBody) {
    throw new Error("isOwnPageFetch no longer passes only same-origin, none and a missing Sec-Fetch-Site");
  }

  // Nothing else hands out a file: a middleware with no path is invisible to the route list above.
  const opaqueAt = server.indexOf("function opaqueOriginAssetRoute(");
  const opaqueHelper = opaqueAt < 0 ? "" : server.slice(opaqueAt, server.indexOf("\n}\n", opaqueAt));
  const senders = [opaqueHelper, filesHandler, attachmentsHandler];
  const sendFiles = server.match(/\bres\.sendFile\(/g)?.length ?? 0;
  if (sendFiles !== senders.length || !senders.every((text) => text.includes("res.sendFile("))) {
    throw new Error("src/server.js sends a file outside the vendored assets, /artifact files and attachments");
  }
  for (const serveFiles of ["express.static(", "serveStatic(", "res.download("]) {
    mustNotContain(server, serveFiles, "src/server.js");
  }

  const dist = read("dist/cli.mjs");
  if (!dist.includes(filesRoute) || !dist.includes(fallbackRoute) || dist.includes(tokenlessRoute)) {
    throw new Error(`dist/cli.mjs does not serve artifact files only under the load token - ${REBUILD}`);
  }
  // The launchers run the bundle, which may suffix a renamed helper.
  try {
    for (const { route, label, then } of ownPageRoutes) {
      const handler = handlerAt(dist, route, "dist/cli.mjs");
      inOrder(handler, ownPageOrder("isOwnPageFetch\\d*", then), `the ${label} in dist/cli.mjs`);
    }
  } catch (error) {
    throw new Error(`${error.message} - ${REBUILD}`);
  }
  return "files only under the current load token; attachments, the export and the library list only for the review page";
});

check("mermaid is vendored for offline rendering", () => {
  const mod = path.join(root, "dist/design/mermaid/mermaid.esm.min.mjs");
  const chunks = path.join(root, "dist/design/mermaid/chunks/mermaid.esm.min");
  if (!existsSync(mod)) throw new Error("dist/design/mermaid/mermaid.esm.min.mjs missing - run `npm run build`");
  if (!existsSync(chunks)) throw new Error("mermaid chunk directory missing - run `npm run build`");
  return "module and chunk graph present";
});

check("only vendored bundles and the current load's files are readable from an opaque origin", () => {
  // The design snippet imports the vendored module from the sandboxed artifact, and module
  // scripts plus their chunk imports are CORS-mode fetches from an opaque origin. Without
  // Access-Control-Allow-Origin the import is blocked and no diagram (or inline whiteboard)
  // ever renders. The artifact's own module scripts, import(), CORS fetch and @font-face need the
  // same from its files, which only the current load's token opens. So the header has one writer
  // with a fixed value, called by the vendored-bundle helper and by the file handler after its
  // token and path checks - never by anything else that carries session data.
  const server = read("src/server.js");
  const expected = ["/^\\/design\\/mermaid\\/(.+)$/", "/^\\/whiteboard-assets\\/(.+)$/"];
  const routeOf = /app\.get\(\s*(\/\^[^\s,]+\/),\s*opaqueOriginAssetRoute\(/g;
  const mounted = [...server.matchAll(routeOf)].map((match) => match[1]).sort();
  if (JSON.stringify(mounted) !== JSON.stringify([...expected].sort())) {
    throw new Error(
      `opaqueOriginAssetRoute is mounted on ${mounted.join(", ") || "nothing"}, expected ${expected.join(", ")}`,
    );
  }
  const uses = server.match(/opaqueOriginAssetRoute\(/g)?.length ?? 0;
  if (uses !== expected.length + 1) {
    throw new Error(`opaqueOriginAssetRoute appears ${uses}x in src/server.js; only its two routes may use it`);
  }
  // Quoted header names only: the comments explaining the rule mention it unquoted.
  const headers = server.match(/["'`]access-control-allow-origin["'`]/gi)?.length ?? 0;
  if (headers !== 1) {
    throw new Error(`src/server.js sets Access-Control-Allow-Origin ${headers}x; only allowOpaqueOriginRead may`);
  }
  // The header goes into sendFile's own `headers` option, which Express applies only once the file
  // is really being sent: a missing file or a failed stat answers with the absolute path in its
  // error body, and must stay unreadable. The bundle may rename identifiers and reflow code, so
  // bodies are compared without whitespace and names may carry esbuild's numeric suffix.
  const squeeze = (text) => (text === undefined ? undefined : text.replace(/\s+/g, ""));
  const bodyOf = (source, name, params) =>
    new RegExp(`\\nfunction ${name}\\d*\\(${params}\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`).exec(source)?.[1];
  const helpers = [
    {
      name: "allowOpaqueOriginRead",
      params: "options",
      body: 'return{...options,headers:{"access-control-allow-origin":"*"}};',
      what: "adds exactly Access-Control-Allow-Origin: * to sendFile's options",
    },
    {
      name: "hasDotSegment",
      params: "relativePath",
      body: 'returnString(relativePath).split(/[\\\\/]/).some((segment)=>segment.startsWith("."));',
      what: "refuses every path segment that starts with a dot",
    },
  ];
  // Every reference counts, not only calls: an alias or `.call` would add a caller. Whole-line
  // comments may name the helper.
  const references = server.replace(/^\s*\/\/.*$/gm, "").match(/\ballowOpaqueOriginRead\b/g)?.length ?? 0;
  if (references !== 3) {
    throw new Error(
      `allowOpaqueOriginRead appears ${references}x in src/server.js; only opaqueOriginAssetRoute and the /artifact file handler may use it`,
    );
  }
  const opaqueAt = server.indexOf("function opaqueOriginAssetRoute(");
  const opaqueHelper = opaqueAt < 0 ? "" : server.slice(opaqueAt, server.indexOf("\n}\n", opaqueAt));
  inOrder(
    opaqueHelper,
    ['res.sendFile(file, allowOpaqueOriginRead({ dotfiles: "allow" }));'],
    "opaqueOriginAssetRoute in src/server.js",
  );
  // The file handler lets a file be read only once the token is current, the path stays inside the
  // artifact's directory and no segment of the resolved path starts with a dot.
  const filesOrder = [
    "const verified = await store.verifyArtifactAssetLoad(req.params[0], req.params[1]);",
    /if \(!verified\.valid\) \{\s*sendArtifactLoadExpired\(res\);\s*return;\s*\}/,
    "await resolveArtifactAsset(root, req.params[2]);",
    /if \(!file\) \{\s*res\.status\(403\)[^;]*;\s*return;\s*\}/,
    'const options = { dotfiles: "allow" };',
    /res\.sendFile\(file, hasDotSegment\d*\(path\d*\.relative\(root, file\)\) \? options : allowOpaqueOriginRead\d*\(options\)\);/,
  ];
  inOrder(handlerAt(server, ARTIFACT_FILES_ROUTE), filesOrder, "the /artifact file handler in src/server.js");
  for (const { name, params, body, what } of helpers) {
    if (squeeze(bodyOf(server, name, params)) !== body) throw new Error(`${name} in src/server.js no longer ${what}`);
  }
  if (server.includes('app.use("/design/mermaid"')) throw new Error("/design/mermaid is mounted outside the helper");
  const dist = read("dist/cli.mjs");
  if (![...dist.matchAll(routeOf)].some((match) => match[1] === expected[0])) {
    throw new Error("dist/cli.mjs does not serve /design/mermaid through opaqueOriginAssetRoute - run `npm run build`");
  }
  // The launchers run the bundle, so it must hold the same order and the same helpers, and nothing
  // there may write the header on its own.
  try {
    const distFiles = handlerAt(dist, ARTIFACT_FILES_ROUTE, "dist/cli.mjs");
    inOrder(distFiles, filesOrder, "the /artifact file handler in dist/cli.mjs");
    const distHeaders = dist.match(/["'`]access-control-allow-origin["'`]/gi)?.length ?? 0;
    if (distHeaders !== 1) throw new Error(`dist/cli.mjs sets Access-Control-Allow-Origin ${distHeaders}x`);
    const distUses = distFiles.match(/\ballowOpaqueOriginRead\d*\b/g)?.length ?? 0;
    if (distUses !== 1)
      throw new Error(`the /artifact file handler in dist/cli.mjs uses allowOpaqueOriginRead ${distUses}x`);
    for (const { name, params, body, what } of helpers) {
      if (squeeze(bodyOf(dist, name, params)) !== body) throw new Error(`${name} in dist/cli.mjs no longer ${what}`);
    }
  } catch (error) {
    throw new Error(`${error.message} - ${REBUILD}`);
  }
  return "Access-Control-Allow-Origin: * on /design/mermaid, /whiteboard-assets and the current load's files only";
});

const quiet = process.argv.includes("--quiet");
const shown = quiet ? results.filter(([status]) => status !== "PASS") : results;
const width = Math.max(0, ...shown.map(([, name]) => name.length));
for (const [status, name, detail] of shown) {
  const mark = status === "PASS" ? "  ok  " : " FAIL ";
  console.log(`${mark} ${name.padEnd(width)}  ${detail}`);
}
if (failed) {
  console.log("");
  console.log(`${failed} check(s) FAILED - do not use this build until they pass.`);
  process.exit(1);
}
if (!quiet) {
  console.log("");
  console.log(`All ${results.length} checks passed. This build is hardened.`);
}
