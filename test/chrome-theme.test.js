// LAVISH-FORK: the editor theme switcher's rules (specs/2026-10-18-theme-switcher-design.md, 4 and 6.1).
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import * as chromeTheme from "../src/chrome-theme.js";

const {
  chromeThemeConfig,
  parseChromeThemePreference,
  resolveChromeTheme,
  toggleChromeTheme,
  chooseChromeThemeVariant,
  setChromeThemeMatchSystem,
} = chromeTheme;

/** @type {import("../src/chrome-theme.js").ChromeThemePreference} */
const DEFAULTS = { mode: "system", light: "warm", dark: "ink" };

test("chromeThemeConfig lists the six variants and the defaults", () => {
  const config = chromeThemeConfig();
  assert.equal(config.storageKey, "lavish-axi:theme");
  assert.deepEqual(config.light, ["warm", "neutral", "cool"]);
  assert.deepEqual(config.dark, ["black", "ink", "graphite"]);
  assert.deepEqual(config.defaults, DEFAULTS);
  assert.equal(config.labels.graphite, "Graphite");
  assert.equal(config.maxLength, 200);
  // A caller that edits its copy must not change what the next caller gets.
  assert.notEqual(chromeThemeConfig(), config);
  assert.notEqual(chromeThemeConfig().defaults, config.defaults);
});

test("junk in storage gives the defaults", () => {
  const padded = JSON.stringify({ mode: "light", light: "cool", dark: "black", pad: "x".repeat(200) });
  for (const raw of [
    null,
    undefined,
    "",
    "not json",
    "[]",
    "42",
    "null",
    JSON.stringify({ mode: 1, light: [], dark: {} }),
    padded,
  ]) {
    assert.deepEqual(parseChromeThemePreference(raw), DEFAULTS, `raw: ${String(raw).slice(0, 40)}`);
  }
});

test("each field falls back on its own", () => {
  assert.deepEqual(parseChromeThemePreference('{"mode":"dark","light":"sepia","dark":"graphite","extra":true}'), {
    mode: "dark",
    light: "warm",
    dark: "graphite",
  });
  assert.deepEqual(parseChromeThemePreference('{"mode":"light","light":"cool","dark":"black"}'), {
    mode: "light",
    light: "cool",
    dark: "black",
  });
  // A dark variant never lands on the light side.
  assert.deepEqual(parseChromeThemePreference('{"light":"ink"}'), DEFAULTS);
});

test("resolveChromeTheme picks the variant of the side in force", () => {
  assert.deepEqual(resolveChromeTheme(DEFAULTS, true), { variant: "ink", scheme: "dark" });
  assert.deepEqual(resolveChromeTheme(DEFAULTS, false), { variant: "warm", scheme: "light" });
  assert.deepEqual(resolveChromeTheme({ mode: "light", light: "cool", dark: "ink" }, true), {
    variant: "cool",
    scheme: "light",
  });
  assert.deepEqual(resolveChromeTheme({ mode: "dark", light: "warm", dark: "black" }, false), {
    variant: "black",
    scheme: "dark",
  });
});

test("toggleChromeTheme makes the opposite side explicit", () => {
  assert.deepEqual(toggleChromeTheme(DEFAULTS, true), { mode: "light", light: "warm", dark: "ink" });
  assert.deepEqual(toggleChromeTheme(DEFAULTS, false), { mode: "dark", light: "warm", dark: "ink" });
  assert.deepEqual(toggleChromeTheme({ mode: "light", light: "cool", dark: "graphite" }, false), {
    mode: "dark",
    light: "cool",
    dark: "graphite",
  });
});

test("chooseChromeThemeVariant shows the pick and leaves system only when it must", () => {
  assert.deepEqual(chooseChromeThemeVariant(DEFAULTS, "graphite", true), {
    mode: "system",
    light: "warm",
    dark: "graphite",
  });
  assert.deepEqual(chooseChromeThemeVariant(DEFAULTS, "cool", true), { mode: "light", light: "cool", dark: "ink" });
  assert.deepEqual(chooseChromeThemeVariant({ mode: "dark", light: "warm", dark: "ink" }, "neutral", false), {
    mode: "light",
    light: "neutral",
    dark: "ink",
  });
  assert.deepEqual(chooseChromeThemeVariant({ mode: "light", light: "cool", dark: "ink" }, "sepia", true), {
    mode: "light",
    light: "cool",
    dark: "ink",
  });
});

test("setChromeThemeMatchSystem keeps the look when turned off", () => {
  assert.deepEqual(setChromeThemeMatchSystem({ mode: "light", light: "warm", dark: "ink" }, true, true), DEFAULTS);
  assert.deepEqual(setChromeThemeMatchSystem(DEFAULTS, false, true), { mode: "dark", light: "warm", dark: "ink" });
  assert.deepEqual(setChromeThemeMatchSystem(DEFAULTS, false, false), { mode: "light", light: "warm", dark: "ink" });
});

// The boot script carries these helpers as `const name = <fn.toString()>` declarations
// (serializeModuleHelpers in src/server.js), so they must still work with nothing but each other.
test("the module survives a toString round trip", () => {
  const declarations = Object.entries(chromeTheme)
    .map(([name, fn]) => `const ${name}=${fn.toString()};`)
    .join("\n");
  const copy = vm.runInNewContext(
    `${declarations}\n;({ parseChromeThemePreference, resolveChromeTheme, chooseChromeThemeVariant })`,
    {},
  );
  const stored = '{"mode":"dark","light":"sepia","dark":"graphite"}';
  assert.deepEqual(
    JSON.parse(JSON.stringify(copy.parseChromeThemePreference(stored))),
    parseChromeThemePreference(stored),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(copy.resolveChromeTheme(DEFAULTS, false))), {
    variant: "warm",
    scheme: "light",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(copy.chooseChromeThemeVariant(DEFAULTS, "cool", true))), {
    mode: "light",
    light: "cool",
    dark: "ink",
  });
});
