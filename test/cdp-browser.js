// LAVISH-HARDENED: the opt-in browser suites drive headless Chrome over the DevTools Protocol
// themselves. Upstream runs them through `chrome-devtools-axi`, which this fork does not install: it
// fetches `chrome-devtools-mcp@latest` from npm at run time (past the lockfile and the release-age
// policy), and on Windows `spawnSync` cannot start its npm `.cmd` shim without a shell. This module
// covers exactly what those suites asked of it: open, emulate, evaluate, wait, and a real click and
// typing inside the sandboxed artifact frame.
//
// `node --test` runs every `.js` file under test/, so this file also runs as an empty test file.
import { spawn, spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return "";
}

/** Reads `read()` until `isReady` accepts its value or the time runs out, and returns the last value. */
export async function waitForValue(read, isReady, { timeoutMs = 10_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!isReady(value) && Date.now() < deadline) {
    await delay(intervalMs);
    value = await read();
  }
  return value;
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) {
        for (const listener of [...this.listeners]) listener(message);
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const entry of this.pending.values()) entry.reject(new Error(`${entry.method}: DevTools connection closed`));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  waitForEvent(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const listener = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      this.listeners.add(listener);
    });
  }
}

// "390x844x3,mobile,touch" - width, height, device scale factor, then flags.
function parseViewport(spec) {
  const [size, ...flags] = String(spec).split(",");
  const [width, height, scale = 1] = size.split("x").map(Number);
  return {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: flags.includes("mobile"),
    touch: flags.includes("touch"),
    landscape: flags.includes("landscape"),
  };
}

// Windows has no process groups (process.kill(-pid) throws there), so take Chrome's tree.
function killChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * @param {{ chromePath: string, profileDir: string }} options
 */
export async function launchBrowser({ chromePath, profileDir }) {
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      // An extension registered on the machine otherwise installs into this fresh profile, and a
      // Chrome killed mid-unpack leaves %TEMP%\scoped_dir* behind.
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--window-size=1440,1000",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  let socket;
  try {
    let portFile = "";
    for (let attempt = 0; attempt < 150 && !portFile; attempt += 1) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Chrome exited (${child.exitCode}) before it opened DevTools`);
      try {
        portFile = await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8");
      } catch {
        await delay(100);
      }
    }
    if (!portFile) throw new Error("Chrome did not open DevTools within 15s");
    const [port, browserPath] = portFile.trim().split(/\r?\n/);
    socket = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("could not connect to Chrome's DevTools")), {
        once: true,
      });
    });
  } catch (error) {
    killChrome(child);
    throw error;
  }

  const cdp = new CdpConnection(socket);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const { targetId } = targetInfos.find((info) => info.type === "page");
  const { sessionId: page } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, page);
  await cdp.send("Runtime.enable", {}, page);
  // The sandboxed artifact frame runs in its own process; listing it as a target needs auto-attach.
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, page);
  let viewport = { mobile: false, touch: false };

  async function navigation(action) {
    const loaded = cdp.waitForEvent(
      (message) => message.sessionId === page && message.method === "Page.loadEventFired",
      30_000,
      "the page to load",
    );
    await action();
    await loaded;
  }

  async function evaluateIn(sessionId, expression) {
    // Either an expression or a function to call; a promise result is awaited.
    const wrapped = `(async () => { const value = (${expression}); return typeof value === "function" ? await value() : await value; })()`;
    const { result, exceptionDetails } = await cdp.send(
      "Runtime.evaluate",
      { expression: wrapped, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    if (exceptionDetails) {
      throw new Error(`evaluation failed: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
    }
    return result.value;
  }

  async function inArtifactFrame(expression) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { targetInfos: targets } = await cdp.send("Target.getTargets");
      const frames = targets.filter((info) => info.type === "iframe" && info.url.includes("/artifact/"));
      if (frames.length > 0) {
        const { sessionId } = await cdp.send("Target.attachToTarget", {
          targetId: frames[frames.length - 1].targetId,
          flatten: true,
        });
        try {
          return await evaluateIn(sessionId, expression);
        } finally {
          await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
        }
      }
      await delay(100);
    }
    throw new Error("the artifact frame is not an out-of-process frame target");
  }

  // A real click: the point inside the artifact frame, offset by the frame's box and border.
  async function clickAt(point) {
    const frame = await evaluateIn(
      page,
      `(() => { const frame = document.getElementById("artifact"); const box = frame.getBoundingClientRect(); return { x: box.left + frame.clientLeft, y: box.top + frame.clientTop }; })()`,
    );
    const x = frame.x + point.x;
    const y = frame.y + point.y;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, page);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, page);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, page);
  }

  return {
    async open(url) {
      await navigation(() => cdp.send("Page.navigate", { url }, page));
    },
    // Like puppeteer's viewport emulation (what chrome-devtools-axi used): a change of the mobile or
    // touch flag reloads the page.
    async emulate(spec) {
      const next = parseViewport(spec);
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width: next.width,
          height: next.height,
          deviceScaleFactor: next.deviceScaleFactor,
          mobile: next.mobile,
          screenOrientation: next.landscape
            ? { angle: 90, type: "landscapePrimary" }
            : { angle: 0, type: "portraitPrimary" },
        },
        page,
      );
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: next.touch }, page);
      const reload = next.mobile !== viewport.mobile || next.touch !== viewport.touch;
      viewport = next;
      if (reload && (await evaluateIn(page, "location.href")) !== "about:blank") {
        await navigation(() => cdp.send("Page.reload", {}, page));
      }
    },
    /** Evaluates in the review page and returns the value. */
    evaluate(expression) {
      return evaluateIn(page, expression);
    },
    /** Evaluates in the artifact frame and returns the value. */
    evaluateInArtifact(expression) {
      return inArtifactFrame(expression);
    },
    wait: delay,
    /** Clicks the element `selector` names inside the artifact frame, or inside its open shadow root under `host`. */
    async clickInArtifact(selector, { host = "" } = {}) {
      const point = await inArtifactFrame(`(() => {
        const scope = ${host ? `document.querySelector(${JSON.stringify(host)})?.shadowRoot` : "document"};
        const element = scope && scope.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error(${JSON.stringify(`no element matches ${selector}`)});
        element.scrollIntoView({ block: "center" });
        const box = element.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      })()`);
      await clickAt(point);
    },
    /** Types into whatever has focus, the way a keyboard would. */
    async type(text) {
      await cdp.send("Input.insertText", { text }, page);
    },
    async close() {
      await Promise.race([cdp.send("Browser.close").catch(() => {}), delay(3000)]);
      await Promise.race([exited, delay(5000)]);
      killChrome(child);
      socket.close();
    },
  };
}
