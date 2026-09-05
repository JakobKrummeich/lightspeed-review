import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RECORDED,
  freshVerdicts,
  groupingFingerprint,
  judgeIsCalibrated,
  loadVerdicts,
  parseVerdict,
  referenceLayouts,
  tally,
  type Verdict,
} from "../../scripts/judge-grouping.ts";
import { loadFixtures } from "../../scripts/grade-grouping.ts";

function verdict(
  fixture: string,
  reference: Verdict["reference"],
  first: string,
  winner: string,
  grouping = "same",
) {
  return {
    fixture,
    reference,
    first,
    winner,
    reason: "because",
    judge: "test",
    grouping,
  } satisfies Verdict;
}

test("a pair that agrees with itself both ways is a win", () => {
  const outcomes = tally([
    verdict("one", "human", RECORDED, RECORDED),
    verdict("one", "human", "human", RECORDED),
  ]);

  assert.deepEqual(outcomes["human"], { wins: { recorded: 1 }, undecided: 0 });
});

test("a verdict that follows the label instead of the grouping is undecided, not half a win", () => {
  const outcomes = tally([
    verdict("one", "human", RECORDED, RECORDED),
    verdict("one", "human", "human", "human"),
  ]);

  assert.deepEqual(outcomes["human"], { wins: {}, undecided: 1 });
});

test("a judge that cannot reject one group per file is not calibrated", () => {
  const rejects = tally([
    verdict("one", "per-file", RECORDED, RECORDED),
    verdict("one", "per-file", "per-file", RECORDED),
  ]);
  const accepts = tally([
    verdict("one", "per-file", RECORDED, "per-file"),
    verdict("one", "per-file", "per-file", "per-file"),
  ]);

  assert.equal(judgeIsCalibrated(rejects), true);
  assert.equal(judgeIsCalibrated(accepts), false);
  assert.equal(judgeIsCalibrated({}), false, "a run that never asked proves nothing");
});

test("a reply that quotes a path inside its own reason still casts its vote", () => {
  const ragged = '{"winner": "B", "reason": "A splits "src/a.ts" from its caller"}';

  assert.equal(parseVerdict(ragged).winner, "B");
  assert.equal(parseVerdict('```json\n{"winner":"A","reason":"clearer"}\n```').winner, "A");
  assert.throws(() => parseVerdict("neither, they are both fine"));
});

test("the reference layouts cover every file of their fixture exactly once", () => {
  for (const fixture of loadFixtures()) {
    const paths = fixture.files.map((file) => file.path).sort();
    for (const [name, layout] of Object.entries(referenceLayouts(fixture))) {
      const covered = layout.flatMap((group) => group.files).sort();
      assert.deepEqual(covered, paths, `${fixture.name}: ${name} does not cover the diff`);
    }
  }
});

test("a verdict cast on a grouping that has since been re-recorded is not evidence", () => {
  const current = new Map([["one", "aaaa"]]);
  const verdicts = [
    verdict("one", "human", RECORDED, RECORDED, "aaaa"),
    verdict("one", "human", "human", RECORDED, "bbbb"),
  ];

  assert.deepEqual(freshVerdicts(verdicts, current), [verdicts[0]]);
  assert.deepEqual(
    freshVerdicts(verdicts, new Map()),
    [],
    "a fixture with no reply has no verdict",
  );
});

test("the fingerprint reads the names and the file order, which is all the judge sees", () => {
  const groups = [{ name: "Core", files: ["src/a.ts", "src/b.ts"] }];

  assert.equal(groupingFingerprint(groups), groupingFingerprint(structuredClone(groups)));
  assert.notEqual(
    groupingFingerprint(groups),
    groupingFingerprint([{ name: "Core", files: ["src/b.ts", "src/a.ts"] }]),
  );
  assert.notEqual(
    groupingFingerprint(groups),
    groupingFingerprint([{ name: "Renamed", files: ["src/a.ts", "src/b.ts"] }]),
  );
});

test("the recorded verdicts, if any, were produced by a calibrated judge", () => {
  const verdicts = loadVerdicts();
  if (verdicts.length === 0) return; // judging needs a provider; CI has none.

  assert.ok(judgeIsCalibrated(tally(verdicts)), "one group per file was not rejected outright");
});
