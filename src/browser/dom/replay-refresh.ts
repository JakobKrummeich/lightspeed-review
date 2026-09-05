import type { ReplayData } from "../../rounds/replay.ts";
import type { ReplayOpening } from "./replay-overlay.ts";

/**
 * The page's side, handed in so the round-versus-fetch ordering (the part
 * worth testing) lives here and the DOM stays in `main.ts`.
 */
export interface ReplayRefresherHost {
  fetch(): Promise<ReplayData>;
  /** Whether this browser already auto-showed the replay for that round. */
  wasReplayed(round: number): boolean;
  markReplayed(round: number): void;
  open(opening: ReplayOpening): void;
  /** What the reopen control may show: this round's cards, or nothing. */
  offer(opening: ReplayOpening | undefined): void;
}

/** The round a refresh is asked for, captured at the moment of asking. */
export interface ReplayRoundView {
  round: number;
  roundReply: string | undefined;
  ended: boolean;
}

/**
 * Fetches last round's comment outcomes; auto-shows once per round. Each call
 * supersedes the last: a slow pre-regroup fetch can neither show the wrong
 * round's cards nor burn the new round's turn. Offer withdrawn on refresh
 * start; failures swallowed whole — the replay never blocks the diff.
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
        if (host.wasReplayed(view.round)) return;
        host.markReplayed(view.round);
        host.open(opening);
      })
      .catch(() => {
        // No overlay, no retry: an unreadable replay just opens on the diff.
      });
  };
}
