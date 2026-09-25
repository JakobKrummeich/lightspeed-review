import { agentSpokeAgain } from "../panel-collapse.ts";
import { currentRound } from "../conversation-rounds.ts";
import { holdsRound, type ReviewerPlace } from "../round-offer.ts";
import { readPresence } from "../agent-presence.ts";
import { renderIntent, showIntentFor } from "../intent-view.ts";
import { mountRoundOffer } from "./round-offer-mount.ts";
import { mountRoundPopup } from "./round-popup.ts";
import { fetchSession, type SessionData } from "./session-api.ts";
import {
  createSyncAsks,
  drawnAfterFeedback,
  isNews,
  nextReopenDelay,
  REOPEN_MS,
  type SyncCause,
} from "./session-sync.ts";
import type { MountedDiff } from "./diff-mount.ts";
import type { MountedPanel } from "./panel-mount.ts";
import type { MountedRail } from "./panel-rail.ts";
import type { MountedStatusBanner } from "./status-mount.ts";

/**
 * A subset of the page: taking the whole `Page` would make this module and
 * the hub import each other.
 */
export interface RoundHosts {
  key: string;
  reviewRoot: HTMLElement;
  intentRoot: HTMLElement;
  replayReopen: HTMLElement;
  roundOffer: HTMLElement;
  roundPopup: HTMLElement;
  /** The "connection lost, reconnecting" chip: shown while the stream is down. */
  connection: HTMLElement;
}

export interface LiveSession {
  round: number;
  /**
   * The session as last drawn: the next arrival's talk is judged against it,
   * and a reopened stream's answer is drawn only past it (`isNews`).
   */
  drawn: SessionData;
}

export interface Wired {
  page: RoundHosts;
  live: LiveSession;
  diff: MountedDiff;
  panel: MountedPanel;
  banner: MountedStatusBanner;
  railControl: MountedRail;
  finish: TurnAware;
  refreshReplay(fresh: SessionData): void;
  place(): ReviewerPlace;
}

export interface TurnAware {
  setTurn(turn: SessionData["turn"]): void;
}

/**
 * A session event is either a re-group (replaces the view) or news inside the
 * round (reply, review ended). The round number tells them apart; only the
 * first may take the reviewer's place, and only with their say-so.
 */
export function wireSessionEvents(wired: Wired): void {
  const { page, live } = wired;
  // Two mouths, one message: the offer stands for the whole wait, the popup
  // announces its start. Taking from either clears both; dismissing the popup
  // sets the offer beckoning — the page's one remaining word must be findable.
  const offer = mountRoundOffer({
    root: page.roundOffer,
    onTake: (taken) => {
      popup.clear();
      applyRound(wired, taken);
    },
  });
  const popup = mountRoundPopup({
    root: page.roundPopup,
    onTake: (taken) => {
      offer.clear();
      applyRound(wired, taken);
    },
    onDismissed: () => offer.beckon(),
  });
  // A reopen's fetch and an event's fetch can answer out of order; `land`
  // drops the one that would put older state back.
  const asks = createSyncAsks();
  const syncSession = (cause: SyncCause): void => {
    const ask = asks.send(cause);
    fetchSession(page.key)
      .then((fresh) => {
        const landed = asks.land(ask);
        if (landed === undefined || !isNews(landed, fresh, live.drawn)) return;
        if (waits(wired, fresh)) {
          // Asked at the moment, not remembered: the queue is whatever it is when
          // the round lands, and both mouths must name the same number.
          const queued = wired.place().queued;
          offer.offer(fresh, queued);
          popup.offer(fresh, queued);
          return;
        }
        // Whatever was offered is on screen now, or older than what is.
        offer.clear();
        popup.clear();
        applyRound(wired, fresh);
      })
      .catch(() => console.error("lightspeed: the session could not be refreshed"));
  };
  openStream(wired, syncSession, { delay: REOPEN_MS });
}

/**
 * One stream and its listeners. Called again only for a stream the browser
 * closed for good; a dropped one the browser reopens by itself.
 */
