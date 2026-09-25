/**
 * The header's tooltip and the foot of the conversation both say this, and two
 * copies would drift — which a reviewer reads as two different things happening.
 */
import type { AgentTurn } from "../session-store.ts";

/**
 * `mode` is presentational — both gate identically — but a reviewer waiting on
 * a silence is owed the difference between "it has your words" and "it is at
 * work on them". The plan is said alone, with no word for the kind of work: it
 * is as often answering or investigating as implementing, and a prefix naming
 * one misreads the others. It is the agent's own text and is escaped by every
 * caller.
 */
export function agentTurnText(turn: AgentTurn): string {
  if (turn.mode !== "working") return "the agent has your feedback";
  return turn.note ?? "the agent is working on your feedback";
}
