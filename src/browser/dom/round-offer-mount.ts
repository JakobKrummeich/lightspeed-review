import { roundOfferLabel } from "../round-offer.ts";
import { currentRound } from "../conversation-rounds.ts";
import type { SessionData } from "./session-api.ts";

export interface MountedRoundOffer {
  /**
   * Session held whole, not refetched on take: what is offered has to be what
   * arrives. `queued` is the unsent count the offer names — the thing a
   * reviewer would expect a new round to cost them.
   */
  offer(fresh: SessionData, queued: number): void;
  clear(): void;
  /**
   * The offer is now the page's only word that a round waits, so it glows
   * (stylesheet reads the mark).
   */
  beckon(): void;
}

export interface RoundOfferOptions {
  root: HTMLElement;
  onTake(fresh: SessionData): void;
}

/**
 * One at a time, always the newest: taking an older round would open a diff
 * the repository has moved past, so a new offer replaces the held one and the
 * label rewrites.
 */
export function mountRoundOffer(options: RoundOfferOptions): MountedRoundOffer {
  const { root, onTake } = options;
  let held: SessionData | undefined;
  const clear = () => {
    held = undefined;
    root.hidden = true;
    delete root.dataset.beckon;
  };
  root.addEventListener("click", () => {
    const taken = held;
    if (taken === undefined) return;
    // Cleared before applying: an offer standing over the redraw invites a
    // press for a round already on screen.
    clear();
    onTake(taken);
  });
  return {
    offer(fresh: SessionData, queued: number) {
      held = fresh;
      root.textContent = roundOfferLabel(currentRound(fresh.rounds), filesIn(fresh), queued);
      root.hidden = false;
    },
    clear,
    beckon() {
      // No held round: glowing would advertise an empty press.
      if (held !== undefined) root.dataset.beckon = "true";
    },
  };
}

/** Unique files: a file in two groups reads once. */
export function filesIn(fresh: SessionData): number {
  return new Set(fresh.groups.flatMap((group) => group.files.map((file) => file.path))).size;
}
