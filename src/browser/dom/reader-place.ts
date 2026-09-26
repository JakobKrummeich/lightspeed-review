import type { ReviewerPlace } from "../round-offer.ts";
import { NOTHING_QUEUED, type QueueTally } from "../queued-pill.ts";

export interface ReaderTracker {
  place(): ReviewerPlace;
  setFocus(focus: number | undefined): void;
  setQueued(queued: QueueTally): void;
}

/**
 * Focus and queue are caught as they happen; scroll is read on demand.
 * Together because they answer one question at one moment: when a round
 * lands, may it take the screen?
 */
export function trackReader(reviewRoot: HTMLElement, focus: number | undefined): ReaderTracker {
  let chapter = focus;
  let queued = NOTHING_QUEUED;
  return {
    place: () => ({ scrolled: reviewRoot.scrollTop, queued, focus: chapter }),
    setFocus: (next) => {
      chapter = next;
    },
    setQueued: (next) => {
      queued = next;
    },
  };
}
