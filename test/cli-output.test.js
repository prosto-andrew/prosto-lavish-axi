import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import WebSocket from "ws";

import { AxiError } from "axi-sdk-js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import {
  collapseHomeDirectory,
  createDesignOutput,
  createExportOutput,
  createHomeOutput,
  createOpenOutput,
  createPollOutput,
  createPlaybookOutput,
  createServerSpawnOptions,
  createShareOutput,
  createShareUnpublishOutput,
  createShareUpdateOutput,
  createUserEndedOpenOutput,
  detectInvokingAgent,
  fetchJson,
  getCommandHelp,
  normalizeArgv,
  resolveShareRequest,
  pollInterruptedText,
  pollWaitBannerText,
  pollWaitTickText,
  serverReplacementReason,
  shareCommand,
  shutdownServerOnPort,
  shouldForceRestartForLocalBuild,
  shouldKillProcessOnPort,
  shouldNarratePollWaitTicks,
  shouldOpenBrowser,
  shouldRestartServer,
  startPollWaitReporter,
  stopCommand,
  telemetryCommandName,
  VERSION,
} from "../src/cli.js";
import { DESIGN_PRIORITY_RULE, DESIGN_SYSTEM_HINT } from "../src/design-reference.js";
import { createSkillMarkdown } from "../src/skill.js";
import { SELF_PAINT_WARNING } from "../src/self-paint.js";
import { serve } from "../src/server.js";
import { canonicalFile, sessionKey } from "../src/session-store.js";

