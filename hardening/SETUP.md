# Hardened lavish-axi — setup

This checkout is lavish-axi **0.1.62** with five capabilities removed **at source level**
(not merely switched off by an environment variable):

| Removed | How |
|---|---|
| Telemetry | `resolveTelemetryConfig()` always returns disabled and the analytics host string is gone from the source. No env var, build define, or config re-enables it. |
| Publishing to a third-party host | The `share` command, the `POST /api/:key/share` route, the browser "Publish link" menu action, and the `ht-ml.app` network calls are all removed. |
| Tailnet / LAN exposure | `resolveListenHosts()` returns `127.0.0.1` and nothing else; `detectTailscale()` returns `null` without ever executing the `tailscale` binary. `LAVISH_AXI_HOST` is ignored. |
| `setup hooks` / `setup plugin` | Removed — no persistent SessionStart hooks, no agent-plugin registration outside this directory. |
| CDN asset loading | Tailwind, DaisyUI and Mermaid are served from this machine's own Lavish server. Mermaid is vendored into `dist/design/mermaid/` at build time. |

The agent-facing help text (`--help`, `design`, `playbook`) was rewritten to match, so
nothing tells an agent to publish, install hooks, or fetch from a CDN.

## 1. Build (once)

From this directory, in **WSL** or **Windows**, whichever you use more:

```
npm install
```

That is all — the package's `prepare` script runs the build automatically.
The build needs Node 22+.

Note on running from both WSL and Windows: the runtime dependencies are pure
JavaScript, so a `node_modules/` installed under one will still *run* under the
other. Only rebuilding (`npm run build`) needs the platform's own esbuild binary —
if you want to rebuild from the other environment, run `npm install` there once.

## 2. Verify

```
node verify-hardening.mjs
```

Ten checks, covering both the sources and the compiled `dist/`. Exit code 0 means
the build is hardened; any failure prints what is wrong. Re-run this after every
`npm install` or `git pull`.

## 3. Put the launcher on PATH

**WSL / Linux:**

```
chmod +x lavish-safe
mkdir -p ~/.local/bin
ln -sf "$(pwd)/lavish-safe" ~/.local/bin/lavish-safe
# add to ~/.bashrc if needed:  export PATH="$HOME/.local/bin:$PATH"
```

**Windows:** add this directory to your user PATH, or copy `lavish-safe.cmd` into a
directory that is already on PATH.

The launcher refuses to start if `dist/cli.mjs` is missing, is older than the patched
sources, lost its hardening markers, or regained any of the removed endpoints — which
is what an accidental re-download or `npm update` would look like.

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
      "Bash(lavish-axi:*)",
      "Bash(npm install -g lavish-axi:*)"
    ]
  }
}
```

## Re-applying after an update

`harden_lavish.py` (in the parent folder) is idempotent and refuses to run against any
version other than 0.1.62. If you ever move to a newer lavish-axi, **re-audit first** —
the script will fail loudly rather than silently leaving a capability in place:

```
python3 harden_lavish.py .
npm run build
node verify-hardening.mjs
```

## What still touches the network

Nothing, during normal use. Artifacts, server state (`~/.lavish-axi/`), and whiteboard
autosaves stay on this machine, and the server listens on loopback only.

One consequence to know about: because Mermaid now loads from the local server, an
**exported** artifact containing a Mermaid whiteboard needs the Lavish server running
to render its diagrams. Exported artifacts using only Tailwind/DaisyUI are fully
self-contained — those files are inlined by `export`.
