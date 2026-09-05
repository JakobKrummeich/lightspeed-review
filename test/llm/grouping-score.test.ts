import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adjustedRandIndex,
  guards,
  loadFixtures,
  loadRecordedReplies,
  orderingScore,
  pairwiseScore,
} from "../../scripts/grade-grouping.ts";

const human = [
  ["src/a.ts", "src/b.ts"],
  ["src/c.ts", "src/d.ts"],
];

test("an identical grouping scores 1", () => {
  assert.deepEqual(pairwiseScore(human, human), { precision: 1, recall: 1, f1: 1 });
});

test("one giant group recalls everything and is precise about nothing", () => {
  const giant = [["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]];

  const score = pairwiseScore(giant, human);

  assert.equal(score.recall, 1);
  assert.ok(score.precision < 0.5, "pairs the human kept apart are counted against it");
  assert.ok(score.f1 < 0.7);
});

test("one group per file is precise about nothing and recalls nothing", () => {
  const split = [["src/a.ts"], ["src/b.ts"], ["src/c.ts"], ["src/d.ts"]];

  assert.deepEqual(pairwiseScore(split, human), { precision: 0, recall: 0, f1: 0 });
});

test("a file the reply dropped costs recall", () => {
  const partial = [["src/a.ts", "src/b.ts"], ["src/c.ts"]];

  assert.ok(pairwiseScore(partial, human).recall < 1);
});

test("ordering is 1 for the human order and -1 for its exact reverse", () => {
  assert.equal(orderingScore(human, human), 1);
  assert.equal(
    orderingScore(
      [...human].reverse().map((group) => [...group].reverse()),
      human,
    ),
    -1,
  );
});

test("right groups in the wrong order lose ordering and nothing else", () => {
  const swapped = [human[1]!, human[0]!];

  assert.equal(pairwiseScore(swapped, human).f1, 1);
  assert.ok(orderingScore(swapped, human) < 0);
});

test("the harness reads tests with the classifier the tool ships, C# conventions and all", () => {
  // One classifier, not two: a guard that recognises fewer tests than
  // `trailTests` does would pass replies the shipped grouping rewrites.
  const bad = [
    {
      name: "Order pricing",
      files: ["MyProj.Tests/OrderServiceTests.cs", "src/Orders/OrderService.cs"],
    },
  ];

  assert.equal(guards(bad, []).noGroupOpensWithATest, false);
});

test("the guards catch a group opening with a test, and a mechanical group that is not last", () => {
  const bad = [
    { name: "Tests", files: ["test/start.test.ts", "src/commands/start.ts"] },
    { name: "Mechanical: formatting", files: ["src/browser/chrome.css"] },
    { name: "Everything else", files: ["src/server.ts"] },
  ];

  const result = guards(bad, ["Require --intent on start"]);

  assert.equal(result.noGroupOpensWithATest, false);
  assert.equal(result.mechanicalGroupIsLast, false);
  assert.equal(result.firstGroupServesTheIntent, true);
});

test("the trailing test group is allowed to sit behind the mechanical one", () => {
  // What `trailTests` produces on every grouping: mechanical last of the groups
  // a reviewer ranks, tests parked after both.
  const shipped = [
    { name: "Start takes an intent", files: ["src/commands/start.ts"] },
    { name: "Mechanical: formatting", files: ["src/browser/chrome.css"] },
    { name: "Tests", files: ["test/start.test.ts"] },
  ];

  assert.equal(guards(shipped, ["Require --intent on start"]).mechanicalGroupIsLast, true);
});

test("a group named for a removal is not mechanical: `moved` matches the word, not `removed`", () => {
  // "Grouping threshold removed" was flagged only because "removed" contains "moved";
  // a group that really moved files stays caught.
  const removal = [
    { name: "Grouping threshold removed", files: ["src/llm/grouping.ts"] },
    { name: "Documentation updates", files: ["README.md"] },
  ];
  const moved = [
    { name: "Files moved into src", files: ["src/a.ts"] },
    { name: "Everything else", files: ["src/server.ts"] },
  ];

  assert.equal(guards(removal, []).mechanicalGroupIsLast, true);
  assert.equal(guards(moved, []).mechanicalGroupIsLast, false);
});

test("a first group about something the intent never names is caught", () => {
  const groups = [{ name: "Docs", files: ["README.md"] }];

  assert.equal(guards(groups, ["Rewrite the grouping prompt"]).firstGroupServesTheIntent, false);
});

test("every fixture's human grouping covers its diff exactly once", () => {
  const fixtures = loadFixtures();

  assert.ok(fixtures.length >= 6, "the harness needs a spread of real diffs to be worth anything");
  for (const fixture of fixtures) {
    const grouped = fixture.human.flatMap((group) => group.files);
    assert.deepEqual(
      [...grouped].sort(),
      fixture.files.map((file) => file.path).sort(),
      `${fixture.name}: the human grouping and the diff disagree`,
    );
    assert.equal(new Set(grouped).size, grouped.length, `${fixture.name}: a file is in two groups`);
  }
});

test("the fixtures include the cases the prompt has never seen", () => {
  const fixtures = loadFixtures();
  const names = fixtures.map((fixture) => fixture.name);

  assert.ok(names.includes("formatting-only"), "a change with no logic in it at all");
  assert.ok(
    fixtures.some((fixture) => fixture.files.some((file) => file.status === "renamed")),
    "a rename-heavy diff",
  );
});

test("the human groupings pass the guards they were written to describe", () => {
  for (const fixture of loadFixtures()) {
    assert.deepEqual(
      guards(fixture.human, fixture.intents),
      {
        noGroupOpensWithATest: true,
        mechanicalGroupIsLast: true,
        firstGroupServesTheIntent: true,
      },
      `${fixture.name}: the fixture does not obey its own rules`,
    );
  }
});

test("a fixture with no recorded reply is a gap, not a failure", () => {
  // Recording needs a configured provider, which CI does not have; the harness
  // says so per fixture instead of failing.
  assert.deepEqual(loadRecordedReplies("no-such-fixture"), []);
});

test("every recorded reply groups exactly the files of its fixture", () => {
  for (const fixture of loadFixtures()) {
    for (const reply of loadRecordedReplies(fixture.name)) {
      const grouped = reply.flatMap((group) => group.files);
      assert.deepEqual(
        [...grouped].sort(),
        fixture.files.map((file) => file.path).sort(),
        `${fixture.name}: a recorded reply and the diff disagree`,
      );
    }
  }
});

test("the adjusted index is 1 for the human grouping and 0 for the answers that took no thought", () => {
  // Why this replaced bare pairwise f1: one group of everything scores f1 0.5 here and 0.54 on
  // the fixtures — better than any grouping the model actually produced.
  const everything = [human.flat()];
  const perFile = human.flat().map((file) => [file]);

  assert.equal(adjustedRandIndex(human, human), 1);
  assert.equal(adjustedRandIndex(everything, human), 0);
  assert.equal(adjustedRandIndex(perFile, human), 0);
  assert.ok(pairwiseScore(everything, human).f1 >= 0.5, "which f1 alone rewards");
});

test("the adjusted index sits between the human grouping and chance when one file moves", () => {
  const three = [
    ["src/a.ts", "src/b.ts"],
    ["src/c.ts", "src/d.ts"],
    ["src/e.ts", "src/f.ts"],
  ];
  const nearly = [["src/a.ts", "src/b.ts", "src/c.ts"], ["src/d.ts"], ["src/e.ts", "src/f.ts"]];

  const score = adjustedRandIndex(nearly, three);

  assert.ok(score > 0 && score < 1, `one misplaced file scored ${score}`);
});

test("a reply that drops a file is scored as having isolated it", () => {
  const dropped = [["src/a.ts", "src/b.ts"], ["src/c.ts"]];

  assert.ok(adjustedRandIndex(dropped, human) < adjustedRandIndex(human, human));
});

test("ordering is blind to a grouping that says nothing", () => {
  // Kendall tau reads flattened file order, so one group of everything can score well:
  // tau is only meaningful next to a grouping score, and the harness never prints it alone.
  assert.equal(orderingScore([human.flat()], human), 1);
});

test("a group that is nothing but tests may open with one", () => {
  const trailing = [
    { name: "The change", files: ["src/commands/start.ts"] },
    { name: "Tests", files: ["test/commands/start.test.ts", "test/cli.test.ts"] },
  ];

  assert.equal(guards(trailing, ["Require --intent on start"]).noGroupOpensWithATest, true);
});
