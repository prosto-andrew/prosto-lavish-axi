// LAVISH-FORK: the editor theme switcher in a real browser (specs/2026-10-18-theme-switcher-design.md
// 7 and 9). Only a browser shows whether the artifact frame, in its own process, learns the editor's
// side through the inherited color-scheme - and whether it ever sees the other side first. Opt-in
// like the other real-browser suites:
//   LAVISH_AXI_BROWSER_E2E=1 node --test test/chrome-theme.browser.test.js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findChrome, launchBrowser } from "./cdp-browser.js";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const chromePath = runBrowserE2e ? await findChrome() : "";
const browserSkip = !runBrowserE2e || (!chromePath && "Chrome or Chromium is required (set CHROME_PATH)");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repoRoot, "test/fixtures/theme/scheme-probe.html");

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

test(
  "the editor theme switcher themes the chrome and the artifact frame in a real browser",
  { skip: browserSkip, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-theme-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    let browser;
    try {
      const artifact = path.join(temp, "probe.html");
      await copyFile(fixture, artifact);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      browser = await launchBrowser({ chromePath, profileDir: path.join(temp, "chrome") });
      await browser.emulate("1440x1000x1");

      const chrome = async () =>
        JSON.parse(
          await browser.evaluate(
            'JSON.stringify({ side: document.documentElement.dataset.lavishTheme + "/" + document.documentElement.dataset.lavishScheme, background: getComputedStyle(document.body).backgroundColor, stored: localStorage.getItem("lavish-axi:theme") })',
          ),
        );
      const frame = async () =>
        JSON.parse(
          await browser.evaluateInArtifact(
            'JSON.stringify({ firstDark: window.__firstDark, dark: matchMedia("(prefers-color-scheme: dark)").matches, changes: window.__changes })',
          ),
        );

      // An explicit light choice in this origin's storage, whatever the machine's own theme is.
      await browser.open(url);
      await browser.evaluate(
        `localStorage.setItem("lavish-axi:theme", '{"mode":"light","light":"warm","dark":"ink"}')`,
      );
      await browser.open(url);
      await browser.wait(4500);
      const light = await chrome();
      assert.equal(light.side, "warm/light");
      assert.equal(light.background, "rgb(247, 243, 234)");
      const lightFrame = await frame();
      assert.equal(lightFrame.firstDark, false, "the artifact's first look is already light");
      assert.equal(lightFrame.dark, false);

      // A real click flips the side, and the artifact follows without a reload.
      await browser.evaluate(
        '() => { window.__artifactLoads = 0; document.getElementById("artifact").addEventListener("load", () => { window.__artifactLoads += 1; }); }',
      );
      await browser.clickInPage("#themeToggle");
      await browser.wait(500);
      const dark = await chrome();
      assert.equal(dark.side, "ink/dark");
      assert.equal(dark.background, "rgb(15, 17, 21)");
      assert.equal(JSON.parse(dark.stored).mode, "dark");
      const darkFrame = await frame();
      assert.equal(darkFrame.dark, true);
      assert.equal(darkFrame.changes.at(-1), true);
      assert.equal(
        await browser.evaluate("window.__artifactLoads"),
        0,
        "switching the theme never reloads the artifact",
      );

      // The choice holds across loads, and the artifact never sees the other side first.
      const firstLooks = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await browser.open(url);
        await browser.wait(4500);
        assert.equal((await chrome()).side, "ink/dark");
        firstLooks.push((await frame()).firstDark);
      }
      assert.deepEqual(firstLooks, [true, true, true, true, true]);

      // The toggle still fits the bar on a phone.
      await browser.emulate("320x700x1");
      await browser.wait(1000);
      const bar = JSON.parse(
        await browser.evaluate(
          'JSON.stringify({ scrollWidth: document.querySelector(".bar").scrollWidth, clientWidth: document.querySelector(".bar").clientWidth })',
        ),
      );
      assert.ok(bar.scrollWidth <= bar.clientWidth, `the bar overflows at 320px: ${JSON.stringify(bar)}`);
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      await browser?.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
);

// Final review #2: with the layout-issues button showing, a 320-340 px bar has no room for the theme
// toggle as well - it pushed the ⋯ menu off screen. There the toggle gives way (the ⋯ menu's Theme
// section still switches sides); on a roomier bar it stays.
test(
  "the theme toggle gives way on a narrow bar that shows layout issues",
  { skip: browserSkip, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-theme-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    let browser;
    try {
      const artifact = path.join(temp, "broken.html");
      await copyFile(path.join(repoRoot, "test/fixtures/layout-audit/control-broken-clipping.html"), artifact);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      browser = await launchBrowser({ chromePath, profileDir: path.join(temp, "chrome") });
      await browser.emulate("1440x1000x1");
      await browser.open(url);
      await browser.wait(6000);

      const bar = async () =>
        JSON.parse(
          await browser.evaluate(
            'JSON.stringify({ warnings: !document.getElementById("warningsWrap").hidden, toggle: getComputedStyle(document.getElementById("themeToggle")).display, moreRight: document.getElementById("moreButton").getBoundingClientRect().right, viewport: innerWidth })',
          ),
        );
      for (const width of [320, 340, 375]) {
        await browser.emulate(`${width}x700x1`);
        await browser.wait(800);
        const state = await bar();
        assert.equal(state.warnings, true, "the fixture's layout issues show their button");
        assert.ok(state.moreRight <= state.viewport, `${width}px: the ⋯ button ends at ${state.moreRight}`);
        if (width < 360) assert.equal(state.toggle, "none", `${width}px: the toggle gives way`);
        else assert.notEqual(state.toggle, "none", `${width}px: the toggle stays`);
      }
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      await browser?.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
);
