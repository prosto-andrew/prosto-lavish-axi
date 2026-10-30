// LAVISH-FORK: F2, specs/2026-10-30-desktop-conversation-toggle-design.md 5.1, 5.3, 7.2, 7.3.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createChromeHtml } from "../src/server.js";

const chromeCssUrl = new URL("../src/chrome.css", import.meta.url);

/**
 * Every style rule in `css` with the prelude of the `@media` block it sits in (null at top level).
 * @param {string} css
 * @returns {{ media: string | null, selector: string, body: string }[]}
 */
function rulesWithContext(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  /** @type {(string | null)[]} */
  const stack = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      const prelude = text.slice(start, index).trim();
      if (prelude.startsWith("@")) {
        stack.push(prelude.startsWith("@media") ? prelude.replace(/^@media\s*/, "") : null);
        start = index + 1;
        continue;
      }
      const end = text.indexOf("}", index);
      const media = [...stack].reverse().find((entry) => entry !== null) ?? null;
      rules.push({ media, selector: prelude, body: text.slice(index + 1, end).trim() });
      index = end;
      start = end + 1;
    } else if (char === "}") {
      stack.pop();
      start = index + 1;
    }
  }
  return rules;
}

test("the bar carries the panel button between Annotate and the more menu", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/a.html" });
  const at = (needle) => {
    const index = html.indexOf(needle);
    assert.ok(index !== -1, `${needle} is in the page`);
    return index;
  };
  const bar = at('<div class="bar">');
  const layout = at('<div class="layout">');
  const annotation = at('id="annotation"');
  const button = at('id="panelButton"');
  const more = at('id="moreWrap"');
  assert.ok(bar < annotation && annotation < button && button < more && more < layout);

  const open = html.lastIndexOf("<button", button);
  const tag = html.slice(open, html.indexOf(">", open) + 1);
  for (const attribute of [
    'type="button"',
    'aria-controls="panel"',
    'aria-expanded="true"',
    'aria-label="Hide conversation"',
    'title="Hide conversation"',
  ]) {
    assert.ok(tag.includes(attribute), `the button carries ${attribute}: ${tag}`);
  }
  assert.ok(!tag.includes("style="), "no inline style");
  assert.doesNotMatch(tag, /\son[a-z]+=/, "no inline handler");

  const inner = html.slice(open, html.indexOf("</button>", open));
  assert.ok(inner.includes('class="panel-button-fill"'), "the icon has a fillable column");
  assert.ok(inner.includes('<span class="panel-button-count" id="panelButtonCount" hidden></span>'));
  assert.ok(inner.includes('<span class="panel-button-dot" id="panelButtonDot" hidden></span>'));
});

test("panel hiding applies only on the wide layout and the button only there", async () => {
  const rules = rulesWithContext(await readFile(chromeCssUrl, "utf8"));

  const layout = rules.find((rule) => rule.selector === "body.panel-hidden .layout");
  assert.ok(layout, "a rule collapses the layout to one column");
  assert.match(layout.body, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  const panel = rules.find((rule) => rule.selector === "body.panel-hidden .panel");
  assert.ok(panel, "a rule hides the panel");
  assert.match(panel.body, /display:\s*none/);

  // Exactly where MOBILE_SHEET_MEDIA, "(max-width: 860px)", does not match: a fractional width between
  // 860 and 861px matches neither "(max-width: 860px)" nor "(min-width: 861px)".
  const hiding = rules.filter((rule) => rule.selector.includes("panel-hidden"));
  for (const rule of hiding) {
    assert.equal(rule.media, "not all and (max-width: 860px)", `${rule.selector} applies wherever the sheet does not`);
  }

  const phone = rules.find(
    (rule) =>
      rule.selector === ".panel-button" && rule.media === "(max-width: 860px)" && /display:\s*none/.test(rule.body),
  );
  assert.ok(phone, "the phone layout never shows the panel button");
});
