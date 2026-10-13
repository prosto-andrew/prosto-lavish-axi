import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ARTIFACT_HTML_ERROR, artifactTreeRoot, isHtmlPath, resolveAllowedArtifactFile } from "../src/artifact-path.js";

async function fileSymlinkUnavailable() {
  const probe = await mkdtemp(path.join(tmpdir(), "lavish-symlink-probe-"));
  try {
    await symlink(path.join(probe, "target"), path.join(probe, "link"), "file");
    return false;
  } catch (error) {
    return `file symlinks unavailable (${error.code || error.message}): Windows needs Developer Mode or an elevated shell`;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

// A file has no junction equivalent, so the cases that need a real file symlink skip where the OS
// refuses one instead of failing on EPERM.
const fileSymlinks = { skip: await fileSymlinkUnavailable() };

test("isHtmlPath matches the CLI .html / .htm rule", () => {
  assert.equal(isHtmlPath("report.html"), true);
  assert.equal(isHtmlPath("report.HTML"), true);
  assert.equal(isHtmlPath("report.htm"), true);
  assert.equal(isHtmlPath("/tmp/preview.Htm"), true);
  assert.equal(isHtmlPath("report.txt"), false);
  assert.equal(isHtmlPath("report.html.bak"), false);
  assert.equal(isHtmlPath("/etc/passwd"), false);
  assert.equal(isHtmlPath(""), false);
});

test("artifactTreeRoot is the HTML file's directory", () => {
  assert.equal(artifactTreeRoot("/tmp/preview/index.html"), "/tmp/preview");
});

test("resolveAllowedArtifactFile accepts a regular HTML file and returns its real path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-artifact-path-"));
  try {
    const artifact = path.join(dir, "preview.HTML");
    await writeFile(artifact, "<!doctype html><html><body></body></html>");
    const resolved = await resolveAllowedArtifactFile(artifact);
    assert.equal(resolved, await realpath(artifact));
    assert.equal(artifactTreeRoot(resolved), path.dirname(resolved));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveAllowedArtifactFile accepts .htm", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-artifact-path-"));
  try {
    const artifact = path.join(dir, "preview.htm");
    await writeFile(artifact, "<!doctype html><html><body></body></html>");
    assert.equal(path.basename(await resolveAllowedArtifactFile(artifact)), "preview.htm");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveAllowedArtifactFile refuses a non-HTML path without following it as a tree", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-artifact-path-"));
  try {
    const secret = path.join(dir, "secret.txt");
    await writeFile(secret, "outside-secret\n");
    await assert.rejects(() => resolveAllowedArtifactFile(secret), {
      name: "ArtifactPathError",
      message: ARTIFACT_HTML_ERROR,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveAllowedArtifactFile refuses an HTML symlink whose real path is not HTML", fileSymlinks, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-artifact-path-"));
  try {
    const secret = path.join(dir, "secret.txt");
    const decoy = path.join(dir, "decoy.html");
    await writeFile(secret, "outside-secret\n");
    await symlink(secret, decoy);
    await assert.rejects(() => resolveAllowedArtifactFile(decoy), {
      name: "ArtifactPathError",
      message: ARTIFACT_HTML_ERROR,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Where a Windows volume generates 8.3 short names, `notes.htmlx` gets the alias NOTES~1.HTM. The
// requested name passes the HTML check; only the realpath check, which expands the alias, refuses it.
// That is the check the symlink case above pins, and that case skips on a Windows account without
// symlink rights.
test(
  "resolveAllowedArtifactFile refuses an 8.3 alias that only looks like HTML",
  { skip: process.platform !== "win32" && "8.3 aliases exist only on Windows" },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "lavish-artifact-path-"));
    try {
      await writeFile(path.join(dir, "notes.htmlx"), "not html\n");
      const alias = path.join(dir, "NOTES~1.HTM");
      if (!existsSync(alias)) {
        t.skip("this volume generates no 8.3 aliases");
        return;
      }
      await assert.rejects(() => resolveAllowedArtifactFile(alias), {
        name: "ArtifactPathError",
        message: ARTIFACT_HTML_ERROR,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

// LAVISH-HARDENED: a colon in the last path component names an NTFS stream. realpath keeps it and stat
// reports a regular file, and a stream on a directory would make that directory's parent the tree.
test(
  "resolveAllowedArtifactFile refuses an NTFS stream name, on a directory or a file",
  { skip: process.platform !== "win32" && "NTFS streams exist only on Windows" },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lavish-artifact-path-"));
    try {
      const child = path.join(dir, "child");
      const secret = path.join(dir, "secret.txt");
      await mkdir(child);
      await writeFile(secret, "outside-secret\n");
      for (const stream of [`${child}:evil.html`, `${secret}:evil.html`]) {
        await writeFile(stream, "<!doctype html><html><body>stream</body></html>");
        await assert.rejects(() => resolveAllowedArtifactFile(stream), {
          name: "ArtifactPathError",
          message: ARTIFACT_HTML_ERROR,
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a colon in a POSIX file name is an ordinary character, not a stream",
  { skip: process.platform === "win32" && "Windows reserves the colon for streams" },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lavish-artifact-path-"));
    try {
      const artifact = path.join(dir, "notes:v2.html");
      await writeFile(artifact, "<!doctype html><html><body></body></html>");
      assert.equal(await resolveAllowedArtifactFile(artifact), await realpath(artifact));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("resolveAllowedArtifactFile refuses a directory whose name looks like HTML", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-artifact-path-"));
  try {
    const fake = path.join(dir, "site.html");
    await mkdir(fake);
    await assert.rejects(() => resolveAllowedArtifactFile(fake), {
      name: "ArtifactPathError",
      message: ARTIFACT_HTML_ERROR,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
