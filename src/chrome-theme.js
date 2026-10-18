// LAVISH-FORK: the editor theme switcher's rules (specs/2026-10-18-theme-switcher-design.md).
// src/server.js inlines this module into the chrome's boot script through serializeModuleHelpers,
// so every export is a function, constants come only from chromeThemeConfig(), and the helpers
// call each other by these exact names.

/**
 * @typedef {{ mode: "system" | "light" | "dark", light: string, dark: string }} ChromeThemePreference
 */

/**
 * @returns {{ storageKey: string, light: string[], dark: string[], labels: Record<string, string>, defaults: ChromeThemePreference, maxLength: number }}
 */
export function chromeThemeConfig() {
  return {
    storageKey: "lavish-axi:theme",
    light: ["warm", "neutral", "cool"],
    dark: ["black", "ink", "graphite"],
    labels: { warm: "Warm", neutral: "Neutral", cool: "Cool", black: "Black", ink: "Ink", graphite: "Graphite" },
    defaults: { mode: "system", light: "warm", dark: "ink" },
    maxLength: 200,
  };
}

/**
 * The stored choice, with every field that is missing or unknown replaced by its default.
 * @param {string | null | undefined} raw
 * @returns {ChromeThemePreference}
 */
export function parseChromeThemePreference(raw) {
  const config = chromeThemeConfig();
  const preference = { ...config.defaults };
  if (typeof raw !== "string" || raw.length > config.maxLength) return preference;
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return preference;
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return preference;
  if (stored.mode === "system" || stored.mode === "light" || stored.mode === "dark") preference.mode = stored.mode;
  if (config.light.includes(stored.light)) preference.light = stored.light;
  if (config.dark.includes(stored.dark)) preference.dark = stored.dark;
  return preference;
}

/**
 * @param {ChromeThemePreference} preference
 * @param {boolean} systemDark
 * @returns {{ variant: string, scheme: "light" | "dark" }}
 */
export function resolveChromeTheme(preference, systemDark) {
  /** @type {"light" | "dark"} */
  const scheme = preference.mode === "system" ? (systemDark ? "dark" : "light") : preference.mode;
  return { variant: scheme === "dark" ? preference.dark : preference.light, scheme };
}

/**
 * The bar button: the side that is not showing becomes the explicit choice.
 * @param {ChromeThemePreference} preference
 * @param {boolean} systemDark
 * @returns {ChromeThemePreference}
 */
export function toggleChromeTheme(preference, systemDark) {
  const { scheme } = resolveChromeTheme(preference, systemDark);
  return { ...preference, mode: scheme === "dark" ? "light" : "dark" };
}

/**
 * A menu pick: remembered for its side and shown at once, leaving "Match system" only when the
 * system's side is not the pick's side.
 * @param {ChromeThemePreference} preference
 * @param {string} variant
 * @param {boolean} systemDark
 * @returns {ChromeThemePreference}
 */
export function chooseChromeThemeVariant(preference, variant, systemDark) {
  const config = chromeThemeConfig();
  const side = config.light.includes(variant) ? "light" : config.dark.includes(variant) ? "dark" : "";
  if (!side) return { ...preference };
  const next = { ...preference, [side]: variant };
  if (resolveChromeTheme(preference, systemDark).scheme !== side) next.mode = side;
  return next;
}

/**
 * Turning "Match system" off keeps the side that is showing.
 * @param {ChromeThemePreference} preference
 * @param {boolean} on
 * @param {boolean} systemDark
 * @returns {ChromeThemePreference}
 */
export function setChromeThemeMatchSystem(preference, on, systemDark) {
  if (on) return { ...preference, mode: "system" };
  return { ...preference, mode: resolveChromeTheme(preference, systemDark).scheme };
}
