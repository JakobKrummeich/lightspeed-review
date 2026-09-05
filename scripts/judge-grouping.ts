/**
 * Judges a recorded grouping the way a reviewer would: by asking a stronger model
 * which of two layouts of the same diff it would rather read. Exists next to
 * `grade-grouping.ts` because the counting harness compares to one human answer
 * and ignores whether a different answer is just as good. Measured, that hurt: it
 * ranked regex source/test splitting above every model grouping, while this judge
 * preferred the model's grouping to that split on 8 fixtures out of 8, both
 * orders. The numbers stay for cheap regressions; the judge says whether a review
 * got better to read.
 *
 * The protocol is what makes a model opinion evidence:
 * - **Blind.** Candidates are A and B; nothing says which came from the prompt.
 * - **Both orders.** Every pair is judged twice, swapped. A verdict that follows
 *   position is reported undecided, not counted — a coin-flip difference.
 * - **Calibrated.** `per-file` (one group per file, indefensible) is judged too;
 *   a run where the judge fails to reject it means the other verdicts are noise.
 *
 * Usage: `node scripts/judge-grouping.ts [--judge <provider/model>] [fixture…]`
 * Verdicts are cached in `test/fixtures/grouping/verdicts/` and committed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { defaultStateDir } from "../src/config.ts";
import { extractDiff } from "../src/diff-extract.ts";
import { buildGroupingPrompt } from "../src/llm/prompts.ts";
import { runGroupingCall } from "../src/llm/pi-client.ts";
import { isTestFile } from "../src/llm/tests-last.ts";
import {
  FIXTURE_DIR,
  loadFixtures,
  loadRecordedReplies,
  type GroupingFixture,
  type NamedGroup,
} from "./grade-grouping.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
export const VERDICT_DIR = join(FIXTURE_DIR, "verdicts");
const DEFAULT_JUDGE = "anthropic/claude-opus-5";

/** What the recorded grouping is judged against, cheapest defence first. */
export const REFERENCE_LAYOUTS = ["human", "regex-split", "per-file"] as const;
export type Reference = (typeof REFERENCE_LAYOUTS)[number];

/** What the grouping under test is called in a verdict. */
export const RECORDED = "recorded";

export interface Verdict {
  fixture: string;
  reference: Reference;
  /** Which layout was labelled A, so a re-read can see the order it was asked in. */
  first: string;
  winner: string;
  reason: string;
  /** Whose opinion this is. A verdict without it is not evidence of anything. */
  judge: string;
  /** The recorded grouping this was cast on: a verdict is evidence only about the
   * layout the judge read, so re-recording replies retires every verdict on them. */
  grouping: string;
}

/** A recorded grouping as a short content hash over names and files in order —
 * everything the judge is shown. In the verdict and the cache file name because
 * the cache is keyed on the question, which includes the answer being judged:
 * keyed only on judge/reference/fixture, a re-record once left 48 verdicts about
 * groupings no longer on disk, printed as current — worse than no cache at all. */
export function groupingFingerprint(groups: NamedGroup[]): string {
  const shape = groups.map((group) => [group.name, ...group.files]);
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 12);
}

/** The verdicts still about a grouping that exists, given today's fingerprints. */
export function freshVerdicts(verdicts: Verdict[], fingerprints: Map<string, string>): Verdict[] {
  return verdicts.filter((verdict) => fingerprints.get(verdict.fixture) === verdict.grouping);
}

export const JUDGE_SYSTEM_PROMPT = [
  "You are judging how a code review should be laid out for a human reviewer.",
  "",
  "You get a diff, the stated intent of the branch, and two candidate groupings",
  "of the same files: A and B. The reviewer will read the diff group by group,",
  "in the order the grouping gives.",
  "",
  "Judge only this: which grouping makes the change explain itself faster to a",
  "reviewer who has not seen it? Consider whether the first group carries the",
  "stated intent, whether causes are read before consequences, whether each group",
  "is one question rather than a bag of files, whether tests are read after the",
  "code they cover, whether mechanical bulk is quarantined out of the way, and",
  "whether the number of groups fits the change.",
  "",
  "One must win; say which, and give one sentence of reason. If they are close,",
  "still pick the one you would rather review by.",
  "",
  'Reply with JSON only: {"winner": "A" | "B", "reason": "..."}',
].join("\n");

/** The layouts a fixture can be judged against, built without asking a model. */
export function referenceLayouts(fixture: GroupingFixture): Record<Reference, NamedGroup[]> {
  const paths = fixture.files.map((file) => file.path);
  return {
    human: fixture.human,
    "regex-split": [
      { name: "Source", files: paths.filter((path) => !isTestFile(path)) },
      { name: "Tests", files: paths.filter(isTestFile) },
    ].filter((group) => group.files.length > 0),
    "per-file": paths.map((path) => ({ name: path, files: [path] })),
  };
}