function openStream(
  wired: Wired,
  syncSession: (cause: SyncCause) => void,
  reopen: { delay: number },
): void {
  const { page, live, panel, banner } = wired;
  const events = new EventSource(`/api/session/${page.key}/events`);
  // The server keeps no backlog (streams.ts is an in-memory map): an `open`
  // right after `stop` publishes its round before this tab has reconnected,
  // and a round can land between the page's `/data` load and its first
  // subscribe. So every open, the first included, asks for the session;
  // `isNews` makes that free when nothing moved. The turn is not this
  // path's business: the presence frame written on subscribe carries it,
  // and `applyRound` never touches it.
  events.addEventListener("open", () => {
    page.connection.hidden = true;
    reopen.delay = REOPEN_MS;
    syncSession("opened");
  });
  events.addEventListener("session", () => syncSession("announced"));
  // The reviewer's feedback as the server wrote it: replaces the sending
  // tab's echo and reaches every other tab. Deliberately touches nothing
  // else — diff, replay and place are about the round, which has not changed.
  events.addEventListener("feedback", () => {
    fetchSession(page.key)
      .then((fresh) => {
        panel.update(fresh);
        banner.setSession(fresh);
        // Kept level with the panel's copy: the next arrival is compared against
        // this, and skipping it would judge fresh talk against older talk. Only
        // what the panel and banner show counts as drawn, never the round.
        live.drawn = drawnAfterFeedback(live.drawn, fresh);
      })
      .catch(() => console.error("lightspeed: the conversation could not be refreshed"));
  });
  // Everything that speaks for the turn hears it at once: the finish card
  // promises to carry the queue only when the queue can still go anywhere.
  events.addEventListener("presence", (event: MessageEvent<string>) => {
    const presence = readPresence(event.data);
    banner.setPresence(presence);
    panel.setTurn(presence.turn, presence.items);
    wired.finish.setTurn(presence.turn);
  });
  // A dropped stream reconnects by itself; a refused one never does. The
  // wait doubles while the server keeps refusing, and resets on an open.
  // Said whichever way it dropped: a page that goes quiet with no word reads
  // as an agent that has nothing to say.
  events.addEventListener("error", () => {
    page.connection.hidden = false;
    if (events.readyState !== EventSource.CLOSED) return;
    setTimeout(() => openStream(wired, syncSession, reopen), reopen.delay);
    reopen.delay = nextReopenDelay(reopen.delay);
  });
}

/**
 * Only over a live review: an ended one is the review stopping, and holding
 * that back would leave the reviewer typing into a closed page.
 */
function waits(wired: Wired, fresh: SessionData): boolean {
  if (currentRound(fresh.rounds) === wired.live.round) return false;
  if (fresh.status === "ended") return false;
  return holdsRound(wired.place());
}

function applyRound(wired: Wired, fresh: SessionData): void {
  const { page, live, diff, panel, banner, railControl } = wired;
  page.intentRoot.innerHTML = renderIntent(fresh);
  // Stamped before the redraw: the redraw reports this round's opening folds,
  // which must not be written under the old round's number.
  const next = currentRound(fresh.rounds);
  const change = next === live.round ? "same-round" : "regrouped";
  live.round = next;
  diff.update(fresh, change);
  // The replay is about a new round; inside a round only the review ending
  // changes its standing (takes the reopen control away).
  if (change === "regrouped") openRound(wired, fresh);
  else if (fresh.status === "ended") page.replayReopen.hidden = true;
  panel.update(fresh);
  // Whole session, not status alone: an ended review is summed over the page,
  // last send included.
  banner.setSession(fresh);
  // An answer the reviewer never sees costs more than the width.
  if (agentSpokeAgain(live.drawn.conversation, fresh.conversation)) railControl.expand();
  live.drawn = fresh;
}

/**
 * The old offset pointed into a diff that no longer exists; within one round
 * the page has no business moving anyone — true of a waiting round too, until
 * taken.
 */
function openRound(wired: Wired, fresh: SessionData): void {
  wired.refreshReplay(fresh);
  wired.page.reviewRoot.scrollTop = 0;
  // `forgetRound` drops focus without reporting it; nothing else would say
  // the chapter the block was hidden for is gone.
  showIntentFor(wired.page.intentRoot, undefined);
}
