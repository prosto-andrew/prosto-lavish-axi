#!/usr/bin/env python3
"""
Harden the lavish-axi v0.1.62 source tree in place.

Removes, at source level (not merely disabled by env var):
  1. Telemetry            - no client is ever constructed, no host string remains.
  2. Tailscale binding    - server binds 127.0.0.1 only; `tailscale` is never spawned.
  3. share / publish      - CLI command, HTTP route, browser menu action, and the
                            ht-ml.app network calls all removed.
  4. setup (hooks/plugin) - no persistent session-start hooks or plugin registration.
  5. CDN fetches          - Tailwind/DaisyUI/Mermaid served from the local server.

Idempotent: running twice is a no-op (already-patched markers are detected).
Every replacement asserts its target exists, so a version drift fails loudly
instead of silently leaving a capability in place.
"""

import sys
import pathlib

MARK = "LAVISH-HARDENED"


class Patcher:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.changed = []
        self.skipped = []

    def edit(self, relpath, old, new, label):
        p = self.root / relpath
        text = p.read_text(encoding="utf-8")
        if new == "":
            # Deletion: it is applied exactly when the target is gone.
            if old not in text:
                self.skipped.append(f"{relpath}: {label} (already applied)")
                return
        elif new in text:
            self.skipped.append(f"{relpath}: {label} (already applied)")
            return
        if old not in text:
            raise SystemExit(
                f"FAIL {relpath}: could not find the target for '{label}'.\n"
                f"The source does not match lavish-axi 0.1.62 - refusing to patch."
            )
        if text.count(old) != 1:
            raise SystemExit(f"FAIL {relpath}: '{label}' target matched {text.count(old)} times, expected 1.")
        p.write_text(text.replace(old, new), encoding="utf-8")
        self.changed.append(f"{relpath}: {label}")

    def replace_line(self, relpath, prefix, new_line, label):
        """Replace the single line starting with `prefix` (used for the giant one-line help strings)."""
        p = self.root / relpath
        lines = p.read_text(encoding="utf-8").split("\n")
        hits = [i for i, line in enumerate(lines) if line.startswith(prefix)]
        if not hits:
            if any(line.startswith(new_line[:40]) for line in lines):
                self.skipped.append(f"{relpath}: {label} (already applied)")
                return
            raise SystemExit(f"FAIL {relpath}: no line starts with {prefix!r} for '{label}'.")
        if len(hits) != 1:
            raise SystemExit(f"FAIL {relpath}: {len(hits)} lines start with {prefix!r}, expected 1.")
        lines[hits[0]] = new_line
        p.write_text("\n".join(lines), encoding="utf-8")
        self.changed.append(f"{relpath}: {label}")

    def append(self, relpath, addition, label):
        p = self.root / relpath
        text = p.read_text(encoding="utf-8")
        if MARK in text and addition.strip() in text:
            self.skipped.append(f"{relpath}: {label} (already applied)")
            return
        p.write_text(text + addition, encoding="utf-8")
        self.changed.append(f"{relpath}: {label}")

    def write(self, relpath, content, label):
        p = self.root / relpath
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        self.changed.append(f"{relpath}: {label}")


