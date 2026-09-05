import type { ReviewerPlace } from "../round-offer.ts";

/** Where the reviewer stands, kept level with them as they move. */
export interface ReaderTracker {
  /** The three facts as they are right now. */
  place(): ReviewerPlace;
  /** They entered a chapter, or came back out of one. */
  setFocus(focus: number | undefined): void;
  /** The unsent queue grew or shrank. */
  setQueued(count: number): void;
}

/**
 * The one place that knows whether the reviewer is mid-something. Focus and
 * queue are caught as they happen; scroll is read on demand. Together because
 * they answer one question at one moment: when a round lands, may it take the
 * screen?
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
