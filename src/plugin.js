// LAVISH-HARDENED: only the Agent Plugins manifest builders remain, for
// scripts/build-plugin.js. Upstream's client registration helpers (the stale-location
// check, the VS Code settings update, the Cursor link) and the process spawner they used
// are DELETED: `setup plugin` is removed, so this build registers itself with no client.

// Canonical schema identifier for the Agent Plugins version this manifest targets.
// Clients select their local validation rules from this string; they never fetch it.
export const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

// Not in package.json (npm infers no author), so the one authoritative copy lives here.
const PLUGIN_AUTHOR = Object.freeze({ name: "Kun Chen", url: "https://github.com/kunchenguid" });

/**
 * @typedef {object} PluginManifest
 * @property {string} $schema canonical Agent Plugins schema identifier
 * @property {string} name plugin name
 * @property {string} [version] plugin version
 * @property {string} [description] short description
 * @property {{ name?: string, email?: string, url?: string }} [author] author object
 * @property {string} [homepage] documentation URL
 * @property {string} [repository] source repository URL
 * @property {string} [license] SPDX license identifier
 * @property {string[]} [keywords] discovery tags
 */

/**
 * Build the Agent Plugins manifest from package.json so the two can never disagree.
 * Field order matches the published schema's reading order.
 *
 * @param {Record<string, any>} packageJson parsed package.json
 * @returns {PluginManifest} plugin.json contents
 */
export function createPluginManifest(packageJson) {
  return {
    $schema: PLUGIN_SCHEMA_URL,
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    author: PLUGIN_AUTHOR,
    homepage: packageJson.homepage,
    // The schema wants a plain URL string; package.json carries npm's `git+….git` form.
    repository: normalizeRepositoryUrl(packageJson.repository),
    license: packageJson.license,
    keywords: packageJson.keywords,
  };
}

/**
 * @param {Record<string, any>} packageJson parsed package.json
 * @returns {string} formatted plugin.json, newline-terminated to match Prettier
 */
export function createPluginManifestJson(packageJson) {
  return `${JSON.stringify(createPluginManifest(packageJson), null, 2)}\n`;
}

/**
 * @param {{ url?: string } | string | undefined} repository package.json `repository`
 * @returns {string | undefined} plain https URL
 */
export function normalizeRepositoryUrl(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (!url) return undefined;
  return url.replace(/^git\+/, "").replace(/\.git$/, "");
}