async function waitForPollListening(base, key, timeoutMs = 10_000) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/events/${key}`, { origin: base });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for listening presence")), timeoutMs);
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type !== "agent-presence" || message.data.state !== "listening") return;
        clearTimeout(timer);
        resolve(undefined);
      });
      socket.once("error", reject);
    });
  } finally {
    socket.close();
  }
}

function assertObservablePollWakePath(text) {
  assert.match(text, /Keep the poll in the foreground by default/i);
  assert.match(text, /return the feedback directly to the agent/i);
  assert.match(text, /harness-native tracked background-job facility/i);
  assert.match(text, /guaranteed to resume or notify the same agent/i);
  assert.match(text, /Never use `nohup`/);
  assert.match(text, /shell `&`/);
  assert.match(text, /`disown`/);
  assert.match(text, /redirected fire-and-forget processes/);
  assert.match(text, /detached terminal without an explicit verified callback/);
  assert.match(text, /no completion-aware background facility/i);
  assert.match(text, /verified wake callback into the surrounding supervisor/i);
  assert.match(text, /Do not tell the user the artifact is being monitored until that wake path is live/i);
  assert.doesNotMatch(text, /foreground command may run.*run the poll as a background task/i);
}

test("CLI version tracks package.json so release-please bumps reach the published binary", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, packageJson.version);
});

test("home output teaches agents when and how to use Lavish Editor", () => {
  const output = createHomeOutput({ bin: `${os.homedir()}/.local/bin/lavish-axi`, sessions: [] });

  assert.equal(output.bin, "~/.local/bin/lavish-axi");
  assert.match(output.description, /Lavish Editor/);
  assert.match(output.description, /complex response/);
  assert.match(output.description, /consider using Lavish Editor/);
  assert.match(output.description, /First generate an interactive HTML artifact/);
  assert.deepEqual(output.sessions, []);
  assert.equal("use_cases" in output, false);
  assert.equal("example_use_cases" in output, false);
  assert.equal("artifact_guidance" in output, false);
  assert.ok(output.visual_guidance.length <= 6);
  assert.ok(output.visual_guidance.some((item) => item.includes("visual hierarchy")));
  assert.ok(
    output.visual_guidance.some(
      (item) =>
        /show, don't tell/i.test(item) && /inline SVG/.test(item) && /screenshot/i.test(item) && /prose/i.test(item),
    ),
  );
  assert.ok(output.visual_guidance.some((item) => item.includes("sections, cards, tables")));
  assert.ok(output.visual_guidance.some((item) => item.includes("horizontal overflow")));
  assert.ok(output.visual_guidance.some((item) => item.includes("minmax(0, 1fr)")));
  assert.ok(output.visual_guidance.some((item) => /nested grid\/flex/i.test(item)));
  assert.ok(output.visual_guidance.some((item) => /pixel or monospace fonts/i.test(item)));
  assert.ok(!output.visual_guidance.some((item) => item.includes("test narrow viewports")));
  assert.ok(output.playbooks.some((item) => item.id === "diagram"));
  assert.equal(
    output.playbooks.find((item) => item.id === "input")?.use_when,
    "Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact",
  );
  assert.ok(output.help.some((item) => item.includes("lavish-safe <html-file>")));
  assert.ok(output.help.some((item) => item.includes("`.lavish/`")));
  assert.ok(output.help.some((item) => item.includes("lavish-safe playbook <playbook_id>")));
  assert.ok(output.help.some((item) => item.includes("combines several playbooks")));
  assert.ok(output.help.some((item) => item.includes("MUST open each matching playbook")));
  assert.ok(output.help.some((item) => item.includes("reference other filesystem assets")));
  assert.ok(output.help.some((item) => item.includes("same directory as the HTML file")));
  assert.ok(output.help.includes(DESIGN_SYSTEM_HINT), "home help carries the single-sourced design rule verbatim");
  assert.ok(!output.help.some((item) => item.includes('<meta name="lavish-design" content="off">')));
  assert.ok(!output.help.some((item) => item.includes("Known IDs")));
  assert.ok(output.help.some((item) => item.includes("technical plan")));
});

test("the design-priority rule is single-sourced and keeps its three-step semantics", () => {
  // Keyword-level checks on the one owner constant; every surface that needs the rule
  // embeds DESIGN_PRIORITY_RULE, so wording changes happen here and nowhere else.
  assert.match(DESIGN_PRIORITY_RULE, /strict priority order/);
  assert.match(DESIGN_PRIORITY_RULE, /\(1\)[\s\S]*\(2\)[\s\S]*\(3\)/);
  assert.match(DESIGN_PRIORITY_RULE, /user asked for a specific look or named design system/);
  assert.match(DESIGN_PRIORITY_RULE, /project the artifact is about/);
  assert.match(DESIGN_PRIORITY_RULE, /current working directory/);
  assert.match(DESIGN_PRIORITY_RULE, /previews, proposes, or mocks/);
  assert.match(DESIGN_PRIORITY_RULE, /app's own design system/);
  assert.match(DESIGN_PRIORITY_RULE, /Tailwind CSS browser runtime v4 \+ DaisyUI v5/);
  assert.match(DESIGN_PRIORITY_RULE, /only when both steps come up empty/);
  assert.match(DESIGN_PRIORITY_RULE, /hand-writing styles/);
  assert.match(DESIGN_PRIORITY_RULE, /unless explicitly instructed/);
  assert.doesNotMatch(DESIGN_PRIORITY_RULE, /inspect the current project/i);

  assert.ok(DESIGN_SYSTEM_HINT.includes(DESIGN_PRIORITY_RULE), "the home hint embeds the rule");
  assert.match(DESIGN_SYSTEM_HINT, /does not auto-inject/);
  assert.match(DESIGN_SYSTEM_HINT, /portable/);
  assert.match(DESIGN_SYSTEM_HINT, /lavish-safe design/);
  assert.match(DESIGN_SYSTEM_HINT, /state which of the three design sources/);
});

test("design output is the sole emitted concise explicit-background guidance", () => {
  const output = createDesignOutput();
  const instruction = "Paint an explicit page background and readable text.";
  assert.match(output.design.summary, new RegExp(instruction.replaceAll(".", "\\.")));
  assert.equal(output.self_paint_rule, undefined);

  // The diagram playbook owns the figure render-verify rule, so it is exempt from the
  // render-verify exclusivity sweep but must still not restate the background instruction.
  const diagramSurface = JSON.stringify(createPlaybookOutput(["diagram"]));
  assert.ok(!diagramSurface.includes(instruction));
  assert.match(diagramSurface, /render-verify/i);
  const otherAgentSurfaces = [
    JSON.stringify(createHomeOutput({ bin: "lavish-axi", sessions: [] })),
    getCommandHelp("design"),
    createSkillMarkdown(),
    ...createPlaybookOutput([])
      .playbooks.map((playbook) => playbook.id)
      .filter((id) => id !== "diagram")
      .map((id) => JSON.stringify(createPlaybookOutput([id]))),
  ];
  for (const surface of otherAgentSurfaces) {
    assert.ok(!surface.includes(instruction));
    assert.doesNotMatch(surface, /render-verify/i);
  }
});

test("open output flags an artifact that never paints its own page surface", () => {
  const warned = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
    status: "opened",
    selfPaintWarning: SELF_PAINT_WARNING,
  });

  assert.equal(warned.self_paint_warning, SELF_PAINT_WARNING);
  assert.match(warned.next_step, /^First fix the unpainted page surface flagged in self_paint_warning/);
  assert.match(warned.next_step, /live-reloads the artifact automatically/);
  assert.match(warned.next_step, /lavish-safe poll \/tmp\/artifact\.html/, "the poll contract stays intact");

  const clean = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
    status: "opened",
  });
  assert.equal("self_paint_warning" in clean, false);
  assert.match(clean.next_step, /^Do not respond to the user just yet\./);
});

test("open output surfaces unavailable Tailscale phone access", () => {
  const output = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://127.0.0.1:4387/session/abc123",
    status: "opened",
    networkWarning: "Tailscale binding failed; there is no phone access.",
  });
  assert.equal(output.network_warning, "Tailscale binding failed; there is no phone access.");
});

test("export and share outputs flag an unpainted page surface before it reaches a host", () => {
  const exported = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [],
    selfPaintWarning: SELF_PAINT_WARNING,
  });
  assert.equal(exported.self_paint_warning, SELF_PAINT_WARNING);
  assert.match(exported.next_step, /^Fix the unpainted page surface flagged in self_paint_warning/);
  assert.match(exported.next_step, /no Lavish server/, "the export contract stays intact");

  const shared = createShareOutput({
    source: "/tmp/report.html",
    site: { url: "https://ht-ml.app/s/x", site_id: "x", update_key: "k" },
    warnings: [],
    selfPaintWarning: SELF_PAINT_WARNING,
  });
  assert.equal(shared.self_paint_warning, SELF_PAINT_WARNING);
  assert.match(shared.next_step, /^Fix the unpainted page surface flagged in self_paint_warning/);
  assert.match(shared.next_step, /re-run the share command/);
  assert.match(shared.next_step, /replacement URL/);
  assert.doesNotMatch(shared.next_step, /with the update_key/);

  const cleanExport = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [],
  });
  assert.equal("self_paint_warning" in cleanExport, false);
});

test("home output warns agents that poll needs an observable wake path", () => {
  const output = createHomeOutput({ bin: "lavish-axi", sessions: [] });
  const pollHelp = output.help.find((item) => item.includes("lavish-safe poll <html-file>"));

  assert.ok(pollHelp, "home help mentions the poll command");
  assert.match(pollHelp, /long-poll/);
  assert.match(pollHelp, /stays silent/);
  assert.match(pollHelp, /never kill it/);
  assertObservablePollWakePath(pollHelp);
  assert.doesNotMatch(pollHelp, /Codex/);
  assert.match(pollHelp, /re-run/);
  assert.match(pollHelp, /feedback remains queued until delivery/);
  assert.match(pollHelp, /`Send & End` ends the session/);
  assert.match(pollHelp, /final feedback is still delivered once/);
  assert.doesNotMatch(pollHelp, /above 10 minutes/);
});

test("ambient and per-artifact output never nags about installing the plugin", () => {
  // Home output loads on every session and open/poll run constantly; setup belongs in the
  // setup surfaces only, so an install prompt here would be pure recurring token cost.
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [] });

  assert.doesNotMatch(JSON.stringify(home), /setup plugin/);
  assert.doesNotMatch(JSON.stringify(home), /setup hooks/);
});

test("home output tailors poll guidance when invoked under Codex", () => {
  const output = createHomeOutput({ bin: "lavish-axi", sessions: [], agent: "codex" });
  const pollHelp = output.help.find((item) => item.includes("lavish-safe poll <html-file>"));

  assertObservablePollWakePath(pollHelp);
  assert.match(pollHelp, /Codex detected/);
  assert.match(pollHelp, /keep the poll attached to the active turn/);
});

test("home output keeps static skill poll guidance safe and agent-neutral", () => {
  const output = createHomeOutput({ bin: "lavish-axi", sessions: [], agent: "static" });
  const pollHelp = output.help.find((item) => item.includes("lavish-safe poll <html-file>"));

  assertObservablePollWakePath(pollHelp);
  assert.doesNotMatch(pollHelp, /keep the poll attached to the active turn/i);
  assert.doesNotMatch(pollHelp, /Codex detected/);
  assert.match(pollHelp, /feedback remains queued until delivery/);
});

test("invoking agent detection recognizes Codex runtime markers only", () => {
  assert.equal(detectInvokingAgent({ PATH: "/bin", CODEX_SANDBOX: "seatbelt" }), "codex");
  assert.equal(detectInvokingAgent({ PATH: "/bin", CODEX_THREAD_ID: "thread" }), "codex");
  assert.equal(detectInvokingAgent({ PATH: "/bin", CODEX_HOME: "/tmp/codex" }), "generic");
  assert.equal(detectInvokingAgent({ PATH: "/bin", CODEX_EXPERIMENTAL_FEATURE: "1" }), "generic");
  assert.equal(detectInvokingAgent({ PATH: "/bin" }), "generic");
});

test("top-level help renders static home output without dynamic sessions", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-help-test-`);
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "--help"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        env: { ...process.env, LAVISH_AXI_STATE_DIR: stateDir },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /playbooks\[8\]/);
    assert.match(result.stdout, /lavish-safe playbook <playbook_id>/);
    assert.match(result.stdout, /reference other filesystem assets/);
    assert.match(result.stdout, /same directory as the HTML file/);
    assert.match(result.stdout, /Tailwind CSS browser runtime v4/);
    assert.match(result.stdout, /lavish-safe design/);
    assert.match(result.stdout, /strict priority order/);
    assert.match(result.stdout, /never kill it/);
    assert.match(result.stdout, /feedback remains queued until delivery/);
    assert.doesNotMatch(result.stdout, /above 10 minutes/);
    assert.doesNotMatch(result.stdout, /lavish-design/);
    assert.doesNotMatch(result.stdout, /sessions\[/);
    assert.doesNotMatch(result.stdout, /Known IDs/);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("design output prints local asset URLs, never a CDN", () => {
  // LAVISH-HARDENED: the stock output handed agents jsdelivr URLs to paste into an
  // artifact. Tailwind, DaisyUI and its themes are vendored and served by this machine,
  // so the snippet points at the local server - and under the artifact policy a CDN URL
  // pasted here would be refused anyway.
  const output = createDesignOutput();
  const snippet = output.design.cdn_snippet;

  assert.match(snippet, /<link rel="stylesheet" href="\/design\/daisyui\.css">/);
  assert.match(snippet, /<link rel="stylesheet" href="\/design\/daisyui-themes\.css">/);
  assert.match(snippet, /<script src="\/design\/tailwindcss-browser\.js"><\/script>/);
  assert.deepEqual(output.design.cdn_urls, {
    tailwind: "/design/tailwindcss-browser.js",
    daisyui: "/design/daisyui.css",
    daisyuiThemes: "/design/daisyui-themes.css",
  });
  assert.equal(output.whiteboard_tooling.cdn_urls.mermaid, "/design/mermaid/mermaid.esm.min.mjs");
  assert.doesNotMatch(snippet, /https?:\/\//);
  assert.doesNotMatch(JSON.stringify(output), /cdn\.jsdelivr\.net|unpkg\.com|esm\.sh/);
});

test("design output recommends luxury as the default theme and warns against @apply on DaisyUI classes", () => {
  const output = createDesignOutput();

  assert.ok(output.theme_usage.some((item) => /default.*luxury|luxury.*default/i.test(item)));
  assert.ok(output.theme_usage.some((item) => item.includes("@apply") && /daisyui/i.test(item)));
  assert.ok(output.theme_usage.some((item) => /aborts the entire|no Tailwind styles/i.test(item)));
});

test("playbook index output lists known playbooks with concise descriptions", () => {
  const output = createPlaybookOutput([]);

  assert.equal(output.playbooks.length, 8);
  assert.deepEqual(
    output.playbooks.map((playbook) => playbook.id),
    ["diagram", "table", "comparison", "plan", "code", "input", "explanation", "slides"],
  );
  assert.equal(
    output.playbooks.find((playbook) => playbook.id === "plan")?.use_when,
    "Explain a product or technical plan before implementation",
  );
  assert.equal(
    output.playbooks.find((playbook) => playbook.id === "input")?.use_when,
    "Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact",
  );
  assert.ok(output.playbooks.every((playbook) => playbook.use_when.length > 20));
  assert.ok(output.help.some((item) => item.includes("lavish-safe playbook <playbook_id>")));
  assert.ok(output.help.some((item) => item.includes("combines several playbooks")));
  assert.ok(output.help.some((item) => item.includes("MUST open each matching playbook")));
});

test("explanation playbook routes understanding of existing things and separates itself from plan and comparison", () => {
  const output = createPlaybookOutput(["explanation"]);

  assert.match(output.playbook.use_when, /Explain an existing system, PR, incident, or decision/i);
  assert.match(output.playbook.use_when, /not choosing a direction or inspecting a plan/);
  assert.ok(
    output.playbook.choose.some((item) => /plan playbook when the reader must inspect and approve/i.test(item)),
  );
  assert.ok(output.playbook.structure.some((item) => /one-sentence answer/i.test(item)));
  assert.ok(output.playbook.structure.some((item) => /what was deliberately left out/i.test(item)));
  assert.ok(output.playbook.pitfalls.some((item) => /restate the PR body, diff, or ticket file-by-file/i.test(item)));
  assert.ok(
    output.playbook.design_rules.some((item) => /diagram playbook's assume-nothing rule/i.test(item)),
    "reader starting point is owned by the diagram playbook and only pointed at here",
  );
  assert.ok(output.playbook.pitfalls.some((item) => /inferred reasoning as verified fact/i.test(item)));
});

test("diagram playbook defaults to hand-authored SVG and names the anti-patterns", () => {
  const output = createPlaybookOutput(["diagram"]);

  assert.ok(output.playbook.choose.some((item) => /Default to hand-authored inline SVG/.test(item)));
  assert.ok(output.playbook.choose.some((item) => /only when the user asks for an editable whiteboard/i.test(item)));
  assert.ok(output.playbook.pitfalls.some((item) => /hand-build boxes-and-arrows/i.test(item)));
  assert.ok(output.playbook.pitfalls.some((item) => /div\/flexbox/i.test(item)));
  assert.ok(output.playbook.pitfalls.some((item) => /reach for Mermaid to save authoring effort/i.test(item)));
});

test("diagram playbook owns assume-nothing and one-concept-per-diagram guidance", async () => {
  const output = createPlaybookOutput(["diagram"]);
  assert.ok(
    output.playbook.structure.some((item) => /knows nothing/i.test(item) && /from zero/i.test(item)),
    "the diagram playbook must tell agents to explain from zero",
  );
  assert.ok(
    output.playbook.structure.some((item) => /one concept per diagram/i.test(item)),
    "the diagram playbook must prefer one concept per diagram",
  );

  const playbookIds = createPlaybookOutput([]).playbooks.map((playbook) => playbook.id);
  const otherSurfaces = [
    JSON.stringify(createHomeOutput({ bin: "lavish-axi", sessions: [] })),
    JSON.stringify(createDesignOutput()),
    createSkillMarkdown(),
    ...playbookIds.filter((id) => id !== "diagram").map((id) => JSON.stringify(createPlaybookOutput([id]).playbook)),
  ];
  for (const surface of otherSurfaces) {
    assert.doesNotMatch(surface, /one concept per diagram/i);
    assert.doesNotMatch(surface, /knows nothing/i);
    assert.doesNotMatch(surface, /presume/i);
  }

  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-playbook-diagram-`);
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "playbook", "diagram"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        env: { ...process.env, LAVISH_AXI_STATE_DIR: stateDir },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /knows nothing/i);
    assert.match(result.stdout, /one concept per diagram/i);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("diagram playbook routes whiteboard Mermaid through the theme-aware design snippet", () => {
  const output = createPlaybookOutput(["diagram"]);

  assert.ok(
    output.playbook.design_rules.some(
      (item) => /mermaid/i.test(item) && /theme-aware/i.test(item) && /`lavish-safe design`/.test(item),
    ),
    "the whiteboard opt-in must still theme Mermaid through the design snippet instead of hardcoding one theme",
  );
});

test("design output emits a theme-aware Mermaid init that re-renders on page-theme change", () => {
  const snippet = createDesignOutput().whiteboard_tooling.mermaid_cdn_snippet;

  // The old bug: a single hardcoded Mermaid theme that ignores the page theme.
  assert.doesNotMatch(snippet, /theme:\s*["']base["']/);

  // It must choose the Mermaid theme from the page's effective light/dark
  // appearance, covering both a data-theme toggle and the OS preference.
  assert.match(snippet, /prefers-color-scheme:\s*dark/);
  assert.match(snippet, /["']dark["']/);
  assert.match(snippet, /["']default["']/);
  assert.match(snippet, /backgroundColor/);

  // Mermaid does not restyle an already-rendered SVG, so the snippet must
  // re-render: it drives rendering itself and reacts to theme changes.
  assert.match(snippet, /startOnLoad:\s*false/);
  assert.match(snippet, /mermaid\.run/);
  assert.match(snippet, /MutationObserver/);
  assert.match(snippet, /data-theme/);
  assert.match(snippet, /document\.addEventListener\(["']change["'],\s*queueRender,\s*true\)/);
  assert.match(snippet, /document\.addEventListener\(\s*["']transitionend["']/);
  assert.match(snippet, /background-color/);
  assert.match(snippet, /function compositeRgba/);
  assert.match(snippet, /colorScheme/);
  assert.match(snippet, /addEventListener\(["']change["']/);
});

function executableMermaidSnippet() {
  return createDesignOutput()
    .whiteboard_tooling.mermaid_cdn_snippet.replace(/^<script type="module">\n/, "")
    .replace(/\n<\/script>$/, "")
    .replace(/^\s*import mermaid from "[^"]+";\n/m, "");
}

// Mermaid registers its own `load` listener when imported and, unless startOnLoad is already off by
// then, renders every `.mermaid` element itself - concurrently with the snippet's own render, which
// resets the same containers mid-layout. Two renders at once share Mermaid's state and fail at random.
test("theme-aware Mermaid snippet turns Mermaid's own load-time render off before load fires", () => {
  const windowListeners = [];
  const initializeCalls = [];
  let runs = 0;
  const document = {
    body: {},
    documentElement: {},
    readyState: "loading",
    createElement() {
      return {
        getContext: () => ({ clearRect() {}, fillRect() {}, getImageData: () => ({ data: [255, 255, 255, 255] }) }),
      };
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
  };
  const window = {
    matchMedia() {
      return { matches: false, addEventListener() {} };
    },
    addEventListener(type) {
      windowListeners.push(type);
    },
  };
  const mermaid = {
    initialize(options) {
      initializeCalls.push(options);
    },
    run() {
      runs += 1;
      return Promise.resolve();
    },
  };

  new Function(
    "mermaid",
    "window",
    "document",
    "MutationObserver",
    "getComputedStyle",
    "console",
    executableMermaidSnippet(),
  )(
    mermaid,
    window,
    document,
    class {
      observe() {}
    },
    () => ({ backgroundColor: "white", colorScheme: "normal" }),
    console,
  );

  assert.deepEqual(windowListeners, ["load"], "the snippet should wait for load before rendering");
  assert.equal(runs, 0);
  assert.ok(
    initializeCalls.some((options) => options.startOnLoad === false),
    "Mermaid's own load-time render must be off before load fires",
  );
});

// Mermaid needs on-screen geometry to lay a diagram out. Lavish hides a container once it embeds the
// inline whiteboard, so re-rendering there on a theme change replaced a good drawing with a failed one.
test("theme-aware Mermaid snippet re-renders only diagrams whose container is displayed", async () => {
  let dark = false;
  const mediaListeners = [];
  const runs = [];
  const paint = {
    clearRect() {},
    fillRect() {},
    getImageData: () => ({ data: [0, 0, 0, 0] }),
  };
  const diagramStub = () => ({
    displayed: true,
    innerHTML: "flowchart TD\n  A -->|yes| B",
    removeAttribute() {},
    getClientRects() {
      return this.displayed ? [{}] : [];
    },
  });
  const shown = diagramStub();
  const replaced = diagramStub();
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };
  const document = {
    body: {},
    documentElement: {},
    readyState: "complete",
    createElement: () => ({ getContext: () => paint }),
    querySelectorAll: () => [shown, replaced],
    addEventListener() {},
  };
  const window = {
    matchMedia: () => ({
      get matches() {
        return dark;
      },
      addEventListener: (type, callback) => mediaListeners.push(callback),
    }),
    addEventListener() {},
  };
  const mermaid = {
    initialize() {},
    run({ nodes }) {
      runs.push(nodes);
      return Promise.resolve();
    },
  };

  new Function(
    "mermaid",
    "window",
    "document",
    "MutationObserver",
    "getComputedStyle",
    "console",
    executableMermaidSnippet(),
  )(
    mermaid,
    window,
    document,
    class {
      observe() {}
    },
    () => ({ backgroundColor: "transparent", colorScheme: "normal" }),
    console,
  );
  await flush();
  assert.deepEqual(runs, [[shown, replaced]], "the first render draws every diagram");

  replaced.displayed = false;
  dark = true;
  mediaListeners[0]();
  await flush();
  assert.deepEqual(runs, [[shown, replaced], [shown]], "a hidden container keeps its drawing");

  shown.displayed = false;
  dark = false;
  mediaListeners[0]();
  await flush();
  assert.equal(runs.length, 2, "with nothing displayed there is nothing to re-render");

  shown.displayed = true;
  mediaListeners[0]();
  await flush();
  assert.deepEqual(runs.at(-1), [shown], "a container shown again catches up on the next pass");
});

test("theme-aware Mermaid snippet serializes rapid theme-change renders", async () => {
  const snippet = createDesignOutput()
    .whiteboard_tooling.mermaid_cdn_snippet.replace(/^<script type="module">\n/, "")
    .replace(/\n<\/script>$/, "")
    .replace(/^\s*import mermaid from "[^"]+";\n/m, "");
  let dark = false;
  let observedThemeMutations = false;
  const observedThemeTargets = [];
  const documentListeners = new Map();
  const initializedThemes = [];
  const mediaListeners = [];
  const pendingRenders = [];
  const loggedRenderErrors = [];
  let nextRenderError;
  let activeRenders = 0;
  let maxActiveRenders = 0;
  const renderedSources = [];
  let bodyColor = "white";
  let rootColor = "white";
  let rootColorScheme = "normal";
  const paint = {
    color: "",
    clearRect() {},
    set fillStyle(color) {
      this.color = color;
    },
    fillRect() {},
    getImageData() {
      const colors = {
        black: [0, 0, 0, 255],
        transparent: [0, 0, 0, 0],
        white: [255, 255, 255, 255],
        "white-40": [255, 255, 255, 102],
      };
      return { data: colors[this.color] };
    },
  };
  let diagramMarkup = 'flowchart TD\\n  A["OBJECTIVE:<br/>do the thing"]';
  const diagram = {
    get innerHTML() {
      return diagramMarkup;
    },
    set innerHTML(value) {
      diagramMarkup = value;
    },
    get textContent() {
      return diagramMarkup.replace(/<br\s*\/?\s*>/gi, "");
    },
    set textContent(value) {
      diagramMarkup = value;
    },
    removeAttribute() {},
    getClientRects() {
      return [{}];
    },
  };
  const document = {
    body: { id: "body" },
    documentElement: { id: "root" },
    readyState: "complete",
    createElement() {
      return { getContext: () => paint };
    },
    querySelectorAll() {
      return [diagram];
    },
    addEventListener(type, callback, capture) {
      documentListeners.set(type, { callback, capture });
    },
  };
  const darkQuery = {
    get matches() {
      return dark;
    },
    addEventListener(type, callback) {
      assert.equal(type, "change");
      mediaListeners.push(callback);
    },
  };
  const window = {
    matchMedia() {
      return darkQuery;
    },
    addEventListener() {
      assert.fail("the snippet should render immediately after document load");
    },
  };
  class TestMutationObserver {
    constructor() {
      observedThemeMutations = true;
    }

    observe(target) {
      observedThemeTargets.push(target);
    }
  }
  const mermaid = {
    // The theme-less call is the up-front startOnLoad switch-off; only render passes pick a theme.
    initialize(options) {
      if ("theme" in options) initializedThemes.push(options.theme);
    },
    run() {
      renderedSources.push(diagram.innerHTML);
      activeRenders += 1;
      maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
      if (nextRenderError) {
        const error = nextRenderError;
        nextRenderError = undefined;
        activeRenders -= 1;
        return Promise.reject(error);
      }
      return new Promise((resolve) => {
        pendingRenders.push(() => {
          activeRenders -= 1;
          resolve();
        });
      });
    },
  };
  function finishNextRender() {
    const finish = pendingRenders.shift();
    if (!finish) throw new Error("expected a pending Mermaid render");
    finish();
  }

  new Function("mermaid", "window", "document", "MutationObserver", "getComputedStyle", "console", snippet)(
    mermaid,
    window,
    document,
    TestMutationObserver,
    (element) => ({
      backgroundColor: element === document.body ? bodyColor : rootColor,
      colorScheme: element === document.documentElement ? rootColorScheme : "normal",
    }),
    { error: (...args) => loggedRenderErrors.push(args) },
  );

  assert.equal(mediaListeners.length, 1);
  assert.equal(observedThemeMutations, true);
  assert.deepEqual(observedThemeTargets, [document.documentElement, document.body]);
  const changeListener = documentListeners.get("change");
  assert.equal(typeof changeListener?.callback, "function");
  assert.equal(changeListener?.capture, true);
  const transitionListener = documentListeners.get("transitionend");
  assert.equal(typeof transitionListener?.callback, "function");
  assert.equal(transitionListener?.capture, true);
  assert.deepEqual(initializedThemes, ["default"]);
  assert.deepEqual(renderedSources, ['flowchart TD\\n  A["OBJECTIVE:<br/>do the thing"]']);
  bodyColor = "white-40";
  rootColor = "black";
  transitionListener.callback({ propertyName: "color" });
  assert.deepEqual(initializedThemes, ["default"]);
  transitionListener.callback({ propertyName: "background-color" });
  assert.equal(maxActiveRenders, 1);
  assert.deepEqual(initializedThemes, ["default"]);

  finishNextRender();
  await Promise.resolve();
  assert.deepEqual(initializedThemes, ["default", "dark"]);
  assert.equal(maxActiveRenders, 1);

  finishNextRender();
  await Promise.resolve();
  assert.equal(activeRenders, 0);
  assert.equal(initializedThemes.filter((entry) => entry === "dark").length, 1);

  bodyColor = "transparent";
  rootColor = "transparent";
  rootColorScheme = "light";
  changeListener.callback();
  assert.deepEqual(initializedThemes, ["default", "dark", "default"]);
  finishNextRender();
  await Promise.resolve();

  rootColorScheme = "dark";
  transitionListener.callback({ propertyName: "background-color" });
  assert.deepEqual(initializedThemes, ["default", "dark", "default", "dark"]);
  finishNextRender();
  await Promise.resolve();

  const renderError = new Error("invalid Mermaid syntax");
  nextRenderError = renderError;
  rootColorScheme = "light";
  transitionListener.callback({ propertyName: "background-color" });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(loggedRenderErrors, [["Mermaid diagram render failed:", renderError]]);

  changeListener.callback();
  assert.equal(activeRenders, 1);
  finishNextRender();
  await Promise.resolve();
});

test("playbook detail output returns focused Lavish-native guidance", () => {
  const output = createPlaybookOutput(["input"]);

  assert.equal(output.playbook.id, "input");
  assert.match(output.playbook.use_when, /Must be used/);
  assert.match(output.playbook.use_when, /collect user input/);
  assert.ok(output.playbook.choose.some((item) => item.includes("control")));
  assert.ok(output.playbook.structure.some((item) => item.includes("decision")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("queuePrompt")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("per-question form submit")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("radio change handlers")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("data-lavish-action")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("data-lavish-question")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("queueKey")));
  assert.ok(output.playbook.lavish_notes.some((item) => item.includes("window.lavish.queuePrompt")));
  assert.ok(output.playbook.lavish_notes.some((item) => item.includes("onsubmit")));
  assert.ok(output.playbook.pitfalls.some((item) => item.includes("unclear")));
  assert.ok(output.playbook.pitfalls.some((item) => item.includes("radio change")));
  assert.ok(output.playbook.lavish_notes.some((item) => item.includes("Lavish")));
});

test("input playbook defines an opt-in tracked batch handoff", () => {
  const output = createPlaybookOutput(["input"]);
  const guidance = JSON.stringify(output.playbook);
  const example = output.playbook.lavish_notes.find((item) => /tag: ['"]tracked-batch/.test(item));

  assert.match(guidance, /multi-item/);
  assert.match(guidance, /stable, visible ID/);
  assert.match(guidance, /selected set/);
  assert.match(guidance, /account for every submitted ID/);
  assert.match(guidance, /addressed/);
  assert.match(guidance, /deferred/);
  assert.match(guidance, /rejected/);
  assert.match(guidance, /receipt ID set/);
  assert.ok(example, "the tracked-batch pattern includes a copyable example");
  assert.match(example, /<form/);
  assert.match(example, /type="checkbox"/);
  assert.match(example, /onsubmit=/);
  assert.equal(example.match(/window\.lavish\.queuePrompt/g)?.length, 1);
  assert.match(example, /items: selected/);
  assert.match(example, /id:/);
  assert.match(example, /label:/);
  assert.match(example, /disposition:/);
});

test("table playbook routes multi-row actions to the input tracked-batch pattern", () => {
  const output = createPlaybookOutput(["table"]);

  assert.ok(
    output.playbook.lavish_notes.some(
      (item) => item.includes("multiple rows") && item.includes("input") && item.includes("tracked batch"),
    ),
  );
});

// LAVISH-HARDENED: the stock rule made a CDN-loaded diff library mandatory. Under
// this build's artifact policy that import is refused and the block renders empty,
// so the playbook now demands self-contained rendering - and this test guards that
// no playbook can hand the agent an off-machine URL again.
test("code playbook demands self-contained rendering and names no external host", () => {
  const output = createPlaybookOutput(["code"]);

  assert.equal(output.playbook.id, "code");
  assert.match(output.playbook.use_when, /source code/);
  assert.ok(output.playbook.choose.some((item) => item.includes("diff")));
  assert.ok(output.playbook.choose.some((item) => item.includes("side-by-side") || item.includes("unified")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("self-contained")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("one row per line")));
  assert.ok(output.playbook.pitfalls.some((item) => item.includes("<pre>")));

  // Match URL forms, not mentions: the rule itself names the common CDNs in order to
  // forbid them, and a bare-name check would fire on its own prohibition.
  const everyString = JSON.stringify(output.playbook);
  for (const url of ["https://esm.sh", "https://cdn.", "https://unpkg.com", "https://cdn.jsdelivr.net"]) {
    assert.ok(!everyString.includes(url), `the code playbook still points at ${url}`);
  }
  assert.doesNotMatch(everyString, /(import|src=|href=)[^"']*https?:\/\//);
});

test("plan playbook detail output has polished guidance copy", () => {
  const output = createPlaybookOutput(["plan"]);

  assert.ok(output.playbook.structure.some((item) => item.includes("Then describe a proposed approach")));
  assert.ok(output.playbook.structure.every((item) => !item.includes("Then describe the a proposed approach")));
});

test("unknown playbook ids produce an actionable validation error", () => {
  assert.throws(
    () => createPlaybookOutput(["unknown"]),
    (error) => {
      assert.ok(error instanceof AxiError);
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.match(error.message, /Unknown playbook/);
      assert.ok(error.suggestions.some((item) => item.includes("lavish-safe playbook")));
      return true;
    },
  );
});

test("home directory collapse tolerates Windows mixed separators", () => {
  assert.equal(
    collapseHomeDirectory("C:\\Users\\runneradmin/.local/bin/lavish-axi", "C:\\Users\\runneradmin"),
    "~/.local/bin/lavish-axi",
  );
  assert.equal(
    collapseHomeDirectory("C:\\Users\\runneradmin\\.local\\bin\\lavish-axi", "C:\\Users\\runneradmin"),
    "~/.local/bin/lavish-axi",
  );
});

test("open output keeps the user URL in session data and next_step focused on polling", () => {
  const output = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
    status: "opened",
  });

  assert.equal(output.session.file, "/tmp/artifact.html");
  assert.equal(output.session.url, "http://localhost:4387/session/abc123");
  assert.equal(output.session.status, "opened");
  // Keyword-level lock on the load-bearing semantics of this agent-facing string:
  // poll now (not the user-facing URL), never kill the poll, no --timeout-ms, and the
  // reopen etiquette. Sentence-level phrasing is free to change without touching this test.
  assert.doesNotMatch(output.next_step, /Tell the user (?:to open|to visit)/i);
  assert.doesNotMatch(output.next_step, /http:\/\/localhost:4387\/session\/abc123/);
  assert.match(output.next_step, /Do not respond to the user just yet\. Now you must run/);
  assert.match(output.next_step, /lavish-safe poll \/tmp\/artifact\.html/);
  assert.match(output.next_step, /keep waiting for more feedback/);
  assert.match(output.next_step, /lavish-safe reply \/tmp\/artifact\.html --agent-reply/);
  assert.match(output.next_step, /without starting another long-poll/);
  assert.match(output.next_step, /Layout issues inbox/);
  assert.doesNotMatch(output.next_step, /layout_warnings/);
  assert.match(output.next_step, /never kill it/);
  assertObservablePollWakePath(output.next_step);
  assert.doesNotMatch(output.next_step, /Codex/);
  assert.match(output.next_step, /feedback remains queued until delivery/);
  assert.match(output.next_step, /Do not pass --timeout-ms/);
  assert.match(output.next_step, /If the user ends the session, stop polling and do not reopen it/);
  assert.match(output.next_step, /--reopen/);
});

test("open output gives Codex the shared wake-path contract plus an attached-turn warning", () => {
  const output = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
    status: "opened",
    agent: "codex",
  });

  assertObservablePollWakePath(output.next_step);
  assert.match(output.next_step, /Codex detected/);
  assert.match(output.next_step, /keep the poll attached to the active turn/);
});

test("a user-ended open refuses with a status agents can branch on, not a URL to open", () => {
  const output = createUserEndedOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
  });

  assert.equal(output.session.file, "/tmp/artifact.html");
  assert.equal(output.session.status, "user-ended");
  assert.match(output.next_step, /user explicitly ended this Lavish Editor session from the browser/);
  assert.match(output.next_step, /did not reopen it/);
  assert.match(output.next_step, /Do not reopen unless the user asks for further review/);
  assert.match(output.next_step, /lavish-safe \/tmp\/artifact\.html --reopen/);
});

test("export output reports the written file and reassures it needs no server", () => {
  const output = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [],
  });

  assert.equal(output.export.source, "/tmp/report.html");
  assert.equal(output.export.output, "/tmp/report.export.html");
  assert.equal(output.export.unresolved_local_assets, 0);
  assert.equal(output.export.bytes, Buffer.byteLength("<html></html>"));
  assert.match(output.next_step, /no Lavish server/);
  assert.match(output.next_step, /remote CDN\/font references are left as links/);
});

test("export output surfaces local assets that could not be inlined", () => {
  const output = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [{ kind: "load-failed", ref: "./missing.png" }],
  });

  assert.deepEqual(output.unresolved_local_assets, [{ kind: "load-failed", ref: "./missing.png" }]);
  assert.match(output.next_step, /LOCAL assets could not be inlined/);
});

test("export output counts active srcdoc refs as unresolved assets", () => {
  const output = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [{ kind: "srcdoc-resource", ref: "local.png" }],
  });

  assert.equal(output.export.unresolved_local_assets, 1);
  assert.deepEqual(output.unresolved_local_assets, [{ kind: "srcdoc-resource", ref: "local.png" }]);
  assert.equal("notices" in output, false);
});

test("export output separates unresolved assets from notices", () => {
  const output = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [
      { kind: "load-failed", ref: "./missing.png", reason: "ENOENT" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
      { kind: "csp-meta", ref: "script-src 'self'" },
    ],
  });

  assert.equal(output.export.unresolved_local_assets, 1);
  assert.equal(output.export.notices, 2);
  assert.deepEqual(output.unresolved_local_assets, [{ kind: "load-failed", ref: "./missing.png", reason: "ENOENT" }]);
  assert.deepEqual(output.notices, [
    { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
    { kind: "csp-meta", ref: "script-src 'self'" },
  ]);
  assert.equal(output.warnings.length, 3);
});

test("export command writes a portable HTML file next to the artifact", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-export-test-`);
  const artifact = `${dir}/report.html`;
  await writeFile(`${dir}/theme.css`, ".btn{color:rebeccapurple}", "utf8");
  await writeFile(
    artifact,
    '<!doctype html><html><head><link rel="stylesheet" href="theme.css">' +
      '<link rel="stylesheet" href="https://cdn.example/app.css"></head><body><h1>Hi</h1></body></html>',
    "utf8",
  );
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "export", artifact],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LAVISH_AXI_STATE_DIR: dir, LAVISH_AXI_TELEMETRY: "0" },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /report\.export\.html/);
    const exported = await readFile(`${dir}/report.export.html`, "utf8");
    // local stylesheet inlined; remote stylesheet left as a link; SDK stripped
    assert.match(exported, /<style>\.btn\{color:rebeccapurple\}<\/style>/);
    assert.match(exported, /<link rel="stylesheet" href="https:\/\/cdn\.example\/app\.css">/);
    assert.doesNotMatch(exported, /sdk\.js/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("export command treats --out value as an option operand, not the source file", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-export-test-`);
  const artifact = `${dir}/report.html`;
  const output = `${dir}/custom.html`;
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "export", "--out", output, artifact],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LAVISH_AXI_STATE_DIR: dir, LAVISH_AXI_TELEMETRY: "0" },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /custom\.html/);
    assert.match(await readFile(output, "utf8"), /<h1>Hi<\/h1>/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// LAVISH-HARDENED: publishing is removed from this build. The block that stood here
// drove create, republish and unpublish against a fake host and asserted the wording of
// every partial-failure outcome - indeterminate, incomplete 200, host rejection, echoed
// site id. None of those paths exist any more. What is asserted instead is that the two
// removed commands refuse, and that the refusal explains itself well enough that an
// agent does not go looking for another route.
test("the removed commands refuse and say why", async () => {
  await assert.rejects(
    () => shareCommand(),
    (error) => {
      assert.ok(error instanceof AxiError);
      assert.match(error.message, /removed in this hardened build/);
      assert.match(error.message, /export/, "the refusal must name the local alternative");
      return true;
    },
  );
});

test("share and setup help announce the removal instead of documenting a feature", () => {
  const shareHelp = getCommandHelp("share");
  assert.match(shareHelp, /REMOVED from this hardened build/);
  assert.match(shareHelp, /No flag re-enables it/);

  const setupHelp = getCommandHelp("setup");
  assert.match(setupHelp, /REMOVED from this hardened build/);
  assert.match(setupHelp, /Nothing needs to be installed/);
});

test("poll help requires an observable wake path", () => {
  const help = getCommandHelp("poll");

  assert.match(help, /long-polls indefinitely/);
  assert.match(help, /stays silent/);
  assert.match(help, /never kill it/);
  assertObservablePollWakePath(help);
  assert.doesNotMatch(help, /Codex/);
  assert.match(help, /feedback remains queued until delivery/);
  assert.match(help, /Do not pass --timeout-ms/);
  assert.match(help, /tests and debugging only/);
  assert.match(help, /`Send & End` ends the session/);
  assert.match(help, /final feedback is still delivered once/);
  assert.doesNotMatch(help, /above 10 minutes/);
});

test("poll help is Codex-aware when requested", () => {
  const help = getCommandHelp("poll", { agent: "codex" });

  assertObservablePollWakePath(help);
  assert.match(help, /Codex detected/);
  assert.match(help, /keep the poll attached to the active turn/);
});

test("feedback next step keeps the next poll completion observable", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "feedback", dom_snapshot: "", prompts: [] },
  });

  assert.equal("artifact_failures" in output, false);
  assert.equal("layout_warnings" in output, false);
  assert.match(output.next_step, /never kill it/);
  assert.match(output.next_step, /without --timeout-ms/);
  assertObservablePollWakePath(output.next_step);
  assert.doesNotMatch(output.next_step, /Codex/);
  assert.match(output.next_step, /feedback remains queued until delivery/);
  assert.match(output.next_step, /Do not respond to the user just yet\. If you are continuing to wait for feedback/);
  assert.doesNotMatch(output.next_step, /above 10 minutes/);
});

test("poll feedback and the next step are emitted before the bulky DOM snapshot", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-poll-output-test-`);
  const artifact = `${stateDir}/artifact.html`;
  await writeFile(artifact, "<html><body>hello</body></html>", "utf8");
  const response = {
    status: "feedback",
    prompts: [{ prompt: "Ship it", tag: "message" }],
    artifact_failures: [{ kind: "artifact-unavailable", detail: "HTTP 404", severity: "fatal" }],
    dom_snapshot: "large snapshot",
  };
  const server = createServer((req, res) => {
    if (new URL(req.url || "/", "http://localhost").pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "lavish-axi", version: VERSION }));
      return;
    }
    if (req.url?.startsWith("/api/poll?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "poll", artifact, "--timeout-ms", "1000"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_PORT: String(address.port) },
      },
    );
    let stdout = "";
    let stderr = "";
    assert.ok(child.stdout);
    assert.ok(child.stderr);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const result = await new Promise((resolve) => {
      child.on("close", (status, signal) => resolve({ status, signal }));
    });

    assert.equal(result.status, 0, stderr);
    const promptsIndex = stdout.indexOf("prompts[");
    const failuresIndex = stdout.indexOf("artifact_failures[");
    const nextStepIndex = stdout.indexOf("next_step:");
    const snapshotIndex = stdout.indexOf("dom_snapshot:");
    assert.ok(promptsIndex >= 0, "poll stdout contains prompts");
    assert.ok(failuresIndex >= 0, "poll stdout contains artifact_failures");
    assert.ok(nextStepIndex >= 0, "poll stdout contains next_step");
    assert.ok(snapshotIndex >= 0, "poll stdout contains dom_snapshot");
    assert.ok(promptsIndex < failuresIndex, "prompts precede artifact_failures in poll stdout");
    assert.ok(failuresIndex < nextStepIndex, "artifact_failures precede next_step in poll stdout");
    assert.ok(nextStepIndex < snapshotIndex, "next_step precedes dom_snapshot in poll stdout");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("feedback next step is Codex-aware when requested", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "feedback", dom_snapshot: "", prompts: [] },
    agent: "codex",
  });

  assertObservablePollWakePath(output.next_step);
  assert.match(output.next_step, /Codex detected/);
  assert.match(output.next_step, /keep the poll attached to the active turn/);
});

