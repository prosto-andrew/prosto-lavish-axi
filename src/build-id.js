/* global __LAVISH_BUILD_ID__ */
// LAVISH-HARDENED: scripts/build.js defines a fresh id for every build, and /health reports it as
// `hardened_build`, so the CLI keeps a running server only when it is this very build. A run from
// source has none and says "source". A free identifier rather than `process.env`: no environment
// variable can set it.
// @ts-expect-error __LAVISH_BUILD_ID__ exists only where scripts/build.js defines it
export const BUILD_ID = typeof __LAVISH_BUILD_ID__ === "string" ? __LAVISH_BUILD_ID__ : "source";
