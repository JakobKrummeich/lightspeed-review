/**
 * One holder per session, three live states: the reviewer composes, the agent
 * digests a batch, the agent works. Discussion strictly alternates — the
 * reviewer's Send hands the turn over only when it is delivered to an agent
 * that is waiting for it, and the agent hands it back only with a command that
 * also waits for the next Send (`reply`, `publish`). No timer, no staleness
 * unlock and no override: an agent that died holding the turn is recovered by
 * re-running the command it died in.
 */
import type { StructuredOutput } from "./output.ts";
import type { SessionRecord, Turn } from "./session-types.ts";
import { batchSize } from "./threads.ts";

export function reviewerTurn(now: string): Turn {
  return { holder: "reviewer", at: now };
}

export function agentDigesting(now: string): Turn {
  return { holder: "agent", mode: "digesting", at: now };
}

/** `at` is where `work` found the branch: its tip and its tree. */
export function agentWorking(
  now: string,
  note: string,
  at: { head?: string; tree?: string } = {},
): Turn {
  return {
    holder: "agent",
    mode: "working",
    at: now,
    note,
    ...(at.head === undefined ? {} : { head: at.head }),
    ...(at.tree === undefined ? {} : { tree: at.tree }),
  };
}

/**
 * One closed set of words an agent can branch on without reading two fields;
 * an ended review says so instead of naming a holder.
 */
export type TurnLabel = "reviewer" | "agent digesting" | "agent working" | "ended";

export interface TurnFacts {
  round: number;
  turn: TurnLabel;
}

/** Round first, as `turnBlock` prints them: spread into a block, the key order is the print order. */
export function turnFacts(session: Pick<SessionRecord, "status" | "turn" | "rounds">): TurnFacts {
  return { round: roundNumber(session), turn: turnLabel(session) };
}

/**
 * A server older than the turn states neither, and a reader must not read that
 * as "the reviewer's" — so the fields are absent rather than guessed.
 */
export function turnBlock(facts: Partial<TurnFacts>): StructuredOutput {
  return {
    ...(facts.round === undefined ? {} : { round: facts.round }),
    ...(facts.turn === undefined ? {} : { turn: facts.turn }),
  };
}

export function turnLabel(session: Pick<SessionRecord, "status" | "turn">): TurnLabel {
  if (session.status === "ended") return "ended";
  if (session.turn.holder === "reviewer") return "reviewer";
  return session.turn.mode === "working" ? "agent working" : "agent digesting";
}

/** As a reviewer counts it, from one; a session holding no rounds is round 0, not round one. */
export function roundNumber(session: Pick<SessionRecord, "rounds">): number {
  const index = session.rounds.at(-1)?.index;
  return index === undefined ? 0 : index + 1;
}

/**
 * What the page says about the agent off the record: whose turn, and — while
 * the agent digests — how many items it is reading. Browser-safe: the served
 * page, the presence frame and the bundle's first paint all read it here.
 */
export interface PresenceFacts {
  turn: Turn;
  items?: number;
}

export function presenceOf(session: Pick<SessionRecord, "turn" | "batch">): PresenceFacts {
  const { turn, batch } = session;
  const digesting = turn.holder === "agent" && turn.mode === "digesting";
  return digesting && batch !== undefined ? { turn, items: batchSize(batch.prompts) } : { turn };
}
