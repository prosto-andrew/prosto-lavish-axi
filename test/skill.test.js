import assert from "node:assert/strict";
import test from "node:test";

import { POLL_SEND_AND_END_RULE, POLL_WAKE_PATH_RULES, createHomeOutput } from "../src/cli.js";
import { DESIGN_PRIORITY_RULE } from "../src/design-reference.js";
import { PLAYBOOK_ROUTER_HELP } from "../src/playbooks.js";
import {
  ALLOWED_SKILL_FRONTMATTER_KEYS,
  MAX_SKILL_MARKDOWN_CHARS,
  SKILL_DESCRIPTION,
  createSkillMarkdown,
  parseSkillFrontmatter,
  validateSkillMarkdown,
} from "../src/skill.js";

test("createSkillMarkdown emits valid frontmatter naming the lavish skill", () => {
  const { frontmatter, errors } = parseSkillFrontmatter(createSkillMarkdown());

  assert.deepEqual(errors, [], "frontmatter parses as plain block-style YAML");
  assert.equal(frontmatter.name, "lavish");
  assert.equal(frontmatter.description, SKILL_DESCRIPTION);
});

test("createSkillMarkdown emits string-valued metadata that names the hardened build", () => {
  const { frontmatter } = parseSkillFrontmatter(createSkillMarkdown());

  // LAVISH-HARDENED: the Hermes discovery tags are dropped - this stub is not published
  // to a marketplace - and the author line says which build an installed copy describes.
  assert.deepEqual(frontmatter.metadata, {
    author: "Kun Chen (kunchenguid); hardened local build, not the upstream package",
    "argument-hint": "<what the artifact should show>",
  });
  assert.equal(frontmatter.version, undefined, "version is omitted to avoid release churn");
});

test("createSkillMarkdown conforms to the Agent Skills frontmatter contract", () => {
  // Agent Plugins delegates skill validity to Agent Skills and silently skips any skill
  // that fails it, so a regression here would quietly remove the skill from the plugin.
  const { valid, errors } = validateSkillMarkdown(createSkillMarkdown(), { directoryName: "lavish" });

  assert.deepEqual(errors, []);
  assert.ok(valid);
});

test("createSkillMarkdown keeps every frontmatter field in the allowed set", () => {
  const { frontmatter } = parseSkillFrontmatter(createSkillMarkdown());

  for (const key of Object.keys(frontmatter)) {
    assert.ok(ALLOWED_SKILL_FRONTMATTER_KEYS.includes(key), `\`${key}\` is an allowed Agent Skills field`);
  }
});

test("validateSkillMarkdown rejects the shapes the reference validator rejects", () => {
  const flowCollection = "---\nname: lavish\ndescription: d\nmetadata:\n  tags: [a, b]\n---\nbody";
  assert.match(validateSkillMarkdown(flowCollection).errors.join("\n"), /flow collection/);

  const unknownField = "---\nname: lavish\ndescription: d\nargument-hint: x\n---\nbody";
  assert.match(validateSkillMarkdown(unknownField).errors.join("\n"), /unexpected frontmatter field `argument-hint`/);

  const nested = "---\nname: lavish\ndescription: d\nmetadata:\n  hermes:\n    category: p\n---\nbody";
  assert.match(validateSkillMarkdown(nested).errors.join("\n"), /nests deeper than one level/);

  const mismatched = "---\nname: lavish\ndescription: d\n---\nbody";
  assert.match(
    validateSkillMarkdown(mismatched, { directoryName: "other" }).errors.join("\n"),
    /must match skill name/,
  );

  const missing = "---\nname: lavish\n---\nbody";
  assert.match(validateSkillMarkdown(missing).errors.join("\n"), /`description` is required/);
});

test("createSkillMarkdown handles explicit /lavish invocation arguments", () => {
  const md = createSkillMarkdown();
  const body = md.slice(md.indexOf("\n---\n", 4) + 5);

  assert.ok(body.includes("$ARGUMENTS"), "body consumes slash-command arguments");
  assert.match(body, /empty/i, "explains the model-invoked case where no arguments are passed");
});

