import { commentedLastRound } from "./commented-files.ts";
import { currentRound } from "./conversation-rounds.ts";
import type { ConversationEntry, RoundMark, SessionStatus } from "../session-store.ts";

/**
 * Whether a round the page is about to draw arrives by the jump: exactly when
 * the replay will open on its own for it — the review is live, the round
 * before it was commented on (the replay's own cards, `commentedLastRound`
 * reads them as `rounds/replay.ts` does), and this browser has not replayed it
 * yet. Answered from the session alone, before the replay is fetched, so the
 * jump can cover the page before the new round is drawn under it.
 */
export function arrivesByJump(
  fresh: {
    rounds: readonly RoundMark[];
    conversation: readonly ConversationEntry[];
    status: SessionStatus;
  },
  replayed: number | undefined,
): boolean {
  if (fresh.status === "ended") return false;
  if (currentRound(fresh.rounds) === replayed) return false;
  return commentedLastRound(fresh.conversation, fresh.rounds).size > 0;
}
