/**
 * Whether the agent has read what the reviewer sent, told per message: a Send
 * with nobody listening is held by the server, and "sent" alone read as "the
 * agent has it". Pure, so the reading is testable without a page.
 */
import type { Batch, FeedbackPrompt, SessionStatus, Turn } from "../session-store.ts";

export type Delivery = "seen" | "unheard" | "sent";

export const DELIVERY_LABEL: Record<Delivery, string> = {
  seen: "✓ seen by agent",
  unheard: "sent · agent not listening",
  sent: "sent",
};

/** Said on a queued pill: it has not left the browser. */
export const DRAFT_LABEL = "not sent yet";

export interface DeliveryFacts {
  /** When the agent last picked words up; absent before any pickup. */
  handedAt?: string;
  /** The server still holds words nobody has picked up. */
  held: boolean;
}

export function deliveryFacts(session: {
  batch?: Pick<Batch, "at">;
  pending: readonly FeedbackPrompt[];
  turn: Turn;
}): DeliveryFacts {
  const facts: DeliveryFacts = { held: session.pending.length > 0 };
  if (session.batch !== undefined) facts.handedAt = session.batch.at;
  return handedOnTurn(facts, session.turn);
}

/**
 * The page hears of a pickup as a turn change, ahead of any session refetch:
 * the agent starts digesting at the very moment it is handed the held words.
 */
export function handedOnTurn(facts: DeliveryFacts, turn: Turn): DeliveryFacts {
  if (turn.holder !== "agent" || turn.mode !== "digesting") return facts;
  const handedAt =
    facts.handedAt !== undefined && facts.handedAt > turn.at ? facts.handedAt : turn.at;
  return { handedAt, held: false };
}

/**
 * Nothing held means everything sent was handed over — which is also how a
 * session from before batches were written down reads, rather than as unheard.
 */
export function deliveryOf(at: string, facts: DeliveryFacts, status: SessionStatus): Delivery {
  if (!facts.held || (facts.handedAt !== undefined && at <= facts.handedAt)) return "seen";
  return status === "ended" ? "sent" : "unheard";
}
