import { chmod, copyFile, cp, mkdir, readFile } from "node:fs/promises";

import * as esbuild from "esbuild";

import { excalidrawFontCdnPlugin } from "./excalidraw-font-cdn.js";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await mkdir("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["bin/lavish-axi.js"],
  outfile: "dist/cli.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  define: {
    "process.env.LAVISH_AXI_BUILD_UMAMI_HOST": JSON.stringify(process.env.LAVISH_AXI_UMAMI_HOST || ""),
    "process.env.LAVISH_AXI_BUILD_UMAMI_WEBSITE_ID": JSON.stringify(process.env.LAVISH_AXI_UMAMI_WEBSITE_ID || ""),
    "process.env.LAVISH_AXI_BUILD_VERSION": JSON.stringify(packageJson.version),
  },
});

await chmod("dist/cli.mjs", 0o755);

await esbuild.build({
  entryPoints: ["bin/lavish-axi-server.js"],
  outfile: "dist/server.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  plugins: [
    {
      name: "external-cli",
      setup(build) {
        build.onResolve({ filter: /^\.\/lavish-axi\.js$/ }, () => ({
          path: "./cli.mjs",
          external: true,
        }));
      },
    },
  ],
});
await chmod("dist/server.mjs", 0o755);

await copyFile("src/chrome-client.js", "dist/chrome-client.js");
await copyFile("src/chrome.css", "dist/chrome.css");
await mkdir("dist/design", { recursive: true });
await copyFile("node_modules/daisyui/daisyui.css", "dist/design/daisyui.css");
await copyFile("node_modules/daisyui/themes.css", "dist/design/daisyui-themes.css");
await copyFile("node_modules/@tailwindcss/browser/dist/index.global.js", "dist/design/tailwindcss-browser.js");

// LAVISH-HARDENED: vendor the Mermaid ESM bundle so artifacts render diagrams with no
// CDN request. The chunk directory must keep its layout - mermaid.esm.min.mjs
// imports from "./chunks/mermaid.esm.min/...".
await mkdir("dist/design/mermaid/chunks", { recursive: true });
await copyFile("node_modules/mermaid/dist/mermaid.esm.min.mjs", "dist/design/mermaid/mermaid.esm.min.mjs");
await cp("node_modules/mermaid/dist/chunks/mermaid.esm.min", "dist/design/mermaid/chunks/mermaid.esm.min", {
  recursive: true,
});

// Whiteboard frame: a self-contained browser bundle (Excalidraw + the Mermaid
// converter + its exactly-pinned mermaid + React) served from
// /whiteboard-assets/ by an embedded frame for every rendered Mermaid diagram
// in a `.mermaid` container.
// Everything is vendored so the eagerly loaded whiteboards work fully offline.
await mkdir("dist/whiteboard", { recursive: true });
const fontCdnStats = { stripped: 0 };
await esbuild.build({
  entryPoints: { whiteboard: "src/whiteboard-frame.js" },
  plugins: [excalidrawFontCdnPlugin(fontCdnStats)],
  outdir: "dist/whiteboard",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  conditions: ["production"],
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.IS_PREACT": '"false"',
  },
});
if (fontCdnStats.stripped !== 1) {
  throw new Error(
    `Expected to strip exactly one Excalidraw font CDN fallback, stripped ${fontCdnStats.stripped} - re-audit scripts/excalidraw-font-cdn.js against the new Excalidraw build`,
  );
}

// Excalidraw lazily fetches canvas fonts from `EXCALIDRAW_ASSET_PATH/fonts/`.
// Vendor every family except Xiaolai (12 MB of CJK glyphs; with the CDN
// fallback stripped above, those fall back to a system font).
const fontFamilies = ["Assistant", "Cascadia", "ComicShanns", "Excalifont", "Liberation", "Lilita", "Nunito", "Virgil"];
await mkdir("dist/whiteboard/fonts", { recursive: true });
for (const family of fontFamilies) {
  await cp(`node_modules/@excalidraw/excalidraw/dist/prod/fonts/${family}`, `dist/whiteboard/fonts/${family}`, {
    recursive: true,
  });
}
