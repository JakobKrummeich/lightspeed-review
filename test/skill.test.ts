import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HELP_START, BLOCKS_IN_FOREGROUND } from "../src/commands/home.ts";
import { renderSkill, SKILL_PATH } from "../src/skill.ts";

const skill = renderSkill();

test("the skill opens with frontmatter a skill loader can read", () => {
  assert.match(skill, /^---\nname: lightspeed\ndescription: .+\n---\n/);
});

test("the skill teaches the whole loop, start to close", () => {
  for (const command of ["start", "poll", "end"]) {
    assert.match(skill, new RegExp(`lightspeed ${command}`), command);
  }
});

test("the skill repeats the foreground-poll rule in the words the CLI uses", () => {
  assert.ok(skill.includes(BLOCKS_IN_FOREGROUND));
});

test("the skill quotes the CLI's own start guidance rather than a second copy", () => {
  assert.ok(skill.includes(HELP_START));
});

test("the skill says an ended review is refused, and how the reviewer asks for more", () => {
  assert.match(skill, /session_ended/);
  assert.match(skill, /start <branch> \[base\] --reopen/);
});

test("the checked-in SKILL.md is current — run `pnpm run build:skill`", () => {
  const onDisk = readFileSync(fileURLToPath(new URL(`../${SKILL_PATH}`, import.meta.url)), "utf8");

  assert.equal(onDisk, skill);
});
