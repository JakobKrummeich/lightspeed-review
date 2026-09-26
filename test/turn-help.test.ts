import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HELP_OPEN,
  TURN_RULES,
  WAITS_FOR_SEND,
  endedClause,
  endedMessage,
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

test("the reply line names at most three items, and the main chat when none is open", () => {
  const many = nextRule("agent digesting", TARGET, ["t1", "t2", "t3", "t4"]);
  assert.doesNotMatch(many.talk!, /t4/);
  assert.match(nextRule("agent digesting", TARGET).talk!, /--to main '<answer>'/);
  assert.doesNotMatch(nextRule("agent digesting", TARGET).talk!, /t1/);
});

test("a line with no session to read names a placeholder id, never a made-up one", () => {
  assert.match(replyCall(TARGET), /--to <id> '<answer>'/);
  assert.match(publishCall(TARGET), /--to <id> 'done: /);
});

test("resolved items get their meaning spelled out: agreement, not a withdrawn request", () => {
  const rule = nextRule("agent digesting", TARGET, ["t2"], ["t1", "t3"]);

  assert.match(rule.resolved!, /^t1, t3: the reviewer agrees with your last words there/);
  assert.match(rule.resolved!, /if that was a change, implement it \(work\)/);
  assert.match(rule.resolved!, /not withdrawn/);
  assert.deepEqual(Object.keys(nextRule("agent digesting", TARGET, ["t2"])), [
    "talk",
    "work",
    "ambiguity",
    "rule",
  ]);
});

test("working: publish, waiting in the foreground; a question goes in the new round", () => {
  const rule = nextRule("agent working", TARGET, ["t5"]);

  assert.deepEqual(Object.keys(rule), ["publish", "stuck"]);
  assert.match(rule.publish!, /lightspeed publish feat\/tokens main --intent .* --to t5 'done: /);
  assert.ok(rule.publish!.endsWith(WAITS_FOR_SEND));
  assert.match(rule.stuck!, /while nothing has changed since work/);
  assert.match(nextRule("agent working", TARGET).publish!, /--to main 'done: /);
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

/** One wording for who closed a review, wherever an ended review is explained. */
test("the closer is named the same way in every ended-review sentence", () => {
  for (const endedBy of ["reviewer", "agent", undefined] as const) {
    assert.ok(endedMessage(endedBy).startsWith(endedClause(endedBy)), String(endedBy));
  }
  assert.equal(endedClause("agent"), "`lightspeed end` ended this review, not the reviewer");
  assert.equal(endedClause("reviewer"), "the reviewer ended this review");
  assert.equal(endedClause(undefined), "this review is ended");
});
