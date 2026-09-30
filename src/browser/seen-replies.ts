/**
 * Which of the agent's messages the reviewer was shown, kept in the review's
 * memory so a reload still knows — what the round replay leaves out. Shown is
 * drawn by the conversation panel while the tab is on screen and the panel
 * open (`shown`, asked by the panel's light); scrolled out of sight or on a
 * folded card still counts, the words were in front of the reviewer. Keys are
 * `saidKey`s (`message-news.ts`).
 */
import { saidAt } from "./message-news.ts";
import {
  readMemory,
  SEEN_REPLY_LIMIT,
  updateMemory,
  type ReviewMemoryStorage,
} from "./review-memory.ts";

export interface SeenReplies {
  /** After every draw of the panel: what it drew, and the round of the session it drew. */
  drawn(said: ReadonlySet<string>, round: number): void;
  /** The last draw is in front of the reviewer: what it holds is seen. */
  shown(): void;
  /**
   * What was shown before `round`'s conversation first reached the panel.
   * Asked as the round arrives, before or after the panel draws it — the
   * same answer either way.
   */
  before(round: number): ReadonlySet<string>;
}

/**
 * Words that come with a round are drawn under the round's jump, before the
 * replay opens over them: they were never in front of the reviewer. So the
 * replay is answered from a snapshot taken the first time a newer round is
 * named — asked for, or drawn — not from everything shown since: a panel
 * opened as the round lands shows the old words then, and must not move the
 * answer already given. The page's first draw starts from the stored record
 * alone, so a reload onto a new round also shows what came with it, and a
 * reload inside the round takes what an earlier load showed as read.
 */
export function trackSeenReplies(storage: ReviewMemoryStorage, sessionKey: string): SeenReplies {
  const seen = new Set(readMemory(storage, sessionKey).seen);
  let prior: ReadonlySet<string> = new Set(seen);
  let namedRound: number | undefined = undefined;
  let onScreen: ReadonlySet<string> = new Set();
  const reach = (round: number): void => {
    if (namedRound !== undefined && round <= namedRound) return;
    prior = new Set(seen);
    namedRound = round;
  };
  return {
    drawn(said, round) {
      reach(round);
      onScreen = said;
    },
    shown() {
      const fresh = [...onScreen].filter((key) => !seen.has(key));
      if (fresh.length === 0) return;
      for (const key of fresh) seen.add(key);
      // Read again, not taken from this page: another tab's are kept.
      const stored = readMemory(storage, sessionKey).seen;
      const kept = newestSaid([...stored, ...fresh]);
      // Nothing newer than what is kept — words the cap let go, shown again
      // by a reload — changes nothing, so writes nothing.
      if (kept.length === stored.length && kept.every((key, index) => key === stored[index])) {
        return;
      }
      updateMemory(storage, sessionKey, { seen: kept });
    },
    before(round) {
      reach(round);
      return prior;
    },
  };
}

/**
 * The newest `SEEN_REPLY_LIMIT` by when they were said, oldest first — the
 * order the review's memory trims from. The panel draws by group, not time,
 * so the order they were shown in says nothing of their age. Ties go by key,
 * so the same words always keep the same order.
 */
function newestSaid(keys: readonly string[]): string[] {
  const byAge = (one: string, other: string): number =>
    codeOrder(saidAt(one), saidAt(other)) || codeOrder(one, other);
  return [...new Set(keys)].sort(byAge).slice(-SEEN_REPLY_LIMIT);
}

/** Code-unit order, as ISO stamps sort by time; no locale may reorder them. */
function codeOrder(one: string, other: string): number {
  if (one === other) return 0;
  return one < other ? -1 : 1;
}