test("detected layout warnings never appear in poll output", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [{ uid: "", prompt: "Tighten the header", selector: "h1", tag: "annotation", text: "Header" }],
    },
  });

  assert.equal("layout_warnings" in output, false);
  assert.equal("artifact_failures" in output, false);
  assert.match(output.next_step, /Apply the requested changes/);
  assert.match(output.next_step, /lavish-safe poll \/tmp\/report\.html --agent-reply/);
  assert.match(output.next_step, /continuing to wait for feedback/);
  assert.match(output.next_step, /lavish-safe reply \/tmp\/report\.html --agent-reply/);
  assert.match(output.next_step, /without starting another long-poll/);
});

test("a queued layout-warnings batch reads as ordinary feedback with lifecycle guidance", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [
        {
          uid: "",
          prompt: "Fix these 2 layout issues the browser detected in this artifact:\\n1. [w1] ...",
          selector: "",
          tag: "layout-warnings",
          text: "Layout issues: 2 selected",
          target: { type: "layout-warnings", warnings: [{ id: "w1" }, { id: "w2" }] },
        },
      ],
    },
  });

  assert.equal("layout_warnings" in output, false, "no parallel protocol - it is just a prompt");
  assert.equal(output.prompts[0].tag, "layout-warnings");
  assert.match(output.next_step, /Layout issues inbox/);
  assert.match(output.next_step, /in one pass before saving so the user's review refreshes once/);
  assert.match(output.next_step, /Queueing is a repair request, not a resolution/);
  assert.match(output.next_step, /newer artifact load and a complete check at the same viewport/);
});

