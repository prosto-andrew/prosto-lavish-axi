import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { stripExcalidrawFontCdnFallback } from "../scripts/excalidraw-font-cdn.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("stripExcalidrawFontCdnFallback drops the CDN source Excalidraw appends to every font", () => {
  const source =
    'static createUrls(t){let n=t.replace(/^\\/+/,""),r=[];r.push(new URL(n,o));' +
    "return r.push(new URL(n,jn.ASSETS_FALLBACK_URL)),r}";
  const { code, count } = stripExcalidrawFontCdnFallback(source);
  assert.equal(count, 1);
  assert.equal(code, 'static createUrls(t){let n=t.replace(/^\\/+/,""),r=[];r.push(new URL(n,o));return 0,r}');
});

test("stripExcalidrawFontCdnFallback leaves code without the fallback untouched", () => {
  const source = 'P(jn,"ASSETS_FALLBACK_URL",`https://esm.sh/x/dist/prod/`);r.push(new URL(n,o))';
  assert.deepEqual(stripExcalidrawFontCdnFallback(source), { code: source, count: 0 });
});

// The whiteboard build fails unless it strips exactly one fallback. Checking the installed package here
// too means an Excalidraw upgrade that reshapes createUrls fails a test, not only the build.
test("the installed Excalidraw build carries exactly one font CDN fallback for the build to strip", async () => {
  const dir = path.join(projectRoot, "node_modules/@excalidraw/excalidraw/dist/prod");
  let total = 0;
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".js")) continue;
    const { code, count } = stripExcalidrawFontCdnFallback(await readFile(path.join(dir, name), "utf8"));
    total += count;
    if (count) assert.ok(!code.includes(".ASSETS_FALLBACK_URL))"), `${name} still appends the CDN fallback`);
  }
  assert.equal(total, 1);
});
