import { renderRoundPopup } from "../round-offer.ts";
import { currentRound } from "../conversation-rounds.ts";
import { filesIn } from "./round-offer-mount.ts";
import type { SessionData } from "./session-api.ts";
import type { QueueTally } from "../queued-pill.ts";

/**
 * Card fold duration, matching the stylesheet's animation. The timer is what
 * removes the card, so animations-off reviewers are not left waiting.
 */
export const FOLD_MS = 260;

export interface MountedRoundPopup {
  /** `queued` is the unsent tally, which the card promises to keep. */
  offer(fresh: SessionData, queued: QueueTally): void;
  clear(): void;
}

export interface RoundPopupOptions {
  root: HTMLElement;
  onTake(fresh: SessionData): void;
  onDismissed(): void;
}

interface PopupView {
  readonly options: RoundPopupOptions;
  held: SessionData | undefined;
  announced: number | undefined;
  fold: ReturnType<typeof setTimeout> | undefined;
  onKey(event: KeyboardEvent): void;
}

/**
 * The header's offer alone proved missable. Dismissing is not declining — the
 * card folds into the offer it duplicates. Each round announced once, however
 * many session events it sends; a newer round is fresh news, announced over
 * the last card's fold if need be.
 */
export function mountRoundPopup(options: RoundPopupOptions): MountedRoundPopup {
  const view: PopupView = {
    options,
    held: undefined,
    announced: undefined,
    fold: undefined,
    onKey: (event) => {
      if (event.key === "Escape") dismiss(view);
    },
  };
  options.root.addEventListener("click", (event) => pressed(view, event));
  return {
    offer: (fresh, queued) => offerRound(view, fresh, queued),
    clear: () => clearPopup(view),
  };
}

function pressed(view: PopupView, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.classList.contains("lsr-round-take")) take(view);
  if (target.classList.contains("lsr-round-stay")) dismiss(view);
}

function offerRound(view: PopupView, fresh: SessionData, queued: QueueTally): void {
  const round = currentRound(fresh.rounds);
  if (round === view.announced) {
    // Not news twice — but a card still up keeps the newest copy, so its take
    // hands over what would have gone on screen anyway.
    if (!view.options.root.hidden) view.held = fresh;
    return;
  }
  view.held = fresh;
  view.announced = round;
  // Louder news outruns a fold in flight: the exit's ending must not hide the
  // newer round's card.
  settle(view);
  delete view.options.root.dataset.state;
  view.options.root.innerHTML = renderRoundPopup(round, filesIn(fresh), queued);
  if (view.options.root.hidden) document.addEventListener("keydown", view.onKey);
  view.options.root.hidden = false;
}

function clearPopup(view: PopupView): void {
  view.held = undefined;
  view.announced = undefined;
  if (!view.options.root.hidden) hide(view);
}

function take(view: PopupView): void {
  const taken = view.held;
  if (taken === undefined) return;
  view.held = undefined;
  hide(view);
  view.options.onTake(taken);
}

function dismiss(view: PopupView): void {
  // Mid-fold: nothing left to dismiss, only a card on its way out.
  if (view.held === undefined || view.fold !== undefined) return;
  view.held = undefined;
  view.options.root.dataset.state = "folding";
  view.fold = setTimeout(() => {
    hide(view);
    view.options.onDismissed();
  }, FOLD_MS);
}

function hide(view: PopupView): void {
  settle(view);
  view.options.root.hidden = true;
  view.options.root.innerHTML = "";
  delete view.options.root.dataset.state;
  document.removeEventListener("keydown", view.onKey);
}

function settle(view: PopupView): void {
  if (view.fold !== undefined) clearTimeout(view.fold);
  view.fold = undefined;
}
