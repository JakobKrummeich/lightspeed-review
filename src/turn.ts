/**
 * The turn: whose move it is, and the four shapes a move leaves behind. One
 * holder per session at a time, and one rule over the whole review —
 *
 *   Queue always. End always. Send only on your turn.
 *
 * The turn moves to the agent on delivery alone, never on the reviewer's Send:
 * words nobody is waiting for queue server-side and the reviewer keeps sending.
 * There is no timer, no staleness unlock and no override — an agent that died
 * holding the turn is recovered in the terminal it was started from.
 */
import type { StructuredOutput } from "./output.ts";
import type { SessionRecord, Turn } from "./session-store.ts";

/** The reviewer's move: Send is live and nothing is owed to them. */
export function reviewerTurn(now: string): Turn {
  return { holder: "reviewer", at: now };
}

/** Delivery: prompts left for a blocked `wait`, so the agent is reading them. */
export function agentReading(now: string): Turn {
  return { holder: "agent", mode: "reading", at: now };
}

/** `work "<plan>"`: the same lock, with the plan for the reviewer's banner. */
export function agentWorking(now: string, note: string): Turn {
  return { holder: "agent", mode: "working", at: now, note };
}

/**
 * The turn as every command prints it: one closed set of words an agent can
 * branch on without reading two fields. An ended review says so instead of
 * naming a holder — there are no moves left to make.
 */
export type TurnLabel = "reviewer" | "agent reading" | "agent working" | "ended";

/**
 * What every command's output carries, and the whole protocol an agent needs to
 * read off one answer: whose move it is now, and which round it is about.
 */
export interface TurnFacts {
  turn: TurnLabel;
  round: number;
}

export function turnFacts(session: Pick<SessionRecord, "status" | "turn" | "rounds">): TurnFacts {
  return { turn: turnLabel(session), round: roundNumber(session) };
}

/**
 * The two facts every command's answer leads with, spread into it. A server
 * older than the turn states neither, and a reader must not read that as "the
 * reviewer's" — so the fields are absent rather than guessed, in one place
 * rather than once per command.
 *
 * The moves a turn allows are the other half of this, and they live with the
 * rest of the help lines in `commands/home.ts`, which reads this module.
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

/**
 * The round on screen as a reviewer counts it, from one. A session holding no
 * rounds is round 0: nothing has been published, which is not round one.
 */
export function roundNumber(session: Pick<SessionRecord, "rounds">): number {
  const index = session.rounds.at(-1)?.index;
  return index === undefined ? 0 : index + 1;
}
