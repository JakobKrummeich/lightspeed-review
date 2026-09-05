import { test } from "node:test";
import assert from "node:assert/strict";
import { TEST_PATH_CONVENTIONS, isTestFile, trailTests } from "../../src/llm/tests-last.ts";
import type { DiffFile, DiffGroup } from "../../src/diff-extract.ts";

function file(path: string): DiffFile {
  return { path, status: "modified", insertions: 1, deletions: 0, diff: "", oversized: false };
}

function group(name: string, ...paths: string[]): DiffGroup {
  return { name, rationale: "why", files: paths.map(file) };
}

test("tests scattered through the groups end up in one group at the end", () => {
  const grouped = trailTests([
    group("Collapse rule", "src/panel.ts", "test/panel.test.ts"),
    group("Wiring", "src/main.ts", "test/main.test.ts"),
  ]);

  assert.deepEqual(
    grouped.map((entry) => [entry.name, entry.files.map((f) => f.path)]),
    [
      ["Collapse rule", ["src/panel.ts"]],
      ["Wiring", ["src/main.ts"]],
      ["Tests", ["test/panel.test.ts", "test/main.test.ts"]],
    ],
  );
});

test("tests land behind mechanical bulk, not in front of it", () => {
  // A diff whose only other group is mechanical must still open on the change
  // that carries the intent, not on its tests.
  const grouped = trailTests([
    group("Mechanical: formatting scope", ".prettierignore"),
    group("Its tests", "test/server-ledger.test.ts"),
  ]);

  assert.deepEqual(
    grouped.map((entry) => entry.name),
    ["Mechanical: formatting scope", "Tests"],
  );
});

test("a group emptied of its tests disappears instead of standing empty", () => {
  const grouped = trailTests([
    group("The change", "src/panel.ts"),
    group("Its tests", "test/panel.test.ts", "test/other.test.ts"),
  ]);

  assert.deepEqual(
    grouped.map((entry) => entry.name),
    ["The change", "Tests"],
  );
});

test("a diff that is nothing but tests is left as one group of tests", () => {
  const grouped = trailTests([group("Tests only", "test/a.test.ts", "test/b.test.ts")]);

  assert.equal(grouped.length, 1);
  assert.deepEqual(
    grouped[0]!.files.map((f) => f.path),
    ["test/a.test.ts", "test/b.test.ts"],
  );
});

test("a diff with no tests is returned untouched", () => {
  const groups = [group("The change", "src/panel.ts")];

  assert.equal(trailTests(groups), groups);
});

test("every convention in the table claims its own examples", () => {
  for (const convention of TEST_PATH_CONVENTIONS) {
    for (const example of convention.examples) {
      assert.ok(
        convention.pattern.test(example),
        `${convention.name}: ${example} is listed as an example and the rule does not claim it`,
      );
      assert.ok(isTestFile(example), `${example} should read as a test`);
    }
  }
});

test("every convention in the table is the only claimant of one of its examples", () => {
  // A rule another rule has swallowed whole is dead text that reads as coverage:
  // `src/test/...` under the `tests?/` directory rule was exactly that.
  for (const convention of TEST_PATH_CONVENTIONS) {
    const others = TEST_PATH_CONVENTIONS.filter((entry) => entry !== convention);
    assert.ok(
      convention.examples.some((example) => !others.some((entry) => entry.pattern.test(example))),
      `${convention.name}: every example is already claimed by another rule, so this one decides nothing`,
    );
  }
});

test("no rule claims a counterexample, whichever rule listed it", () => {
  // Being wrong in this direction is worse than missing a test file: it drags
  // code the reviewer must read out of the order the model chose for it.
  for (const convention of TEST_PATH_CONVENTIONS) {
    for (const counterexample of convention.counterexamples) {
      assert.equal(
        isTestFile(counterexample),
        false,
        `${convention.name}: ${counterexample} is production code and should stay put`,
      );
    }
  }
});

test("every convention carries examples and counterexamples to be judged by", () => {
  for (const convention of TEST_PATH_CONVENTIONS) {
    assert.ok(convention.examples.length > 0, `${convention.name}: claimed and never exercised`);
    assert.ok(
      convention.counterexamples.length > 0,
      `${convention.name}: no path is named that it must not claim`,
    );
  }
});

test("a C# test pinned to its production class is pulled out of that group", () => {
  // The complaint this widening came from: the model pairs OrderServiceTests.cs
  // with OrderService.cs, and nothing recognised the test, so the pairing stood.
  const grouped = trailTests([
    group("Order pricing", "src/Orders/OrderService.cs", "tests/Orders/OrderServiceTests.cs"),
    group("Checkout", "src/Checkout/Cart.cs"),
  ]);

  assert.deepEqual(
    grouped.map((entry) => [entry.name, entry.files.map((f) => f.path)]),
    [
      ["Order pricing", ["src/Orders/OrderService.cs"]],
      ["Checkout", ["src/Checkout/Cart.cs"]],
      ["Tests", ["tests/Orders/OrderServiceTests.cs"]],
    ],
  );
});

test("a test group the model put near the top is moved to the end", () => {
  const grouped = trailTests([
    group("Tests for the new pricing", "MyProj.Tests/PricingTests.cs"),
    group("Pricing", "src/Pricing.cs"),
  ]);

  assert.deepEqual(
    grouped.map((entry) => entry.name),
    ["Pricing", "Tests"],
  );
});

/**
 * The one rationale this repository writes itself. It was "Do these check what the
 * change above promises?" — a claim a tests-only fallback has no group above it to make.
 */
test("the Tests group's own rationale states what the files are, from any position", () => {
  const appended = trailTests([group("The change", "src/a.ts"), group("Checks", "test/a.test.ts")]);
  const alone = trailTests([group("Everything", "test/a.test.ts")]);
  const rationale = appended.at(-1)!.rationale;

  assert.equal(rationale, alone.at(-1)!.rationale, "one string, whatever is above it");
  assert.doesNotMatch(rationale, /\?/, "no check-questions");
  assert.doesNotMatch(rationale, /\babove\b|\bbelow\b/i, "true wherever the group lands");
  assert.match(rationale, /checks this change ships/i);
});
