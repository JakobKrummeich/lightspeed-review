import { ReviewError } from "../errors.ts";
import { END_VERDICTS, type EndApproval, type PollPayload } from "../feedback.ts";
import { SELECTION_LIMIT, truncateContent, type StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import type { ReviewCloser } from "../session-types.ts";
import type { BatchItem } from "../threads.ts";
import { turnBlock, type TurnLabel } from "../turn.ts";
import { endedClause, nextRule } from "../turn-help.ts";
import { longPoll } from "./long-poll.ts";
import { serverOrigin } from "./server-address.ts";
import { assertServerCurrent } from "./server-lifecycle.ts";

export interface ListenInput {
  repoRoot: string;
  branch: string;
  base: string;
  port: number;
}

/**
 * The waiting half of `open`, `reply` and `publish`: it returns when the
 * reviewer sends (or the review ends), with the batch. No timeout by design;
 * broken connections don't end it either — `longPoll` re-makes them while the
 * server is there, and a killed one is recovered by re-running the command.
 */
export async function listen(input: ListenInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const target = `${input.branch} ${input.base}`;
  // Before the wait, not after it: a wait against a server this CLI cannot read
  // would otherwise hold the agent for hours and then answer with defaults.
  await assertServerCurrent(input.port, target);
  const result = (await longPoll({
    origin: serverOrigin(input.port),
    key,
    target,
    port: input.port,
  })) as PollPayload;
  return batchOutput(result, target);
}

/**
 * `round` and `turn` lead, the items follow, and `next:` closes: the decision
 * rule for ending this turn is the last thing the agent reads (D5).
 */
export function batchOutput(result: PollPayload, target: string): StructuredOutput {
  if (result.superseded === true) return supersededOutput(result);
  const items = result.items.map(itemRow);
  if (result.ended) {
    return {
      ...turnBlock(result),
      ended: true,
      ...(items.length === 0
        ? { message: "no feedback was queued when this review ended" }
        : { items }),
      ...endedFacts(result),
      help: [endedHelp(result), ...helpApprovals(result, target)],
      next: nextRule("ended", target),
    };
  }
  const open = result.items.filter((item) => item.status !== "resolved").map((item) => item.id);
  const resolved = result.items.filter((item) => item.status === "resolved").map((item) => item.id);
  return {
    ...turnBlock({ ...result, turn: turnOf(result) }),
    items,
    next: nextRule(turnOf(result), target, open, resolved),
  };
}

/**
 * The agent re-ran its waiting command and this is the old one: the newer
 * command holds the wait and will hand over the Send. No turn, no items — the
 * process that prints this is a leftover, and its only move is to stop.
 */
function supersededOutput(result: PollPayload): StructuredOutput {
  return {
    superseded: true,
    message:
      result.message ??
      "another lightspeed command took over listening for this review; nothing to do here",
    next: {
      done: "Nothing to do in this process: the command that took over hands you the reviewer's Send",
    },
  };
}

/**
 * One row per thread. `reviewer` is a plain string when they said one thing —
 * the usual case — so it reads as a sentence, not a one-element list.
 */
export function itemRow(item: BatchItem): StructuredOutput {
  const said = item.reviewer.length === 1 ? item.reviewer[0] : item.reviewer;
  return {
    id: item.id,
    status: item.status,
    ...(item.file === undefined ? {} : { at: placeOf(item) }),
    ...(item.selected_text === undefined ? {} : { selected: selectionOf(item) }),
    ...(item.you === undefined ? {} : { you: item.you }),
    ...(item.reviewer.length === 0 ? {} : { reviewer: said }),
  };
}

function placeOf(item: BatchItem): string {
  if (item.line_start === undefined) return item.file!;
  const lines =
    item.line_start === item.line_end
      ? `${item.line_start}`
      : `${item.line_start}-${item.line_end}`;
  return `${item.file}:${lines}${item.side === "old" ? " (base)" : ""}`;
}

/**
 * A selection is a pointer into a file the agent already has, so the cut costs
 * nothing as long as the pointer survives it.
 */
function selectionOf(item: BatchItem): string {
  const rest =
    item.line_start === undefined ? `${item.file} has the rest` : `${placeOf(item)} has the rest`;
  return truncateContent(item.selected_text!, SELECTION_LIMIT, rest);
}

/**
 * A server of this version always states the turn — `listen` refuses the ones
 * that would not — so absence here is a payload gone wrong, reported, never
 * guessed.
 */
function turnOf(result: PollPayload): TurnLabel {
  if (result.turn !== undefined) return result.turn;
  throw new ReviewError({
    code: "server_stale",
    message: "the review server answered without saying whose turn it is",
    detail: "a payload with no `turn` comes from a server older than this CLI",
    suggestions: ["Run `lightspeed stop`, then re-run the command; it brings this version up"],
  });
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

/** A record that does not say must not be read as either party; opening a help line, capitalised. */
function closerClause(endedBy: ReviewCloser | undefined): string {
  const clause = endedClause(endedBy);
  return clause.charAt(0).toUpperCase() + clause.slice(1);
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
