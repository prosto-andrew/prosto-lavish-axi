// LAVISH-FORK: the chrome page carries the theme switcher's boot script and controls
// (specs/2026-10-18-theme-switcher-design.md 6.2 and 6.4).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import vm from "node:vm";

import * as chromeTheme from "../src/chrome-theme.js";
import {
  assertHelpersKeepTheirNames,
  CHROME_CONTENT_SECURITY_POLICY,
  CHROME_THEME_BOOT_JS,
  createChromeHtml,
} from "../src/server.js";

/**
 * Runs the boot script the way the page does: bare `localStorage` and `document`, `window.matchMedia`.
 * @param {{ stored?: string | null, systemDark?: boolean | null, storageThrows?: boolean, noRoot?: boolean }} options
 */
function boot({ stored = null, systemDark = true, storageThrows = false, noRoot = false } = {}) {
  const dataset = {};
  const window = {};
  if (systemDark !== null) {
    window.matchMedia = (query) => ({ matches: query === "(prefers-color-scheme: dark)" && systemDark });
  }
  const context = {
    window,
    localStorage: {
      getItem(key) {
        if (storageThrows) throw new Error("SecurityError: storage is blocked");
        return key === "lavish-axi:theme" ? stored : null;
      },
    },
    document: noRoot
      ? Object.defineProperty({}, "documentElement", {
          get() {
            throw new Error("no root");
          },
        })
      : { documentElement: { dataset } },
  };
  vm.runInNewContext(CHROME_THEME_BOOT_JS, context);
  return { dataset: { ...dataset }, window };
}

test("the boot script themes the page from storage and the OS", () => {
  assert.deepEqual(boot({ systemDark: true }).dataset, { lavishTheme: "ink", lavishScheme: "dark" });
  assert.deepEqual(boot({ systemDark: false }).dataset, { lavishTheme: "warm", lavishScheme: "light" });
  assert.deepEqual(boot({ stored: '{"mode":"light","light":"cool","dark":"black"}', systemDark: true }).dataset, {
    lavishTheme: "cool",
    lavishScheme: "light",
  });

  const api = boot().window.__lavishChromeTheme;
  assert.ok(Object.isFrozen(api));
  assert.deepEqual(Object.keys(api).sort(), [
    "chooseChromeThemeVariant",
    "chromeThemeConfig",
    "parseChromeThemePreference",
    "resolveChromeTheme",
    "setChromeThemeMatchSystem",
    "toggleChromeTheme",
  ]);
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const defaults = { mode: "system", light: "warm", dark: "ink" };
  assert.deepEqual(plain(api.toggleChromeTheme(defaults, true)), { mode: "light", light: "warm", dark: "ink" });
  assert.deepEqual(plain(api.chooseChromeThemeVariant(defaults, "graphite", true)), {
    mode: "system",
    light: "warm",
    dark: "graphite",
  });
  assert.equal(api.chromeThemeConfig().storageKey, "lavish-axi:theme");
});

test("the boot script survives blocked storage and a missing matchMedia", () => {
  assert.deepEqual(boot({ storageThrows: true, systemDark: true }).dataset, {
    lavishTheme: "ink",
    lavishScheme: "dark",
  });
  assert.deepEqual(boot({ systemDark: null }).dataset, { lavishTheme: "warm", lavishScheme: "light" });
  // Anything else going wrong leaves the page as CSS draws it (Ink) and offers no controls; an
  // exception escaping the boot script would fail this call.
  const broken = boot({ noRoot: true });
  assert.deepEqual(broken.dataset, {});
  assert.equal(broken.window.__lavishChromeTheme, undefined);
});

test("the session page loads the boot script before its stylesheet, allowed by hash", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/a.html" });
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  const firstScript = /<script>([\s\S]*?)<\/script>/.exec(head);
  assert.ok(firstScript, "the head carries an inline script");
  assert.equal(firstScript[1], CHROME_THEME_BOOT_JS);
  const stylesheet = head.indexOf('<link rel="stylesheet" href="/chrome.css">');
  assert.ok(stylesheet !== -1 && firstScript.index < stylesheet, "the boot script runs before chrome.css");

  const hash = `'sha256-${crypto.createHash("sha256").update(CHROME_THEME_BOOT_JS, "utf8").digest("base64")}'`;
  const scriptSrc = CHROME_CONTENT_SECURITY_POLICY.split(";")
    .map((directive) => directive.trim().split(/\s+/))
    .find(([name]) => name === "script-src");
  assert.ok(scriptSrc.includes(hash), "script-src lists the boot script's hash");
  assert.ok(!CHROME_CONTENT_SECURITY_POLICY.includes("'unsafe-inline'"));
});

test("the page carries the theme toggle and the Theme menu", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/a.html" });
  const at = (needle) => {
    const index = html.indexOf(needle);
    assert.ok(index !== -1, `${needle} is in the page`);
    return index;
  };
  const bar = at('<div class="bar">');
  const toggle = at('id="themeToggle"');
  assert.ok(bar < at('id="revisionsWrap"') && at('id="revisionsWrap"') < toggle && toggle < at('id="annotation"'));

  const menu = at('id="moreMenu"');
  const section = at('id="themeMenuSection"');
  assert.ok(menu < at('id="exportArtifact"') && at('id="exportArtifact"') < section && section < at('id="end"'));
  const variants = [...html.matchAll(/id="themeVariant-([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(variants, ["warm", "neutral", "cool", "black", "ink", "graphite"]);
  assert.ok(section < at('id="themeVariant-warm"') && at('id="themeVariant-graphite"') < at('id="themeMatchSystem"'));
  assert.ok(at('id="themeMatchSystem"') < at('id="end"'));
});

// Final review #5: the serialized helpers call each other by their export names, so a bundler that
// renamed one (esbuild does on a name clash) would leave the theme controls throwing on every click.
// The server refuses to build the boot script from such a module, so the failure is loud.
test("the boot script is built only from helpers that keep their export names", () => {
  assert.doesNotThrow(() => assertHelpersKeepTheirNames(chromeTheme));
  const renamed = { resolveChromeTheme: function resolveChromeTheme2() {} };
  assert.throws(() => assertHelpersKeepTheirNames(renamed), /resolveChromeTheme.*resolveChromeTheme2/);
});
