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

/** Whether the tab is on screen, and word when that changes: the document's. */
export interface PageVisibility {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** What the wiring reaches outside itself for; a test hands in its own. */
export interface ReplayDeps {
  arrivals(root: HTMLElement): Arrivals;
  fetch(key: string): Promise<ReplayData>;
  storage: ReviewMemoryStorage;
  visibility: PageVisibility;
  overlay(page: ReplayHosts): ReplayOverlayControl;
}

/** Runs `back` once, the next time the tab comes on screen; the returned call stops waiting. */
function onReturn(page: PageVisibility, back: () => void): () => void {
  const changed = (): void => {
    if (page.visibilityState === "hidden") return;
    page.removeEventListener("visibilitychange", changed);
    back();
  };
  page.addEventListener("visibilitychange", changed);
  return () => page.removeEventListener("visibilitychange", changed);
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
    visibility: document,
    overlay: mountOverlay,
  };
}

/**
 * This page's claim on a round's one showing: written where every tab of the
 * review reads it, and held here until the showing spends it.
 */
function roundClaims(storage: ReviewMemoryStorage, key: string) {
  let claim: number | undefined = undefined;
  return {
    replayed: (): number | undefined => readMemory(storage, key).replayed,
    take(round: number): void {
      claim = round;
      updateMemory(storage, key, { replayed: round });
    },
    spend(round: number): boolean {
      if (claim !== round) return false;
      claim = undefined;
      return true;
    },
  };
}

export function wireReplay(
  page: ReplayHosts,
  live: LiveSession,
  deps: ReplayDeps = browserDeps(),
): WiredReplay {
  const replayOverlay = deps.overlay(page);
  let replay: ReplayOpening | undefined;
  /** The round's cards could not be fetched: the reopen asks for them again. */
  let unread = false;
  const arrival = deps.arrivals(page.openingRoot);
  const claims = roundClaims(deps.storage, page.key);
  /** Waiting for a hidden tab to come back to a round it left unclaimed. */
  let stopWaiting: (() => void) | undefined = undefined;
  // Opened as the arrival's jump lands, or at once when there was none.
  const show = (opening: ReplayOpening): void =>
    arrival.onLanding(() => replayOverlay.open(opening));
  // Back on screen: the round is this tab's if no tab took it meanwhile. No
  // jump — the round was drawn while nobody watched, there is no swap to cover.
  const cameBack = (round: number): void => {
    stopWaiting = undefined;
    if (claims.replayed() === round || live.drawn.status === "ended") return;
    claims.take(round);
    // Cards still coming: the refresher opens them when they do.
    if (replay !== undefined && claims.spend(round)) show(replay);
  };
  page.replayReopen.addEventListener("click", () => {
    // Manual reopen ignores the once-per-round memory on purpose. Not mid-jump:
    // the landing opens the replay itself, and would reset one opened now.
    if (arrival.jumping()) return;
    if (replay !== undefined) replayOverlay.open(replay);
    else if (unread) replayRefresh.retry();
  });
  // Ordering (which round a response belongs to, what failed fetches leave)
  // lives in the refresher.
  const replayRefresh = createReplayRefresher({
    fetch: () => deps.fetch(page.key),
    claimed: claims.spend,
    open: show,
    offer: (opening) => {
      replay = opening;
      unread = false;
      page.replayReopen.hidden = opening === undefined;
    },
    failed: () => {
      unread = true;
      page.replayReopen.hidden = false;
    },
  });
  return {
    arriving: (fresh) => {
      // An older round's replay, queued for a landing or a return, is not this round's.
      arrival.forget();
      stopWaiting?.();
      stopWaiting = undefined;
      if (!arrivesByJump(fresh, claims.replayed())) return;
      const round = currentRound(fresh.rounds);
      // A background tab leaves the showing to a tab on screen, until it is one.
      if (deps.visibility.visibilityState === "hidden") {
        stopWaiting = onReturn(deps.visibility, () => cameBack(round));
        return;
      }
      // Claimed now, not when the cards come back: another tab on this review
      // reads it taken and neither jumps nor opens, and a fetch that fails
      // leaves it spent, so a reload does not jump to nothing again.
      claims.take(round);
      arrival.jump();
    },
    refreshReplay: (fresh) =>
      replayRefresh.refresh({
        round: live.round,
        roundReply: agentRoundReply(fresh.conversation, fresh.rounds),
        ended: fresh.status === "ended",
      }),
  };
}
