/**
 * Which of the agent's messages the conversation panel has drawn, kept in the
 * review's memory so a reload still knows — what the round replay leaves out.
 * Drawn counts, whether or not it was scrolled to or its card was open: the
 * words were on the page. Keys are `saidKey`s (`message-news.ts`).
 */
import { readMemory, updateMemory, type ReviewMemoryStorage } from "./review-memory.ts";

export interface SeenReplies {
  /** After every draw of the panel: what it drew, and the round of the session it drew. */
  drawn(said: ReadonlySet<string>, round: number): void;
  /**
   * What the panel drew before `round`'s conversation first reached it. Asked
   * as the round arrives, before or after the panel draws it — the same answer
   * either way.
   */
  before(round: number): ReadonlySet<string>;
}

/**
 * Words that come with a round are drawn under the round's jump, before the
 * replay opens over them: they were never in front of the reviewer. So the
 * replay is answered from a snapshot taken as the panel's first draw of a
 * newer round begins, not from everything drawn. The page's first draw starts
 * from the stored record alone, so a reload onto a new round also shows what
 * came with it, and a reload inside the round takes what an earlier load
 * drew as read.
 */
export function trackSeenReplies(storage: ReviewMemoryStorage, sessionKey: string): SeenReplies {
  const seen = new Set(readMemory(storage, sessionKey).seen);
  let prior: ReadonlySet<string> = new Set(seen);
  let drawnRound: number | undefined = undefined;
  return {
    drawn(said, round) {
      if (drawnRound === undefined || round > drawnRound) {
        prior = new Set(seen);
        drawnRound = round;
      }
      const fresh = [...said].filter((key) => !seen.has(key));
      if (fresh.length === 0) return;
      for (const key of fresh) seen.add(key);
      // Read again, not taken from this page: another tab's draws are kept.
      const stored = readMemory(storage, sessionKey).seen;
      updateMemory(storage, sessionKey, { seen: [...new Set([...stored, ...fresh])] });
    },
    before(round) {
      return drawnRound === undefined || round > drawnRound ? new Set(seen) : prior;
    },
  };
}