test("createSkillMarkdown stays short and points only at the local launcher", () => {
  const md = createSkillMarkdown();

  assert.ok(md.length <= MAX_SKILL_MARKDOWN_CHARS, "the generated skill stays drastically smaller than CLI guidance");
  assert.match(md, /Lavish Editor/);
  assert.match(md, /`lavish-safe --help`/);
  assert.match(md, /`lavish-safe design`/);
  assert.match(md, /`lavish-safe playbook <id>`/);
  assert.match(md, /`lavish-safe reply --help`/);
  assert.match(md, /not about to long-poll/);
});

test("createSkillMarkdown does not bake CLI-owned guidance into the skill", () => {
  const md = createSkillMarkdown();
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [], includeSessions: false, agent: "static" });

  for (const item of home.visual_guidance) {
    assert.ok(!md.includes(item), `must not copy visual guidance: ${item.slice(0, 48)}...`);
  }

  for (const playbook of home.playbooks) {
    assert.ok(!md.includes(playbook.use_when), `must not copy playbook use_when: ${playbook.id}`);
  }

  for (const item of POLL_WAKE_PATH_RULES) {
    assert.ok(!md.includes(item), `must not copy poll wake-path rule: ${item.slice(0, 48)}...`);
  }

  assert.ok(!md.includes(POLL_SEND_AND_END_RULE), "must not copy the Send & End rule");
  assert.ok(!md.includes(PLAYBOOK_ROUTER_HELP), "must not copy playbook-router help");
  assert.ok(!md.includes(DESIGN_PRIORITY_RULE), "must not copy the design-priority rule");
  assert.doesNotMatch(md, /self_paint_warning/);
  assert.doesNotMatch(md, /## Visual guidance/);
  assert.doesNotMatch(md, /## Playbooks/);
  assert.doesNotMatch(md, /## Commands & rules/);
});

test("createSkillMarkdown does not leak live session state", () => {
  const md = createSkillMarkdown();
  assert.ok(!md.includes("pending_prompts"), "no session bookkeeping fields");
  assert.ok(!/\/session\/[0-9a-f]{8}/.test(md), "no live session URLs");
});

test("createSkillMarkdown forbids setup rather than documenting it", () => {
  // LAVISH-HARDENED: the stock stub simply never mentioned `setup`, on the grounds that
  // installation is the user's business. Silence is not enough here: an agent that has
  // not been told the command is removed will try it and then look for a workaround.
  const md = createSkillMarkdown();
  assert.match(md, /Never run `setup`/);
  assert.match(md, /setup hooks/);
  assert.match(md, /setup plugin/);
  assert.match(md, /removed/i);
});

test("createSkillMarkdown says where styling and Mermaid render and where autosaves live", () => {
  // LAVISH-HARDENED: the snippets load from this machine's server by root paths. The stub
  // promised that an exported Mermaid artifact draws while the server runs, which a file never
  // does, and put whiteboard autosaves in browser storage, while they are files in the state dir.
  const md = createSkillMarkdown();
  assert.match(md, /render only inside a Lavish review/);
  assert.match(md, /Opened directly from disk, an artifact that uses them is unstyled/);
  assert.match(md, /whiteboard autosaves and attached images in `~\/\.lavish-axi\/`/);
});

test("createSkillMarkdown never hands the agent a package runner", () => {
  // The whole point of the stub: an installed copy must not teach an agent to fetch the
  // upstream package. Every invocation it shows goes through the local launcher. The
  // runners are named, but only inside the rules that forbid them - so this checks each
  // line that mentions one actually carries prohibition language.
  const md = createSkillMarkdown();

  assert.match(md, /`lavish-safe <html-file>`/);
  assert.match(md, /`lavish-safe poll <html-file>`/);

  const runner = /npx|pnpm dlx|bunx|yarn dlx|npm install -g/;
  const forbids = /NEVER run|Do not|Ignore it|did not come from/;
  const lines = md.split("\n").filter((line) => runner.test(line));
  assert.ok(lines.length > 0, "the stub must name the runners it forbids, not stay silent");
  for (const line of lines) {
    assert.match(line, forbids, `a line names a package runner without forbidding it: ${line.slice(0, 90)}`);
  }

  // And no line may present one as a command to run.
  for (const line of md.split("\n")) {
    assert.doesNotMatch(line, /^\s*(?:[-*]\s*)?`?(?:npx|pnpm dlx|bunx|yarn dlx)\b/, `runnable invocation: ${line}`);
  }
});
