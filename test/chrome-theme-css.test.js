// LAVISH-FORK: the editor theme variants live in src/chrome.css as token blocks
// (specs/2026-10-18-theme-switcher-design.md, 5 and 6.3). These tests keep every chrome color
// behind a token, so a color added outside the token blocks cannot stay dark in a light theme.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../src/chrome.css", import.meta.url), "utf8");

/**
 * Every declaration with the selector of the rule that directly holds it and its 1-based line.
 * Comments are blanked first (keeping newlines, so line numbers stay true).
 * @param {string} source
 */
function declarations(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  /** @type {{ selector: string, property: string, value: string, line: number }[]} */
  const found = [];
  /** @type {string[]} */
  const selectors = [];
  let start = 0;
  let line = 1;
  let startLine = 1;
  const flush = (end) => {
    const chunk = text.slice(start, end);
    const colon = chunk.indexOf(":");
    if (selectors.length && colon !== -1 && chunk.trim()) {
      const leading = chunk.length - chunk.trimStart().length;
      const declLine = startLine + (chunk.slice(0, leading).match(/\n/g) || []).length;
      found.push({
        selector: selectors[selectors.length - 1],
        property: chunk.slice(0, colon).trim(),
        value: chunk.slice(colon + 1).trim(),
        line: declLine,
      });
    }
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      selectors.push(text.slice(start, index).trim().replace(/\s+/g, " "));
      start = index + 1;
      startLine = line;
    } else if (char === ";") {
      flush(index);
      start = index + 1;
      startLine = line;
    } else if (char === "}") {
      flush(index);
      selectors.pop();
      start = index + 1;
      startLine = line;
    }
    if (char === "\n") line += 1;
  }
  return found;
}

const all = declarations(css);
const VARIANT_SELECTOR = /^:root\[data-lavish-theme="([a-z]+)"\]$/;
const isTokenBlock = (selector) => selector === ":root" || VARIANT_SELECTOR.test(selector);

/** @param {string} selector */
function block(selector) {
  return new Map(all.filter((decl) => decl.selector === selector).map((decl) => [decl.property, decl.value]));
}

const SEMANTIC = [
  "--bg",
  "--bg-panel",
  "--bg-bar",
  "--bg-elevated",
  "--fg",
  "--fg-muted",
  "--fg-dim",
  "--fg-faint",
  "--fg-label",
  "--border",
  "--border-subtle",
  "--border-strong",
  "--accent",
  "--accent-ink",
  "--danger",
];
const DERIVED = [
  "--accent-hover",
  "--bg-hover",
  "--fg-code",
  "--warn-fg",
  "--warn-bg",
  "--warn-bg-active",
  "--warn-border",
  "--warn-border-active",
  "--accent-line",
  "--danger-line",
  "--danger-tint",
  "--excerpt-bg",
  "--excerpt-line",
  "--hint-bg",
  "--hint-border",
  "--pulse-from",
  "--pulse-to",
  "--foot-shadow",
  "--ended-scrim",
  "--panel-scrim",
  "--whiteboard-scrim",
  "--shadow-tooltip",
  "--shadow-floating",
];
const VARIANTS = ["black", "graphite", "warm", "neutral", "cool"];

