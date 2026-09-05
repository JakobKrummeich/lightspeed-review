import { roundOfferLabel } from "../round-offer.ts";
import { currentRound } from "../conversation-rounds.ts";
import type { SessionData } from "./session-api.ts";

export interface MountedRoundOffer {
  /**
   * A round arrived mid-read. Session held whole, not refetched on take: what
   * is offered has to be what arrives.
   */
  offer(fresh: SessionData): void;
  /** The round went on screen by another route, so there is nothing to offer. */
  clear(): void;
  /**
   * Popup dismissed: the offer is now the page's only word that a round
   * waits, so it glows (stylesheet reads the mark). Ends with the offer.
   */
  beckon(): void;
}

export interface RoundOfferOptions {
  /** The button in the header, hidden until there is something to say. */
  root: HTMLElement;
  /** The reviewer pressed it: this is the round they just asked for. */
  onTake(fresh: SessionData): void;
}

/**
 * The header offer and its round. One at a time, always the newest: taking an
 * older round would open a diff the repository has moved past. A new offer
 * replaces the held one, which is why the label rewrites on every offer.
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
    offer(fresh: SessionData) {
      held = fresh;
      root.textContent = roundOfferLabel(currentRound(fresh.rounds), filesIn(fresh));
      root.hidden = false;
    },
    clear,
    beckon() {
      // No held round: glowing would advertise an empty press.
      if (held !== undefined) root.dataset.beckon = "true";
    },
  };
}

/** Size of the waiting round: unique files — a file in two groups reads once. */
export function filesIn(fresh: SessionData): number {
  return new Set(fresh.groups.flatMap((group) => group.files.map((file) => file.path))).size;
}
