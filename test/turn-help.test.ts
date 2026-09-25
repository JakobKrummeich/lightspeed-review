import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HELP_OPEN,
  TURN_RULES,
  WAITS_FOR_SEND,
  helpReopen,
  nextRule,
  publishCall,
  replyCall,
  workCall,
} from "../src/turn-help.ts";

const TARGET = "feat/tokens main";

/** D5: not a menu of what is legal, but what to do next, keyed by the decision. */
test("digesting: the rule is talk or work, never both, with ambiguity asked first", () => {
  const rule = nextRule("agent digesting", TARGET, ["t1", "t4"]);

  assert.deepEqual(Object.keys(rule), ["talk", "work", "ambiguity", "rule"]);
  assert.match(
    rule.talk!,
    /lightspeed reply --to t1 '<answer>' --to t4 '<answer>' feat\/tokens main/,
  );
  assert.match(rule.work!, /lightspeed work '<plan>' feat\/tokens main/);
  assert.match(rule.work!, /clear change requests go straight here/);
  assert.match(rule.rule!, /never both/);
});

test("the reply line names at most three items, and t1 when it holds none", () => {
  const many = nextRule("agent digesting", TARGET, ["t1", "t2", "t3", "t4"]);
  assert.doesNotMatch(many.talk!, /t4/);
  assert.match(nextRule("agent digesting", TARGET).talk!, /--to t1 '<answer>'/);
});

test("working: publish, waiting in the foreground; a question goes in the new round", () => {
  const rule = nextRule("agent working", TARGET, ["t5"]);

  assert.deepEqual(Object.keys(rule), ["publish", "blocked"]);
  assert.match(rule.publish!, /lightspeed publish feat\/tokens main --intent .* --to t5 'done: /);
  assert.ok(rule.publish!.endsWith(WAITS_FOR_SEND));
  assert.match(rule.blocked!, /while nothing has changed since work/);
});

test("the reviewer's turn: the only move is to listen by re-running open", () => {
  const rule = nextRule("reviewer", TARGET);

  assert.deepEqual(Object.keys(rule), ["listen"]);
  assert.match(rule.listen!, /lightspeed open feat\/tokens main`/);
  assert.match(rule.listen!, /foreground/);
});

test("ended: done, and a new round only when the reviewer asks for one", () => {
  const rule = nextRule("ended", TARGET);

  assert.deepEqual(Object.keys(rule), ["done"]);
  assert.equal(rule.done, `The review is over. ${helpReopen(TARGET)}`);
  assert.match(rule.done!, /lightspeed open feat\/tokens main --reopen --intent '<why>'/);
});

/** Single quotes: an agent pastes these into a shell, where they expand nothing. */
test("every placeholder is single-quoted, so a pasted line runs as written", () => {
  for (const line of [HELP_OPEN, replyCall(TARGET), workCall(TARGET), publishCall(TARGET)]) {
    assert.doesNotMatch(line, /"</, line);
  }
  assert.match(HELP_OPEN, /--intent '<why this branch exists>'/);
});

test("the turn rules are the three the protocol reduces to", () => {
  assert.equal(TURN_RULES.length, 3);
  assert.match(TURN_RULES[1], /reply.*work.*never both/);
});
