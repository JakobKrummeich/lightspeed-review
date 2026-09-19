import { validationError } from "../errors.ts";
import { END_VERDICTS, type EndApproval, type PollPayload } from "../feedback.ts";
import { truncateContent, type StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import type { FeedbackPrompt, ReviewCloser } from "../session-store.ts";
import { turnBlock } from "../turn.ts";
import { hasFlag, scanArgs } from "./args.ts";
import { longPoll } from "./long-poll.ts";
import { serverOrigin } from "./server-address.ts";
import { legalMoves, turnHelp } from "./home.ts";

export interface WaitArgs {
  /** Unset when the agent left it to `resolveSession` to work out. */
  branch: string | undefined;
  base: string | undefined;
  /** `--full`: print selections at their real length instead of truncating. */
  full: boolean;
}

export interface WaitInput {
  repoRoot: string;
  branch: string;
  base: string;
  port: number;
  full?: boolean;
  /**
   * The question this block is the answer to, when `ask` opened it. Echoed
   * because the answer may arrive hours later, into an agent that no longer
   * holds the sentence it sent — "env var, same as every other secret here"
   * answers nothing on its own.
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
      validationError(`unknown flag ${flag}`, [
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
 * The one blocking call in the CLI, and the only way the turn ever comes to the
 * agent. No timeout by design; broken connections don't end it either —
 * `longPoll` re-makes them while the server is there. Agents are told everywhere
 * to run this in the foreground and wait.
 */
export async function runWait(input: WaitInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const result = (await longPoll({
    origin: serverOrigin(input.port),
    key,
    target: `${input.branch} ${input.base}`,
    port: input.port,
  })) as PollPayload;
  return waitOutput(result, input);
}

/** Selections can be page-long; `--full` is the way to see one in full. */
function shorten(prompt: FeedbackPrompt): FeedbackPrompt {
  if (prompt.type !== "annotation") return prompt;
  return { ...prompt, selected_text: truncateContent(prompt.selected_text) };
}

/**
 * What a delivered turn looks like. `turn` and `round` lead because they are
 * what the next command has to be chosen against, and `help[]` closes with the
 * moves that are legal from here — the protocol, learned from one answer.
 */
export function waitOutput(result: PollPayload, input: WaitInput): StructuredOutput {
  const target = `${input.branch} ${input.base}`.trimEnd();
  return {
    ...turnBlock(result),
    ...(input.asked === undefined ? {} : { asked: input.asked }),
    // `status` is not printed: `turn` names the holder and `ended` says whether
    // there is one, while the record's own word went stale between rounds —
    // `feedback` long after the feedback was read. Two fields for one fact is a
    // reconciliation an agent should never be asked to make.
    ended: result.ended,
    ...promptBlock(result, input.full ?? false),
    ...endedFacts(result),
    help: result.ended
      ? // An ended review is read once and acted on once: the account of what it
        // left is never boilerplate, so it is never shortened.
        [endedHelp(result), ...helpApprovals(result, target), ...legalMoves("ended", target)]
      : // Delivery is what ended this wait, so the turn is the agent's — stated by
        // the answer, and assumed only of a server too old to state it.
        turnHelp(result.turn ?? "agent reading", target, result.helpForm),
  };
}

/**
 * The prompts, or the definitive statement that there were none. A `wait` on an
 * open review only returns once something is queued (`drainPending`), so an
 * empty list is the review that ended with nothing waiting — and `prompts: []`
 * would leave an agent unable to tell that from a field that came back empty by
 * accident.
 */
function promptBlock(result: PollPayload, full: boolean): StructuredOutput {
  if (result.prompts.length === 0) {
    return { prompts: 0, message: "no feedback was queued when this review ended" };
  }
  return { prompts: full ? result.prompts : result.prompts.map(shorten) };
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

/** The one command that names files, offered only where a name could matter: a
 * review that ended holding some. Nothing runs it by default. */
function helpApprovals(result: PollPayload, target: string): string[] {
  const approval = counted(result.approval);
  if (approval === undefined || approval.total === 0) return [];
  return [
    `Run \`lightspeed approvals ${target}\` to name the files behind those counts —` +
      " which were approved, which were swept, which nobody signed off on",
  ];
}

/** The one answer an agent may act on with nobody left in the loop. The counts
 * state themselves and the words are spent only on the readings no number
 * carries — except the verdict, which is echoed here in the one line every reader
 * reads. An agent that skims the help and never opens the payload is the one this
 * whole sentence exists for, and "ended" alone would let it read a sign-off. */
function endedHelp(result: PollPayload): string {
  return [closerClause(result.endedBy), ...approvalClauses(counted(result.approval))].join("; ");
}

/** Who closed it. A record that does not say must not be read as either party. */
function closerClause(endedBy: ReviewCloser | undefined): string {
  if (endedBy === "reviewer") return "The reviewer ended this review";
  if (endedBy === "agent") return "`lightspeed end` closed this review, not the reviewer";
  return "This review is ended";
}

/** The two readings a number cannot carry. An older server's account is
 * unreadable rather than empty — it recorded approvals, it just did not report
 * them in a shape this reads — and a sweep lane's tick says accepted where the
 * review asked nobody to read, which is what would otherwise turn a `signed-off`
 * verdict into a claim nobody made. */
function approvalClauses(approval: EndApproval | undefined): string[] {
  if (approval === undefined) return ["what was approved was not reported"];
  const verdict = [`verdict: ${approval.verdict}`];
  if (approval.swept === 0) return verdict;
  return [...verdict, "some approvals were swept as bulk the review never asked anyone to read"];
}
