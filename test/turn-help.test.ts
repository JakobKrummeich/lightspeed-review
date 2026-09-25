import { test } from "node:test";
import assert from "node:assert/strict";
import {
  helpNextRound,
  helpPublishAndWait,
  helpReopen,
  legalMoves,
  nextMoves,
  turnHelp,
} from "../src/turn-help.ts";

/**
 * The same four-line block was printed by `wait`, `ask`, `say`, `work` and
 * every turn refusal in that state — 146 of an `ask` answer's 187 tokens, and
 * one 17-token clause 19 times in a single transcript. After the first answer
 * of a round has spelt the moves out, the reminder is one line.
 */
test("the short form names the same moves, in the same order, on one line", () => {
  assert.equal(
    nextMoves("agent working", "feat/tokens main"),
    'Next: `lightspeed start feat/tokens main --wait --intent "<why>"`' +
      ' | `ask "<q>"` | `say "<text>"`',
  );
  assert.equal(
    nextMoves("agent reading", "feat/tokens main"),
    'Next: `lightspeed work "<plan>" feat/tokens main` | `say "<text>"` | `ask "<q>"`' +
      ' | commit then `start feat/tokens main --intent "<why>"`',
  );
  assert.equal(
    nextMoves("reviewer", "feat/tokens main"),
    "Next: `lightspeed wait feat/tokens main`",
  );
});

test("no turn offers a move in one form that the other form leaves out", () => {
  for (const turn of ["reviewer", "agent reading", "agent working", "ended"] as const) {
    const short = nextMoves(turn, "b m");
    const full = legalMoves(turn, "b m");
    assert.equal(short.split(" | ").length, full.length, turn);
  }
});

test("the full block is what a turn's first answer carries, the short line the rest", () => {
  assert.deepEqual(turnHelp("agent working", "b m", "full"), legalMoves("agent working", "b m"));
  assert.deepEqual(turnHelp("agent working", "b m", "short"), [nextMoves("agent working", "b m")]);
  // A server too old to say which is one that never heard of the short form.
  assert.deepEqual(turnHelp("agent working", "b m", undefined), legalMoves("agent working", "b m"));
});

test("the next-round line carries the --intent start refuses to run without", () => {
  assert.equal(
    helpNextRound("feat/tokens main"),
    "Address the feedback, commit, then run `lightspeed start feat/tokens main" +
      ' --intent "<why this branch exists>"` to show the updated diff —' +
      " --intent is required on every round",
  );
});

test("the publish-and-block line carries --intent too", () => {
  assert.equal(
    helpPublishAndWait("feat/tokens main"),
    "Run `lightspeed start feat/tokens main --wait" +
      ' --intent "<why this branch exists>"` to publish what you changed and block on the' +
      " next round",
  );
});

test("the reopen line names this session and the intent a new round needs", () => {
  assert.equal(
    helpReopen("feat/tokens main"),
    'Run `lightspeed start feat/tokens main --reopen --intent "<why>"`' +
      " once the reviewer asks for one",
  );
});
