import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HELP_START, BLOCKS_IN_FOREGROUND, TURN_RULE } from "../src/commands/home.ts";
import { REACHABLE_MODELS } from "../src/config.ts";
import { renderSkill, SKILL_PATH } from "../src/skill.ts";

const skill = renderSkill();

test("the skill opens with frontmatter a skill loader can read", () => {
  assert.match(skill, /^---\nname: lightspeed\ndescription: .+\n---\n/);
});

test("the skill teaches the whole loop, start to close", () => {
  for (const command of ["start", "wait", "ask", "say", "work", "end"]) {
    assert.match(skill, new RegExp(`lightspeed ${command}`), command);
  }
});

/** The one sentence the whole protocol reduces to, worded once in the CLI and
 * quoted everywhere: two copies would drift and the agent would learn the stale one. */
test("the skill states the turn rule in the CLI's own words", () => {
  assert.ok(skill.includes(TURN_RULE));
  assert.match(skill, /^## The turn$/m);
  // What the agent has to know to pick a command: where the turn comes from, and
  // that it is stated on every answer.
  assert.match(skill, /`turn`/);
  assert.match(skill, /`round`/);
});

test("the skill repeats the foreground-wait rule in the words the CLI uses", () => {
  assert.ok(skill.includes(BLOCKS_IN_FOREGROUND));
});

/** `poll` is gone, not renamed: a skill still naming it teaches a command the CLI
 * answers with "Unknown command". */
test("the skill never names the command that was replaced", () => {
  assert.doesNotMatch(skill, /lightspeed poll/);
  assert.doesNotMatch(skill, /--agent-reply/);
});

test("the skill quotes the CLI's own start guidance rather than a second copy", () => {
  assert.ok(skill.includes(HELP_START));
});

/**
 * B2: the Setup section told the agent to write `"model": "<provider/model>"`
 * — a placeholder nothing here resolves. There is no `models` command, so the
 * skill is the only place a real id can come from, and a guessed one degrades
 * every review to a single group without failing.
 */
test("the skill's setup names models that exist instead of a placeholder", () => {
  assert.doesNotMatch(skill, /<provider\/model>/);
  for (const model of REACHABLE_MODELS) assert.ok(skill.includes(model), model);
  assert.match(skill, /lightspeed init --config/);
});

test("the skill says an ended review is refused, and how the reviewer asks for more", () => {
  assert.match(skill, /session_ended/);
  assert.match(skill, /start <branch> \[base\] --reopen/);
});

test("the checked-in SKILL.md is current — run `pnpm run build:skill`", () => {
  const onDisk = readFileSync(fileURLToPath(new URL(`../${SKILL_PATH}`, import.meta.url)), "utf8");

  assert.equal(onDisk, skill);
});
