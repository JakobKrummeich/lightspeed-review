import { createDiff2HtmlRenderer } from "../diff2html-adapter.ts";
import type { ReplayData } from "../../rounds/replay.ts";
import { currentRound } from "../conversation-rounds.ts";
import { readMemory, updateMemory, type ReviewMemoryStorage } from "../review-memory.ts";
import { arrivesByJump } from "../round-arrival.ts";
import { agentRoundReply } from "../round-replay.ts";
import { arrivals, type Arrivals } from "./jump-overlay.ts";
import { createReplayRefresher } from "./replay-refresh.ts";
import {
  mountReplayOverlay,
  type ReplayOpening,
  type ReplayOverlayControl,
} from "./replay-overlay.ts";
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

/** What the wiring reaches outside itself for; a test hands in its own. */
export interface ReplayDeps {
  arrivals(root: HTMLElement): Arrivals;
  fetch(key: string): Promise<ReplayData>;
  storage: ReviewMemoryStorage;
  /** Asks every tab of this browser for `name`: `lost` runs in each but the first. */
  contend(name: string, lost: () => void): void;
  overlay(page: ReplayHosts): ReplayOverlayControl;
}

/**
 * Long enough for a claim written to `localStorage` to reach every other tab:
 * a tab learning of the round after this reads it taken instead.
 */
const CLAIM_HELD_MS = 5000;

/**
 * `localStorage` is not shared at once between tabs: two that learn of a round
 * in the same instant both read it free. A Web Lock is — the first tab to ask
 * holds it, the others hear they lost within a millisecond or so, before the
 * room is painted. A browser without locks keeps the claim as read.
 */
function firstTab(name: string, lost: () => void): void {
  if (!("locks" in navigator)) return;
  navigator.locks
    .request(name, { ifAvailable: true }, (lock) => {
      if (lock === null) return lost();
      return new Promise((held) => setTimeout(held, CLAIM_HELD_MS));
    })
    .catch(() => undefined);
}

/** Closing the replay lands at the top of the diff, where a new round starts anyway. */
function mountOverlay(page: ReplayHosts): ReplayOverlayControl {
  return mountReplayOverlay({
    root: page.replayRoot,
    renderer: createDiff2HtmlRenderer(),
    onClose: () => {
      page.reviewRoot.scrollTop = 0;
    },
  });
}

/** The page's own: read when wired, so a test never touches the browser's. */
function browserDeps(): ReplayDeps {
  return {
    arrivals: (root) => arrivals(root, stillness),
    fetch: fetchReplay,
    storage: localStorage,
    contend: firstTab,
    overlay: mountOverlay,
  };
}

export function wireReplay(
  page: ReplayHosts,
  live: LiveSession,
  deps: ReplayDeps = browserDeps(),
): WiredReplay {
  const replayOverlay = deps.overlay(page);
  let replay: ReplayOpening | undefined;
  const arrival = deps.arrivals(page.openingRoot);
  /** The round this page claimed the showing of, until the showing spends it. */
  let claim: number | undefined = undefined;
  page.replayReopen.addEventListener("click", () => {
    // Manual reopen ignores the once-per-round memory on purpose. Not mid-jump:
    // the landing opens the replay itself, and would reset one opened now.
    if (replay !== undefined && !arrival.jumping()) replayOverlay.open(replay);
  });
  // Ordering (which round a response belongs to, what failed fetches leave)
  // lives in the refresher.
  const replayRefresh = createReplayRefresher({
    fetch: () => deps.fetch(page.key),
    claimed: (round) => {
      if (claim !== round) return false;
      claim = undefined;
      return true;
    },
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
      if (!arrivesByJump(fresh, readMemory(deps.storage, page.key).replayed)) return;
      // Claimed now, not when the cards come back: another tab on this review
      // reads it taken and neither jumps nor opens, and a fetch that fails
      // leaves it spent, so a reload does not jump to nothing again.
      const round = currentRound(fresh.rounds);
      claim = round;
      updateMemory(deps.storage, page.key, { replayed: round });
      arrival.jump();
      deps.contend(`lightspeed-replay:${page.key}:${round}`, () => {
        if (claim !== round) return;
        claim = undefined;
        arrival.abort();
      });
    },
    refreshReplay: (fresh) =>
      replayRefresh({
        round: live.round,
        roundReply: agentRoundReply(fresh.conversation, fresh.rounds),
        ended: fresh.status === "ended",
      }),
  };
}
