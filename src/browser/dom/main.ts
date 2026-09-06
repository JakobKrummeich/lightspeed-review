import "diff2html/bundles/css/diff2html.min.css";
import "../chrome.css";
import { DARK_SCHEME_QUERY } from "../color-scheme.ts";
import { currentRound } from "../conversation-rounds.ts";
import { clampFocus } from "../focus-mode.ts";
import { showIntentFor } from "../intent-view.ts";
import { opensFor } from "../opening-view.ts";
import { readMemory, reviewPlace, updateMemory, type ReviewPlace } from "../review-memory.ts";
import { agentRoundReply } from "../round-replay.ts";
import { effectiveFormat, readViewFormat, roomQuery } from "../view-format.ts";
import { saveLater } from "./save-later.ts";
import { mountAnnotationPopup } from "./annotation-popup.ts";
import { lockSelectionToColumn } from "./column-lock.ts";
import { createDiff2HtmlRenderer } from "../diff2html-adapter.ts";
import { mountDiffView } from "./diff-mount.ts";
import { wireFinish } from "./finish.ts";
import { wireIntent } from "./intent-mount.ts";
import { mountOpening } from "./opening-overlay.ts";
import { mountPanel, type MountedPanel } from "./panel-mount.ts";
import type { LinePlace } from "./line-numbers.ts";
import { createReplayRefresher } from "./replay-refresh.ts";
import { mountReplayOverlay, type ReplayOpening } from "./replay-overlay.ts";
import { mountPanelRail, type MountedRail } from "./panel-rail.ts";
import { mountSchemeToggle } from "./scheme-toggle.ts";
import { fetchReplay, fetchSession, type SessionData } from "./session-api.ts";
import { mountStatusBanner, type MountedStatusBanner } from "./status-mount.ts";
import { trackReader } from "./reader-place.ts";
import { wireSessionEvents, type LiveSession } from "./session-events.ts";
import { mountViewToggle } from "./view-toggle.ts";

/** The page the server rendered, or nothing when this is not that page. */
interface Page {
  key: string;
  /** The one scroll container: the intent and the groups move through it. */
  reviewRoot: HTMLElement;
  intentRoot: HTMLElement;
  diffRoot: HTMLElement;
  panelRoot: HTMLElement;
  viewSwitch: HTMLElement;
  schemeSwitch: HTMLElement;
  progress: HTMLElement;
  rail: HTMLElement;
  openingRoot: HTMLElement;
  replayRoot: HTMLElement;
  replayReopen: HTMLElement;
  /** Where a round that arrived mid-read waits until the reviewer takes it. */
  roundOffer: HTMLElement;
  /** Where that round's arrival is announced, once, over the review. */
  roundPopup: HTMLElement;
  /** Where the last tick is answered, over the review, with the press it calls for. */
  donePopup: HTMLElement;
}

/**
 * All template landmarks: either all exist (the server-rendered page) or this
 * script is running somewhere else and does nothing.
 */
function readPage(): Page | undefined {
  try {
    return {
      key: present(document.body.dataset.sessionKey),
      reviewRoot: present(document.querySelector<HTMLElement>("#lsr-review")),
      intentRoot: present(document.querySelector<HTMLElement>("#lsr-intent")),
      diffRoot: present(document.querySelector<HTMLElement>("#lsr-diff")),
      panelRoot: present(document.querySelector<HTMLElement>("#lsr-panel")),
      viewSwitch: present(document.querySelector<HTMLElement>("#lsr-view-switch")),
      schemeSwitch: present(document.querySelector<HTMLElement>("#lsr-scheme-switch")),
      progress: present(document.querySelector<HTMLElement>("#lsr-progress")),
      rail: present(document.querySelector<HTMLElement>("#lsr-panel-rail")),
      openingRoot: present(document.querySelector<HTMLElement>("#lsr-opening")),
      replayRoot: present(document.querySelector<HTMLElement>("#lsr-replay")),
      replayReopen: present(document.querySelector<HTMLElement>("#lsr-replay-reopen")),
      roundOffer: present(document.querySelector<HTMLElement>("#lsr-round-offer")),
      roundPopup: present(document.querySelector<HTMLElement>("#lsr-round-popup")),
      donePopup: present(document.querySelector<HTMLElement>("#lsr-done-popup")),
    };
  } catch {
    return undefined;
  }
}

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing page element");
  return value;
}

