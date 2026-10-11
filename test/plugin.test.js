import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PLUGIN_SCHEMA_URL,
  createPluginManifest,
  createPluginManifestJson,
  normalizeRepositoryUrl,
} from "../src/plugin.js";
import { validateSkillMarkdown } from "../src/skill.js";

// Closed manifest schema from agent-plugins.org/schemas/1.0.0/plugin.schema.json.
const ALLOWED_MANIFEST_FIELDS = [
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
];
const MANIFEST_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

test("generated manifest satisfies the closed Agent Plugins 1.0.0 schema", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = createPluginManifest(packageJson);

  assert.equal(manifest.$schema, PLUGIN_SCHEMA_URL, "targets the canonical schema identifier");
  assert.match(manifest.name, MANIFEST_NAME_PATTERN);
  assert.ok(manifest.name.length >= 1 && manifest.name.length <= 64);

  for (const field of Object.keys(manifest)) {
    assert.ok(ALLOWED_MANIFEST_FIELDS.includes(field), `\`${field}\` is a permitted top-level field`);
  }
  // `author` is itself closed to name/email/url.
  for (const field of Object.keys(manifest.author)) {
    assert.ok(["name", "email", "url"].includes(field), `author.${field} is permitted`);
  }
  assert.ok(Array.isArray(manifest.keywords));
});

test("generated manifest tracks package.json rather than restating it", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = createPluginManifest(packageJson);

  assert.equal(manifest.name, packageJson.name);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.description, packageJson.description);
  assert.equal(manifest.license, packageJson.license);
  assert.deepEqual(manifest.keywords, packageJson.keywords);
});

test("committed plugin.json stays in sync with package.json", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const committed = await readFile(new URL("../plugin.json", import.meta.url), "utf8");

  assert.equal(committed, createPluginManifestJson(packageJson), "run `npm run build:plugin` and commit the result");
});

test("normalizeRepositoryUrl converts npm git URLs to plain https", () => {
  assert.equal(
    normalizeRepositoryUrl({ url: "git+https://github.com/kunchenguid/lavish-axi.git" }),
    "https://github.com/kunchenguid/lavish-axi",
  );
  assert.equal(normalizeRepositoryUrl("https://example.com/x"), "https://example.com/x");
  assert.equal(normalizeRepositoryUrl(undefined), undefined);
});

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("the package root is itself a discoverable Agent Plugin", async () => {
  // This is the whole point of the adoption: no separate plugin artifact to publish.
  const root = PACKAGE_ROOT;
  const manifest = JSON.parse(await readFile(path.join(root, "plugin.json"), "utf8"));
  assert.equal(manifest.$schema, PLUGIN_SCHEMA_URL, "plugin.json sits at the plugin root");

  // Spec section 7.1: each immediate child of skills/ holding a regular SKILL.md is one skill.
  const entries = await readdir(path.join(root, "skills"), { withFileTypes: true });
  const discovered = entries.filter(
    (entry) => entry.isDirectory() && existsSync(path.join(root, "skills", entry.name, "SKILL.md")),
  );
  assert.deepEqual(
    discovered.map((entry) => entry.name),
    ["lavish"],
    "exactly the lavish skill is discovered",
  );

  const skill = await readFile(path.join(root, "skills", "lavish", "SKILL.md"), "utf8");
  assert.deepEqual(validateSkillMarkdown(skill, { directoryName: "lavish" }).errors, []);
});

test("the plugin declares no MCP servers", async () => {
  // lavish-safe's agent surface is the CLI itself; an mcp.json would add a second contract.
  assert.equal(existsSync(path.join(PACKAGE_ROOT, "mcp.json")), false);
});
