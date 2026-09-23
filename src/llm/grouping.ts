import type { Message, MutableModels } from "@earendil-works/pi-ai";
import type { LightspeedConfig } from "../config.ts";
import type { DiffFile, DiffGroup } from "../diff-extract.ts";
import { ReviewError } from "../errors.ts";
import { trailSweeps } from "../group-tier.ts";
import {
  GROUPING_SYSTEM_PROMPT,
  buildGroupingPrompt,
  buildRepairPrompt,
  type PreviousGroup,
} from "./prompts.ts";
import { MODEL_FIX, runGroupingCall, type GroupingCallResult } from "./pi-client.ts";
import { raiseToStudy } from "./reading-tier.ts";
import { validateGroupingReply, type GroupingReply } from "./schema.ts";
import { trailTests } from "./tests-last.ts";
import { voiceProblem } from "./voice.ts";

export const FALLBACK_GROUP_NAME = "All Changes";

/** How many corrective rounds the model gets after its first invalid reply. */
export const MAX_REPAIR_ROUNDS = 2;

export type GroupingMode = "skipped" | "llm" | "fallback";

export interface GroupingResult {
  groups: DiffGroup[];
  mode: GroupingMode;
  /** Why the LLM was skipped or abandoned; absent when `mode` is `llm`. */
  reason?: string;
  /**
   * `start` exits 0 on a degraded grouping — the review still opens — so this
   * edit is the whole of the warning an agent gets that the product's main
   * feature is off.
   */
  fix?: string;
}

export interface GroupDiffInput {
  files: DiffFile[];
  config: LightspeedConfig;
  intents: string[];
  /**
   * Last round's grouping in reading order, so the model holds it steady rather
   * than re-deriving one the reviewer must relearn.
   */
  previous?: PreviousGroup[];
  /** Injected in tests; defaults to pi-ai's built-in providers. */
  models?: MutableModels;
}

/**
 * A bad model answer degrades to one group rather than blocking the review.
 * Missing credentials are the exception — an unfinished install, not weather —
 * otherwise they would read as a successful review of an ungrouped diff, the
 * exact failure grouping exists to prevent.
 */
export async function groupDiff(input: GroupDiffInput): Promise<GroupingResult> {
  const { files } = input;
  if (files.length <= 1) {
    return {
      ...singleGroup(files),
      mode: "skipped",
      reason: `${files.length} changed file: nothing to order`,
    };
  }
  try {
    return await groupWithModel(input);
  } catch (error) {
    if (error instanceof ReviewError && error.code === "pi_auth_missing") throw error;
    return { ...fallbackGroups(files), mode: "fallback", ...degraded(error) };
  }
}

const UNGROUPED = "the diff is one group instead of semantic ones";

/**
 * Not `detail ?? message`, which throws the failure itself away: an unknown
 * model then prints the format rule — `model` must be `<provider>/<model-id>`
 * — over a reference whose format was right, never naming the model that does
 * not exist. Single-file diffs skip the model altogether, so a review can run
 * degraded for rounds without anyone noticing.
 */
function degraded(error: unknown): { reason: string; fix?: string } {
  if (!(error instanceof ReviewError)) return { reason: `${String(error)} — ${UNGROUPED}` };
  if (error.code === "pi_model_unknown") {
    return { reason: `${error.message} — ${UNGROUPED}`, fix: error.detail ?? MODEL_FIX };
  }
  const cause = error.detail === undefined ? error.message : `${error.message}: ${error.detail}`;
  return { reason: `${cause} — ${UNGROUPED}` };
}

