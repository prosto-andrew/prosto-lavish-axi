import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Security floors for transitive dependencies are declared twice: the `overrides`
// block in pnpm-workspace.yaml is what pnpm, CI, `pnpm audit` and Dependabot read
// (pnpm 11 ignores the `pnpm` field in package.json), while the top-level
// `overrides` in package.json is what npm reads - and npm is how this fork's install
// docs build it. Each tool ignores the other's declaration, so a rule added to only
// one of them leaves the other install path on the vulnerable version with no error.

// The whiteboard converter breaks on other versions of these (see
// test/whiteboard-pins.test.js); an override would silently defeat the exact pin.
const EXACTLY_PINNED = ["mermaid", "@excalidraw/excalidraw", "@excalidraw/mermaid-to-excalidraw"];

function readText(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function npmOverrides() {
  return JSON.parse(readText("../package.json")).overrides ?? {};
}

// No YAML parser is a dependency, so read only the top-level `overrides:` block, and
// only in the one shape it is written in (`  "selector": "spec"` per line). Anything
// else fails loudly rather than being skipped, so the comparison never runs on half
// of the rules.
function pnpmOverrides() {
  const lines = readText("../pnpm-workspace.yaml").split(/\r?\n/);
  const start = lines.indexOf("overrides:");
  if (start === -1) return {};
  const overrides = {};
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(" ")) break;
    const match = /^ {2}"([^"]+)": "([^"]+)"$/.exec(line);
    assert.ok(match, `unrecognized line in the pnpm-workspace.yaml overrides block: ${line}`);
    overrides[match[1]] = match[2];
  }
  return overrides;
}

// npm nests parent-scoped rules ({ parent: { child: spec } }, with "." naming the
// parent itself); pnpm spells the same rule "parent>child".
function flattenNpmOverrides(overrides, prefix = "") {
  const flat = {};
  for (const [key, value] of Object.entries(overrides)) {
    const selector = key === "." ? prefix : prefix ? `${prefix}>${key}` : key;
    if (typeof value === "string") flat[selector] = value;
    else Object.assign(flat, flattenNpmOverrides(value, selector));
  }
  return flat;
}

function overriddenPackageName(selector) {
  const target = selector.split(">").at(-1);
  const versionAt = target.indexOf("@", 1);
  return versionAt === -1 ? target : target.slice(0, versionAt);
}

test("npm and pnpm declare the same dependency overrides", () => {
  const pnpm = pnpmOverrides();
  assert.ok(Object.keys(pnpm).length > 0, "pnpm-workspace.yaml must declare overrides");
  assert.deepEqual(flattenNpmOverrides(npmOverrides()), pnpm);
});

test("no override replaces an exactly pinned whiteboard dependency", () => {
  const selectors = [...Object.keys(pnpmOverrides()), ...Object.keys(flattenNpmOverrides(npmOverrides()))];
  for (const selector of selectors) {
    assert.ok(
      !EXACTLY_PINNED.includes(overriddenPackageName(selector)),
      `override "${selector}" would replace an exactly pinned whiteboard dependency`,
    );
  }
});
