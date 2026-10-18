import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findChrome, launchBrowser, waitForValue } from "./cdp-browser.js";

// The behavioral regression boundary for passive layout triage. Before this change the browser's
// audit returned straight out of `lavish-safe poll` with no user action, so several individually
// reasonable agent fixes produced repeated edit/reload cycles while the user was mid-review. Every
// assertion here pins the replacement contract in a real browser: detection is passive, the user
// decides what becomes work, and only a queued batch wakes the agent.
// LAVISH-HARDENED: headless Chrome over CDP (`./cdp-browser.js`) instead of chrome-devtools-axi.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const chromePath = runBrowserE2e ? await findChrome() : "";
const browserSkip = !runBrowserE2e || (!chromePath && "Chrome or Chromium is required (set CHROME_PATH)");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(repoRoot, "test/fixtures/layout-audit");

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
  "passive layout-warning triage works end to end in a real browser",
  { skip: browserSkip, timeout: 420_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-warning-inbox-"));
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

    function openArtifact(file, args = []) {
      const output = run(process.execPath, ["bin/lavish-axi.js", file, "--no-open", ...args], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      return url;
    }

    function poll(file, timeoutMs) {
      return run(
        process.execPath,
        ["bin/lavish-axi.js", "poll", file, "--timeout-ms", String(timeoutMs)],
        lavishEnv,
        timeoutMs + 45_000,
      );
    }

    /** Evaluate an expression in the chrome page and return its JSON-decoded result. */
    async function evaluate(expression) {
      let value = await browser.evaluate(expression);
      // The expressions here already JSON.stringify their result - so unwrap until it stops being
      // encoded JSON.
      while (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }

    function inbox() {
      return evaluate(
        "JSON.stringify({" +
          ' hidden: document.getElementById("warningsWrap").hidden,' +
          ' badge: document.getElementById("warningsCount").textContent,' +
          ' label: document.getElementById("warningsButton").getAttribute("aria-label"),' +
          ' gate: document.body.classList.contains("layout-gate-active"),' +
          ' pills: document.querySelectorAll(".bubble.queued").length,' +
          " loads: window.__lavishArtifactLoads," +
          ' rows: [...document.querySelectorAll(".warning-row")].map((row) => ({' +
          '   title: row.querySelector(".warning-title").textContent,' +
          '   target: row.querySelector(".warning-target").textContent,' +
          '   status: [...row.querySelectorAll(".warning-chip")][1].textContent,' +
          '   viewport: [...row.querySelectorAll(".warning-chip")][2].textContent,' +
          '   selectable: !row.querySelector(".warning-select").disabled,' +
          " }))" +
          "})",
      );
    }

    // Count artifact iframe loads from inside the chrome so "how many refreshes did that cost?" is
    // directly observable. Re-running it resets the counter; a viewport emulation reloads the page
    // and clears both, so this is called again after every viewport change.
    async function instrumentArtifactLoads() {
      await browser.evaluate(
        '() => { window.__lavishArtifactLoads = 0; if (window.__lavishArtifactLoadsWired) return "reset"; window.__lavishArtifactLoadsWired = true; document.getElementById("artifact").addEventListener("load", () => { window.__lavishArtifactLoads += 1; }); return "wired"; }',
      );
    }

    async function openReview(url, settleMs = 4500) {
      await browser.open(url);
      await browser.wait(settleMs);
      await instrumentArtifactLoads();
    }

    function wait(ms) {
      return browser.wait(ms);
    }

    try {
      browser = await launchBrowser({ chromePath, profileDir: path.join(temp, "chrome") });
      // ---------------------------------------------------------------------
      // Detection is passive: a badge and a list, a still-pending poll, no refresh.
      // ---------------------------------------------------------------------
      const artifact = path.join(temp, "review.html");
      await copyFile(path.join(fixtures, "control-broken-clipping.html"), artifact);
      const url = openArtifact(artifact);
      await browser.emulate("1440x1000x1");
      await openReview(url);

      const detected = await inbox();
      assert.equal(detected.hidden, false, "the warning button appears once there is unresolved work");
      assert.equal(detected.badge, "3");
      assert.equal(detected.label, "3 unresolved layout issues");
      assert.equal(detected.gate, false, "the artifact is revealed, not held hostage pending a repair");
      assert.equal(detected.loads, 0, "detection alone never refreshes the artifact");
      assert.equal(detected.pills, 0, "detection alone never queues feedback");

      openArtifact(artifact);
      await writeFile(artifact, `${await readFile(artifact, "utf8")}\n<!-- reopened -->`);
      await wait(4500);
      const reopened = await inbox();
      assert.equal(reopened.loads, 1, "reopening the session preserves live artifact reloads");
      assert.equal(
        await evaluate(
          'JSON.stringify(new URL(document.getElementById("artifact").src).searchParams.get("artifact_revision"))',
        ),
        2,
      );
      const sessionKey = new URL(url).pathname.split("/").pop();
      // LAVISH-HARDENED: revision 2's pass lands a moment after the frame shows the new revision, so
      // wait up to 8 s more for it.
      const warningState = await waitForValue(
        () =>
          evaluate(
            `fetch("/api/${sessionKey}/layout-warnings").then((response) => response.json()).then((data) => JSON.stringify(data))`,
          ),
        (state) => state.warnings.every((warning) => warning.last_seen_revision === 2),
        { timeoutMs: 8000 },
      );
      assert.ok(warningState.warnings.every((warning) => warning.last_seen_revision === 2));
      await instrumentArtifactLoads();

      // A bounded poll must run out its timeout rather than return on detection.
      assert.match(poll(artifact, 4000), /status:\s*waiting/);

      // ---------------------------------------------------------------------
      // Repeat reports of the same findings do not inflate the count.
      // ---------------------------------------------------------------------
      await browser.evaluate('() => window.dispatchEvent(new Event("resize"))');
      await wait(3000);
      assert.equal((await inbox()).badge, "3", "a repeat diagnostic pass deduplicates onto the same records");

      // ---------------------------------------------------------------------
      // The drawer is accessible and does not break narrow or wide layouts.
      // ---------------------------------------------------------------------
      const opened = await evaluate(
        '(() => { document.getElementById("warningsButton").click(); return JSON.stringify({' +
          ' expanded: document.getElementById("warningsButton").getAttribute("aria-expanded"),' +
          ' role: document.getElementById("warningsDrawer").getAttribute("role"),' +
          ' labelledby: document.getElementById("warningsDrawer").getAttribute("aria-labelledby"),' +
          " focus: document.activeElement && document.activeElement.id," +
          ' checkboxLabel: document.querySelector(".warning-select").getAttribute("aria-label"),' +
          ' selectAllChecked: document.getElementById("warningsSelectAll").checked,' +
          ' queueDisabled: document.getElementById("warningsQueueButton").disabled,' +
          " docOverflow: document.documentElement.scrollWidth - window.innerWidth," +
          ' drawerRight: Math.round(document.getElementById("warningsDrawer").getBoundingClientRect().right),' +
          " innerWidth: window.innerWidth," +
          "}); })()",
      );
      assert.equal(opened.expanded, "true");
      assert.equal(opened.role, "dialog");
      assert.equal(opened.labelledby, "warningsTitle");
      assert.equal(opened.focus, "warningsSelectAll", "focus moves into the drawer");
      assert.match(opened.checkboxLabel, /^Select /);
      assert.equal(opened.selectAllChecked, false, "default selection never silently authorizes everything");
      assert.equal(opened.queueDisabled, true);
      assert.equal(opened.docOverflow, 0, "the wide layout does not scroll sideways");
      assert.ok(opened.drawerRight <= opened.innerWidth, "the drawer stays inside the viewport");

      const escaped = await evaluate(
        '(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return JSON.stringify({' +
          ' hidden: document.getElementById("warningsDrawer").hidden,' +
          " focus: document.activeElement && document.activeElement.id," +
          "}); })()",
      );
      assert.equal(escaped.hidden, true, "Escape closes the drawer");
      assert.equal(escaped.focus, "warningsButton", "focus returns to the trigger");

      await browser.emulate("420x900x1,mobile,touch");
      await wait(3500);
      await instrumentArtifactLoads();
      const narrow = await evaluate(
        '(() => { document.getElementById("warningsButton").click(); const box = document.getElementById("warningsDrawer").getBoundingClientRect(); return JSON.stringify({' +
          " docOverflow: document.documentElement.scrollWidth - window.innerWidth," +
          ' barOverflow: document.querySelector(".bar").scrollWidth - window.innerWidth,' +
          " left: Math.round(box.left), right: Math.round(box.right), innerWidth: window.innerWidth," +
          ' listOverflow: document.getElementById("warningsList").scrollWidth - document.getElementById("warningsList").clientWidth,' +
          "}); })()",
      );
      assert.equal(narrow.docOverflow, 0, "the narrow layout does not scroll sideways");
      assert.equal(narrow.barOverflow, 0, "the top bar still fits at phone width");
      assert.ok(narrow.left >= 0 && narrow.right <= narrow.innerWidth, "the drawer fits the narrow viewport");
      assert.equal(narrow.listOverflow, 0, "the list itself never overflows horizontally");
      await browser.evaluate('() => document.getElementById("warningsButton").click()');

      // A phone-width pass adds phone-scoped findings without clearing the desktop ones.
      const mobileDetected = await inbox();
      assert.ok(Number(mobileDetected.badge) > 3, "a second viewport adds its own warnings");
      assert.ok(
        mobileDetected.rows.some((row) => row.viewport.startsWith("Desktop")),
        "a mobile pass cannot clear a desktop warning",
      );

      await browser.emulate("1440x1000x1");
      await wait(3500);
      await instrumentArtifactLoads();

      // ---------------------------------------------------------------------
      // Selecting a subset queues exactly one ordinary prompt with only those warnings, and
      // queueing does not clear anything.
      // ---------------------------------------------------------------------
      const beforeQueue = await inbox();
      const desktopRows = beforeQueue.rows.filter((row) => row.viewport.startsWith("Desktop"));
      assert.equal(desktopRows.length, 3);

      const selected = await evaluate(
        '(() => { document.getElementById("warningsButton").click();' +
          ' const rows = [...document.querySelectorAll(".warning-row")].filter((row) => [...row.querySelectorAll(".warning-chip")][2].textContent.startsWith("Desktop"));' +
          ' rows[0].querySelector(".warning-select").click(); rows[2].querySelector(".warning-select").click();' +
          ' return JSON.stringify({ selected: document.getElementById("warningsSelected").textContent, queueDisabled: document.getElementById("warningsQueueButton").disabled,' +
          ' targets: [rows[0].querySelector(".warning-target").textContent, rows[2].querySelector(".warning-target").textContent] }); })()',
      );
      assert.equal(selected.selected, "2 selected");
      assert.equal(selected.queueDisabled, false);

      await browser.evaluate('() => document.getElementById("warningsQueueButton").click()');
      await wait(1500);

      const afterQueue = await inbox();
      assert.equal(afterQueue.badge, beforeQueue.badge, "queueing never removes a warning from the active count");
      assert.equal(afterQueue.pills, 1, "the selected group becomes exactly one queued prompt");
      const queuedRows = afterQueue.rows.filter((row) => row.status === "Queued for send");
      assert.equal(queuedRows.length, 2);
      assert.deepEqual(
        queuedRows.map((row) => row.target).sort(),
        [...selected.targets].sort(),
        "only the selected warnings were queued",
      );
      for (const row of queuedRows) {
        assert.equal(row.selectable, false, "duplicate queueing is disabled while the request is outstanding");
      }
      assert.equal(afterQueue.loads, 0, "queueing itself never refreshes the artifact");

      // Leave unsent review context in the composer so the batch refresh can be checked against it.
      await browser.evaluate(
        '() => { const el = document.getElementById("chatInput"); el.value = "Also check the footer spacing"; return el.value; }',
      );
      await browser.evaluate('() => document.getElementById("send").click()');
      await wait(1200);

      const feedback = poll(artifact, 8000);
      assert.match(feedback, /tag:\s*layout-warnings/);
      assert.match(feedback, /Layout issues: 2 selected/);
      assert.doesNotMatch(feedback, /^layout_warnings\[/m, "no parallel agent protocol at the CLI boundary");
      assert.doesNotMatch(feedback, /artifact_failures/);
      for (const target of selected.targets) {
        assert.ok(feedback.includes(target), `the queued batch names ${target}`);
      }

      // ---------------------------------------------------------------------
      // One batch of fixes costs one controlled refresh, and review context survives it.
      // ---------------------------------------------------------------------
      await instrumentArtifactLoads();
      await browser.evaluate(
        '() => { document.getElementById("chatInput").value = "Also check the footer spacing"; return "reset"; }',
      );
      const source = await readFile(artifact, "utf8");
      // Repair the clipped copy and the clipped control together, the way an agent applying one
      // queued batch would - and leave the badge's third finding untouched.
      await writeFile(
        artifact,
        source
          .replace(".clip {\n        height: 42px;", ".clip {\n        height: auto;")
          .replace("width: 60px;", "width: 100%;"),
      );
      await wait(6000);

      const afterFix = await inbox();
      assert.equal(afterFix.loads, 1, "one queued batch costs one artifact refresh");
      assert.equal(afterFix.pills, 0);
      assert.equal(
        await evaluate('document.getElementById("chatInput").value'),
        "Also check the footer spacing",
        "unsent composer text survives the batch refresh",
      );

      // ---------------------------------------------------------------------
      // Lifecycle: repaired findings resolve, a queued finding still present recurs.
      // ---------------------------------------------------------------------
      const desktopAfter = afterFix.rows.filter((row) => row.viewport.startsWith("Desktop"));
      assert.ok(
        desktopAfter.length < desktopRows.length,
        "a complete matching-viewport pass resolved the repaired issue",
      );
      const recurring = desktopAfter.find((row) => row.status === "Still present");
      if (recurring) {
        assert.equal(recurring.selectable, true, "a recurring warning can be queued again");
      }
      assert.ok(
        desktopAfter.every((row) => row.status !== "Queued for fix"),
        "a newer revision re-checks every outstanding request",
      );

      // Detection after the fix still must not wake the agent.
      assert.match(poll(artifact, 4000), /status:\s*waiting/);

      // ---------------------------------------------------------------------
      // Dismissal lasts for the current artifact revision only.
      // ---------------------------------------------------------------------
      const beforeDismiss = await inbox();
      // Dismiss a desktop-scoped issue so the follow-up revision (loaded at desktop width) is the
      // one that can surface it again. The same selector can appear under two viewport classes, so
      // identity here is target + viewport, exactly like the fingerprint.
      const dismissed = await evaluate(
        '(() => { document.getElementById("warningsButton").click();' +
          ' const row = [...document.querySelectorAll(".warning-row")].find((candidate) => [...candidate.querySelectorAll(".warning-chip")][2].textContent.startsWith("Desktop"));' +
          ' const target = row.querySelector(".warning-target").textContent;' +
          ' const viewport = [...row.querySelectorAll(".warning-chip")][2].textContent;' +
          ' [...row.querySelectorAll(".warning-action")].find((button) => button.textContent === "Dismiss").click();' +
          " return JSON.stringify({ target, viewport }); })()",
      );
      await wait(1200);
      const afterDismiss = await inbox();
      assert.equal(Number(afterDismiss.badge), Number(beforeDismiss.badge) - 1, "a dismissal leaves the active count");
      assert.ok(
        afterDismiss.rows.every((row) => !(row.target === dismissed.target && row.viewport === dismissed.viewport)),
      );

      // Touch the artifact so a newer revision loads; the still-present issue must surface again.
      await writeFile(artifact, `${await readFile(artifact, "utf8")}\n<!-- revision -->\n`);
      await wait(6000);
      const afterRevision = await inbox();
      assert.ok(
        afterRevision.rows.some((row) => row.target === dismissed.target && row.viewport === dismissed.viewport),
        "a later artifact revision surfaces a dismissed issue that is still detected",
      );

      // ---------------------------------------------------------------------
      // A review with zero warnings keeps the top bar unchanged and the poll silent.
      // ---------------------------------------------------------------------
      const clean = path.join(temp, "clean.html");
      await copyFile(path.join(fixtures, "real-plan-clean.html"), clean);
      await openReview(openArtifact(clean));
      const cleanInbox = await inbox();
      assert.equal(cleanInbox.hidden, true, "no button without unresolved work");
      assert.equal(cleanInbox.gate, false);
      assert.match(poll(clean, 3000), /status:\s*waiting/);

      // Ordinary annotation feedback still works unchanged alongside the inbox.
      await browser.evaluate(
        '() => { document.getElementById("chatInput").value = "Tighten the summary"; document.getElementById("send").click(); return "sent"; }',
      );
      await wait(1200);
      const cleanFeedback = poll(clean, 8000);
      assert.match(cleanFeedback, /Tighten the summary/);
      assert.doesNotMatch(cleanFeedback, /layout-warnings/);
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      await browser?.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
);

test("a live reload preserves the review context Lavish owns", { skip: browserSkip, timeout: 240_000 }, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "lavish-review-context-"));
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

  // LAVISH-HARDENED: upstream read these from the accessibility tree; the same facts come from the
  // artifact frame's DOM here - the answers, and the annotation card in the SDK's open shadow root.
  function reviewContext() {
    return browser.evaluateInArtifact(
      '(() => { const card = document.querySelector(".lavish-annotation-root")?.shadowRoot?.querySelector(".lavish-annotation-card"); return { pro: document.getElementById("plan-pro").checked, beta: document.getElementById("plan-beta").checked, card: card ? card.querySelector(".lavish-heading").textContent : null }; })()',
    );
  }
  function wait(ms) {
    return browser.wait(ms);
  }

  try {
    browser = await launchBrowser({ chromePath, profileDir: path.join(temp, "chrome") });
    const artifact = path.join(temp, "review-context.html");
    await copyFile(path.join(fixtures, "review-context.html"), artifact);
    const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
    const url = output.match(/url:\s*"([^"]+)"/)?.[1];
    assert.ok(url, output);
    await browser.emulate("1440x1000x1");
    await browser.open(url);
    await wait(4500);

    // Lavish-owned answers: a radio and a checkbox inside a data-lavish-question scope.
    await browser.clickInArtifact("#plan-pro");
    await browser.clickInArtifact("#plan-beta");
    // Unsent annotation text on an element the reload will replace.
    await browser.clickInArtifact("#annotate-me");
    await wait(800);
    await browser.type("Shorten this to one sentence");
    await wait(800);

    const before = await reviewContext();
    assert.equal(before.pro, true);
    assert.equal(before.beta, true);

    await writeFile(artifact, `${await readFile(artifact, "utf8")}\n<!-- revision -->\n`);
    await wait(5000);

    const after = await reviewContext();
    assert.equal(after.pro, true, "a Lavish-owned answer survives the reload");
    assert.equal(after.beta, true);
    assert.equal(after.card, "Annotate <p>", "the open annotation card comes back");

    // Queueing the restored card proves the unsent text itself survived, not just the card.
    await browser.clickInArtifact(".lavish-annotation-card .lavish-send", { host: ".lavish-annotation-root" });
    await wait(800);
    const geometry = JSON.parse(
      await browser.evaluate(
        '() => { const bubble = document.querySelector(".bubble.queued"); const excerpt = bubble.querySelector(".anchor-excerpt"); const scroll = document.getElementById("panelScroll"); const chat = document.getElementById("chatLog"); return JSON.stringify({ text: bubble.querySelector(".bubble-text").textContent, borderStyle: getComputedStyle(bubble).borderStyle, excerptWhiteSpace: getComputedStyle(excerpt).whiteSpace, excerptHeight: excerpt.getBoundingClientRect().height, excerptLineHeight: parseFloat(getComputedStyle(excerpt).lineHeight), scrollOverflowY: getComputedStyle(scroll).overflowY, emptyCopyDisplay: getComputedStyle(chat, "::before").display }); }',
      ),
    );
    assert.equal(geometry.text, "Shorten this to one sentence");
    assert.equal(geometry.borderStyle, "dashed");
    assert.equal(geometry.excerptWhiteSpace, "nowrap");
    assert.equal(geometry.scrollOverflowY, "auto");
    assert.equal(geometry.emptyCopyDisplay, "none");
    assert.ok(geometry.excerptHeight <= geometry.excerptLineHeight + 1, "the anchor excerpt stays on one line");
  } finally {
    run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
    await browser?.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