test("a fatal artifact failure is the only thing that reaches the agent without user action", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [],
      artifact_failures: [
        { kind: "artifact-asset-unavailable", detail: "<img> could not load /artifact/x/logo.png", severity: "fatal" },
      ],
    },
  });

  assert.ok("artifact_failures" in output);
  assert.equal(output.artifact_failures.length, 1);
  assert.match(output.next_step, /1 fatal artifact failure detected/);
  assert.match(output.next_step, /the review surface could not be used/);
  assert.match(output.next_step, /artifact-asset-unavailable/);
});

test("whiteboard feedback tells agents to read the summary, inspect files when needed, and update the Mermaid source", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [
        {
          uid: "",
          prompt: "Whiteboard edits to diagram 1:\nMoved rectangle (Auth)",
          selector: "",
          tag: "whiteboard",
          text: "Whiteboard: diagram 1",
          target: {
            type: "excalidraw-scene",
            diagramIndex: 0,
            diagramId: "mermaid-1",
            sourceHash: "abc",
            scenePath: "/state/whiteboards/k/0.excalidraw",
            previewPath: "/state/whiteboards/k/0.png",
            imageFallback: false,
            stats: { added: 0, removed: 0, moved: 1, relabeled: 0, drawn: 0 },
          },
        },
      ],
    },
  });

  assert.match(output.next_step, /whiteboard edits \(tag "whiteboard"\)/);
  assert.match(output.next_step, /read the edit summary in the prompt text first/);
  assert.match(output.next_step, /scenePath/);
  assert.match(output.next_step, /previewPath/);
  assert.match(output.next_step, /Mermaid source stays authoritative/);
  assert.match(output.next_step, /never try to write the \.excalidraw scene back/);
});

