import { createDiff2HtmlRenderer } from "../diff2html-adapter.ts";
import { readMemory, updateMemory } from "../review-memory.ts";
import { arrivesByJump } from "../round-arrival.ts";
import { agentRoundReply } from "../round-replay.ts";
import { arrivals } from "./jump-overlay.ts";
import { createReplayRefresher } from "./replay-refresh.ts";
import { mountReplayOverlay, type ReplayOpening } from "./replay-overlay.ts";
import { fetchReplay, type SessionData } from "./session-api.ts";
import type { LiveSession } from "./session-events.ts";
import { stillness } from "./stillness.ts";

/** The part of the page the replay and the round jump live in. */
export interface ReplayHosts {
  key: string;
  reviewRoot: HTMLElement;
  replayRoot: HTMLElement;
  replayReopen: HTMLElement;
  openingRoot: HTMLElement;
}

export interface WiredReplay {
  /**
   * A round is about to be drawn: when the replay will open on its own for it,
   * the jump starts now, so the page swaps under the room rather than before it.
   */
  arriving(fresh: SessionData): void;
  /** Fetches the replay for the round now drawn; run on load and every re-group. */
  refreshReplay(fresh: SessionData): void;
}

/** Closing the replay lands at the top of the diff, where a new round starts anyway. */
export function wireReplay(page: ReplayHosts, live: LiveSession): WiredReplay {
  const replayOverlay = mountReplayOverlay({
    root: page.replayRoot,
    renderer: createDiff2HtmlRenderer(),
    onClose: () => {
      page.reviewRoot.scrollTop = 0;
    },
  });
  let replay: ReplayOpening | undefined;
  const arrival = arrivals(page.openingRoot, stillness);
  const replayed = (): number | undefined => readMemory(localStorage, page.key).replayed;
  page.replayReopen.addEventListener("click", () => {
    // Manual reopen ignores the once-per-round memory on purpose. Not mid-jump:
    // the landing opens the replay itself, and would reset one opened now.
    if (replay !== undefined && !arrival.jumping()) replayOverlay.open(replay);
  });
  // Ordering (which round a response belongs to, what failed fetches leave)
  // lives in the refresher.
  const replayRefresh = createReplayRefresher({
    fetch: () => fetchReplay(page.key),
    wasReplayed: (shown) => replayed() === shown,
    markReplayed: (shown) => updateMemory(localStorage, page.key, { replayed: shown }),
    // Opened as the arrival's jump lands, or at once when there was none. A
    // manual reopen is not an arrival, so it opens straight away.
    open: (opening) => arrival.onLanding(() => replayOverlay.open(opening)),
    offer: (opening) => {
      replay = opening;
      page.replayReopen.hidden = opening === undefined;
    },
  });
  return {
    arriving: (fresh) => {
      // An older round's replay, queued for a landing, is not this round's.
      arrival.forget();
      if (arrivesByJump(fresh, replayed())) arrival.jump();
    },
    refreshReplay: (fresh) =>
      replayRefresh({
        round: live.round,
        roundReply: agentRoundReply(fresh.conversation, fresh.rounds),
        ended: fresh.status === "ended",
      }),
  };
}
