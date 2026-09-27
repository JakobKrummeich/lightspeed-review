/**
 * Writes the tab beacon into the title and the favicon. Lit when the turn
 * flips to the reviewer while the tab is hidden; dark again the moment the
 * tab is looked at, or if the turn goes back to the agent first. Dark while
 * the review is ended: `lightspeed end` hands the turn back to the reviewer
 * too, and a closed review is nobody's turn — until `open --reopen` opens it.
 */
import { beaconState, beaconTitle, FAVICON, FAVICON_LIT, type Beacon } from "../tab-beacon.ts";
import type { SessionRecord, Turn } from "../../session-store.ts";

/** A background tab's timers run about once a second anyway: this is that second. */
const TWINKLE_MS = 1000;

export type BeaconPage = Pick<Document, "title" | "hidden" | "addEventListener" | "querySelector">;

export interface MountedBeacon {
  setTurn(turn: Turn): void;
  /**
   * Ended puts the beacon out, and no turn lights it while the review stays
   * ended; the turns are still followed, so a reopened review lights only on
   * a flip that comes after it.
   */
  setEnded(ended: boolean): void;
}

interface BeaconView {
  readonly page: BeaconPage;
  /** The page's own title, which the beacon only ever prefixes. */
  readonly title: string;
  readonly icon: HTMLLinkElement | null;
  /** Reduced motion: lit, but on one frame. */
  readonly still: () => boolean;
  beacon: Beacon;
  twinkle?: ReturnType<typeof setInterval>;
}

/**
 * `opening` is the session the page was drawn on: its turn, and whether it
 * had ended. Only a flip is news: the presence frames restate the turn, and a
 * tab hidden on the reviewer's own turn was left by a reviewer who already knew.
 */
export function mountTabBeacon(
  page: BeaconPage,
  opening: Pick<SessionRecord, "status" | "turn">,
  still: () => boolean,
): MountedBeacon {
  const view: BeaconView = {
    page,
    title: page.title,
    icon: page.querySelector<HTMLLinkElement>('link[rel="icon"]'),
    still,
    beacon: "dark",
  };
  let holder = opening.turn.holder;
  let ended = opening.status === "ended";
  page.addEventListener("visibilitychange", () => {
    if (!page.hidden) show(view, "dark");
  });
  return {
    setTurn(turn) {
      if (turn.holder === holder) return;
      holder = turn.holder;
      if (!ended) show(view, beaconState(turn, page.hidden));
    },
    setEnded(now) {
      ended = now;
      if (ended) show(view, "dark");
    },
  };
}

function show(view: BeaconView, beacon: Beacon): void {
  if (beacon === view.beacon) return;
  view.beacon = beacon;
  view.page.title = beaconTitle(view.title, beacon);
  clearInterval(view.twinkle);
  const { icon } = view;
  if (!icon) return;
  icon.href = beacon === "lit" ? FAVICON_LIT[0] : FAVICON;
  if (beacon === "lit" && !view.still()) {
    let frame = 0;
    view.twinkle = setInterval(() => {
      frame = 1 - frame;
      icon.href = FAVICON_LIT[frame as 0 | 1];
    }, TWINKLE_MS);
  }
}