test("image-attachment feedback tells agents to open the local image paths", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [
        {
          uid: "1",
          prompt: "Match this mock",
          selector: "header",
          tag: "header",
          text: "",
          attachments: [
            {
              id: "a".repeat(64) + ".png",
              type: "image",
              path: "/state/attachments/k/" + "a".repeat(64) + ".png",
              mime: "image/png",
              bytes: 1234,
              width: 800,
              height: 600,
              name: "mock.png",
            },
          ],
        },
      ],
    },
  });

  assert.match(output.next_step, /image attachments/);
  assert.match(output.next_step, /`attachments` array/);
  assert.match(output.next_step, /absolute local `path`/);
});

test("feedback without attachments does not mention image attachments", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [{ uid: "1", prompt: "Tweak this", selector: "h1", tag: "h1", text: "" }],
    },
  });
  assert.doesNotMatch(output.next_step, /image attachments/);
});

test("non-whiteboard feedback does not mention whiteboard guidance", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [{ uid: "", prompt: "Tighten this", selector: "h1", tag: "h1", text: "Title" }],
    },
  });

  assert.doesNotMatch(output.next_step, /whiteboard/i);
});

test("a poll reporting the session ended by the user tells the agent to stop and not reopen", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "ended", ended_by: "user" },
  });

  assert.equal(output.session.status, "ended");
  assert.equal(output.session.ended_by, "user");
  assert.match(output.next_step, /user ended this Lavish Editor session/);
  assert.match(output.next_step, /Stop polling/);
  assert.match(output.next_step, /do not run `lavish-safe \/tmp\/report\.html` to reopen it/);
  assert.match(output.next_step, /deliver any remaining updates directly in this conversation/i);
  assert.match(output.next_step, /lavish-safe \/tmp\/report\.html --reopen/);
});

test("a poll reporting an agent-ended session allows a plain reopen if still needed", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "ended", ended_by: "agent" },
  });

  assert.equal(output.session.ended_by, "agent");
  assert.match(output.next_step, /Stop polling/);
  assert.match(output.next_step, /lavish-safe \/tmp\/report\.html`\s+to open a fresh session/);
  assert.doesNotMatch(output.next_step, /--reopen/);
});

test("the final feedback batch before a user end flags session_ended and skips the reopen instruction", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "bye" }],
      session_ended: true,
      ended_by: "user",
    },
  });

  assert.equal(output.session.session_ended, true);
  assert.equal(output.session.ended_by, "user");
  assert.match(output.next_step, /last feedback before the user ended the session/);
  assert.match(output.next_step, /Stop polling \/tmp\/report\.html and do not reopen it/);
  assert.match(output.next_step, /lavish-safe \/tmp\/report\.html --reopen/);
  assert.doesNotMatch(output.next_step, /reload or re-open/);
});

test("the final feedback batch before an agent end preserves ended_by and allows plain reopen", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "bye" }],
      session_ended: true,
      ended_by: "agent",
    },
  });

  assert.equal(output.session.session_ended, true);
  assert.equal(output.session.ended_by, "agent");
  assert.match(output.next_step, /last feedback before the Lavish Editor session ended/);
  assert.match(output.next_step, /lavish-safe \/tmp\/report\.html`\s+to open a fresh session/);
  assert.doesNotMatch(output.next_step, /--reopen/);
  assert.doesNotMatch(output.next_step, /user ended this Lavish Editor session/);
});

test("final user-ended feedback still reports a fatal artifact failure without reopening", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      prompts: [],
      artifact_failures: [{ kind: "artifact-unavailable", detail: "HTTP 404", severity: "fatal" }],
      session_ended: true,
      ended_by: "user",
    },
  });

  assert.match(output.next_step, /fatal artifact failure/);
  assert.match(output.next_step, /confirm it renders without reopening this ended Lavish session/);
  assert.doesNotMatch(output.next_step, /--reopen/);
});

test("final agent-ended feedback points a fatal artifact failure at a fresh session", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      prompts: [],
      artifact_failures: [{ kind: "artifact-unavailable", detail: "HTTP 404", severity: "fatal" }],
      session_ended: true,
      ended_by: "agent",
    },
  });

  assert.match(output.next_step, /fatal artifact failure/);
  assert.match(output.next_step, /to open a fresh session/);
});

