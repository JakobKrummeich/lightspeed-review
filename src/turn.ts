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

/** Whether the agent may send — and, read the other way, whether Send is off. */
export function agentHoldsTurn(session: Pick<SessionRecord, "turn">): boolean {
  return session.turn.holder === "agent";
}

/**
 * The turn as every command prints it: one closed set of words an agent can
 * branch on without reading two fields. An ended review says so instead of
 * naming a holder — there are no moves left to make.
 */
export type TurnLabel = "reviewer" | "agent reading" | "agent working" | "ended";

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