export interface PairOutcome {
  /** Fixtures where both orders agreed, by the name of what won them. */
  wins: Record<string, number>;
  /** Fixtures where the verdict followed the label instead of the grouping. */
  undecided: number;
}

/** Both-order verdicts collapsed to one outcome per fixture. A pair that disagrees
 * with itself swapped counts undecided, never half a win: position is the one
 * thing a judge must not be answering. */
export function tally(verdicts: Verdict[]): Record<string, PairOutcome> {
  const outcomes: Record<string, PairOutcome> = {};
  for (const [, both] of groupByPair(verdicts)) {
    const outcome = (outcomes[both[0]!.reference] ??= { wins: {}, undecided: 0 });
    if (both.length !== 2 || both[0]!.winner !== both[1]!.winner) {
      outcome.undecided += 1;
      continue;
    }
    outcome.wins[both[0]!.winner] = (outcome.wins[both[0]!.winner] ?? 0) + 1;
  }
  return outcomes;
}

function groupByPair(verdicts: Verdict[]): Map<string, Verdict[]> {
  const pairs = new Map<string, Verdict[]>();
  for (const verdict of verdicts) {
    const key = `${verdict.reference}\u0000${verdict.fixture}`;
    pairs.set(key, [...(pairs.get(key) ?? []), verdict]);
  }
  return pairs;
}

/** Whether the run's verdicts can be believed at all: a judge that cannot say one
 * group per file is worse than a real grouping is not judging groupings. */
export function judgeIsCalibrated(outcomes: Record<string, PairOutcome>): boolean {
  const outcome = outcomes["per-file"];
  if (!outcome) return false;
  const wins = Object.entries(outcome.wins);
  const rejected = wins
    .filter(([name]) => name !== "per-file")
    .reduce((total, [, count]) => total + count, 0);
  const accepted = outcome.wins["per-file"] ?? 0;
  return outcome.undecided === 0 && accepted === 0 && rejected > 0;
}

export function loadVerdicts(): Verdict[] {
  if (!existsSync(VERDICT_DIR)) return [];
  const all = readdirSync(VERDICT_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => JSON.parse(readFileSync(join(VERDICT_DIR, entry), "utf8")) as Verdict);
  const fresh = freshVerdicts(all, currentFingerprints());
  if (fresh.length < all.length) {
    console.log(
      `${all.length - fresh.length} verdict(s) ignored: the grouping they judged has been re-recorded since`,
    );
  }
  return fresh;
}

/** What each fixture's first recorded reply looks like right now. */
function currentFingerprints(): Map<string, string> {
  return new Map(
    loadFixtures().map((fixture) => {
      const recorded = loadRecordedReplies(fixture.name)[0] ?? [];
      return [fixture.name, groupingFingerprint(recorded)];
    }),
  );
}

function renderGrouping(groups: NamedGroup[]): string {
  return groups
    .map(
      (group, index) =>
        `${index + 1}. ${group.name}\n${group.files.map((file) => `   - ${file}`).join("\n")}`,
    )
    .join("\n");
}

/** pi-ai ships a pinned model catalog and the judge is deliberately the newest
 * model — routinely newer than the catalog. An uncatalogued judge borrows the
 * newest sibling's capabilities (id aside), so the run is one dependency bump
 * behind at worst instead of impossible. */