test("poll wait messages tell watching agents the silence is normal", () => {
  const banner = pollWaitBannerText("/tmp/report.html");
  assert.match(banner, /\[lavish-safe\]/);
  assert.match(banner, /Long-polling for user feedback/);
  assert.match(banner, /stays silent/);
  assert.match(banner, /leave it running/i);
  assert.match(banner, /feedback remains queued until delivery/);

  const tick = pollWaitTickText(3 * 60_000);
  assert.match(tick, /\[lavish-safe\]/);
  assert.match(tick, /Still waiting for user feedback \(3m\)/);
  assert.match(tick, /leave this running/i);

  const interrupted = pollInterruptedText("/tmp/report.html");
  assert.match(interrupted, /\[lavish-safe\]/);
  assert.match(interrupted, /Poll interrupted/);
  assert.match(interrupted, /user may still be reviewing/);
  assert.match(interrupted, /lavish-safe poll \/tmp\/report\.html/);
  assert.match(interrupted, /feedback remains queued until delivery/);
});

// LAVISH-HARDENED: upstream's opt-in Herdr chime spawned an external `herdr` binary from
// PATH whenever a poll started waiting. This build launches no helper processes, so the hook,
// its env switches, and the poll-state header it keyed off were not taken from upstream.
test("poll has no Herdr notification hook and its help never mentions one", async () => {
  const cli = await import("../src/cli.js");
  assert.equal("herdrPollChimeEnabled" in cli, false);
  assert.equal("notifyHerdrPollReady" in cli, false);
  assert.doesNotMatch(getCommandHelp("poll"), /herdr/i);
});

test("poll wait reporter writes a banner immediately and heartbeats on an interval", async () => {
  const lines = [];
  const reporter = startPollWaitReporter({
    file: "/tmp/report.html",
    write: (line) => {
      lines.push(line);
    },
    intervalMs: 5,
  });

  try {
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Long-polling for user feedback/);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(lines.length >= 2, "emits heartbeat lines while waiting");
    assert.match(lines[1], /Still waiting for user feedback/);
  } finally {
    reporter.stop();
  }

  const countAfterStop = lines.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(lines.length, countAfterStop, "stops heartbeating after stop()");
});

test("poll wait reporter still banners without ticks when narration is off", async () => {
  const lines = [];
  const reporter = startPollWaitReporter({
    file: "/tmp/report.html",
    write: (line) => {
      lines.push(line);
    },
    intervalMs: 5,
    narrateTicks: false,
  });

  try {
    assert.equal(lines.length, 1, "the one-shot not-hung banner is unconditional");
    assert.match(lines[0], /Long-polling for user feedback/);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(lines.length, 1, "suppresses the recurring heartbeat lines");
  } finally {
    reporter.stop();
  }
});

test("shouldNarratePollWaitTicks heartbeats only in an interactive terminal", () => {
  assert.equal(shouldNarratePollWaitTicks({ isTTY: true }), true);
  assert.equal(shouldNarratePollWaitTicks({ isTTY: undefined }), false);
  assert.equal(shouldNarratePollWaitTicks({ isTTY: false }), false);
});

