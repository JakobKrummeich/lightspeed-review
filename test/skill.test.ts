import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HELP_OPEN, TURN_RULES, WAITS_FOR_SEND, nextRule } from "../src/turn-help.ts";
import { REACHABLE_MODELS } from "../src/config.ts";
import { renderSkill, SKILL_PATH } from "../src/skill.ts";

const skill = renderSkill();

test("the skill opens with frontmatter a skill loader can read", () => {
  assert.match(skill, /^---\nname: lightspeed\ndescription: .+\n---\n/);
});

test("the skill teaches the whole loop, open to close", () => {
  for (const command of ["open", "reply", "work", "publish", "end"]) {
    assert.match(skill, new RegExp(`lightspeed ${command}`), command);
  }
});

/** The rules the whole protocol reduces to, worded once in the CLI and quoted
 * everywhere: two copies would drift and the agent would learn the stale one. */
test("the skill states the turn rules in the CLI's own words", () => {
  for (const rule of TURN_RULES) assert.ok(skill.includes(rule), rule);
  assert.match(skill, /^## The turn$/m);
  // What the agent has to know to pick a command: where the turn comes from, and
  // that it is stated on every answer.
  assert.match(skill, /`turn`/);
  assert.match(skill, /`round`/);
});

test("the skill repeats the waits-for-your-Send rule in the words the CLI uses", () => {
  assert.ok(skill.includes(WAITS_FOR_SEND));
});

/** The skill is read once, at startup: the kill rule has to be in it whole, not only in `help[]`. */
test("the skill's rules name the shell tool's timeout and forbid a second review to recover", () => {
  const rules = skill
    .slice(skill.indexOf("## Rules"), skill.indexOf("## Setup"))
    .replace(/\s+/g, " ");
  assert.match(rules, /often minutes to hours/);
  assert.match(rules, /Call your shell tool with NO timeout parameter, not via `timeout` or `&`/);
  assert.match(rules, /only that command died: the server and the review stay live/);
  assert.match(rules, /Re-run exactly the same command with NO timeout/);
  assert.match(rules, /Never open another review, `end` or `--reopen` to recover/);
  assert.doesNotMatch(skill, /foreground/);
});

/** D3: "locked" is the browser's word, "waits for your Send" the CLI's. */
test("the skill never says blocking", () => {
  assert.doesNotMatch(skill, /\bblock(s|ing|ed)?\b/i);
});

test("the skill quotes the next rule the CLI prints, not a paraphrase of it", () => {
  const digesting = nextRule("agent digesting", "<branch>", ["t4", "t2"]);
  assert.ok(skill.includes(digesting.talk!));
  assert.ok(skill.includes(digesting.work!));
  assert.ok(skill.includes(nextRule("agent working", "<branch>", ["t4"]).publish!));
});

/** `poll` is gone, not renamed: a skill still naming it teaches a command the CLI
 * answers with "Unknown command". */
test("the skill never teaches a command that was replaced", () => {
  for (const gone of ["poll", "wait", "ask", "say", "start"]) {
    assert.doesNotMatch(skill, new RegExp(`lightspeed ${gone}\\b`), gone);
  }
  assert.doesNotMatch(skill, /--agent-reply|--wait|--for /);
  assert.match(skill, /removed_verb/);
});

test("the skill quotes the CLI's own open guidance rather than a second copy", () => {
  assert.ok(skill.includes(HELP_OPEN));
});

/**
 * There is no `models` command, so the skill is the only place a real id can
 * come from, and a guessed one degrades every review to a single group without
 * failing.
 */
test("the skill's setup names models that exist instead of a placeholder", () => {
  assert.doesNotMatch(skill, /<provider\/model>/);
  for (const model of REACHABLE_MODELS) assert.ok(skill.includes(model), model);
  assert.match(skill, /lightspeed init --config/);
});

test("the skill says an ended review is refused, and how the reviewer asks for more", () => {
  assert.match(skill, /session_ended/);
  assert.match(skill, /open <branch> \[base\] --reopen/);
});

test("the checked-in SKILL.md is current — run `pnpm run build:skill`", () => {
  const onDisk = readFileSync(fileURLToPath(new URL(`../${SKILL_PATH}`, import.meta.url)), "utf8");

  assert.equal(onDisk, skill);
});

/** A rule key renamed under the skill once printed `undefined` into every agent's instructions. */
test("the skill quotes every working rule the CLI prints, and nothing unfilled", () => {
  const working = nextRule("agent working", "<branch>", ["t4"]);

  for (const line of Object.values(working)) assert.ok(skill.includes(line), line);
  assert.doesNotMatch(skill, /\bundefined\b/);
});

/**
 * A bad model degrades the round; missing credentials stop it (both pinned
 * against `groupDiff` in test/llm/grouping.test.ts). SKILL.md is generated
 * output an agent reads as the contract, so the two outcomes must be two
 * separate claims: worded as one, an agent told its user a credential-less
 * review would "fall back".
 */
test("the skill states the fallback and the credentials stop as separate claims", () => {
  const paragraph = skill.split("\n\n").find((block) => block.includes("grouping.mode: fallback"));
  const sentences = (paragraph ?? "").replace(/\n/g, " ").split(/(?<=[.:—])\s+(?=[A-Z])/);
  const degrades = sentences.find((sentence) => /does not fail the run/.test(sentence));
  const stops = sentences.find((sentence) => /credentials/i.test(sentence));

  assert.ok(degrades !== undefined && stops !== undefined, paragraph);
  assert.notEqual(degrades, stops);
  assert.doesNotMatch(degrades, /credential|login/i);
  assert.match(stops, /`pi_auth_missing`/);
  assert.match(stops, /no round opened/);
  assert.match(stops, /`lightspeed login <provider>`/);
  assert.doesNotMatch(stops, /fallback/);
});
