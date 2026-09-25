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

export function reviewerTurn(now: string): Turn {
  return { holder: "reviewer", at: now };
}

export function agentDigesting(now: string): Turn {
  return { holder: "agent", mode: "digesting", at: now };
}

export function agentWorking(now: string, note: string, head?: string): Turn {
  return {
    holder: "agent",
    mode: "working",
    at: now,
    note,
    ...(head === undefined ? {} : { head }),
  };
}

/**
 * One closed set of words an agent can branch on without reading two fields;
 * an ended review says so instead of naming a holder.
 */
export type TurnLabel = "reviewer" | "agent digesting" | "agent working" | "ended";

export interface TurnFacts {
  turn: TurnLabel;
  round: number;
}

export function turnFacts(session: Pick<SessionRecord, "status" | "turn" | "rounds">): TurnFacts {
  return { turn: turnLabel(session), round: roundNumber(session) };
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
