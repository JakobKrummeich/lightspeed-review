import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceProblem } from "../../src/llm/voice.ts";

/** A group with the one sentence under test and nothing else worth reading. */
function group(rationale: string) {
  return [{ name: "Auth probe", rationale, tier: "study" as const, files: ["src/auth.ts"] }];
}

const good = group(
  "Splits authentication failures into a rejected code and a missing-credential code.",
);

test("a statement about the code passes", () => {
  assert.equal(voiceProblem(good), undefined);
});

test("a question is rejected, whichever group asks it", () => {
  // The whole complaint that started this: the reviewer's eye slides off a
  // question it cannot answer before reading the diff it stands in front of.
  assert.match(
    voiceProblem(group("Does this split the auth failures correctly?")) ?? "",
    /question/,
  );
  assert.match(
    voiceProblem([...good, ...group("Is the branch still reachable?")]) ?? "",
    /question/,
  );
});

test("an order aimed at the reader is rejected wherever it stands in the sentence", () => {
  // The prompt has forbidden these verbs in prose for as long as the field has
  // existed and the model writes them anyway; prose is not enforcement.
  for (const rationale of [
    "Verify the intent is to split the cases.",
    "The codes are added but unused; verify the implementation should use them.",
    "Ensure every caller passes the reference.",
    "Confirm the reason message is accurate.",
    "Make sure the timers are dropped.",
    "Check the expiry logic carefully.",
    "Watch whether a rejected key reaches the missing-credential branch.",
    "Note that the manifest pins two versions.",
    "Review the teardown path.",
  ]) {
    assert.notEqual(voiceProblem(group(rationale)), undefined, rationale);
  }
});

test("the reviewer is never addressed", () => {
  assert.match(voiceProblem(group("You will want to look at the empty detail.")) ?? "", /reader/);
});

test("a verb that describes the code keeps its place", () => {
  // `verify` inside a name is the code's own word, and the third person is not
  // an order however close its stem sits to one.
  for (const rationale of [
    "Renames `verifyToken` to `checkToken` and validates the expiry against the skew.",
    "The check runs before the clock skew correction, so a slow clock revives dead tokens.",
    "Tests the parser against a truncated stream.",
    "Notes are dropped.",
  ]) {
    assert.equal(voiceProblem(group(rationale)), undefined, rationale);
  }
});

test("the problem names the group and quotes the sentence, because that is what a repair needs", () => {
  const problem = voiceProblem(group("Verify the reference is passed."));

  assert.match(problem ?? "", /Auth probe/);
  assert.match(problem ?? "", /rationale/);
  assert.match(problem ?? "", /Verify the reference is passed\./);
});