def main(root):
    P = Patcher(root)

    pkg = (P.root / "package.json").read_text(encoding="utf-8")
    if '"version": "0.1.62"' not in pkg:
        raise SystemExit("FAIL: package.json is not version 0.1.62 - refusing to patch an unaudited tree.")

    # ---------------------------------------------------------------- 1. telemetry
    P.edit(
        "src/telemetry.js",
        'const HARDCODED_FALLBACK_HOST = "https://a.kunchenguid.com";',
        f'// {MARK}: analytics host removed; no telemetry endpoint exists in this build.\nconst HARDCODED_FALLBACK_HOST = "";',
        "remove analytics host constant",
    )
    P.edit(
        "src/telemetry.js",
        """export function resolveTelemetryConfig(input) {
  const optOut = String(input.env.LAVISH_AXI_TELEMETRY || "")
    .trim()
    .toLowerCase();
  if (optOut === "0" || optOut === "false" || optOut === "off") {
    return { enabled: false, host: "", websiteID: "" };
  }

  const websiteID = String(input.env.LAVISH_AXI_UMAMI_WEBSITE_ID || "").trim() || input.buildWebsiteID.trim();
  if (!websiteID) {
    return { enabled: false, host: "", websiteID: "" };
  }

  const host =
    String(input.env.LAVISH_AXI_UMAMI_HOST || "").trim() || input.buildHost.trim() || HARDCODED_FALLBACK_HOST;
  return { enabled: true, host, websiteID };
}""",
        f"""export function resolveTelemetryConfig() {{
  // {MARK}: telemetry is permanently off. No environment variable, build-time
  // define, or config value can re-enable it.
  return {{ enabled: false, host: "", websiteID: "" }};
}}""",
        "force telemetry config disabled",
    )
    P.edit(
        "src/telemetry.js",
        """export function createTelemetryClient(config) {
  if (!config.enabled || !config.websiteID) {
    return new NoopTelemetryClient();
  }
  const endpoint = normalizeEndpoint(config.host);
  if (!endpoint) {
    return new NoopTelemetryClient();
  }
  return new HttpTelemetryClient(endpoint, config);
}""",
        f"""export function createTelemetryClient() {{
  // {MARK}: always a no-op client. HttpTelemetryClient is never constructed,
  // so no network request is ever made from this module.
  return new NoopTelemetryClient();
}}""",
        "force no-op telemetry client",
    )

    # ------------------------------------------------- 2. loopback-only / no tailscale
    P.edit(
        "src/paths.js",
        """export function bindHost(env = process.env) {
  return env.LAVISH_AXI_HOST?.trim() || LOOPBACK_HOST;
}""",
        f"""export function bindHost() {{
  // {MARK}: always loopback. LAVISH_AXI_HOST is ignored so the review server
  // can never be published onto a LAN, a VPN, or a tailnet.
  return LOOPBACK_HOST;
}}""",
        "bind loopback only",
    )
    P.edit(
        "src/paths.js",
        """export function resolveListenHosts({ host, env = process.env, tailscale = null } = {}) {
  const envHost = env.LAVISH_AXI_HOST?.trim() || "";
  const autoTailscale = !envHost;
  const requested = host || bindHost(env);
  const primary = isWildcardHost(requested) ? LOOPBACK_HOST : requested || LOOPBACK_HOST;
  const hosts = [primary];
  if (autoTailscale && tailscale?.ipv4 && tailscale.ipv4 !== primary && !isWildcardHost(tailscale.ipv4)) {
    hosts.push(tailscale.ipv4);
  }
  return sanitizeListenHosts(hosts);
}""",
        f"""export function resolveListenHosts() {{
  // {MARK}: the only listen address is loopback. The Tailscale IPv4 that the
  // stock build appended here is never added.
  return [LOOPBACK_HOST];
}}""",
        "never listen on a tailnet address",
    )
    P.edit(
        "src/tailscale.js",
        """export async function detectTailscale({
  execFile = execFileAsync,
  timeoutMs = 2000,
  commands = tailscaleCommandCandidates(),
  now = Date.now,
} = {}) {""",
        f"""export async function detectTailscale() {{
  // {MARK}: Tailscale detection removed. The `tailscale` binary is never
  // executed, so this build starts no subprocess to probe the tailnet.
  return null;
}}

async function detectTailscaleDisabled({{
  execFile = execFileAsync,
  timeoutMs = 2000,
  commands = tailscaleCommandCandidates(),
  now = Date.now,
}} = {{}}) {{""",
        "never probe tailscale",
    )

    # ------------------------------------------------------- 3+4. share / setup removal
    P.edit(
        "src/cli.js",
        'const COMMANDS = new Set(["open", "poll", "end", "stop", "server", "playbook", "design", "setup", "export", "share"]);',
        f'''const COMMANDS = new Set(["open", "poll", "end", "stop", "server", "playbook", "design", "setup", "export", "share"]);

// {MARK}: `share` and `setup` are removed from this build. They stay registered
// as command names only so the CLI answers with a clear refusal instead of
// treating the word as an HTML file name to open.
const DISABLED_COMMANDS = {{
  share:
    "`share` is removed in this hardened build: it published the artifact to ht-ml.app, a third-party host. Use `export` for a self-contained local copy instead.",
  setup:
    "`setup` is removed in this hardened build: it installed persistent session-start hooks and agent plugin registrations outside the project.",
}};

function disabledCommand(name) {{
  return async () => {{
    throw new AxiError(DISABLED_COMMANDS[name], "VALIDATION_ERROR", []);
  }};
}}''',
        "register share/setup as refusals",
    )
    P.edit("src/cli.js", "        setup: setupCommand,", '        setup: disabledCommand("setup"),', "unwire setup command")
    P.edit("src/cli.js", "        share: shareCommand,", '        share: disabledCommand("share"),', "unwire share command")
    P.edit(
        "src/cli.js",
        "export async function shareCommand(args) {",
        f"""export async function shareCommand() {{
  // {MARK}: unreachable from the CLI; kept as a hard stop for any other caller.
  throw new AxiError(DISABLED_COMMANDS.share, "VALIDATION_ERROR", []);
}}

async function shareCommandDisabled(args) {{""",
        "make shareCommand throw",
    )

    # Remove the help entry that advertises publishing to the agent.
    cli = (P.root / "src/cli.js").read_text(encoding="utf-8")
    if MARK + ": share help entry removed" not in cli:
        lines = cli.split("\n")
        keep, dropped = [], 0
        for line in lines:
            if line.lstrip().startswith('"Run `lavish-axi share <html-file>'):
                keep.append(f"      // {MARK}: share help entry removed - publishing does not exist in this build.")
                dropped += 1
                continue
            keep.append(line)
        if dropped != 1:
            raise SystemExit(f"FAIL src/cli.js: expected 1 share help entry, found {dropped}.")
        (P.root / "src/cli.js").write_text("\n".join(keep), encoding="utf-8")
        P.changed.append("src/cli.js: remove share from agent-facing help")

    # ht-ml.app network layer
    P.edit(
        "src/html-app.js",
        'const DEFAULT_API_URL = "https://api.ht-ml.app";',
        f'// {MARK}: third-party publishing host removed; no default endpoint remains.\nconst DEFAULT_API_URL = "";',
        "remove ht-ml.app endpoint",
    )
    P.edit(
        "src/html-app.js",
        "export async function publishToHtmlApp(html, options = {}) {",
        f"""export async function publishToHtmlApp() {{
  // {MARK}: publishing to a third-party host is removed from this build.
  throw new Error("publishing is disabled in this hardened build of lavish-axi");
}}

async function publishToHtmlAppDisabled(html, options = {{}}) {{""",
        "block publish call",
    )
    P.edit(
        "src/html-app.js",
        "export async function updateHtmlApp(siteId, html, options = {}) {",
        f"""export async function updateHtmlApp() {{
  // {MARK}: republishing to a third-party host is removed from this build.
  throw new Error("publishing is disabled in this hardened build of lavish-axi");
}}

async function updateHtmlAppDisabled(siteId, html, options = {{}}) {{""",
        "block republish call",
    )

    # Server-side share route
    P.edit(
        "src/server.js",
        """  app.post("/api/:key/share", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {""",
        f"""  app.post("/api/:key/share", async (req, res, next) => {{
    try {{
      // {MARK}: publishing is removed. The route stays so the browser gets a
      // clear refusal rather than a confusing 404.
      res.status(403).json({{ error: "publishing is disabled in this hardened build" }});
      return;
      // eslint-disable-next-line no-unreachable
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {{""",
        "refuse share route",
    )

    # Browser chrome: no click handler for the publish menu item
    P.edit(
        "src/chrome-client.js",
        "shareArtifactButton.onclick = openShareDialog;",
        f"""// {MARK}: publishing removed - the menu item is hidden in chrome.css and
// deliberately gets no click handler. openShareDialog stays referenced so the
// surrounding module keeps its shape.
void shareArtifactButton;
void openShareDialog;""",
        "unbind publish menu action",
    )
    P.append(
        "src/chrome.css",
        f"\n/* {MARK}: publishing is removed from this build - hide its menu entry. */\n#shareArtifact {{\n  display: none !important;\n}}\n",
        "hide publish menu item",
    )

    # ------------------------------------------------------------ 5. offline assets
    P.edit(
        "src/design-reference.js",
        """export const DESIGN_CDN_URLS = {
  tailwind: `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@${TAILWIND_BROWSER_VERSION}/dist/index.global.js`,
  daisyui: `https://cdn.jsdelivr.net/npm/daisyui@${DAISYUI_VERSION}/daisyui.css`,
  daisyuiThemes: `https://cdn.jsdelivr.net/npm/daisyui@${DAISYUI_VERSION}/themes.css`,
};""",
        f"""// {MARK}: artifacts load styling from this machine's own Lavish server instead
// of a public CDN, so opening one makes no outbound request. `export` inlines
// these same files, so a standalone copy stays styled offline.
export const DESIGN_CDN_URLS = {{
  tailwind: "/design/tailwindcss-browser.js",
  daisyui: "/design/daisyui.css",
  daisyuiThemes: "/design/daisyui-themes.css",
}};""",
        "serve Tailwind/DaisyUI locally",
    )
    P.edit(
        "src/design-reference.js",
        'export const MERMAID_VERSION = "11.15.0";',
        f'// {MARK}: pinned to the copy vendored into dist/design/mermaid by the build.\nexport const MERMAID_VERSION = "11.12.1";',
        "pin mermaid to vendored copy",
    )
    P.edit(
        "src/design-reference.js",
        "export const MERMAID_CDN_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs`;",
        f'// {MARK}: served from this machine\'s Lavish server, not a CDN.\nexport const MERMAID_CDN_URL = "/design/mermaid/mermaid.esm.min.mjs";',
        "serve mermaid locally",
    )
    P.edit(
        "src/server.js",
        """  app.get("/design/:asset", async (req, res, next) => {""",
        f"""  // {MARK}: vendored Mermaid ESM bundle (the module plus its chunk graph), so an
  // artifact that renders Mermaid never reaches out to a CDN. Resolved the same
  // way as the other design assets: the packaged copy when this file runs from
  // dist/, the built copy when the server is spawned from this checkout's src/
  // (which is what resolveServerEntry does whenever bin/ is present).
  const hardenedMermaidDir = (() => {{
    const packaged = fileURLToPath(new URL("./design/mermaid", import.meta.url));
    if (existsSync(packaged)) return packaged;
    return fileURLToPath(new URL("../dist/design/mermaid", import.meta.url));
  }})();
  app.use("/design/mermaid", express.static(hardenedMermaidDir));

  app.get("/design/:asset", async (req, res, next) => {{""",
        "add local mermaid route",
    )

    # Build step that vendors Mermaid next to the other design assets.
    P.edit(
        "scripts/build.js",
        """await copyFile("node_modules/@tailwindcss/browser/dist/index.global.js", "dist/design/tailwindcss-browser.js");""",
        f"""await copyFile("node_modules/@tailwindcss/browser/dist/index.global.js", "dist/design/tailwindcss-browser.js");

// {MARK}: vendor the Mermaid ESM bundle so artifacts render diagrams with no
// CDN request. The chunk directory must keep its layout - mermaid.esm.min.mjs
// imports from "./chunks/mermaid.esm.min/...".
await mkdir("dist/design/mermaid/chunks", {{ recursive: true }});
await copyFile("node_modules/mermaid/dist/mermaid.esm.min.mjs", "dist/design/mermaid/mermaid.esm.min.mjs");
await cp("node_modules/mermaid/dist/chunks/mermaid.esm.min", "dist/design/mermaid/chunks/mermaid.esm.min", {{
  recursive: true,
}});""",
        "vendor mermaid at build time",
    )

    # ------------------------------------------- 6. agent-facing text must match reality
    # The skill tells the agent to trust `--help` / `design` output, so any text
    # still describing publishing, Tailscale binding, or CDN loading would be an
    # instruction to attempt something this build refuses.
    # Order matters: the per-command help lines carry the same usage text as the
    # top-level help, so they are rewritten first and the deletion below then has
    # exactly one target left.
    P.replace_line(
        "src/cli.js",
        "    share: `Usage:",
        "    share: `"
        + "The 'share' command is REMOVED from this hardened build. It published the artifact to "
        "ht-ml.app, a third-party host, publicly by default and with no delete endpoint. No flag "
        "re-enables it, and this build offers no other way to publish. "
        "Use 'lavish-axi export <html-file>' for a self-contained local copy instead, and hand "
        "the user that file.\\n`,",
        "replace share help with the refusal",
    )
    P.replace_line(
        "src/cli.js",
        "    setup: `Usage: lavish-axi setup hooks",
        "    setup: `"
        + "The 'setup' command is REMOVED from this hardened build. It installed persistent "
        "SessionStart hooks and agent-plugin registrations outside the project directory. Nothing "
        "needs to be installed: run this build directly by its path.\\n`,",
        "replace setup help with the refusal",
    )
    P.edit(
        "src/cli.js",
        r"  lavish-axi share <html-file> [--private | --password <pw>] [--token <t>]\n  lavish-axi share <html-file> --site <site_id> --update-key <key> [--private | --password <pw>]\n  lavish-axi share --unpublish --site <site_id> --update-key <key>\n",
        "",
        "drop share from top-level usage",
    )
    P.edit(
        "src/cli.js",
        r"  lavish-axi setup hooks\n  lavish-axi setup plugin\n",
        "",
        "drop setup from top-level usage",
    )
    P.edit(
        "src/cli.js",
        "By default Lavish binds to 127.0.0.1 and, when Tailscale is running, this machine's Tailscale IPv4. Any explicit LAVISH_AXI_HOST overrides automatic Tailscale binding; wildcard values such as 0.0.0.0 or :: are restricted to loopback. An explicit non-wildcard LAVISH_AXI_HOST sets one bind address; binding beyond loopback exposes an unauthenticated server that can read and serve arbitrary local files to anything that can reach it, so only do so on a trusted network. With automatic binding enabled, a successfully bound Tailscale listener uses its MagicDNS name in generated session links; otherwise LAVISH_AXI_LINK_HOST can set the link hostname.",
        "This hardened build binds to 127.0.0.1 and nothing else. LAVISH_AXI_HOST is ignored and Tailscale detection is removed, so the server is never reachable from another machine or from a tailnet.",
        "correct server help about binding",
    )
    P.edit(
        "src/cli.js",
        "Show a copy-pasteable CDN snippet for Tailwind CSS browser runtime v4 + DaisyUI v5 + themes,",
        "Show a copy-pasteable LOCAL snippet for Tailwind CSS browser runtime v4 + DaisyUI v5 + themes (served by this machine's own Lavish server - this build makes no CDN requests),",
        "correct design help wording",
    )
    P.edit(
        "src/cli.js",
        "Lavish artifacts stay portable HTML. This CDN snippet is the design fallback, not the default:",
        "Lavish artifacts stay portable HTML. This local snippet is the design fallback, not the default:",
        "correct design fallback wording",
    )
    P.edit(
        "src/design-reference.js",
        "use the Lavish-recommended Tailwind CSS browser runtime v4 + DaisyUI v5, available via CDN, and prefer that CDN snippet over hand-writing styles",
        "use the Lavish-recommended Tailwind CSS browser runtime v4 + DaisyUI v5, served locally by this machine's own Lavish server (no CDN), and prefer that local snippet over hand-writing styles",
        "correct design priority wording",
    )
    P.edit(
        "src/design-reference.js",
        "a content-to-playbook router, a copy-pasteable CDN snippet,",
        "a content-to-playbook router, a copy-pasteable local design snippet,",
        "correct design router wording",
    )
    P.edit(
        "src/design-reference.js",
        '"Use this Lavish CDN fallback only if',
        '"Use this Lavish local design fallback only if',
        "correct design fallback label",
    )
    P.edit(
        "src/design-reference.js",
        '" Paste the CDN snippet below into your `<head>`.",',
        '" Paste the local design snippet below into your `<head>`. It loads from this machine\'s Lavish server, so the artifact makes no outbound request; `export` inlines these files into the standalone copy.",',
        "correct snippet instruction",
    )

    print("PATCHED:")
    for c in P.changed:
        print("  +", c)
    if P.skipped:
        print("ALREADY APPLIED:")
        for s in P.skipped:
            print("  =", s)
    print(f"\n{len(P.changed)} change(s), {len(P.skipped)} already in place.")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