test("spawned poll with piped stderr banners once and leaves re-run guidance when killed", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-poll-wait-test-`);
  const artifact = `${stateDir}/artifact.html`;
  await writeFile(artifact, "<html><body>hello</body></html>", "utf8");
  const server = await serve({ port: 0, stateFile: `${stateDir}/state.json`, version: VERSION });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    assert.ok(sessionResponse.ok, "session opens");

    const key = sessionKey(await canonicalFile(artifact));

    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "poll", artifact],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_PORT: String(server.port) },
      },
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    await waitForPollListening(base, key);
    assert.equal(
      stderr.match(/Long-polling for user feedback/g)?.length,
      1,
      "piped stderr still gets the one-shot not-hung banner",
    );
    assert.doesNotMatch(stderr, /Still waiting for user feedback/, "the banner carries no immediate wait tick");

    // Wait for "close" rather than "exit": "exit" can fire while the final stderr chunk is
    // still in flight, so asserting on stderr at "exit" races the guidance message.
    const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    await closed;

    // Windows terminates Node child processes directly instead of delivering SIGTERM
    // to the child process's JavaScript signal handler.
    if (process.platform !== "win32") {
      assert.match(stderr, /Poll interrupted/);
      assert.match(stderr, /feedback remains queued until delivery/);
    }
  } finally {
    await server.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("browser-disconnected poll output asks before reopening or ending the resumable session", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "browser_disconnected" },
  });

  assert.deepEqual(output.session, { file: "/tmp/report.html", status: "browser_disconnected" });
  assert.match(output.next_step, /review window (?:was closed|disconnected)/i);
  assert.match(output.next_step, /ask the user/i);
  assert.match(output.next_step, /reopen/i);
  assert.match(output.next_step, /end the session/i);
  assert.match(output.next_step, /remains open|resumable/i);
  assert.doesNotMatch(output.next_step, /Run `lavish-axi \/tmp\/report\.html`/);
});

test("waiting next step reassures agents that re-running poll loses nothing", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "waiting" },
  });

  assert.match(output.next_step, /lavish-safe poll \/tmp\/report\.html/);
  assert.match(output.next_step, /without --timeout-ms/);
  assert.match(output.next_step, /feedback remains queued until delivery/);
});

test("html file arguments normalize to the hidden open command", () => {
  assert.deepEqual(normalizeArgv(["report.html"]), ["open", "report.html"]);
  assert.deepEqual(normalizeArgv(["--no-open", "report.html"]), ["open", "--no-open", "report.html"]);
  assert.deepEqual(normalizeArgv(["--no-gate", "report.html"]), ["open", "--no-gate", "report.html"]);
  assert.deepEqual(normalizeArgv(["poll", "report.html"]), ["poll", "report.html"]);
  assert.deepEqual(normalizeArgv(["setup", "hooks"]), ["setup", "hooks"]);
  assert.deepEqual(normalizeArgv(["playbook", "diagram"]), ["playbook", "diagram"]);
  assert.deepEqual(normalizeArgv(["design"]), ["design"]);
  assert.deepEqual(normalizeArgv(["--help"]), ["--help"]);
});

test("SDK reserved commands pass through instead of normalizing to open", () => {
  assert.deepEqual(normalizeArgv(["update"]), ["update"]);
  assert.deepEqual(normalizeArgv(["update", "--check"]), ["update", "--check"]);
  assert.deepEqual(normalizeArgv(["update", "--help"]), ["update", "--help"]);
});

// LAVISH-HARDENED: the SDK's built-in `update` fetched the npm registry and then told the
// agent to `npm install -g` the upstream package, which is not hardened. The preload records
// every fetch the CLI attempts, and npm runs offline so the SDK's `npm view` fallback cannot
// reach the registry either - this test never touches the network, even when it fails.
test("update refuses without contacting the npm registry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-axi-update-"));
  try {
    const fetchLog = path.join(dir, "fetch.log");
    const preload = path.join(dir, "record-fetch.mjs");
    await writeFile(
      preload,
      [
        'import { appendFileSync } from "node:fs";',
        "globalThis.fetch = async (url) => {",
        `  appendFileSync(${JSON.stringify(fetchLog)}, String(url) + "\\n");`,
        '  throw new Error("network disabled in this test");',
        "};",
        "",
      ].join("\n"),
    );
    const entry = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
    for (const args of [["update"], ["update", "--check"]]) {
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, entry, ...args], {
        env: { ...process.env, LAVISH_AXI_STATE_DIR: dir, LAVISH_AXI_TELEMETRY: "0", npm_config_offline: "true" },
        encoding: "utf8",
      });
      const command = args.join(" ");
      assert.equal(existsSync(fetchLog), false, `${command} attempted a network request`);
      assert.match(result.stdout, /`update` is removed in this hardened build/, command);
      assert.notEqual(result.status, 0, `${command} must exit non-zero`);
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// LAVISH-HARDENED: `setup` is removed, and so is everything it called - the hook
// directory resolvers, the ambient-context script, the settings merge, the writer and
// the per-client plugin registration. The fifteen tests that stood here exercised all
// of it against temporary HOME and COPILOT_HOME directories. The refusal itself is
// asserted above, in "the removed commands refuse and say why".
test("telemetry command names are anonymous and do not include file paths", () => {
  assert.equal(telemetryCommandName(["report.html"]), "open");
  assert.equal(telemetryCommandName(["poll", "/tmp/secret/report.html"]), "poll");
  assert.equal(telemetryCommandName(["end", "/tmp/secret/report.html"]), "end");
  assert.equal(telemetryCommandName(["playbook", "diagram"]), "playbook");
  assert.equal(telemetryCommandName(["design"]), "design");
  assert.equal(telemetryCommandName([]), "home");
});

test("server spawn options detach without inheriting invalid streams", () => {
  const options = createServerSpawnOptions();

  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
});

test("server spawn options can persist detached server output to a log fd", () => {
  const options = createServerSpawnOptions(17);

  assert.equal(options.detached, true);
  assert.deepEqual(options.stdio, ["ignore", 17, 17]);
});

test("detached server entry dispatches the CLI", () => {
  const entry = fileURLToPath(new URL("../bin/lavish-axi-server.js", import.meta.url));
  const result = spawnSync(process.execPath, [entry, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\d+\.\d+\.\d+/);
});

// LAVISH-HARDENED: the launchers always run this checkout's dist/cli.mjs, so upstream's
// "a local build restarts the server" rule fired on every open and cut off every other
// agent's poll on the shared server. A developer who wants it opts in explicitly.
test("local built CLI opens restart the server only when a developer opts in", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const optIn = { LAVISH_AXI_DEV_RESTART: "1" };

  assert.equal(shouldForceRestartForLocalBuild(`${root}/dist/cli.mjs`, true, {}), false);
  assert.equal(shouldForceRestartForLocalBuild(`${root}/dist/cli.mjs`, true, { LAVISH_AXI_DEV_RESTART: "0" }), false);
  assert.equal(shouldForceRestartForLocalBuild(`${root}/dist/cli.mjs`, true, optIn), true);
  assert.equal(shouldForceRestartForLocalBuild(`${root}/bin/lavish-axi.js`, true, optIn), false);
  assert.equal(
    shouldForceRestartForLocalBuild("/usr/local/lib/node_modules/lavish-axi/dist/cli.mjs", false, optIn),
    false,
  );
});

test("shouldRestartServer reuses a server running the same version", () => {
  assert.equal(shouldRestartServer("0.1.4", { ok: true, version: "0.1.4" }), false);
});

test("shouldRestartServer restarts a same-version server after a Tailscale transition", () => {
  const health = { ok: true, app: "lavish-axi", version: "0.1.4", network_stale: true };
  assert.equal(shouldRestartServer("0.1.4", health), true);
  assert.equal(serverReplacementReason("0.1.4", health), "");
});

test("shouldRestartServer restarts same-version Lavish servers when forced", () => {
  assert.equal(shouldRestartServer("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.4" }, true), true);
  assert.equal(shouldRestartServer("0.1.4", { ok: true, app: "other", version: "0.1.4" }, true), false);
});

test("shouldRestartServer restarts when the running server reports a different version", () => {
  // Catches the upgrade scenario: client got bumped to 0.1.4 but a 0.1.3 server is still
  // holding the port from a previous invocation.
  assert.equal(shouldRestartServer("0.1.4", { ok: true, version: "0.1.3" }), true);
});

test("shouldRestartServer restarts when the running server predates the version handshake", () => {
  // Pre-handshake servers (any release older than this change) return `{ ok: true }` with
  // no version field. Treat that as "older than me" and restart so users actually get the
  // version they just installed.
  assert.equal(shouldRestartServer("0.1.4", { ok: true }), true);
});

test("shouldRestartServer does not restart when /health was unreachable", () => {
  // null = fetch failed; the caller should fall through to startServer instead of trying
  // to POST /shutdown against nothing.
  assert.equal(shouldRestartServer("0.1.4", null), false);
});

// Every other open review page is told why its server went away, so the reason has to name the
// branch that actually fired: a local-build force replaces a server of the same version, and
// calling that an update is false on both counts.
test("serverReplacementReason names a local-build force apart from a real version change", () => {
  assert.equal(serverReplacementReason("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.3" }), "upgrade");
  assert.equal(serverReplacementReason("0.1.4", { ok: true, app: "lavish-axi" }), "upgrade");
  assert.equal(
    serverReplacementReason("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.4" }, true),
    "local-build",
  );
  // A version difference is an upgrade even when the local-build force is also set.
  assert.equal(serverReplacementReason("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.3" }, true), "upgrade");
});

test("serverReplacementReason names nothing when no replacement is warranted", () => {
  assert.equal(serverReplacementReason("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.4" }), "");
  assert.equal(serverReplacementReason("0.1.4", null), "");
});

test("shouldKillProcessOnPort does not kill unidentified health responders", () => {
  assert.equal(shouldKillProcessOnPort("0.1.4", { ok: true, app: "other", version: "0.1.3" }), false);
});

test("shouldKillProcessOnPort kills pre-handshake Lavish servers after shutdown fails", () => {
  assert.equal(shouldKillProcessOnPort("0.1.4", { ok: true }), true);
});

test("shouldKillProcessOnPort only kills Lavish servers with a mismatched version", () => {
  assert.equal(shouldKillProcessOnPort("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.3" }), true);
  assert.equal(shouldKillProcessOnPort("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.4" }), false);
});

test("shutdownServerOnPort kills pre-handshake Lavish servers when shutdown does not free the port", async () => {
  let shutdowns = 0;
  let kills = 0;
  const portFreeResults = [false, true];

  const output = await shutdownServerOnPort(4387, {
    baseUrl: "http://127.0.0.1:4387",
    currentVersion: "0.1.4",
    fetchHealth: async () => ({ ok: true }),
    requestShutdown: async () => {
      shutdowns += 1;
    },
    waitForPortFree: async () => portFreeResults.shift() ?? false,
    killServerProcess: () => {
      kills += 1;
      return true;
    },
    processMatchesLavish: () => true,
  });

  assert.equal(shutdowns, 1);
  assert.equal(kills, 1);
  assert.deepEqual(output, { server: { status: "stopped", port: 4387 } });
});

test("shutdownServerOnPort ignores unidentified health responders", async () => {
  let shutdowns = 0;
  let kills = 0;

  const output = await shutdownServerOnPort(4387, {
    baseUrl: "http://127.0.0.1:4387",
    currentVersion: "0.1.4",
    fetchHealth: async () => ({ ok: true }),
    requestShutdown: async () => {
      shutdowns += 1;
    },
    waitForPortFree: async () => false,
    killServerProcess: () => {
      kills += 1;
      return true;
    },
    processMatchesLavish: () => false,
  });

  assert.equal(shutdowns, 0);
  assert.equal(kills, 0);
  assert.deepEqual(output, { server: { status: "not-lavish", port: 4387 } });
});

test("open can resume a session without opening another browser window", () => {
  assert.equal(shouldOpenBrowser(["--no-open", "artifact.html"], {}), false);
  assert.equal(shouldOpenBrowser(["artifact.html", "--no-open"], {}), false);
  assert.equal(shouldOpenBrowser(["--no-gate", "artifact.html"], {}), true);
  assert.equal(shouldOpenBrowser(["artifact.html"], { LAVISH_AXI_NO_OPEN: "1" }), false);
  assert.equal(shouldOpenBrowser(["artifact.html"], {}), true);
  assert.match(getCommandHelp("open"), /--no-open/);
  assert.match(getCommandHelp("open"), /--no-gate/);
  assert.match(getCommandHelp("open"), /--reopen/);
  assert.match(getCommandHelp("playbook"), /diagram/);
  assert.match(getCommandHelp("playbook"), /code/);
  assert.match(getCommandHelp("playbook"), /input/);
  assert.doesNotMatch(getCommandHelp("playbook"), new RegExp(`${"di"}ff, input`));
  assert.doesNotMatch(getCommandHelp("playbook"), /interactive/);
  assert.match(getCommandHelp("design"), /DaisyUI/);
  assert.match(getCommandHelp("design"), /lavish-safe design/);
  assert.match(getCommandHelp("design"), /portable/);
  assert.ok(getCommandHelp("design").includes(DESIGN_PRIORITY_RULE), "design help embeds the single-sourced rule");
  assert.match(getCommandHelp("design"), /fallback, not the default/i);
  assert.match(getCommandHelp("design"), /inspect the subject project/i);
  assert.doesNotMatch(getCommandHelp("design"), /auto-injects/);
});

test("polling a file without an active session tells the agent to open it first", () => {
  assert.throws(
    () => createPollOutput({ file: "/tmp/report.html", response: { status: "missing" } }),
    (error) => {
      assert.ok(error instanceof AxiError);
      assert.equal(error.code, "NOT_FOUND");
      assert.match(error.message, /No active Lavish Editor session/);
      assert.ok(error.suggestions.some((item) => item.includes("lavish-safe /tmp/report.html")));
      return true;
    },
  );
});

test("network fetch failures become structured Lavish server errors", async () => {
  await assert.rejects(
    () => fetchJson("http://127.0.0.1:1/api/poll"),
    (error) => {
      assert.ok(error instanceof AxiError);
      assert.equal(error.code, "SERVER_ERROR");
      assert.match(error.message, /Lavish Editor server connection failed/);
      assert.ok(error.suggestions.some((item) => item.includes("lavish-safe server --verbose")));
      return true;
    },
  );
});

test("fetchJson retries transient connection failures", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (requests === 1) {
      req.socket.destroy();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "waiting" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
    const port = address.port;
    const result = await fetchJson(`http://127.0.0.1:${port}/api/poll`, { retries: 1, retryDelayMs: 1 });

    assert.deepEqual(result, { status: "waiting" });
    assert.equal(requests, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchJson reports interrupted response body failures without retrying", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
    const port = address.port;

    await assert.rejects(
      () => fetchJson(`http://127.0.0.1:${port}/api/poll`, { retries: 1, retryDelayMs: 1 }),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "SERVER_ERROR");
        assert.match(error.message, /Lavish Editor poll response was interrupted/);
        return true;
      },
    );
    assert.equal(requests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("stop command shuts down the running server on the configured port", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-stop-test-`);
  const server = await serve({ port: 0, stateFile: `${dir}/state.json`, version: "9.9.9-test" });
  const previousStateDir = process.env.LAVISH_AXI_STATE_DIR;
  process.env.LAVISH_AXI_STATE_DIR = dir;
  try {
    const output = await stopCommand(["--port", String(server.port)]);
    assert.deepEqual(output, { server: { status: "stopped", port: server.port } });
    await server.done;
    await assert.rejects(() => fetch(`http://127.0.0.1:${server.port}/health`), /fetch failed|ECONNREFUSED/);
  } finally {
    if (previousStateDir === undefined) delete process.env.LAVISH_AXI_STATE_DIR;
    else process.env.LAVISH_AXI_STATE_DIR = previousStateDir;
    await server.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("stop command reports when no server is running", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-stop-test-`);
  try {
    // Bind then release a port so we know nothing is listening on it.
    const probe = await serve({ port: 0, stateFile: `${dir}/state.json` });
    const freePort = probe.port;
    await probe.close();

    const output = await stopCommand(["--port", String(freePort)]);
    assert.deepEqual(output, { server: { status: "not-running", port: freePort } });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// A stand-in for a running server of another version: it answers /health, records what the CLI
// actually puts on the wire at /shutdown, and then frees the port like a real one.
async function startShutdownRecorder(version = "0.0.0-previous") {
  const bodies = [];
  const server = createServer((req, res) => {
    if (new URL(req.url || "/", "http://localhost").pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "lavish-axi", version }));
      return;
    }
    if (req.url === "/shutdown" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        bodies.push(raw ? JSON.parse(raw) : {});
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "shutting-down" }));
        server.close();
        server.closeAllConnections?.();
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { bodies, port: address.port, close: () => server.close() };
}

test("lavish-safe stop tells the server it was stopped, and names no session to reload", async () => {
  const recorder = await startShutdownRecorder();
  try {
    const output = await shutdownServerOnPort(recorder.port, {
      baseUrl: `http://127.0.0.1:${recorder.port}`,
      currentVersion: "0.1.4",
    });

    assert.deepEqual(recorder.bodies, [{ reason: "stop" }]);
    assert.equal(output.server.status, "stopped");
  } finally {
    recorder.close();
  }
});

