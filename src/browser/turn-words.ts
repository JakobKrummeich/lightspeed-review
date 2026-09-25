/**
 * The header and the foot of the conversation both say this, and two copies
 * would drift — which a reviewer reads as two different things happening.
 */
import type { AgentTurn } from "../session-store.ts";

/**
 * Digesting and working lock differently, so the reviewer is owed which one it
 * is: "reading your 5 items" is short and locks everything, "Working on" lasts
 * and takes a queue. The plan is the agent's own text and is escaped by every
 * caller. The count is absent when nobody said it (an older server, a page
 * loaded before the frame).
 */
export function agentTurnText(turn: AgentTurn, items?: number): string {
  if (turn.mode === "working") {
    return turn.note === undefined ? "Working on your feedback" : `Working on: ${turn.note}`;
  }
  if (items === undefined) return "Agent is reading your feedback";
  return `Agent is reading your ${items} ${items === 1 ? "item" : "items"}`;
}

/** The reviewer's turn, said as a fact about a live connection, never a timer. */
export function listeningText(waiting: boolean): string {
  return waiting ? "Agent is listening" : "Agent isn't listening";
}
