import { test } from "node:test";
import assert from "node:assert/strict";
import { allValues, hasFlag, lastValue, scanArgs } from "../../src/commands/args.ts";

/**
 * The scanner apart from any command: the unknown-flag error and the value
 * policies are what the call sites differ in, so each knob is proven once here.
 */

const reject = (flag: string) => new Error(`unknown flag ${flag}`);

test("splits tokens into positionals, value flags and boolean flags", () => {
  const scanned = scanArgs(["branch", "--base", "main", "--no-open", "extra"], {
    value: ["--base"],
    boolean: ["--no-open"],
    onUnknown: reject,
  });

  assert.deepEqual(scanned.positional, ["branch", "extra"]);
  assert.deepEqual(scanned.flags, [
    { flag: "--base", value: "main" },
    { flag: "--no-open", value: undefined },
  ]);
});

/** A mistyped flag must never pass for a branch name: `start` opened reviews on
 * `--basee` before it was made to throw. */
test("a near-miss of a known flag is an error, not a positional", () => {
  assert.throws(
    () => scanArgs(["--basee", "develop"], { value: ["--base"], onUnknown: reject }),
    /unknown flag --basee/,
  );
});

test("the caller's error is thrown at the unknown flag", () => {
  assert.throws(
    () => scanArgs(["ok", "--bogus"], { value: ["--base"], onUnknown: reject }),
    /unknown flag --bogus/,
  );
});

test("the leftmost mistake is reported, not an arbitrary one", () => {
  // One pass, left to right: with two unknown flags the first one is the error.
  assert.throws(() => scanArgs(["--first", "--second"], { onUnknown: reject }), /--first/);
});

test("the default flag prefix leaves single-dash tokens positional", () => {
  // A poll branch named `-x` is odd but allowed; only `--x` looks like a flag.
  const scanned = scanArgs(["-x"], { onUnknown: reject });

  assert.deepEqual(scanned.positional, ["-x"]);
});

test("flagPrefix '-' makes single-dash tokens flag-like and rejectable", () => {
  assert.throws(() => scanArgs(["-x"], { onUnknown: reject, flagPrefix: "-" }), /unknown flag -x/);
});

test("a repeated flag keeps every occurrence in command-line order", () => {
  const scanned = scanArgs(["--intent", "one", "--full", "--intent", "two"], {
    value: ["--intent"],
    boolean: ["--full"],
    onUnknown: reject,
  });

  assert.deepEqual(
    scanned.flags.map((hit) => hit.flag),
    ["--intent", "--full", "--intent"],
  );
  assert.deepEqual(allValues(scanned, "--intent"), ["one", "two"]);
  assert.equal(lastValue(scanned, "--intent"), "two");
  assert.equal(hasFlag(scanned, "--full"), true);
  assert.equal(hasFlag(scanned, "--intent"), true);
  assert.equal(hasFlag(scanned, "--absent"), false);
});

test("a value flag at the end of the line records a hit with no value", () => {
  const scanned = scanArgs(["branch", "--base"], { value: ["--base"], onUnknown: reject });

  assert.deepEqual(scanned.flags, [{ flag: "--base", value: undefined }]);
  // The helpers skip valueless hits: `start` treats them as never given.
  assert.equal(lastValue(scanned, "--base"), undefined);
  assert.deepEqual(allValues(scanned, "--base"), []);
});

test("onMissingValue turns a valueless flag into the caller's error", () => {
  assert.throws(
    () =>
      scanArgs(["--since"], {
        value: ["--since"],
        onUnknown: reject,
        onMissingValue: (flag) => new Error(`${flag} needs a value`),
      }),
    /--since needs a value/,
  );
});

test("values 'any' eats the next token even when it looks like a flag", () => {
  // A poll note may legitimately be "-1 on that".
  const scanned = scanArgs(["--note", "-1 on that", "--agent-reply", "--full"], {
    value: ["--note", "--agent-reply"],
    onUnknown: reject,
  });

  assert.equal(lastValue(scanned, "--note"), "-1 on that");
  assert.equal(lastValue(scanned, "--agent-reply"), "--full");
});

test("values 'bare' refuses a flag-like value and reports the flag it starves", () => {
  // `feedback list --since --format md`: the mistake is --since, and it is
  // reported before --format or md are judged at all.
  assert.throws(
    () =>
      scanArgs(["--since", "--format", "md"], {
        value: ["--since", "--format"],
        onUnknown: reject,
        onMissingValue: (flag) => new Error(`${flag} needs a value`),
        values: "bare",
      }),
    /--since needs a value/,
  );
});

test("values 'bare' without onMissingValue leaves the flag-like token unconsumed", () => {
  const scanned = scanArgs(["--limit", "--full"], {
    value: ["--limit"],
    boolean: ["--full"],
    onUnknown: reject,
    values: "bare",
  });

  assert.deepEqual(scanned.flags, [
    { flag: "--limit", value: undefined },
    { flag: "--full", value: undefined },
  ]);
});
