import { ReviewError, invocationError } from "../errors.ts";
import { END_VERDICTS, type EndApproval, type PollPayload } from "../feedback.ts";
import {
  PROMPT_LIMIT,
  SELECTION_LIMIT,
  truncateContent,
  type StructuredOutput,
} from "../output.ts";
import { sessionKey } from "../paths.ts";
import type { AnnotationPrompt, FeedbackPrompt, ReviewCloser } from "../session-store.ts";
import { turnBlock, type TurnLabel } from "../turn.ts";
import { hasFlag, scanArgs } from "./args.ts";
import { longPoll } from "./long-poll.ts";
import { serverOrigin } from "./server-address.ts";
import { assertServerCurrent } from "./server-lifecycle.ts";
import { legalMoves, turnHelp } from "./home.ts";

export interface WaitArgs {
  /** Unset when the agent left it to `resolveSession` to work out. */
  branch: string | undefined;
  base: string | undefined;
  full: boolean;
}

export interface WaitInput {
  repoRoot: string;
  branch: string;
  base: string;
  port: number;
  full?: boolean;
  /**
   * Echoed because the answer may arrive hours later, into an agent that no
   * longer holds the sentence it sent — "env var, same as every other secret
   * here" answers nothing on its own.
   */
  asked?: string;
}

const WAIT_FLAGS = ["--full"];

export function parseWaitArgs(args: string[]): WaitArgs {
  const scanned = scanArgs(args, {
    boolean: WAIT_FLAGS,
    // Fail loud: a mistyped flag read as a branch name would wait on the wrong
    // session, or on none.
    onUnknown: (flag) =>
      invocationError("unknown_flag", `unknown flag ${flag}`, [
        `Known here: ${WAIT_FLAGS.join(", ")}`,
        "Run `lightspeed wait --help` for what it takes",
      ]),
  });
  return {
    branch: scanned.positional[0],
    base: scanned.positional[1],
    full: hasFlag(scanned, "--full"),
  };
}

/**
 * No timeout by design; broken connections don't end it either — `longPoll`
 * re-makes them while the server is there.
 */
export async function runWait(input: WaitInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  // Before the block, not after it: a wait against a server this CLI cannot read
  // would otherwise hold the agent for hours and then answer with defaults.
  await assertServerCurrent(input.port, `${input.branch} ${input.base}`.trimEnd());
  const result = (await longPoll({
    origin: serverOrigin(input.port),
    key,
    target: `${input.branch} ${input.base}`,
    port: input.port,
  })) as PollPayload;
  return waitOutput(result, input);
}

function shorten(prompt: FeedbackPrompt): FeedbackPrompt {
  if (prompt.type !== "annotation") return prompt;
  return {
    ...prompt,
    selected_text: truncateContent(prompt.selected_text, SELECTION_LIMIT, whereTheRestIs(prompt)),
  };
}

/**
 * A selection is a pointer into a file the agent already has, so the cut costs
 * nothing as long as the pointer survives it.
 */
function whereTheRestIs(prompt: AnnotationPrompt): string {
  if (prompt.line_start === undefined) return `${prompt.file} has the rest`;
  return `lines ${prompt.line_start}-${prompt.line_end} of ${prompt.file} have the rest`;
}

/**
 * `turn` and `round` lead because they are what the next command has to be
 * chosen against; `help[]` closes with the moves that are legal from here.
 */
export function waitOutput(result: PollPayload, input: WaitInput): StructuredOutput {
  const target = `${input.branch} ${input.base}`.trimEnd();
  const listed = promptBlock(result, input.full ?? false);
  return {
    ...turnBlock(result),
    ...(input.asked === undefined ? {} : { asked: input.asked }),
    // No `status`: `turn` names the holder and `ended` says whether there is
    // one, while the record's own word went stale between rounds.
    ended: result.ended,
    ...listed.block,
    ...endedFacts(result),
    // A queue the cap cut is said in `help[]` as well as in the payload: help is
    // what an agent reads before it acts, and acting on part of a round while
    // believing it has all of it is the one failure a cut can cause.
    help: [...listed.help, ...moves(result, target)],
  };
}

function moves(result: PollPayload, target: string): string[] {
  return result.ended
    ? // An ended review is read once and acted on once: the account of what it
      // left is never boilerplate, so it is never shortened.
      [endedHelp(result), ...helpApprovals(result, target), ...legalMoves("ended", target)]
    : // Delivery is what ended this wait, so the turn is the agent's.
      turnHelp(turnOf(result), target, result.helpForm);
}

