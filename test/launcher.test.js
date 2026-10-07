import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// LAVISH-HARDENED: the launchers are the only supported way to run this build, so what they run
// and what they refuse is the hardening's last gate. Each test puts the real launcher in a fake
// checkout beside a stub verifier and a stub CLI, so only the launcher's own behaviour is under
// test. Windows runs the .cmd, every other platform the bash script.
const isWindows = process.platform === "win32";
const LAUNCHER = isWindows ? "lavish-safe.cmd" : "lavish-safe";

// On Windows the directory carries a space and parentheses - the shape of "Program Files (x86)",
// which once closed a parenthesized block in the .cmd early and made it exit with no message.
async function fakeCheckout({ verifierPasses }) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "lavish-launcher-"));
  const root = path.join(parent, isWindows ? "lavish (x86) safe" : "lavish safe");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await copyFile(fileURLToPath(new URL(`../${LAUNCHER}`, import.meta.url)), path.join(root, LAUNCHER));
  if (!isWindows) await chmod(path.join(root, LAUNCHER), 0o755);
  // A version line and a hardening marker, so a launcher that only greps them would let this run.
  await writeFile(path.join(root, "package.json"), '{\n  "version": "0.1.82"\n}\n');
  await writeFile(
    path.join(root, "verify-hardening.mjs"),
    verifierPasses
      ? 'if (!process.argv.includes("--quiet")) console.log("verbose verifier report");\n'
      : 'console.log(" FAIL  stub check  dist/ is older than src/cli.js");\nprocess.exit(1);\n',
  );
  await writeFile(
    path.join(root, "dist", "cli.mjs"),
    [
      "// LAVISH-HARDENED stub",
      "const { LAVISH_AXI_TELEMETRY: telemetry, LAVISH_AXI_HOST: host } = process.env;",
      "console.log(JSON.stringify({ argv: process.argv.slice(2), telemetry, host }));",
      "process.exit(7);",
      "",
    ].join("\n"),
  );
  return { parent, root };
}

function runLauncher(root, args) {
  const launcher = path.join(root, LAUNCHER);
  if (!isWindows) return spawnSync(launcher, args, { encoding: "utf8" });
  // Every Windows shell runs a .cmd through cmd.exe; quote each argument the way a caller must.
  const line = [launcher, ...args].map((arg) => `"${arg}"`).join(" ");
  return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    encoding: "utf8",
    windowsVerbatimArguments: true,
  });
}

test("the launcher refuses to start when the verifier fails", async () => {
  const { parent, root } = await fakeCheckout({ verifierPasses: false });
  try {
    const result = runLauncher(root, ["poll", "report.html"]);

    assert.doesNotMatch(result.stdout, /"argv"/, "the CLI must not run");
    assert.match(result.stderr, /dist\/ is older than src\/cli\.js/, "the verifier's failure must reach the user");
    assert.match(result.stderr, /refusing to start/);
    assert.notEqual(result.status, 0);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("the launcher runs the verified build with its arguments, environment and exit code", async () => {
  const { parent, root } = await fakeCheckout({ verifierPasses: true });
  try {
    const result = runLauncher(root, ["poll", "my report.html", "a&b"]);

    // stdout carries the CLI's response alone: the agent parses it.
    assert.deepEqual(JSON.parse(result.stdout), {
      argv: ["poll", "my report.html", "a&b"],
      telemetry: "0",
      host: "127.0.0.1",
    });
    assert.equal(result.status, 7, result.stderr);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});
