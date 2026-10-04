import { readFile } from "node:fs/promises";

// LAVISH-HARDENED: Excalidraw appends `https://esm.sh/@excalidraw/excalidraw@<version>/dist/prod/` as
// a last-resort source for every bundled font (`ExcalidrawFontFace.createUrls`). The whiteboard frame's
// policy refuses that host, and Chromium raised one CSP refusal per font face - about 230 of them,
// Xiaolai's 209 subsets included - on every whiteboard load, before any text had asked for a font.
// The build drops that source, so fonts come only from EXCALIDRAW_ASSET_PATH (/whiteboard-assets/),
// and Xiaolai, which is not vendored, falls back to a system font.
const FALLBACK_PUSH = /\b[A-Za-z_$][\w$]*\.push\(new URL\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\.ASSETS_FALLBACK_URL\)\)/g;

/**
 * Replace each `urls.push(new URL(asset, ExcalidrawFontFace.ASSETS_FALLBACK_URL))` in minified
 * Excalidraw code with `0`, leaving the surrounding comma expression valid.
 * @param {string} source
 * @returns {{ code: string, count: number }}
 */
export function stripExcalidrawFontCdnFallback(source) {
  let count = 0;
  const code = source.replace(FALLBACK_PUSH, () => {
    count += 1;
    return "0";
  });
  return { code, count };
}

/**
 * esbuild plugin applying `stripExcalidrawFontCdnFallback` to Excalidraw's production build. The
 * caller must check `stats.stripped` after the build: anything but exactly 1 means Excalidraw's font
 * loader changed shape and the fallback may be back.
 * @param {{ stripped: number }} stats
 * @returns {import("esbuild").Plugin}
 */
export function excalidrawFontCdnPlugin(stats) {
  return {
    name: "strip-excalidraw-font-cdn",
    setup(build) {
      build.onLoad({ filter: /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/][^\\/]+\.js$/ }, async (args) => {
        const { code, count } = stripExcalidrawFontCdnFallback(await readFile(args.path, "utf8"));
        stats.stripped += count;
        return { contents: code, loader: "js" };
      });
    },
  };
}
