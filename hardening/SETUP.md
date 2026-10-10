# Hardened lavish-axi — setup

This checkout is lavish-axi **0.1.82** with five capabilities removed **at source level**
(not merely switched off by an environment variable):

| Removed                          | How                                                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telemetry                        | `resolveTelemetryConfig()` always returns disabled and the analytics host string is gone from the source. No env var, build define, or config re-enables it.                 |
| Publishing to a third-party host | The `share` command, the `POST /api/:key/share` route, the browser "Publish link" menu action, and the `ht-ml.app` network calls are all removed.                            |
| Tailnet / LAN exposure           | `resolveListenHosts()` returns `127.0.0.1` and nothing else; `detectTailscale()` returns `null` without ever executing the `tailscale` binary. `LAVISH_AXI_HOST` is ignored. |
| `setup hooks` / `setup plugin`   | Removed — no persistent SessionStart hooks, no agent-plugin registration outside this directory.                                                                             |
| CDN asset loading                | Tailwind, DaisyUI and Mermaid are served from this machine's own Lavish server. Mermaid is vendored into `dist/design/mermaid/` at build time.                               |

The agent-facing help text (`--help`, `design`, `playbook`) was rewritten to match, so
nothing tells an agent to publish, install hooks, or fetch from a CDN.

## 1. Build (once)

Clone anywhere you like - nothing here assumes a particular path - and from the checkout,
in **WSL/Linux** or **Windows**:

```
npx --yes pnpm@11.1.1 install --frozen-lockfile
```

That installs exactly the dependency tree in the committed `pnpm-lock.yaml` (the one CI
tests) and the package's `prepare` script then runs the build. The pnpm version matches
`packageManager` in `package.json`; `npx` fetches it, so nothing needs a global install.
The build needs Node 22+.

`pnpm-lock.yaml` is the fork's only lockfile. Do not use `npm install`: it re-resolves every
`^` range on each machine and ignores the supply-chain policy in `pnpm-workspace.yaml`
(minimum release age, trust policy, build-script allowlist). The verifier, and so the
launchers, refuse a tree that npm installed or rewrote - a `package-lock.json` or a
`node_modules/.package-lock.json` gives it away. If that happens, delete `node_modules`,
`dist` and `package-lock.json`, then run the pnpm command above.

Install separately in each environment you run from (one clone for WSL, one for Windows):
pnpm links `node_modules/` with symlinks or junctions native to the platform that made them.

## 2. Verify

```
node verify-hardening.mjs
```

Twenty-seven checks, covering both the sources and the compiled `dist/`. Exit code 0
means the build is hardened; any failure prints what is wrong. Re-run this after every
install or `git pull`.

## 3. Put the launcher on PATH

**WSL / Linux:**

```
chmod +x lavish-safe
mkdir -p ~/.local/bin
ln -sf "$(pwd)/lavish-safe" ~/.local/bin/lavish-safe
# add to ~/.bashrc if needed:  export PATH="$HOME/.local/bin:$PATH"
```

**Windows:** add the checkout directory itself to your user PATH. Do not copy
`lavish-safe.cmd` elsewhere: it resolves `dist\cli.mjs` relative to its own location.

Before every start the launcher runs `node verify-hardening.mjs --quiet` and refuses to start
when any check fails: a missing, stale or unhardened `dist/`, a `node_modules` that npm
rewrote, a version that was never audited. After a `git pull`, rebuild (step 1) before the
next use; the refusal names the command. The checks add about 0.3 s to each invocation. The
CLI it starts spawns its server from the same `dist/` (`dist/server.mjs`), never from `src/`.

## 4. Install the skill

Copy `skills/lavish/SKILL.md` to your agent's skills directory:

- WSL: `~/.claude/skills/lavish/SKILL.md`
- Windows: `%USERPROFILE%\.claude\skills\lavish\SKILL.md`

That file tells the agent to use `lavish-safe` only, and never `npx lavish-axi`
(which would download the unhardened upstream package).

## 5. Optional: block the upstream package at the agent level

In `~/.claude/settings.json` (and the Windows equivalent):

```json
{
  "permissions": {
    "deny": [
      "Bash(npx lavish-axi:*)",
      "Bash(npx -y lavish-axi:*)",
      "Bash(npx --yes lavish-axi:*)",
      "Bash(lavish-axi:*)",
      "Bash(npm install -g lavish-axi:*)"
    ]
  }
}
```

## Moving to a newer upstream

Newer upstream releases are **merged** into this tree, and every merge is a fresh audit:
resolve conflicts in favour of the hardening, drop anything that adds a network destination,
a non-loopback bind, a helper process, or a persistence hook, then

```
pnpm install            # refreshes pnpm-lock.yaml for the merged package.json
pnpm run check
node verify-hardening.mjs
```

and bump the version pinned in `verify-hardening.mjs` (the launchers defer to it) only once
every check passes. Until then the launchers refuse to start, so a half-merged tree never runs. The 0.1.82 merge left out upstream's Herdr chime (it spawned a
`herdr` binary) and its multi-address serving (`server --also-listen`, interface-sweep discovery).
The original 0.1.62 patch script (`harden_lavish.py`) is gone from the tree; it refused every
other version, and git history keeps it.

Upstream files this fork does not use are deleted: the release-please workflow (which ran
`npm publish` with the telemetry host in its environment) and its config, the no-mistakes PR
gate, the generated-files guard, `CONTRIBUTING.md`, the issue templates, the
`lavish-editor-marketing/` video project (its demo GIF only illustrated the upstream README), and the
committed `task-evidence/` screenshots. If a later merge reports a modify/delete conflict on
one of them, keep it deleted.

The one workflow kept, `.github/workflows/ci.yml`, lints, type-checks, tests and builds on
Linux, macOS and Windows, then runs `node verify-hardening.mjs` against that build, so a pull
request that fails a check fails CI. Its actions are pinned to full commit SHAs, and its token
can only read the repository.

## What still touches the network

Nothing, during normal use. Artifacts, server state (`~/.lavish-axi/`), and whiteboard
autosaves stay on this machine, and the server listens on loopback only. The review page
itself carries a policy that pins every request, and every navigation of the artifact frame,
to the local server: an artifact cannot make it fetch an icon from another host, and an
artifact that tries to send its own frame to another site gets a blocked frame instead.
Other pages open in the same browser cannot drive it from the background either: polling for
feedback needs a header only the `lavish-safe` CLI sends, and loading the review page in a hidden
frame or image does not move the review away from the tab that has it. A page can still open the
review link in a new tab, which takes the review over just as opening the link yourself does; the
old tab says so and offers **Take over here**.

One consequence to know about: Mermaid now loads from the local server by a root path
(`/design/mermaid/...`), so Mermaid diagrams render only inside a Lavish review. An
**exported** or directly opened copy shows each diagram's Mermaid source as text, whether
or not the server is running, and `export` lists that import under
`unresolved_local_assets`. Exported artifacts using only Tailwind/DaisyUI are fully
self-contained — those files are inlined by `export`.
