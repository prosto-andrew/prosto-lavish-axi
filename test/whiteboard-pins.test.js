import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The Mermaid-to-Excalidraw converter reaches into mermaid's rendered DOM and
// diagram.db internals, so a mermaid release can silently degrade class/ER/state
// diagrams and subgraph flowcharts to non-editable image fallbacks
// (mermaid-to-excalidraw#108). 11.14.0 did, by prefixing rendered ids, which
// installMermaidRenderIdPrefixShim in src/whiteboard-core.js undoes. mermaid is
// therefore pinned EXACTLY, and the same copy is vendored for artifacts. A bump
// changes this test first, and must pass the native-conversion re-probe in
// test/whiteboard-render.browser.test.js before it lands.

const REQUIRED_EXACT_PINS = {
  mermaid: "11.16.1",
  "@excalidraw/excalidraw": "0.18.1",
  "@excalidraw/mermaid-to-excalidraw": "2.2.2",
};

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

// The version a bare `import "<name>"` inside `packageDir` reaches, found the way Node
// and esbuild look it up: node_modules directories upward from the package's real path.
// Under pnpm that is the package's own dependency, not the top-level node_modules copy.
function versionResolvedFrom(packageDir, name) {
  const real = realpathSync(fileURLToPath(new URL(packageDir, import.meta.url)));
  const require = createRequire(path.join(real, "package.json"));
  for (const dir of require.resolve.paths(name) ?? []) {
    const manifest = path.join(dir, name, "package.json");
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")).version;
  }
  return undefined;
}

test("whiteboard dependencies are pinned exactly in package.json", () => {
  const pkg = readJson("../package.json");
  for (const [name, version] of Object.entries(REQUIRED_EXACT_PINS)) {
    assert.equal(pkg.devDependencies[name], version, `${name} must be pinned exactly to ${version}`);
  }
});

test("the installed mermaid the build vendors for artifacts is the pinned version", () => {
  const installed = readJson("../node_modules/mermaid/package.json");
  assert.equal(installed.version, REQUIRED_EXACT_PINS.mermaid);
});

// The whiteboard bundle gets mermaid through the converter's own import, and the
// converter asks only for `^11.12.1`, so a lockfile can keep it on an older mermaid
// after the top-level pin moves. Fix that with `pnpm dedupe`, never an override.
test("the mermaid the whiteboard converter imports is the pinned version", () => {
  assert.equal(
    versionResolvedFrom("../node_modules/@excalidraw/mermaid-to-excalidraw", "mermaid"),
    REQUIRED_EXACT_PINS.mermaid,
  );
});

test("the converter and editor resolve to their pinned versions", () => {
  assert.equal(
    readJson("../node_modules/@excalidraw/mermaid-to-excalidraw/package.json").version,
    REQUIRED_EXACT_PINS["@excalidraw/mermaid-to-excalidraw"],
  );
  assert.equal(
    readJson("../node_modules/@excalidraw/excalidraw/package.json").version,
    REQUIRED_EXACT_PINS["@excalidraw/excalidraw"],
  );
});