async function groupWithModel(input: GroupDiffInput): Promise<GroupingResult> {
  const { files, config } = input;
  const paths = files.map((file) => file.path);
  let messages: Message[] = [
    {
      role: "user",
      content: buildGroupingPrompt({
        files,
        intents: input.intents,
        classify: config.classify,
        ...(input.previous ? { previous: input.previous } : {}),
      }),
      timestamp: Date.now(),
    },
  ];

  for (let round = 0; round <= MAX_REPAIR_ROUNDS; round += 1) {
    const call = await runGroupingCall({
      model: config.model,
      thinking: config.thinking,
      stateDir: config.stateDir,
      ...(config.providers ? { providers: config.providers } : {}),
      systemPrompt: GROUPING_SYSTEM_PROMPT,
      messages,
      ...(input.models ? { models: input.models } : {}),
    });
    const validation = validateGroupingReply(call.text, paths);
    if (validation.ok) {
      const voice = voiceComplaint(validation.value.groups, round);
      if (voice === undefined) {
        // Order matters: `trailTests` first, so the `Tests` chapter it mints is
        // tiered like every other; `trailSweeps` last, because only a settled
        // tier says which chapters sink — one the model called `sweep` and
        // `raiseToStudy` raised keeps the place the model gave it.
        const ordered = trailTests(toDiffGroups(validation.value.groups, files));
        return { groups: trailSweeps(raiseToStudy(ordered, config.classify)), mode: "llm" };
      }
      messages = repairRound(call, voice, round);
      continue;
    }
    messages = repairRound(call, validation.problem, round);
  }
  return {
    ...fallbackGroups(files),
    mode: "fallback",
    reason: `the model did not return a valid grouping after ${MAX_REPAIR_ROUNDS + 1} attempts`,
  };
}

/**
 * The last round takes the rationale as it comes: a grouping whose `rationale`
 * orders the reviewer about is worth incomparably more than the fallback's one
 * undivided chapter.
 */
function voiceComplaint(groups: GroupingReply["groups"], round: number): string | undefined {
  return round === MAX_REPAIR_ROUNDS ? undefined : voiceProblem(groups);
}

/**
 * One line per rejection on stderr: when a review opens on "fallback", this
 * trail is the only record of what the model kept getting wrong.
 */
function repairRound(call: GroupingCallResult, problem: string, round: number): Message[] {
  console.error(`grouping attempt ${round + 1} rejected: ${problem}`);
  return [
    ...call.messages,
    { role: "user", content: buildRepairPrompt(problem), timestamp: Date.now() },
  ];
}

function toDiffGroups(groups: GroupingReply["groups"], files: DiffFile[]): DiffGroup[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return groups.map((group) => ({
    name: group.name,
    rationale: group.rationale,
    tier: group.tier,
    files: group.files.map((path) => byPath.get(path)).filter((file) => file !== undefined),
  }));
}

/** Follows the prompt's own rule for a rationale: a statement, not a question. */
export const UNGROUPED_RATIONALE =
  "Not ordered by a model: the files are in the order git listed them.";

/**
 * Untouched: a one-file diff is reported as `skipped` with "nothing to order",
 * and ordering it anyway would contradict the sentence the same call prints.
 */
function singleGroup(files: DiffFile[]): { groups: DiffGroup[] } {
  if (files.length === 0) return { groups: [] };
  return {
    // `study`, and not a tier worked out from the files: nothing here read the
    // diff, and a chapter holding the whole change is the last one to skim.
    groups: [{ name: FALLBACK_GROUP_NAME, rationale: UNGROUPED_RATIONALE, tier: "study", files }],
  };
}

/**
 * Stand-in for a failed model: one group with tests trailing — the one ordering
 * rule that needs no model. A diff of nothing but tests keeps its single
 * `All Changes` group: that name is what docs and `reason` promise, and
 * splitting tests away from nothing renames the fallback for nobody's benefit.
 */
function fallbackGroups(files: DiffFile[]): { groups: DiffGroup[] } {
  const one = singleGroup(files);
  const trailed = trailTests(one.groups);
  const keptTheFallback = trailed.some((group) => group.name === FALLBACK_GROUP_NAME);
  return { groups: keptTheFallback ? trailed : one.groups };
}