async function main(): Promise<void> {
  const page = readPage();
  if (!page) return;

  // Before the diff fetch: the reviewer's scheme must not arrive late.
  mountScheme(page.schemeSwitch);

  const session = await fetchSession(page.key);
  const room = roomWatch();
  const format = effectiveFormat(readViewFormat(localStorage, page.key), room.hasRoom());
  const { live, place, focus } = openedOn(page, session);
  showIntentFor(page.intentRoot, focus);
  wireIntent(page.intentRoot);
  // All reviewer-position state goes through this: a round arriving mid-read
  // asks it before taking the page.
  const reader = trackReader(page.reviewRoot, focus);
  const finish = wireFinish(page.donePopup);
  const diff = mountDiffView({
    root: page.diffRoot,
    progress: page.progress,
    key: page.key,
    session,
    format,
    open: place && { groups: place.groups, files: place.files },
    focus: place?.focus,
    onFocus: (chapter) => {
      // Held as well as stored: being inside a chapter is half of whether an
      // arriving round may take the page.
      reader.setFocus(chapter);
      focusMoved(page, live, chapter);
    },
    onOpen: (open) => updateMemory(localStorage, page.key, { round: live.round, ...open }),
    onApproved: finish.onApproved,
  });
  const view = mountViewToggle({
    root: page.viewSwitch,
    sessionKey: page.key,
    storage: localStorage,
    hasRoom: room.hasRoom,
    onFormat: (next) => diff.setFormat(next),
  });
  room.onChange(() => view.refresh());

  rememberScrollPlace(page, live, place);

  // A comment's file-name press lands back on its lines: the diff owns the jump.
  const side = mountPanelSide(
    page,
    session,
    (count) => {
      finish.setQueued(count);
      reader.setQueued(count);
    },
    () => {
      room.toggle();
      view.refresh();
    },
    (file, anchor) => diff.reveal(file, anchor),
  );
  finish.attach(side);
  const { panel } = side;
  // Queueing leaves a shut panel shut: the popup already showed the words,
  // and the rail counts them.
  mountAnnotationPopup({ diffRoot: page.diffRoot, onQueue: (prompts) => panel.queue(prompts) });
  lockSelectionToColumn(page.diffRoot);

  const refreshReplay = wireOverlays(page, live, session);

  // `reader.place`, not a flag: where the reviewer stands is only answerable
  // at the moment a round lands.
  wireSessionEvents({ page, live, diff, ...side, refreshReplay, place: reader.place });
}

/**
 * What the page opens on: round, remembered place, chapter. A place is only
 * handed back to the round it was read in — see `review-memory.ts`.
 */
function openedOn(
  page: Page,
  session: SessionData,
): { live: LiveSession; place: ReviewPlace | undefined; focus: number | undefined } {
  const live: LiveSession = {
    round: currentRound(session.rounds),
    conversation: session.conversation,
  };
  const place = reviewPlace(readMemory(localStorage, page.key), live.round);
  // Clamped to what the diff will draw: a chapter a shorter grouping lost
  // opens as the survey, and `onFocus` is never called for the opening state.
  return { live, place, focus: clampFocus(place?.focus, session.groups.length) };
}

/**
 * On chapter enter/leave: store the place for reload, and toggle the intent
 * block — it belongs beside the survey, dead space beside a diff.
 */
function focusMoved(page: Page, live: LiveSession, focus: number | undefined): void {
  updateMemory(localStorage, page.key, { round: live.round, focus });
  showIntentFor(page.intentRoot, focus);
}

/**
 * One media query per panel state (shut leaves 352px more room). Collapsed
 * state held in here so the page cannot ask against the wrong panel.
 */
function roomWatch(): {
  hasRoom(): boolean;
  /** The reviewer folded the panel away, or brought it back. */
  toggle(): void;
  onChange(refresh: () => void): void;
} {
  const room = {
    open: window.matchMedia(roomQuery(false)),
    shut: window.matchMedia(roomQuery(true)),
  };
  let collapsed = false;
  return {
    hasRoom: () => (collapsed ? room.shut : room.open).matches,
    toggle: () => {
      collapsed = !collapsed;
    },
    onChange: (refresh) => {
      room.open.addEventListener("change", refresh);
      room.shut.addEventListener("change", refresh);
    },
  };
}

function mountScheme(schemeSwitch: HTMLElement): void {
  mountSchemeToggle({
    root: schemeSwitch,
    target: document.documentElement,
    storage: localStorage,
    prefersDark: window.matchMedia(DARK_SCHEME_QUERY),
  });
}

/**
 * Restores the scroll offset, then keeps it stored. After the first draw, so
 * the review is at full height: restoring against a folded page lands at the end.
 */
