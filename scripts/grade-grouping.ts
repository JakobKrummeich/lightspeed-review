/**
 * Scores a grouping against a recorded one, to notice that it moved. Not a measure
 * of quality, and the fixtures are not gold: asked blind, twice, the reviewer took
 * the model's grouping over the hand-written fixture six times out of six
 * (`test/fixtures/grouping-reviewer-verdicts.json`). A lower score means *different
 * from what was recorded* — worth a look, not worse.
 *
 * Two numbers, because one hides wrong groups vs right groups in the wrong order:
 * - **Grouping**: adjusted Rand index. Uncorrected pairwise f1 was the headline
 *   until measured against everything-in-one-group: f1 0.54, better than any real
 *   reply, since with three or four human groups a third of all pairs do belong
 *   together. ARI scores both degenerate answers 0. Precision/recall still print
 *   as the diagnosis of *how* a grouping is wrong.
 * - **Ordering**: Kendall tau over each file's position in the flattened reading
 *   order; right groups in the wrong order lose here and nowhere else.
 *
 * Every run prints the same scores for three no-thought groupings (one group,
 * per-file, src-vs-test): a number with nothing to compare against reads by mood,
 * and a model that cannot beat two lines of `if` is visibly not earning its call.
 * Reported, never gated: a fixture is one defensible reading order of several, and
 * a test failing on a different defensible one would be deleted within a week.
 *
 * Usage: `node scripts/grade-grouping.ts [fixture-name…]`
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTestFile } from "../src/llm/tests-last.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, "..", "test", "fixtures", "grouping");
/** Model replies recorded from a real run; absent until someone records them. */
export const REPLY_DIR = join(FIXTURE_DIR, "replies");

export interface FixtureFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  previousPath?: string;
}

export interface NamedGroup {
  name: string;
  files: string[];
}

export interface GroupingFixture {
  name: string;
  commit: string;
  subject: string;
  intents: string[];
  files: FixtureFile[];
  /** The grouping a human wants for this diff. */
  human: NamedGroup[];
}

/** Pairwise agreement corrected for chance: 1 for the human grouping, 0 for any
 * that agrees only as much as its shape forces (one group, per-file, a shuffle).
 * Left-out files are each their own group: dropping costs the same as isolating. */
export function adjustedRandIndex(predicted: string[][], human: string[][]): number {
  const files = [...new Set(human.flat())];
  const predictedLabels = labelsOf(predicted, files);
  const humanLabels = labelsOf(human, files);
  const cells = new Map<string, number>();
  const predictedSizes = new Map<string, number>();
  const humanSizes = new Map<string, number>();
  for (const [index] of files.entries()) {
    const left = predictedLabels[index]!;
    const right = humanLabels[index]!;
    tally(cells, `${left}\u0000${right}`);
    tally(predictedSizes, left);
    tally(humanSizes, right);
  }
  const shared = sumPairs(cells);
  const expected = (sumPairs(predictedSizes) * sumPairs(humanSizes)) / pairs(files.length);
  const most = (sumPairs(predictedSizes) + sumPairs(humanSizes)) / 2;
  return most === expected ? 0 : (shared - expected) / (most - expected);
}

/** One label per file, in `files` order; a file no group names is alone. */
function labelsOf(groups: string[][], files: string[]): string[] {
  const label = new Map<string, string>();
  for (const [index, group] of groups.entries()) {
    for (const file of group) label.set(file, `group ${index}`);
  }
  return files.map((file, index) => label.get(file) ?? `unassigned ${index}`);
}

