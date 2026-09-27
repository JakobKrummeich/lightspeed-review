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
}

/** Captured at the moment of asking. */
export interface ReplayRoundView {
  round: number;
  roundReply: string | undefined;
  ended: boolean;
}

/**
 * Auto-shows once per round, in the page that claimed it. Each call supersedes
 * the last: a slow pre-regroup fetch can neither show the wrong round's cards
 * nor spend the new round's claim. Offer withdrawn on refresh start; failures swallowed whole — the
 * replay never blocks the diff.
 */
export function createReplayRefresher(host: ReplayRefresherHost): (view: ReplayRoundView) => void {
  let generation = 0;
  return (view) => {
    const mine = ++generation;
    host.offer(undefined);
    void host
      .fetch()
      .then((data) => {
        if (mine !== generation) return;
        if (data.comments.length === 0 || view.ended) return;
        const opening: ReplayOpening = { data, roundReply: view.roundReply };
        host.offer(opening);
        if (host.claimed(view.round)) host.open(opening);
      })
      .catch(() => {
        // No overlay, no retry: an unreadable replay just opens on the diff.
      });
  };
}
