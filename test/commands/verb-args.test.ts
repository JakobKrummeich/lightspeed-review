import { test } from "node:test";
import assert from "node:assert/strict";
import { lastValue } from "../../src/commands/args.ts";
import { parseVerb } from "../../src/commands/verb-args.ts";

test("the message comes first, then the session it is about", () => {
  const parsed = parseVerb(["wrapped it", "feature-auth", "develop"], { verb: "say" }, "something");

  assert.equal(parsed.message, "wrapped it");
  assert.equal(parsed.branch, "feature-auth");
  assert.equal(parsed.base, "develop");
});

test("branch and base are left unset so the session can be resolved from the repository", () => {
  const parsed = parseVerb(["wrapped it"], { verb: "say" }, "something");

  assert.equal(parsed.branch, undefined);
  assert.equal(parsed.base, undefined);
});

test("a value flag takes the token after it, wherever it sits on the line", () => {
  const parsed = parseVerb(
    ["wrapped it", "--for", "evt_a", "feature-auth"],
    { verb: "say", value: ["--for"] },
    "something",
  );

  assert.equal(parsed.message, "wrapped it");
  assert.equal(parsed.branch, "feature-auth");
  assert.equal(lastValue(parsed.scanned, "--for"), "evt_a");
});

/** A message that starts with a dash is still the message, not a flag. */
test("a message that looks like a flag value is still the message", () => {
  const parsed = parseVerb(["-1 on that, see notes"], { verb: "say" }, "something");

  assert.equal(parsed.message, "-1 on that, see notes");
});

function rejects(args: string[], spec: Parameters<typeof parseVerb>[1], pattern: RegExp): void {
  assert.throws(
    () => parseVerb(args, spec, "something to say"),
    (error: unknown) => {
      assert.match((error as Error).message, pattern);
      return true;
    },
    args.join(" "),
  );
}

/**
 * Loud, because the quiet readings are both wrong: read as the message it puts
 * `--flu` in front of the reviewer, and read as a branch it speaks into the
 * wrong review, or none.
 */
test("an unknown flag is named, with what the verb does take", () => {
  rejects(["hi", "--flu"], { verb: "say", value: ["--for"] }, /unknown flag --flu/);
  assert.throws(
    () => parseVerb(["hi", "--flu"], { verb: "say", value: ["--for"] }, "something"),
    (error: unknown) => {
      assert.match(
        (error as { suggestions: string[] }).suggestions.join("\n"),
        /Known here: --for/,
      );
      return true;
    },
  );
});

test("a verb that takes no flags says so instead of listing none", () => {
  assert.throws(
    () => parseVerb(["hi", "--full"], { verb: "ask" }, "something"),
    (error: unknown) => {
      const suggestions = (error as { suggestions: string[] }).suggestions.join("\n");
      assert.match(suggestions, /`lightspeed ask` takes no flags/);
      assert.match(suggestions, /lightspeed ask --help/);
      return true;
    },
  );
});

/** A blank line in the conversation is a turn the reviewer cannot read. */
test("a missing or blank message is refused, naming what the verb wanted", () => {
  rejects([], { verb: "say" }, /say needs something to say/);
  rejects(["   "], { verb: "say" }, /say needs something to say/);
});

/**
 * N3: the placeholder the error prints is the one `--help` prints. `ask` asked
 * for a `<text>` here and a `<question>` there, which is two names for the one
 * argument an agent has to get right.
 */
test("the example in the error names the verb's own argument", () => {
  const names = (spec: Parameters<typeof parseVerb>[1]): string => {
    try {
      parseVerb([], spec, "something");
    } catch (error) {
      return (error as { suggestions: string[] }).suggestions[0]!;
    }
    throw new Error("a missing message must be refused");
  };

  assert.match(names({ verb: "work", placeholder: "plan" }), /work "<plan>"/);
  assert.match(names({ verb: "ask", placeholder: "question" }), /ask "<question>"/);
  assert.match(names({ verb: "say" }), /say "<text>"/);
});
