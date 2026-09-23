import type { ReviewerPlace } from "../round-offer.ts";

export interface ReaderTracker {
  place(): ReviewerPlace;
  setFocus(focus: number | undefined): void;
  setQueued(count: number): void;
}

/**
 * Focus and queue are caught as they happen; scroll is read on demand.
 * Together because they answer one question at one moment: when a round
 * lands, may it take the screen?
 */
export function trackReader(reviewRoot: HTMLElement, focus: number | undefined): ReaderTracker {
  let chapter = focus;
  let queued = 0;
  return {
    place: () => ({ scrolled: reviewRoot.scrollTop, queued, focus: chapter }),
    setFocus: (next) => {
      chapter = next;
    },
    setQueued: (count) => {
      queued = count;
    },
  };
}