/**
 * Defaulting to `agent reading` is how a server from before the turn existed
 * had its silence read as a fact: the agent was told it held a turn nobody had
 * handed over. A server of this version always states it — `runWait` refuses
 * the ones that would not — so absence here is our own payload gone wrong, and
 * is reported, never guessed.
 */
function turnOf(result: PollPayload): TurnLabel {
  if (result.turn !== undefined) return result.turn;
  throw new ReviewError({
    code: "server_stale",
    message: "the review server answered without saying whose turn it is",
    detail: "a payload with no `turn` comes from a server older than this CLI",
    suggestions: [
      "Run `lightspeed stop`, then re-run the command; the next `start` brings this version up",
    ],
  });
}

/**
 * A `wait` on an open review only returns once something is queued
 * (`drainPending`), so an empty list is the review that ended with nothing
 * waiting — and `prompts: []` would leave an agent unable to tell that from a
 * field that came back empty by accident.
 */
function promptBlock(
  result: PollPayload,
  full: boolean,
): { block: StructuredOutput; help: string[] } {
  if (result.prompts.length === 0) {
    return {
      block: { prompts: 0, message: "no feedback was queued when this review ended" },
      help: [],
    };
  }
  if (full || result.prompts.length <= PROMPT_LIMIT) {
    return { block: { prompts: full ? result.prompts : result.prompts.map(shorten) }, help: [] };
  }
  const held = result.prompts.length - PROMPT_LIMIT;
  const rest = `${held} more prompt${held === 1 ? "" : "s"} in this round`;
  return {
    block: {
      prompts: result.prompts.slice(0, PROMPT_LIMIT).map(shorten),
      omitted: held,
      message: `${rest}: re-run this wait's command with --full to read them`,
    },
    help: [`Read the whole round before you act: ${rest}, printed by --full`],
  };
}

/** Counts, not paths: no agent should parse the help sentence for a fact the
 * payload can state, and none should be handed a file list it did not ask for.
 * `endedBy` is here for the first reason too. */
function endedFacts(result: PollPayload): Partial<Pick<PollPayload, "approval" | "endedBy">> {
  if (!result.ended) return {};
  const approval = counted(result.approval);
  return {
    ...(approval === undefined ? {} : { approval }),
    ...(result.endedBy !== undefined ? { endedBy: result.endedBy } : {}),
  };
}

const KNOWN_VERDICTS: ReadonlySet<string> = new Set(END_VERDICTS);

/** A server older than the counts sends paths where the numbers now are, and one
 * older than the verdict sends numbers without the word an agent branches on.
 * Either read as a whole account would report a sign-off off an array's
 * truthiness or off a missing field, so a partial account is dropped and the help
 * line says it was not reported — which is what it is, and not "nothing was
 * approved". Present means all five fields, so nothing downstream reads half. */
function counted(approval: EndApproval | undefined): EndApproval | undefined {
  if (approval === undefined) return undefined;
  const numbers: unknown[] = [
    approval.approved,
    approval.unapproved,
    approval.swept,
    approval.total,
  ];
  if (!numbers.every((value) => typeof value === "number")) return undefined;
  return KNOWN_VERDICTS.has(approval.verdict) ? approval : undefined;
}

/** Offered only where a name could matter: a review that ended holding some. */
function helpApprovals(result: PollPayload, target: string): string[] {
  const approval = counted(result.approval);
  if (approval === undefined || approval.total === 0) return [];
  return [
    `Run \`lightspeed approvals ${target}\` to name the files behind those counts —` +
      " which were approved, which were swept, which nobody signed off on",
  ];
}

/** The words are spent only on the readings no number carries — except the
 * verdict, echoed in the one line every reader reads: an agent that skims the
 * help and never opens the payload is the one this sentence exists for, and
 * "ended" alone would let it read a sign-off. */
function endedHelp(result: PollPayload): string {
  return [closerClause(result.endedBy), ...approvalClauses(counted(result.approval))].join("; ");
}

/** A record that does not say must not be read as either party. */
function closerClause(endedBy: ReviewCloser | undefined): string {
  if (endedBy === "reviewer") return "The reviewer ended this review";
  if (endedBy === "agent") return "`lightspeed end` closed this review, not the reviewer";
  return "This review is ended";
}

/** An older server's account is unreadable rather than empty — it recorded
 * approvals, it just did not report them in a shape this reads — and a sweep
 * lane's tick says accepted where the review asked nobody to read, which would
 * otherwise turn a `signed-off` verdict into a claim nobody made. */
function approvalClauses(approval: EndApproval | undefined): string[] {
  if (approval === undefined) return ["what was approved was not reported"];
  const verdict = [`verdict: ${approval.verdict}`];
  if (approval.swept === 0) return verdict;
  return [...verdict, "some approvals were swept as bulk the review never asked anyone to read"];
}
