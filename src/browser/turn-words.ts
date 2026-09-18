/**
 * What the agent holding the turn is told to the reviewer, in one place. The
 * header banner and the foot of the conversation both say it, and two copies
 * would drift — which a reviewer reads as two different things happening.
 */
import type { Turn } from "../session-store.ts";

/**
 * The two things the agent's turn can mean. They gate identically — `mode` is
 * presentational — but a reviewer waiting on a silence is owed the difference
 * between "it has your words" and "it is writing the code", which is the whole
 * point of the plan `work` declares. The plan is the agent's own text and is
 * escaped by every caller.
 */
export function agentTurnText(turn: Turn): string {
  if (turn.mode !== "working") return "the agent has your feedback";
  return turn.note === undefined
    ? "the agent is implementing your feedback"
    : `implementing: ${turn.note}`;
}
