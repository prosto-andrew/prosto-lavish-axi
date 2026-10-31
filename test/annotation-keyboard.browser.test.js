import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findChrome, launchBrowser, waitForValue } from "./cdp-browser.js";

// LAVISH-FORK: upstream drives this suite through chrome-devtools-axi, which this fork does not
// install; it runs on the CDP helper the other opt-in suites use (test/cdp-browser.js). The text goes
// in one key at a time, as upstream's tool typed it: Input.insertText fires no keydown, so with it
// the spaces the deck pages on - the bug this test is about - would never reach a key handler.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const chromePath = runBrowserE2e ? await findChrome() : "";
const browserSkip = !runBrowserE2e || (!chromePath && "Chrome or Chromium is required (set CHROME_PATH)");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

// A slide deck that pages on Space, ArrowRight, and PageDown from a document keydown listener.
const ARTIFACT_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>e2e-keyboard</title></head>
<body style="background:#fff;color:#111">
<p id="slide">Slide 1</p>
<p id="annotate-me">Annotate this paragraph.</p>
<script>
var slide = 1;
document.addEventListener("keydown", function (event) {
  if ([" ", "ArrowRight", "PageDown"].includes(event.key)) {
    event.preventDefault();
    slide += 1;
    document.getElementById("slide").textContent = "Slide " + slide;
  }
});
</script>
</body>
</html>
`;

// The annotation card lives in the SDK's open shadow root.
const CARD = `(() => {
  const root = document.querySelector(".lavish-annotation-root")?.shadowRoot;
  const area = root?.querySelector(".lavish-annotation-card textarea");
  return JSON.stringify({
    open: Boolean(area),
    focused: Boolean(area) && root.activeElement === area,
    value: area ? area.value : "",
    slide: document.getElementById("slide")?.textContent || "",
  });
})()`;

test(
  "typing in the annotation card does not reach the artifact's own key handlers",
  { skip: browserSkip, timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-keyboard-e2e-"));
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
    const card = async () => JSON.parse(await browser.evaluateInArtifact(CARD));

    try {
      browser = await launchBrowser({ chromePath, profileDir: path.join(temp, "chrome") });
      const artifact = path.join(temp, "deck.html");
      await writeFile(artifact, ARTIFACT_HTML);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      await browser.open(url);
      const gate = await waitForValue(
        () => browser.evaluate(`document.body.classList.contains("layout-gate-active")`),
        (active) => active === false,
        { timeoutMs: 20_000 },
      );
      assert.equal(gate, false, "the layout gate lifts");
      await browser.clickInArtifact("#annotate-me");
      const opened = await waitForValue(card, (state) => state.open && state.focused);
      assert.ok(opened.open && opened.focused, `the card opens with its field focused: ${JSON.stringify(opened)}`);

      await browser.typeKeys("fix this text");
      let state = await card();
      assert.equal(state.value, "fix this text");
      assert.equal(state.slide, "Slide 1");
      await browser.press("ArrowRight");
      state = await card();
      assert.equal(state.slide, "Slide 1");

      await browser.clickInArtifact(".lavish-annotation-card .lavish-cancel", { host: ".lavish-annotation-root" });
      state = await waitForValue(card, (value) => !value.open);
      assert.equal(state.open, false, "Cancel closes the card");
      await browser.press("ArrowRight");
      state = await waitForValue(card, (value) => value.slide !== "Slide 1");
      assert.equal(state.slide, "Slide 2", "the deck still pages once the card is closed");
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      await browser?.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
);
