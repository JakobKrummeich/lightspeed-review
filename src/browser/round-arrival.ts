import { commentedLastRound } from "./commented-files.ts";
import { currentRound } from "./conversation-rounds.ts";
import type { ConversationEntry, RoundMark, SessionStatus } from "../session-store.ts";

/**
 * A round arrives by the jump exactly when its replay will open on its own.
 * Answered from the session alone, before the replay is fetched, so the jump
 * can cover the page before the new round is drawn under it.
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