function tally(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sumPairs(counts: Map<string, number>): number {
  return [...counts.values()].reduce((total, count) => total + pairs(count), 0);
}

function pairs(count: number): number {
  return (count * (count - 1)) / 2;
}

export interface PairwiseScore {
  precision: number;
  recall: number;
  f1: number;
}

/** Agreement over pairs of files sharing a group. Left-out files score as missing,
 * not ignored: a grouping that drops a file is one the reviewer cannot read the diff by. */
export function pairwiseScore(predicted: string[][], human: string[][]): PairwiseScore {
  const predictedPairs = samePairs(predicted);
  const humanPairs = samePairs(human);
  const shared = [...predictedPairs].filter((pair) => humanPairs.has(pair)).length;
  const precision = ratio(shared, predictedPairs.size);
  const recall = ratio(shared, humanPairs.size);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/** Kendall tau over reading position, on the files both orders name: 1 is the
 * human's order, -1 exactly backwards, 0 no better than a shuffle. */
export function orderingScore(predicted: string[][], human: string[][]): number {
  const predictedOrder = position(predicted.flat());
  const humanOrder = position(human.flat());
  const common = [...humanOrder.keys()].filter((path) => predictedOrder.has(path));
  let concordant = 0;
  let discordant = 0;
  for (const [index, left] of common.entries()) {
    for (const right of common.slice(index + 1)) {
      const human = Math.sign(humanOrder.get(left)! - humanOrder.get(right)!);
      const model = Math.sign(predictedOrder.get(left)! - predictedOrder.get(right)!);
      if (human * model > 0) concordant += 1;
      if (human * model < 0) discordant += 1;
    }
  }
  const pairs = (common.length * (common.length - 1)) / 2;
  return pairs === 0 ? 0 : (concordant - discordant) / pairs;
}

export interface Guards {
  /** No group opens with a test then shows the code it covers: read first, a test
   * is a puzzle. A group that is nothing but tests is not that mistake. */
  noGroupOpensWithATest: boolean;
  /** A mechanical-change group is last, or there is none. "Last" among groups a
   * reviewer ranks: `trailTests` parks tests behind mechanical bulk on purpose,
   * so a test-only group does not count as after. */
  mechanicalGroupIsLast: boolean;
  /** The first group touches a file the stated intent names. */
  firstGroupServesTheIntent: boolean;
}

/** Checks needing no human fixture — the three prompt rules a reader could verify
 * without knowing the code. Run on raw replies off disk, never on what ships:
 * `groupDiff` puts every reply through `trailTests` with the same `isTestFile`, so
 * `noGroupOpensWithATest` cannot fail on a shipped grouping. This grades prompt
 * and model, not the review the reviewer gets. */
export function guards(groups: NamedGroup[], intents: string[]): Guards {
  const ranked = groups.filter((group) => !group.files.every(isTestFile));
  const mechanical = ranked.map((group) => MECHANICAL_NAME.test(group.name));
  const lastMechanical = mechanical.lastIndexOf(true);
  return {
    noGroupOpensWithATest: groups.every((group) => !opensWithATest(group.files)),
    mechanicalGroupIsLast: lastMechanical === -1 || lastMechanical === ranked.length - 1,
    firstGroupServesTheIntent: namesAnIntentWord(groups[0]?.files ?? [], intents),
  };
}

/** `lockfile` was here and is not: the prompt now ranks a dependency change high
 * with its manifest, so "Lockfile and dependency bump" first is obeying the rule
 * and a guard failing it would punish the wanted answer (no fixture adds a
 * dependency, so printed scores are unmoved). `moved` is bounded because it hides
 * inside ordinary words — "Grouping threshold removed" was flagged mechanical;
 * `rename` stays bare on purpose to catch `renamed`/`renames`. */
const MECHANICAL_NAME = /mechanical|formatting|generated|rename|\bmoved\b|boilerplate/i;

function opensWithATest(files: string[]): boolean {
  return isTestFile(files[0] ?? "") && !files.every(isTestFile);
}

/** Whether the intent names one of these files, by path words. Loose on purpose:
 * a smoke alarm for a first group about something else entirely, not a measure of
 * how well the group serves the intent. */
function namesAnIntentWord(files: string[], intents: string[]): boolean {
  if (intents.length === 0) return true;
  const words = new Set(
    intents
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4),
  );
  return files.some((file) => {
    const path = file.toLowerCase();
    return [...words].some((word) => path.includes(word));
  });
}

function samePairs(groups: string[][]): Set<string> {
  const pairs = new Set<string>();
  for (const group of groups) {
    const sorted = [...group].sort();
    for (const [index, left] of sorted.entries()) {
      for (const right of sorted.slice(index + 1)) pairs.add(`${left}\u0000${right}`);
    }
  }
  return pairs;
}

function position(order: string[]): Map<string, number> {
  return new Map(order.map((path, index) => [path, index]));
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

export function loadFixtures(names: string[] = []): GroupingFixture[] {
  return (
    readdirSync(FIXTURE_DIR)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => JSON.parse(readFileSync(join(FIXTURE_DIR, entry), "utf8")) as GroupingFixture)
      // Non-fixtures parked in the directory, and fixtures missing either half,
      // are better skipped here than read as an empty grouping downstream.
      .filter((fixture) => Array.isArray(fixture.files) && Array.isArray(fixture.human))
      .filter((fixture) => names.length === 0 || names.includes(fixture.name))
  );
}

/** Every reply recorded for a fixture: `<name>.json`, `<name>.2.json`, … More than
 * one because the same prompt and diff do not group the same twice — one reply per
 * fixture put the run-to-run spread inside the number instead of next to it. */
export function loadRecordedReplies(name: string): NamedGroup[][] {
  if (!existsSync(REPLY_DIR)) return [];
  return readdirSync(REPLY_DIR)
    .filter((entry) => entry === `${name}.json` || entry.startsWith(`${name}.`))
    .filter((entry) => /^.+\.(json)$/.test(entry) && basename(entry, ".json").startsWith(name))
    .sort()
    .map(
      (entry) =>
        (JSON.parse(readFileSync(join(REPLY_DIR, entry), "utf8")) as { groups: NamedGroup[] })
          .groups,
    );
}

interface Scored {
  ari: number;
  f1: number;
  precision: number;
  recall: number;
  tau: number;
}

function score(reply: NamedGroup[], fixture: GroupingFixture): Scored {
  const predicted = reply.map((group) => group.files);
  const human = fixture.human.map((group) => group.files);
  const pairwise = pairwiseScore(predicted, human);
  return {
    ari: adjustedRandIndex(predicted, human),
    f1: pairwise.f1,
    precision: pairwise.precision,
    recall: pairwise.recall,
    tau: orderingScore(predicted, human),
  };
}

function report(fixtures: GroupingFixture[]): void {
  const scored: Scored[] = [];
  for (const fixture of fixtures) {
    const replies = loadRecordedReplies(fixture.name);
    console.log(`\n${fixture.name}  (${fixture.files.length} files, ${fixture.subject})`);
    if (replies.length === 0) {
      console.log("  no recorded reply — run `node scripts/record-grouping-replies.ts`");
      continue;
    }
    const runs = replies.map((reply) => score(reply, fixture));
    scored.push(...runs);
    console.log(
      `  grouping ARI ${spread(runs.map((run) => run.ari))} over ${runs.length} reply(s)` +
        `  [pairwise f1 ${mean(runs.map((run) => run.f1)).toFixed(2)},` +
        ` precision ${mean(runs.map((run) => run.precision)).toFixed(2)},` +
        ` recall ${mean(runs.map((run) => run.recall)).toFixed(2)}]`,
    );
    console.log(`  ordering tau ${spread(runs.map((run) => run.tau))}`);
    for (const guard of GUARD_NAMES) {
      const passes = replies.filter((reply) => guards(reply, fixture.intents)[guard]).length;
      const mark = passes === replies.length ? "ok  " : "FAIL";
      console.log(`  ${mark} ${guard} (${passes}/${replies.length})`);
    }
  }
  if (scored.length > 0) {
    console.log(
      `\naggregate over ${scored.length} scored reply(s): grouping ARI ${spread(scored.map((run) => run.ari))}` +
        `, pairwise f1 ${mean(scored.map((run) => run.f1)).toFixed(2)}` +
        `, ordering tau ${spread(scored.map((run) => run.tau))}`,
    );
  }
  reportReferences(fixtures);
}

/** What a grouping nobody thought about scores, on the same fixtures: ARI 0.38 is
 * only a result if it beats splitting source from tests with a regex. */
function reportReferences(fixtures: GroupingFixture[]): void {
  console.log("\ngroupings that took no thought, for comparison:");
  for (const [label, group] of Object.entries(REFERENCES)) {
    const runs = fixtures.map((fixture) => {
      const paths = fixture.files.map((file) => file.path);
      const human = fixture.human.map((entry) => entry.files);
      return {
        ari: adjustedRandIndex(group(paths), human),
        f1: pairwiseScore(group(paths), human).f1,
      };
    });
    console.log(
      `  ${label.padEnd(24)} ARI ${mean(runs.map((run) => run.ari)).toFixed(2)}` +
        `  [pairwise f1 ${mean(runs.map((run) => run.f1)).toFixed(2)}]`,
    );
  }
}

const REFERENCES: Record<string, (paths: string[]) => string[][]> = {
  "one group of everything": (paths) => [paths],
  "one group per file": (paths) => paths.map((path) => [path]),
  "source split from tests": (paths) =>
    [paths.filter((path) => !isTestFile(path)), paths.filter(isTestFile)].filter(
      (group) => group.length > 0,
    ),
};

const GUARD_NAMES = [
  "noGroupOpensWithATest",
  "mechanicalGroupIsLast",
  "firstGroupServesTheIntent",
] as const satisfies readonly (keyof Guards)[];

/** `mean ±sd`, so a score is never read without its run-to-run spread. */
function spread(values: number[]): string {
  const deviation = Math.sqrt(mean(values.map((value) => (value - mean(values)) ** 2)));
  return `${mean(values).toFixed(2)} ±${deviation.toFixed(2)}`;
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  report(loadFixtures(process.argv.slice(2)));
}
