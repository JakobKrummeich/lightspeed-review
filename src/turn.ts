/**
 * One holder per session, one rule: Queue always. End always. Send only on
 * your turn. The turn moves to the agent on delivery alone, never on the
 * reviewer's Send: words nobody is waiting for queue server-side and the
 * reviewer keeps sending. No timer, no staleness unlock and no override — an
 * agent that died holding the turn is recovered in the terminal it was started from.
 */
import type { StructuredOutput } from "./output.ts";
import type { SessionRecord, Turn } from "./session-store.ts";

export function reviewerTurn(now: string): Turn {
  return { holder: "reviewer", at: now };
}

export function agentReading(now: string): Turn {
  return { holder: "agent", mode: "reading", at: now };
}

export function agentWorking(now: string, note: string): Turn {
  return { holder: "agent", mode: "working", at: now, note };
}

/**
 * One closed set of words an agent can branch on without reading two fields;
 * an ended review says so instead of naming a holder.
 */
export type TurnLabel = "reviewer" | "agent reading" | "agent working" | "ended";

/**
 * The full block is how an agent learns the protocol from a single answer;
 * every repeat of it inside one round is bytes the agent already has.
 */
export type HelpForm = "full" | "short";

export interface TurnFacts {
  turn: TurnLabel;
  round: number;
  /** Absent from an old server. */
  helpForm?: HelpForm;
}

export function turnFacts(session: Pick<SessionRecord, "status" | "turn" | "rounds">): TurnFacts {
  return { turn: turnLabel(session), round: roundNumber(session) };
}

/**
 * Kept on the session rather than worked out from `turn.at` or held in memory,
 * because every CLI invocation is a fresh process and a `serve` restart must
 * not re-start the reader's education mid-round. Keyed on the round because a
 * new round is exactly when the moves change and the full block earns its
 * tokens again — and because that makes `start` reset it without writing
 * anything: the round number it compares against has simply moved on.
 */
export function budgetHelp(session: SessionRecord): { form: HelpForm; session: SessionRecord } {
  const round = roundNumber(session);
  if (session.helpShownRound === round) return { form: "short", session };
  return { form: "full", session: { ...session, helpShownRound: round } };
}

/** The same reading without spending it: a refusal tells an agent what it may
 * do instead, and telling it that is not the answer a round's help was for. */
export function helpFormFor(session: SessionRecord): HelpForm {
  return session.helpShownRound === roundNumber(session) ? "short" : "full";
}

/** The wire field, present only where there is a form to state — an answer
 * nobody prints states none, and a reader that finds none prints in full. */
export function helpFormField(form: HelpForm | undefined): { helpForm?: HelpForm } {
  return form === undefined ? {} : { helpForm: form };
}

/**
 * A server older than the turn states neither, and a reader must not read that
 * as "the reviewer's" — so the fields are absent rather than guessed.
 */
export function turnBlock(facts: Partial<TurnFacts>): StructuredOutput {
  return {
    ...(facts.turn === undefined ? {} : { turn: facts.turn }),
    ...(facts.round === undefined ? {} : { round: facts.round }),
  };
}

export function turnLabel(session: Pick<SessionRecord, "status" | "turn">): TurnLabel {
  if (session.status === "ended") return "ended";
  if (session.turn.holder === "reviewer") return "reviewer";
  return session.turn.mode === "working" ? "agent working" : "agent reading";
}

/** As a reviewer counts it, from one; a session holding no rounds is round 0, not round one. */
export function roundNumber(session: Pick<SessionRecord, "rounds">): number {
  const index = session.rounds.at(-1)?.index;
  return index === undefined ? 0 : index + 1;
}