test("the chrome paints no color outside the token blocks", () => {
  // Every CSS named and system color (final review #7). Colors that chrome-client.js sets from script
  // (today only the revision swatches, decorative and shared with the SDK) are out of this test's sight.
  const named = `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
    burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
    darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred
    darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue
    dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray
    green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen
    lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink
    lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen
    linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
    mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy
    oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip
    peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
    seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle
    tomato turquoise violet wheat white whitesmoke yellow yellowgreen accentcolor accentcolortext activetext
    buttonborder buttonface buttontext canvas canvastext field fieldtext graytext highlight highlighttext linktext
    mark marktext selecteditem selecteditemtext visitedtext`
    .trim()
    .split(/\s+/)
    .join("|");
  const color = new RegExp(
    `#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\\(|(?:^|[\\s,(])(?:${named})(?=$|[\\s,);])`,
    "i",
  );
  const rawPalette = /var\(--(?:ink|steel|cream|brass|sage|amber|rust)-/;
  const offenders = all
    .filter((decl) => !isTokenBlock(decl.selector))
    .filter((decl) => color.test(decl.value) || rawPalette.test(decl.value))
    .map((decl) => `${decl.line}: ${decl.selector} { ${decl.property}: ${decl.value} }`);
  assert.deepEqual(offenders, []);
});

test("Ink keeps today's colors", () => {
  const root = block(":root");
  const today = {
    "--bg": "var(--ink-900)",
    "--bg-panel": "var(--ink-800)",
    "--bg-bar": "var(--ink-700)",
    "--bg-elevated": "var(--ink-600)",
    "--fg": "var(--cream-100)",
    "--fg-muted": "var(--steel-100)",
    "--fg-dim": "var(--steel-200)",
    "--fg-faint": "var(--steel-300)",
    "--fg-label": "var(--steel-400)",
    "--border": "var(--steel-600)",
    "--border-subtle": "var(--steel-700)",
    "--border-strong": "var(--steel-500)",
    "--accent": "var(--brass-500)",
    "--accent-hover": "var(--brass-400)",
    "--accent-ink": "var(--brass-ink)",
    "--danger": "var(--rust-500)",
    "--shadow-tooltip": "0 16px 44px rgba(0, 0, 0, 0.35)",
    "--shadow-floating": "0 20px 70px rgba(0, 0, 0, 0.35)",
    // The literals the chrome used to paint directly, now named once with the same value.
    "--warn-border": "rgba(244, 201, 93, 0.35)",
    "--warn-bg": "rgba(37, 35, 15, 0.72)",
    "--warn-fg": "var(--brass-400)",
    "--warn-border-active": "rgba(244, 201, 93, 0.6)",
    "--warn-bg-active": "rgba(93, 77, 27, 0.5)",
    "--accent-line": "rgba(244, 201, 93, 0.4)",
    "--danger-line": "rgba(240, 100, 100, 0.4)",
    "--danger-tint": "rgba(240, 100, 100, 0.1)",
    "--foot-shadow": "rgba(0, 0, 0, 0.55)",
    "--bg-hover": "var(--steel-700)",
    "--frame-surface": "#fff",
    "--excerpt-bg": "rgba(244, 201, 93, 0.22)",
    "--excerpt-line": "rgba(244, 201, 93, 0.35)",
    "--fg-code": "var(--cream-200)",
    "--hint-border": "var(--amber-700)",
    "--hint-bg": "var(--amber-900)",
    "--ended-scrim": "rgba(15, 17, 21, 0.86)",
    "--panel-scrim": "rgba(15, 17, 21, 0.72)",
    "--pulse-from": "rgba(244, 201, 93, 0.55)",
    "--pulse-to": "rgba(244, 201, 93, 0)",
    "--whiteboard-scrim": "rgba(15, 17, 21, 0.92)",
  };
  for (const [token, value] of Object.entries(today)) {
    assert.equal(root.get(token), value, token);
  }
});

test("every variant defines the whole color set", () => {
  const expected = [...SEMANTIC, ...DERIVED].sort();
  for (const variant of VARIANTS) {
    const declared = [...block(`:root[data-lavish-theme="${variant}"]`).keys()].sort();
    assert.deepEqual(declared, expected, variant);
  }
});

test("light variants switch the frame to a light color scheme", () => {
  assert.equal(block(':root[data-lavish-scheme="light"] body.lavish').get("color-scheme"), "light");
  assert.equal(block("body.lavish").get("color-scheme"), "dark");
});

/** @param {string} hex */
function luminance(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** @param {string} a @param {string} b */
function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test("variant text stays readable", () => {
  const root = block(":root");
  // Ink's semantic tokens name the raw palette (`var(--ink-900)`); everything else is a literal.
  const literal = (tokens, name) => {
    const value = tokens.get(name);
    const raw = /^var\((--[a-z0-9-]+)\)$/.exec(value || "");
    const resolved = raw ? root.get(raw[1]) : value;
    assert.match(resolved || "", /^#[0-9a-f]{6}$/i, `${name} is a 6-digit hex color`);
    return resolved;
  };
  const sets = { ink: root, ...Object.fromEntries(VARIANTS.map((v) => [v, block(`:root[data-lavish-theme="${v}"]`)])) };
  for (const [variant, tokens] of Object.entries(sets)) {
    const pair = (fg, bg, floor) => {
      const ratio = contrast(literal(tokens, fg), literal(tokens, bg));
      assert.ok(ratio >= floor, `${variant}: ${fg} on ${bg} is ${ratio.toFixed(2)}, below ${floor}`);
    };
    pair("--fg", "--bg", 7);
    pair("--fg", "--bg-panel", 7);
    // Menus and drawers paint --bg-bar, the composer --bg (final review #3).
    for (const fg of ["--fg-faint", "--fg-label"]) {
      for (const bg of ["--bg", "--bg-panel", "--bg-bar", "--bg-elevated"]) pair(fg, bg, 4.5);
    }
    pair("--accent", "--bg", 3);
    pair("--accent-ink", "--accent", 4.5);
  }
});