function rememberScrollPlace(page: Page, live: LiveSession, place: ReviewPlace | undefined): void {
  if (place) page.reviewRoot.scrollTop = place.scroll;
  // Scrolling is a burst: stored once settled — except on pagehide, when the
  // wait would lose the place.
  const rememberScroll = saveLater(() =>
    updateMemory(localStorage, page.key, { round: live.round, scroll: page.reviewRoot.scrollTop }),
  );
  page.reviewRoot.addEventListener("scroll", () => rememberScroll.soon());
  window.addEventListener("pagehide", () => rememberScroll.now());
}

/** The panel column: the status banner, the rail beside the panel, the panel itself. */
function mountPanelSide(
  page: Page,
  session: SessionData,
  onQueued: (count: number) => void,
  onToggle: () => void,
  onJump: (file: string, place: LinePlace | undefined) => void,
): { banner: MountedStatusBanner; railControl: MountedRail; panel: MountedPanel } {
  const banner = mountStatusBanner(session);
  const railControl = mountPanelRail({
    rail: page.rail,
    page: document.body,
    onToggle,
  });
  const panel = mountPanel({
    root: page.panelRoot,
    key: page.key,
    session,
    storage: localStorage,
    onEnd: (sent) => {
      // Closed on what the page already knows, without the network: ending a
      // review is the moment the server is most likely to go away (the agent's
      // poll returns "ended" and shuts it down).
      banner.setEndedByReviewer(sent);
      // Refined by the server's account when there is one: other-tab ticks, a
      // reply that landed mid-send.
      void fetchSession(page.key)
        .then((fresh) => banner.setSession(fresh))
        .catch(() => {
          // The reviewer is already reading their summary.
        });
    },
    onPending: (count) => {
      railControl.setQueued(count);
      onQueued(count);
    },
    onJump,
  });
  return { banner, railControl, panel };
}

/**
 * The between-rounds replay. Closing it lands at the top of the diff, where a
 * new round starts anyway. Returns the refresh run on load and every re-group.
 */
function wireReplay(page: Page, live: LiveSession): (fresh: SessionData) => void {
  const replayOverlay = mountReplayOverlay({
    root: page.replayRoot,
    renderer: createDiff2HtmlRenderer(),
    onClose: () => {
      page.reviewRoot.scrollTop = 0;
    },
  });
  let replay: ReplayOpening | undefined;
  page.replayReopen.addEventListener("click", () => {
    // Manual reopen ignores the once-per-round memory on purpose.
    if (replay !== undefined) replayOverlay.open(replay);
  });
  // Ordering (which round a response belongs to, what failed fetches leave)
  // lives in the refresher; this only ties its hands to the page.
  const replayRefresh = createReplayRefresher({
    fetch: () => fetchReplay(page.key),
    wasReplayed: (shown) => readMemory(localStorage, page.key).replayed === shown,
    markReplayed: (shown) => updateMemory(localStorage, page.key, { replayed: shown }),
    open: (opening) => replayOverlay.open(opening),
    offer: (opening) => {
      replay = opening;
      page.replayReopen.hidden = opening === undefined;
    },
  });
  return (fresh) =>
    replayRefresh({
      round: live.round,
      roundReply: agentRoundReply(fresh.conversation, fresh.rounds),
      ended: fresh.status === "ended",
    });
}

/**
 * The two overlays a round can open on — opening for a first round, replay
 * after a commented one — and the one place that knows a round never opens on
 * both. Returns the replay's refresh.
 */
function wireOverlays(
  page: Page,
  live: LiveSession,
  session: SessionData,
): (fresh: SessionData) => void {
  const refreshReplay = wireReplay(page, live);
  refreshReplay(session);
  wireOpening(page, session, live.round);
  return refreshReplay;
}

/**
 * The opening ceremony. Whether it opens is `opensFor`'s question alone; the
 * page asks and records that this browser opened it (once per review, not per
 * load). Wired last, over a drawn page: closing it must reveal the review,
 * not one still being built.
 */
function wireOpening(page: Page, session: SessionData, round: number): void {
  const review = {
    round,
    intents: session.intents,
    ended: session.status === "ended",
    unwrapped: readMemory(localStorage, page.key).unwrapped,
  };
  if (!opensFor(review)) return;
  mountOpening({
    root: page.openingRoot,
    intents: session.intents,
    onOpen: () => updateMemory(localStorage, page.key, { unwrapped: true }),
    onClose: () => {
      // Lands on the home screen: the survey is what the reasons were about.
      page.reviewRoot.scrollTop = 0;
    },
  });
}

void main();