async function judgeModels(reference: string): Promise<MutableModels> {
  const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
  const models = createModels();
  for (const provider of builtinProviders()) models.setProvider(provider);
  const [providerId, ...rest] = reference.split("/");
  const id = rest.join("/");
  if (models.getModel(providerId!, id)) return models;
  const sibling = newestSibling(models, providerId!, id);
  console.log(`${reference} is not in the pi-ai catalog; borrowing ${sibling.id}'s capabilities`);
  return new Proxy(models, {
    get(target, key) {
      if (key === "getModel") {
        return (provider: string, wanted: string): Model<Api> | undefined =>
          target.getModel(provider, wanted) ??
          (provider === providerId && wanted === id ? { ...sibling, id, name: id } : undefined);
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The catalogued model whose id shares the longest prefix with the one asked for. */
function newestSibling(models: MutableModels, providerId: string, id: string): Model<Api> {
  const family = id.split("-")[0] ?? id;
  const candidates = models
    .getModels(providerId)
    .filter((model) => model.id.startsWith(family))
    .sort((left, right) => left.id.localeCompare(right.id));
  const sibling = candidates.at(-1) ?? models.getModels(providerId).at(-1);
  if (!sibling) throw new Error(`no model at all for provider ${providerId}`);
  return sibling;
}

async function askJudge(
  fixture: GroupingFixture,
  a: NamedGroup[],
  b: NamedGroup[],
  judge: string,
  models: MutableModels,
): Promise<{ winner: "A" | "B"; reason: string }> {
  const { files } = extractDiff(REPO_ROOT, fixture.commit, `${fixture.commit}^`);
  const prompt = [
    buildGroupingPrompt({ files, intents: fixture.intents }),
    "",
    "=== Grouping A ===",
    renderGrouping(a),
    "",
    "=== Grouping B ===",
    renderGrouping(b),
  ].join("\n");
  const call = await runGroupingCall({
    model: judge,
    thinking: "off",
    stateDir: defaultStateDir(),
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    models,
  });
  return parseVerdict(call.text);
}

/** The verdict out of whatever the judge wrote. Strict JSON first; a model quoting
 * a file name inside its reason still cast a vote, and dropping it would bias the
 * count towards fixtures that are easy to explain. */
export function parseVerdict(text: string): { winner: "A" | "B"; reason: string } {
  const body = text.replace(/^```(?:json)?|```$/gm, "").trim();
  return asJson(body) ?? looselyRead(body);
}

function asJson(body: string): { winner: "A" | "B"; reason: string } | undefined {
  try {
    const parsed = JSON.parse(body) as { winner: unknown; reason?: unknown };
    if (parsed.winner !== "A" && parsed.winner !== "B") return undefined;
    return { winner: parsed.winner, reason: String(parsed.reason ?? "") };
  } catch {
    return undefined;
  }
}

function looselyRead(body: string): { winner: "A" | "B"; reason: string } {
  const winner = /"winner"\s*:\s*"?([AB])/.exec(body)?.[1];
  if (winner !== "A" && winner !== "B") throw new Error(`no verdict in: ${body.slice(0, 200)}`);
  const reason = /"reason"\s*:\s*"(.*)"/s.exec(body)?.[1] ?? "";
  return { winner, reason: reason.replace(/\\n/g, " ").slice(0, 400) };
}

async function judgeOnce(
  fixture: GroupingFixture,
  reference: Reference,
  flipped: boolean,
  judge: string,
  models: MutableModels,
): Promise<void> {
  const slug = judge.replace(/[^a-z0-9]+/gi, "-");
  const recorded = loadRecordedReplies(fixture.name)[0];
  if (!recorded) {
    console.log(`${fixture.name}: no recorded reply to judge`);
    return;
  }
  const grouping = groupingFingerprint(recorded);
  const path = join(
    VERDICT_DIR,
    `${slug}.${reference}.${fixture.name}.${grouping}.${flipped ? "b" : "a"}.json`,
  );
  if (existsSync(path)) return;
  const layouts = referenceLayouts(fixture)[reference];
  const [first, second] = flipped ? [reference, RECORDED] : [RECORDED, reference];
  const [a, b] = flipped ? [layouts, recorded] : [recorded, layouts];
  const answer = await askJudge(fixture, a, b, judge, models);
  const verdict: Verdict = {
    fixture: fixture.name,
    reference,
    first,
    winner: answer.winner === "A" ? first : second,
    reason: answer.reason,
    judge,
    grouping,
  };
  writeFileSync(path, `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(`${fixture.name} vs ${reference}: ${verdict.winner} wins`);
}

function report(outcomes: Record<string, PairOutcome>): void {
  console.log("\nverdicts, counted only where swapping the labels did not change them:");
  for (const reference of REFERENCE_LAYOUTS) {
    const outcome = outcomes[reference];
    if (!outcome) continue;
    const wins = Object.entries(outcome.wins)
      .map(([name, count]) => `${name} ${count}`)
      .join(", ");
    console.log(
      `  vs ${reference.padEnd(12)} ${wins || "nothing decided"} (${outcome.undecided} undecided)`,
    );
  }
  console.log(
    judgeIsCalibrated(outcomes)
      ? "\njudge calibrated: it rejected one group per file every time"
      : "\nJUDGE NOT CALIBRATED — it could not reject one group per file; ignore the rest",
  );
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf("--judge");
  const judge = flag === -1 ? DEFAULT_JUDGE : argv[flag + 1]!;
  const names = flag === -1 ? argv : [...argv.slice(0, flag), ...argv.slice(flag + 2)];
  mkdirSync(VERDICT_DIR, { recursive: true });
  const models = await judgeModels(judge);
  await Promise.all(
    loadFixtures(names).flatMap((fixture) =>
      REFERENCE_LAYOUTS.flatMap((reference) =>
        [false, true].map((flipped) =>
          judgeOnce(fixture, reference, flipped, judge, models).catch((error: unknown) => {
            // One unusable reply is a gap in the tally, not a lost run.
            console.log(`${fixture.name} vs ${reference}: ${String(error)}`);
          }),
        ),
      ),
    ),
  );
  report(tally(loadVerdicts()));
}
