import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findChrome, launchBrowser, waitForValue } from "./cdp-browser.js";

// LAVISH-FORK: F2, the desktop conversation toggle measured in a real browser
// (specs/2026-10-30-desktop-conversation-toggle-design.md 7.4). From 861px the bar's panel button
// hides the conversation panel so the artifact takes the full width, keeps what the panel holds,
// survives a reload of the tab but not a fresh tab, and stays off the phone layout.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const chromePath = runBrowserE2e ? await findChrome() : "";
const browserSkip = !runBrowserE2e || (!chromePath && "Chrome or Chromium is required (set CHROME_PATH)");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(repoRoot, "test", "fixtures", "layout-audit");

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

const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Toggle fixture</title>
<style>body{margin:0;padding:24px;font-family:Georgia,serif;background:#fffbf3;color:#17130a}h1{margin:0 0 12px}section{border:1px solid #e8e1cf;border-radius:12px;padding:16px;margin:16px 0;background:#fff}</style>
</head><body>
<h1>Checkout redesign</h1>
<p id="annotate-me">Autofill the address from the browser profile.</p>
<section><h2>Step 2</h2><p>Card, Apple Pay, and Link.</p></section>
<section><h2>Step 3</h2><p>Review the order before paying.</p></section>
</body></html>`;

// Enough replies to make the conversation taller than the panel, so showing it has a place to scroll.
const REPLIES = Array.from(
  { length: 12 },
  (_, index) =>
    `Reply ${index + 1}: the checkout plan now covers address autofill, saved cards, and the review step, with the totals recomputed after every change.`,
);

const GEOMETRY = `() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; };
  const panel = document.getElementById("panel");
  const button = document.getElementById("panelButton");
  const count = document.getElementById("panelButtonCount");
  return JSON.stringify({
    viewport: { width: innerWidth, height: innerHeight },
    hidden: document.body.classList.contains("panel-hidden"),
    panelDisplay: getComputedStyle(panel).display,
    panelPosition: getComputedStyle(panel).position,
    panel: rect(panel),
    frame: rect(document.getElementById("artifact")),
    button: {
      display: getComputedStyle(button).display,
      rect: rect(button),
      expanded: button.getAttribute("aria-expanded"),
      count: count.textContent,
      countHidden: count.hidden,
    },
    more: rect(document.getElementById("moreButton")),
    active: document.activeElement ? document.activeElement.id : "",
    input: document.getElementById("chatInput").value,
    queued: document.querySelectorAll(".bubble.queued").length,
    documentScrollable: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
  });
}`;

function parsed(value) {
  let result = value;
  while (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      break;
    }
  }
  return result;
}

test("the conversation panel hides and returns on a wide screen", { skip: browserSkip, timeout: 300_000 }, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "lavish-desktop-toggle-"));
  const port = await freePort();
  const lavishEnv = {
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
  };
  let browser;

  async function geometry() {
    return parsed(await browser.evaluate(GEOMETRY));
  }

  function openSession(file) {
    const output = run(process.execPath, ["bin/lavish-axi.js", file, "--no-open"], lavishEnv);
    const url = output.match(/url:\s*"([^"]+)"/)?.[1];
    assert.ok(url, output);
    return url;
  }

  try {
    browser = await launchBrowser({ chromePath, profileDir: path.join(temp, "chrome") });
    const artifact = path.join(temp, "review.html");
    await writeFile(artifact, ARTIFACT);
    const url = openSession(artifact);
    for (const reply of REPLIES) {
      run(
        process.execPath,
        ["bin/lavish-axi.js", "poll", artifact, "--agent-reply", reply, "--timeout-ms", "200"],
        lavishEnv,
        30_000,
      );
    }

    // ---- Shown: the side-by-side layout as before ----
    await browser.emulate("1440x1000x1");
    await browser.open(url);
    await browser.wait(4000);
    let g = await geometry();
    assert.equal(g.hidden, false);
    assert.equal(g.panel.right - g.panel.left, 360, "the shown panel keeps its width");
    assert.equal(g.frame.right, g.panel.left, "artifact and panel sit side by side");
    assert.equal(g.button.expanded, "true");
    assert.notEqual(g.button.display, "none");

    // ---- Hidden: the artifact takes the whole width ----
    await browser.clickInPage("#chatInput");
    await browser.type("Unsent words");
    await browser.clickInPage("#panelButton");
    await browser.wait(300);
    g = await geometry();
    assert.equal(g.hidden, true);
    assert.equal(g.panelDisplay, "none");
    assert.equal(g.frame.left, 0);
    assert.equal(g.frame.right, g.viewport.width, `the artifact spans the viewport: ${JSON.stringify(g.frame)}`);
    assert.equal(g.documentScrollable, false, "the page itself never scrolls");
    assert.equal(g.active, "panelButton", "focus stays on the button, never inside the hidden panel");
    assert.equal(g.button.expanded, "false");

    await browser.clickInPage("#panelButton");
    await browser.wait(300);
    g = await geometry();
    assert.equal(g.hidden, false);
    assert.equal(g.input, "Unsent words", "showing the panel brings back what was typed");

    // ---- Showing the panel lands on the end of the conversation ----
    await browser.evaluate('() => { document.getElementById("panelScroll").scrollTop = 0; return "ok"; }');
    await browser.clickInPage("#panelButton");
    await browser.wait(300);
    await browser.clickInPage("#panelButton");
    await browser.wait(300);
    const scroll = parsed(
      await browser.evaluate(
        '() => { const s = document.getElementById("panelScroll"); return JSON.stringify({ top: Math.round(s.scrollTop), client: s.clientHeight, height: s.scrollHeight }); }',
      ),
    );
    assert.ok(scroll.height > scroll.client, `the fixture conversation overflows: ${JSON.stringify(scroll)}`);
    assert.ok(
      scroll.top + scroll.client >= scroll.height - 1,
      `the end of the conversation is on screen: ${JSON.stringify(scroll)}`,
    );

    // ---- A note queued from the artifact while hidden badges the button ----
    await browser.clickInPage("#panelButton");
    await browser.wait(300);
    await browser.clickInArtifact("#annotate-me");
    await browser.wait(800);
    await browser.type("Note while hidden");
    await browser.clickInArtifact(".lavish-annotation-card .lavish-send", { host: ".lavish-annotation-root" });
    await browser.wait(800);
    g = await geometry();
    assert.equal(g.hidden, true);
    assert.equal(g.button.countHidden, false);
    assert.equal(g.button.count, "1");

    // ---- A reload of the tab keeps the panel hidden ----
    await browser.open(url);
    await browser.wait(3000);
    g = await geometry();
    assert.equal(g.hidden, true);
    assert.equal(g.button.count, "1");

    // ---- Keyboard: Enter on the focused button toggles, focus stays on it ----
    await browser.evaluate('() => { document.getElementById("panelButton").focus(); return "ok"; }');
    await browser.press("Enter");
    await browser.wait(300);
    g = await geometry();
    assert.equal(g.hidden, false);
    assert.equal(g.active, "panelButton");
    assert.equal(g.queued, 1, "the note queued while hidden is in the queue");
    assert.equal(g.input, "Unsent words");
    await browser.press("Enter");
    await browser.wait(300);
    assert.equal((await geometry()).hidden, true);

    // ---- A fresh tab starts with the panel shown ----
    const tab = await browser.openTab(url);
    await browser.wait(3000);
    const fresh = parsed(
      await tab.evaluate(
        '() => JSON.stringify({ hidden: document.body.classList.contains("panel-hidden"), expanded: document.getElementById("panelButton").getAttribute("aria-expanded") })',
      ),
    );
    assert.deepEqual(fresh, { hidden: false, expanded: "true" });
    await tab.close();

    // ---- 861px with layout issues showing: the whole bar still fits ----
    const clipping = path.join(temp, "clipping.html");
    await copyFile(path.join(fixtures, "control-broken-clipping.html"), clipping);
    const clippingUrl = openSession(clipping);
    await browser.emulate("861x900x1");
    await browser.open(clippingUrl);
    const warningsHidden = await waitForValue(
      () => browser.evaluate('() => document.getElementById("warningsWrap").hidden'),
      (hidden) => hidden === false,
      { timeoutMs: 15_000 },
    );
    assert.equal(warningsHidden, false, "the fixture raises layout issues");
    g = await geometry();
    assert.notEqual(g.button.display, "none");
    assert.ok(g.more.right <= g.viewport.width, `the more menu stays on screen: ${JSON.stringify(g.more)}`);
    assert.ok(g.button.rect.right <= g.more.left, "the panel button sits before the more menu");

    // ---- 860px: the phone dock owns the panel and the button is gone ----
    await browser.emulate("860x900x1");
    await browser.open(url);
    await browser.wait(3000);
    g = await geometry();
    assert.equal(g.button.display, "none");
    assert.equal(g.panelPosition, "fixed", "the phone dock and sheet apply");
  } finally {
    run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
    await browser?.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
