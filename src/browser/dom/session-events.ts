import { agentSpokeAgain } from "../panel-collapse.ts";
import { currentRound } from "../conversation-rounds.ts";
import { holdsRound, type ReviewerPlace } from "../round-offer.ts";
import { readPresence } from "../agent-presence.ts";
import { renderIntent, showIntentFor } from "../intent-view.ts";
import { mountRoundOffer } from "./round-offer-mount.ts";
import { mountRoundPopup } from "./round-popup.ts";
import { fetchSession, type SessionData } from "./session-api.ts";
import type { MountedDiff } from "./diff-mount.ts";
import type { MountedPanel } from "./panel-mount.ts";
import type { MountedRail } from "./panel-rail.ts";
import type { MountedStatusBanner } from "./status-mount.ts";

/**
 * Landmarks a session event writes into. A subset of the page: taking the
 * whole `Page` would make this module and the hub import each other.
 */
export interface RoundHosts {
  key: string;
  reviewRoot: HTMLElement;
  intentRoot: HTMLElement;
  replayReopen: HTMLElement;
  roundOffer: HTMLElement;
  roundPopup: HTMLElement;
}

/** The round on screen and the talk so far, as the hub holds them. */
export interface LiveSession {
  round: number;
  conversation: SessionData["conversation"];
}

/** Everything a session event may have to move, and who to ask before it does. */
export interface Wired {
  page: RoundHosts;
  live: LiveSession;
  diff: MountedDiff;
  panel: MountedPanel;
  banner: MountedStatusBanner;
  railControl: MountedRail;
  refreshReplay(fresh: SessionData): void;
  /** Where the reviewer stands in the round on screen, asked at the moment. */
  place(): ReviewerPlace;
}

/**
 * A session event is either a re-group (replaces the view) or news inside the
 * round (reply, review ended). The round number tells them apart; only the
 * first may take the reviewer's place, and only with their say-so.
 */
export function wireSessionEvents(wired: Wired): void {
  const { page, live, panel, banner } = wired;
  const events = new EventSource(`/api/session/${page.key}/events`);
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
  events.addEventListener("session", () => {
    void fetchSession(page.key).then((fresh) => {
      if (waits(wired, fresh)) {
        offer.offer(fresh);
        popup.offer(fresh);
        return;
      }
      // Whatever was offered is on screen now, or older than what is.
      offer.clear();
      popup.clear();
      applyRound(wired, fresh);
    });
  });
  // The reviewer's feedback as the server wrote it: replaces the sending
  // tab's echo and reaches every other tab. Deliberately touches nothing
  // else — diff, replay and place are about the round, which has not changed.
  events.addEventListener("feedback", () => {
    void fetchSession(page.key).then((fresh) => {
      panel.update(fresh);
      banner.setSession(fresh);
      // Kept level with the panel's copy: the next arrival is compared against
      // this, and skipping it would judge fresh talk against older talk.
      live.conversation = fresh.conversation;
    });
  });
  // Both ends hear it: the header states presence in words, the panel shows
  // the working half where the eye is after Send.
  events.addEventListener("presence", (event: MessageEvent<string>) => {
    const presence = readPresence(event.data);
    banner.setPresence(presence);
    panel.setWorking(presence.working);
  });
}

/**
 * Whether this round must wait for the reviewer. Only over a live review: an
 * ended one is the review stopping, and holding that back would leave the
 * reviewer typing into a closed page.
 */
function waits(wired: Wired, fresh: SessionData): boolean {
  if (currentRound(fresh.rounds) === wired.live.round) return false;
  if (fresh.status === "ended") return false;
  return holdsRound(wired.place());
}

/**
 * Puts the round on screen. Reached from the event itself when the reviewer
 * has nothing to lose, from the offer when they do.
 */
function applyRound(wired: Wired, fresh: SessionData): void {
  const { page, live, diff, panel, banner, railControl } = wired;
  // A new round may be about something else than the last one.
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
  if (agentSpokeAgain(live.conversation, fresh.conversation)) railControl.expand();
  live.conversation = fresh.conversation;
}

/**
 * What taking a round does to the reviewer's place: replay, top of the re-cut
 * diff, intent block back beside the survey. The old offset pointed into a
 * diff that no longer exists; within one round the page has no business
 * moving anyone — true of a waiting round too, until taken.
 */
function openRound(wired: Wired, fresh: SessionData): void {
  wired.refreshReplay(fresh);
  wired.page.reviewRoot.scrollTop = 0;
  // `forgetRound` drops focus without reporting it; nothing else would say
  // the chapter the block was hidden for is gone.
  showIntentFor(wired.page.intentRoot, undefined);
}
