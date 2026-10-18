// LAVISH-FORK: the design guidance's light/dark theme pair (specs/2026-10-18-theme-switcher-design.md 8
// and 14). The editor theme reaches the artifact frame as its prefers-color-scheme, so an artifact
// built from `lavish-safe design` follows it: luxury when dark, a tuned caramellatte when light.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { getCommandHelp } from "../src/cli.js";
import { createDesignOutput, DAISYUI_THEMES } from "../src/design-reference.js";
import { buildSelfContainedHtml } from "../src/export-bundle.js";
import { analyzeSelfPaint } from "../src/self-paint.js";

const themesCss = await readFile(new URL("../node_modules/daisyui/themes.css", import.meta.url), "utf8");

function switchSnippet() {
  const snippet = createDesignOutput().design.theme_switch_snippet;
  assert.equal(typeof snippet, "string", "design.theme_switch_snippet is missing");
  return snippet;
}

function snippetPart(tag) {
  const match = switchSnippet().match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  assert.ok(match, `the snippet has no <${tag}> block`);
  return match[1];
}

function tweakRule() {
  const css = snippetPart("style").replace(/\/\*[\s\S]*?\*\//g, "");
  const match = css.match(/^\s*([^{}]+)\{([^{}]*)\}\s*$/);
  assert.ok(match, `the snippet's <style> holds exactly one rule: ${css}`);
  return {
    selectors: match[1].split(",").map((selector) => selector.trim()),
    declarations: match[2]
      .split(";")
      .map((declaration) => declaration.trim().replace(/\s+/g, " "))
      .filter(Boolean),
  };
}

function tweakValue(name) {
  const declaration = tweakRule().declarations.find((item) => item.startsWith(`${name}:`));
  assert.ok(declaration, `the tweak sets ${name}`);
  return declaration.slice(name.length + 1).trim();
}

function caramellatteValue(name) {
  const block = themesCss.match(/\[data-theme=caramellatte\]\{([^}]*)\}/)?.[1];
  assert.ok(block, "themes.css defines caramellatte");
  const value = block.match(new RegExp(`${name}:([^;]+)`))?.[1];
  assert.ok(value, `caramellatte defines ${name}`);
  return value.trim();
}

function toLinearRgb(color) {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    return [0, 2, 4]
      .map((index) => parseInt(hex[1].slice(index, index + 2), 16) / 255)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  }
  const oklch = color.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  assert.ok(oklch, `unsupported color ${color}`);
  const lightness = Number(oklch[1]) / 100;
  const chroma = Number(oklch[2]);
  const hue = (Number(oklch[3]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.min(1, Math.max(0, channel)));
}

function contrast(first, second) {
  const luminance = (color) => {
    const [r, g, b] = toLinearRgb(color);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [high, low] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test("the design output carries a theme switch snippet for the luxury/caramellatte pair", () => {
  const snippet = switchSnippet();
  assert.match(snippet, /^<style>[\s\S]*<\/style>\n<script>[\s\S]*<\/script>$/);
  assert.doesNotMatch(snippet, /<html\b/i, "the root element stays in the artifact's own markup");
  assert.doesNotMatch(
    snippet,
    /https?:|\bsrc\s*=|\bhref\s*=|url\(|@import|\bimport\(|\bfetch\(/i,
    "the snippet loads nothing",
  );
  for (const theme of ["luxury", "caramellatte"]) {
    assert.ok(DAISYUI_THEMES.includes(theme), `${theme} is a listed DaisyUI theme`);
    assert.ok(themesCss.includes(`[data-theme=${theme}]`), `the vendored themes.css defines ${theme}`);
  }
  // Without JavaScript, or opened from disk, the markup's luxury still paints the page.
  assert.deepEqual(
    analyzeSelfPaint(`<!doctype html><html data-theme="luxury"><head>${snippet}</head><body></body></html>`),
    { painted: true, signal: "data-theme" },
  );
  assert.match(getCommandHelp("design"), /theme switch snippet/i);
  // Next to the snippet, so an agent skimming the design block does not paste only cdn_snippet.
  const design = createDesignOutput().design;
  assert.deepEqual(Object.keys(design).slice(0, 4), [
    "summary",
    "cdn_snippet",
    "theme_switch_snippet",
    "theme_switch_note",
  ]);
  assert.match(design.theme_switch_note, /`<head>`/);
  assert.match(design.theme_switch_note, /cdn_snippet/);
  assert.match(design.theme_switch_note, /theme_usage/);
});

test("the theme switch script follows the reviewer's side", () => {
  const queries = [];
  const listeners = [];
  const media = {
    matches: true,
    addEventListener(type, listener) {
      listeners.push({ type, listener });
    },
  };
  const root = { dataset: { theme: "luxury" } };
  vm.runInNewContext(snippetPart("script"), {
    document: { documentElement: root },
    matchMedia(query) {
      queries.push(query);
      return media;
    },
  });

  assert.deepEqual(queries, ["(prefers-color-scheme: dark)"]);
  assert.equal(root.dataset.theme, "luxury", "the dark side is luxury");
  assert.deepEqual(
    listeners.map(({ type }) => type),
    ["change"],
  );
  media.matches = false;
  listeners[0].listener();
  assert.equal(root.dataset.theme, "caramellatte", "the light side is caramellatte");
  media.matches = true;
  listeners[0].listener();
  assert.equal(root.dataset.theme, "luxury", "and back");

  const lightRoot = { dataset: { theme: "luxury" } };
  vm.runInNewContext(snippetPart("script"), {
    document: { documentElement: lightRoot },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  });
  assert.equal(lightRoot.dataset.theme, "caramellatte", "a light side at load is caramellatte at once");
});

test("the caramellatte tweaks are the four approved values and outrank themes.css", () => {
  const { selectors, declarations } = tweakRule();
  // html + attribute (0,1,1) beats themes.css's bare [data-theme=caramellatte] (0,1,0) whatever the
  // order of the <head>, and the descendant form reaches nested caramellatte sections too.
  assert.deepEqual(selectors, ['html[data-theme="caramellatte"]', 'html [data-theme="caramellatte"]']);
  assert.deepEqual(declarations, [
    "--color-neutral: oklch(20% 0 0)",
    "--color-neutral-content: oklch(80% 0.0081 61.42)",
    "--color-error: #9f1c1c",
    "--color-error-content: #fff7ed",
  ]);
});

test("the tweaked caramellatte pairs pass WCAG AA", () => {
  const error = tweakValue("--color-error");
  const pairs = [
    ["error-content on error", tweakValue("--color-error-content"), error],
    ["neutral-content on neutral", tweakValue("--color-neutral-content"), tweakValue("--color-neutral")],
    ["text-error on base-100", error, caramellatteValue("--color-base-100")],
    ["text-error on base-200", error, caramellatteValue("--color-base-200")],
  ];
  for (const [label, foreground, background] of pairs) {
    const ratio = contrast(foreground, background);
    assert.ok(ratio >= 4.5, `${label}: ${ratio.toFixed(2)}:1 is below AA`);
  }
});

test("export keeps the theme switch snippet unchanged", async () => {
  const snippet = switchSnippet();
  const { html: out, warnings } = await buildSelfContainedHtml(
    `<!doctype html><html data-theme="luxury"><head>${snippet}</head><body><p>x</p></body></html>`,
    {
      baseDir: "/art",
      readLocalFile: async () => {
        throw new Error("no reads");
      },
    },
  );
  assert.ok(out.includes(snippet), "the exported copy carries the snippet as written");
  assert.equal(warnings.length, 0);
});
