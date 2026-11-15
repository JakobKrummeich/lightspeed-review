import { test } from "node:test";
import assert from "node:assert/strict";
import { leadingFlagProblem, withHelpAlias } from "../../src/commands/leading-args.ts";

test("help alone is --help, and help <name> is that name's --help", () => {
  assert.deepEqual(withHelpAlias(["help"]), ["--help"]);
  assert.deepEqual(withHelpAlias(["help", "open"]), ["open", "--help"]);
  assert.deepEqual(withHelpAlias(["help", "nonsense"]), ["nonsense", "--help"]);
});

test("a line not led by help is handed on as it stands", () => {
  assert.deepEqual(withHelpAlias([]), []);
  assert.deepEqual(withHelpAlias(["open", "help"]), ["open", "help"]);
});

test("a command, or nothing at all, leaves the SDK nothing to refuse", () => {
  assert.equal(leadingFlagProblem([]), undefined);
  assert.equal(leadingFlagProblem(["open", "--bogus"]), undefined);
});

test("each flag read before a command is read when it stands alone", () => {
  for (const flag of ["--all", "--help", "--version", "-v", "-V"]) {
    assert.equal(leadingFlagProblem([flag]), undefined, flag);
  }
});

test("a flag read only alone, with a command after it, is refused as alone-only", () => {
  const problem = leadingFlagProblem(["-v", "open"]);

  assert.equal(problem?.code, "unknown_flag");
  assert.equal(problem.message, "-v is read only on its own, with no command after it");
  assert.equal(problem.detail, "before a command only --all, --help, --version are read");
});

test("any other flag before the command is refused as unknown", () => {
  const problem = leadingFlagProblem(["--bogus"]);

  assert.equal(problem?.code, "unknown_flag");
  assert.equal(problem.message, "unknown flag --bogus");
  assert.match(problem.suggestions[0] ?? "", /Flags come after the command/);
});
