import type { ReplayData } from "../../rounds/replay.ts";
import type { ReplayOpening } from "./replay-overlay.ts";

/**
 * Handed in so the round-versus-fetch ordering (the part worth testing) lives
 * here and the DOM stays in `main.ts`.
 */
export interface ReplayRefresherHost {
  fetch(): Promise<ReplayData>;
  /**
   * Whether this page claimed the round's one showing as it arrived (and
   * jumped for it): asking spends the claim. Another tab's claim, or a round
   * shown before, is not this page's to open.
   */
  claimed(round: number): boolean;
  open(opening: ReplayOpening): void;
  offer(opening: ReplayOpening | undefined): void;
  /** The round's cards could not be fetched: the reopen stays, and asks again. */
  failed(): void;
}

/** Captured at the moment of asking. */
export interface ReplayRoundView {
  round: number;
  roundReply: string | undefined;
  ended: boolean;
}

export interface ReplayRefresher {
  /** Fetches the replay for `view`'s round; run on load and every re-group. */
  refresh(view: ReplayRoundView): void;
  /** Asked by hand after `failed`: fetches the last round's replay again and opens it. */
  retry(): void;
}

/**
 * Auto-shows once per round, in the page that claimed it. Each call supersedes
 * the last: a slow pre-regroup fetch can neither show the wrong round's cards
 * nor spend the new round's claim. Offer withdrawn on refresh start. A failure
 * never blocks the diff: the page reads on without the replay, and the reopen
 * stays to fetch it again by hand.
 */
export function createReplayRefresher(host: ReplayRefresherHost): ReplayRefresher {
  let generation = 0;
  let last: ReplayRoundView | undefined;
  const ask = (view: ReplayRoundView, byHand: boolean): void => {
    const mine = ++generation;
    last = view;
    host.offer(undefined);
    void host
      .fetch()
      .then((data) => {
        if (mine !== generation) return;
        if (data.comments.length === 0 || view.ended) return;
        const opening: ReplayOpening = { data, roundReply: view.roundReply };
        host.offer(opening);
        // The claim is spent either way: a round opens on its own at most once.
        if (host.claimed(view.round) || byHand) host.open(opening);
      })
      .catch(() => {
        if (mine === generation && !view.ended) host.failed();
      });
  };
  return {
    refresh: (view) => ask(view, false),
    retry: () => {
      if (last !== undefined) ask(last, true);
    },
  };
}