// The page being opened is the one that reloads itself, and the server picks it by key, so the
// key the CLI sends has to be the canonical session key for the file - an empty or non-canonical
// one silently degrades the feature to "nobody reloads, everybody gets a banner".
test("opening an artifact names that session as the one to reload across a version upgrade", async () => {
  const recorder = await startShutdownRecorder();
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-open-reload-"));
  const stateDir = path.join(dir, "state");
  const nested = path.join(dir, "pages");
  await mkdir(nested, { recursive: true });
  const artifact = path.join(nested, "board.html");
  await writeFile(artifact, "<!doctype html><html><body>board</body></html>");
  const base = `http://127.0.0.1:${recorder.port}`;

  try {
    // Spawned asynchronously on purpose: the recorder runs in this process, so a blocking
    // spawnSync would deadlock the CLI's own /health request against it.
    const child = spawn(
      process.execPath,
      // A path with a `..` hop: the key must come from the canonicalized file, not this spelling.
      [
        fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)),
        path.join(nested, "..", "pages", "board.html"),
        "--no-open",
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          LAVISH_AXI_PORT: String(recorder.port),
          LAVISH_AXI_STATE_DIR: stateDir,
          LAVISH_AXI_TELEMETRY: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    const code = await new Promise((resolve) => child.on("exit", resolve));

    assert.equal(code, 0, stderr);
    assert.deepEqual(recorder.bodies, [{ reload_key: sessionKey(await canonicalFile(artifact)), reason: "upgrade" }]);
  } finally {
    // The CLI replaced the recorder with a real server on that port; stop it again.
    await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
    for (let i = 0; i < 30; i += 1) {
      const alive = await fetch(`${base}/health`).then(
        () => true,
        () => false,
      );
      if (!alive) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    recorder.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveShareRequest publishes a public page by default", () => {
  const request = resolveShareRequest(["report.html"]);

  assert.equal(request.mode, "create");
  assert.equal(request.file, "report.html");
  assert.equal(request.password, undefined);
  assert.equal(request.generatedPassword, false);
});

test("resolveShareRequest --private mints a password instead of asking the agent for one", () => {
  const request = resolveShareRequest(["report.html", "--private"]);

  assert.equal(request.mode, "create");
  assert.equal(request.generatedPassword, true);
  assert.match(String(request.password), /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
});

test("resolveShareRequest keeps an explicit password verbatim and refuses to also generate one", () => {
  assert.equal(resolveShareRequest(["report.html", "--password", "hunter2"]).password, "hunter2");
  assert.throws(() => resolveShareRequest(["report.html", "--password", "hunter2", "--private"]), /--private/);
});

test("resolveShareRequest reads the file path even when a password flag precedes it", () => {
  assert.equal(resolveShareRequest(["--password", "hunter2", "report.html"]).file, "report.html");
  assert.equal(resolveShareRequest(["--private", "report.html"]).file, "report.html");
});

test("resolveShareRequest requires both halves of the republish credential", () => {
  const request = resolveShareRequest(["report.html", "--site", "abc123", "--update-key", "uk_secret"]);

  assert.equal(request.mode, "update");
  assert.equal(request.siteId, "abc123");
  assert.equal(request.updateKey, "uk_secret");
  assert.equal(request.password, undefined, "an omitted password preserves the page's current one");
  assert.throws(() => resolveShareRequest(["report.html", "--site", "abc123"]), /--update-key/);
  assert.throws(() => resolveShareRequest(["report.html", "--update-key", "uk_secret"]), /--site/);
  assert.throws(() => resolveShareRequest(["--site", "abc123", "--update-key", "uk_secret"]), /HTML file/);
});

test("resolveShareRequest never asks the host to clear a password it silently ignores", () => {
  // The live host answers 200 to an empty password and leaves the page gated, so no argument
  // shape may produce one - a "" here would report a still-private page as public.
  for (const args of [
    ["report.html"],
    ["report.html", "--site", "abc123", "--update-key", "uk_secret"],
    ["report.html", "--private"],
    ["report.html", "--password", "hunter2"],
  ]) {
    assert.notEqual(resolveShareRequest(args).password, "", `${args.join(" ")} must not clear the password`);
  }
});

test("resolveShareRequest treats unpublish as a credentialed republish with no file", () => {
  const request = resolveShareRequest(["--unpublish", "--site", "abc123", "--update-key", "uk_secret"]);

  assert.equal(request.mode, "unpublish");
  assert.equal(request.siteId, "abc123");
  assert.equal(request.file, null);
  assert.throws(() => resolveShareRequest(["--unpublish", "--site", "abc123"]), /--update-key/);
  assert.throws(
    () => resolveShareRequest(["report.html", "--unpublish", "--site", "abc123", "--update-key", "uk"]),
    /--unpublish/,
  );
});

test("resolveShareRequest refuses a value flag that swallowed the next flag", () => {
  // An empty unquoted $PW in `share r.html --password $PW --site abc --update-key k` used to make
  // "--site" the password and silently ROTATE a live page to a literal nobody could recover.
  assert.throws(
    () => resolveShareRequest(["r.html", "--password", "--site", "abc", "--update-key", "k"]),
    /--password was given no value.*--site/s,
  );
  assert.throws(() => resolveShareRequest(["r.html", "--site", "--update-key", "k"]), /--site was given no value/);
  assert.throws(
    () => resolveShareRequest(["r.html", "--site", "abc", "--update-key", "--private"]),
    /--update-key was given no value/,
  );
  assert.throws(() => resolveShareRequest(["r.html", "--token", "--private"]), /--token was given no value/);
});

test("resolveShareRequest refuses an explicitly empty value flag", () => {
  for (const args of [
    ["r.html", "--password", ""],
    ["r.html", "--password="],
    ["r.html", "--password"],
    ["r.html", "--password", "   "],
  ]) {
    assert.throws(() => resolveShareRequest(args), /--password was given an empty value/, args.join(" "));
  }
  assert.throws(() => resolveShareRequest(["r.html", "--site=", "--update-key", "k"]), /--site was given an empty/);
});

test("resolveShareRequest still accepts a value that legitimately starts with dashes via the = form", () => {
  // The = form cannot swallow a following token, so it stays the escape hatch for such a value.
  assert.equal(resolveShareRequest(["r.html", "--password=--dashes--"]).password, "--dashes--");
});

test("resolveShareRequest rejects a bearer token on a republish or unpublish", () => {
  assert.equal(resolveShareRequest(["report.html", "--token", "tok_123"]).token, "tok_123");
  assert.throws(
    () => resolveShareRequest(["report.html", "--site", "abc123", "--update-key", "uk_secret", "--token", "tok_123"]),
    /--token only applies when creating a page/,
  );
  assert.throws(
    () => resolveShareRequest(["--unpublish", "--site", "abc123", "--update-key", "uk_secret", "--token", "tok_123"]),
    /--token only applies when creating a page/,
  );
});

test("createShareOutput hands back a generated password and tells the agent it is a shared secret", () => {
  const output = createShareOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", update_key: "uk_secret", status: "active" },
    warnings: [],
    passwordProtected: true,
    password: "xk4t-9rmb-2wqz",
  });

  assert.equal(output.share.password, "xk4t-9rmb-2wqz");
  assert.equal(output.share.visibility, "private");
  assert.match(output.next_step, /xk4t-9rmb-2wqz/);
  assert.match(output.next_step, /shared secret/i);
});

test("createShareOutput never echoes a password the caller chose", () => {
  const output = createShareOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", update_key: "uk_secret", status: "active" },
    warnings: [],
    passwordProtected: true,
  });

  assert.equal(output.share.password, undefined);
});

test("createShareUpdateOutput reports what a plain republish did, not a password state it cannot know", () => {
  // Lavish persists no site state, so a republish of a page created without a password would be
  // misreported by any claim that "the password was left unchanged".
  const output = createShareUpdateOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
    warnings: [],
  });

  assert.equal(output.share.url, "https://x.ht-ml.app/");
  assert.equal(output.share.visibility, "unchanged");
  assert.equal(output.share.password, undefined);
  assert.match(output.next_step, /same URL/i);
  assert.match(output.next_step, /did not touch the page's password/i);
  assert.match(output.next_step, /cannot tell you whether that is a password or none/i);
  assert.doesNotMatch(output.next_step, /password was left unchanged/i);
  assert.doesNotMatch(output.next_step, /it is password-protected/i);
});

test("createShareUpdateOutput surfaces a rotated password and never claims a page went public", () => {
  const rotated = createShareUpdateOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
    warnings: [],
    password: "xk4t-9rmb-2wqz",
    passwordProtected: true,
  });
  assert.equal(rotated.share.password, "xk4t-9rmb-2wqz");
  assert.equal(rotated.share.visibility, "private");

  const untouched = createShareUpdateOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
    warnings: [],
  });
  assert.equal(untouched.share.visibility, "unchanged");
  assert.doesNotMatch(untouched.next_step, /CLEARED|now public|is PUBLIC/i);
});

test("createShareUpdateOutput does not present a newly set password as an instant gate", () => {
  // Probed live: locking a page that was public left it answering uncredentialed CDN requests for
  // minutes, and Lavish persists no site state, so it cannot know the page was not public.
  const locked = createShareUpdateOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
    warnings: [],
    password: "xk4t-9rmb-2wqz",
    passwordProtected: true,
  });

  assert.match(locked.next_step, /NOT instant/i);
  assert.match(locked.next_step, /cach/i);
  assert.match(locked.next_step, /already private/i);

  // A plain republish sets no password, so it must not raise the caveat at all.
  const untouched = createShareUpdateOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
    warnings: [],
  });
  assert.doesNotMatch(untouched.next_step, /NOT instant/i);
});

test("createShareUpdateOutput says the host reported no URL rather than naming one", () => {
  const output = createShareUpdateOutput({
    source: "/tmp/report.html",
    site: { url: "", site_id: "abc123", status: "active" },
    warnings: [],
  });

  assert.equal(output.share.url, "");
  assert.match(output.next_step, /did not report a URL/i);
  assert.match(output.next_step, /abc123/);
  assert.doesNotMatch(JSON.stringify(output), /ht-ml\.app/);
});

test("createShareUnpublishOutput says the host reported no URL rather than naming one", () => {
  const output = createShareUnpublishOutput({ site: { url: "", site_id: "abc123", status: "active" } });

  assert.equal(output.share.url, "");
  assert.match(output.next_step, /did not report a URL/i);
  assert.doesNotMatch(output.next_step, /Replaced the page at /);
});

// A recovery hint is only recovery if the CLI accepts it. Pull the command Lavish printed out of
// the text it printed and run it back through the real argument parser, so a hint that drifts into
// a usage error - `--site`/`--update-key` with no HTML file was one - fails here instead of on the
// user's next paste.
function parseSuggestedShareCommand(text) {
  const match = /`lavish-safe share ([^`]+)`/.exec(String(text));
  assert.ok(match, `expected a suggested share command in: ${text}`);
  const argv = match[1].trim().split(/\s+/);
  const request = resolveShareRequest(argv);
  // `<html-file>` and `<key>` fail loudly when pasted literally - one is not a file, the other
  // earns a 401 - but ANY non-empty string is a valid password, so a placeholder that reaches the
  // parser as a password value would be accepted and would rotate a live page to a secret nobody
  // was told, which ht-ml.app cannot clear. A suggested command must never carry one.
  assert.ok(
    request.generatedPassword || request.password === undefined,
    `a suggested command must not dictate a password value, got ${request.password} from: ${argv.join(" ")}`,
  );
  return request;
}

test("createShareUnpublishOutput says the page still exists and how to bring it back", () => {
  const output = createShareUnpublishOutput({
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
  });

  assert.equal(output.share.site_id, "x");
  assert.equal(output.share.unpublished, true);
  assert.match(output.next_step, /not deleted|no delete/i);
  assert.match(output.next_step, /update_key/);
  // The recovery instruction has to be one the host actually honors: clearing is ignored.
  assert.doesNotMatch(output.next_step, /--clear-password/);
  assert.match(output.next_step, /--private/);
  assert.equal(parseSuggestedShareCommand(output.next_step).mode, "update");
  assert.doesNotMatch(JSON.stringify(output), /[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/);
});

test("createShareUnpublishOutput separates the immediate content swap from the lagging lock", () => {
  // Probed live: the PUT invalidated the CDN copy and the edge then served the NEW placeholder to
  // uncredentialed requests for minutes. So the old content is gone at once and what lingers is an
  // unlocked placeholder. Saying "no visitor can read the old content" while also saying the CDN
  // kept answering was self-contradictory, and the report may not imply the old page stays up.
  const output = createShareUnpublishOutput({
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
  });

  assert.match(output.next_step, /previous content is gone/i, "the swap must read as immediate");
  assert.match(output.next_step, /cach/i, "the lagging lock must still be disclosed");
  assert.match(output.next_step, /readable without the password/i);
  assert.doesNotMatch(output.next_step, /no visitor can read the old content/i);
});
