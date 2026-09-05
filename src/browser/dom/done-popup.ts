import { renderReviewDone } from "../review-done.ts";

export interface MountedDonePopup {
  /** The last file was just ticked: the card goes up over the review. */
  open(queued: number): void;
  /** The review is no longer finished (a round took the page, a box came unticked): nothing to say. */
  close(): void;
}

export interface DonePopupOptions {
  /** The reserved landmark the card is drawn into, emptied when it closes. */
  root: HTMLElement;
  /** The reviewer pressed the card's own end: the sidebar's Send & End, from here. */
  onEnd(): void;
}

/** One mounted popup: its options, and what it holds while the card is up. */
interface PopupView {
  readonly options: DonePopupOptions;
  /** Who had the caret before the card took it, handed back when it goes. */
  before: Element | null;
  onKey(event: KeyboardEvent): void;
}

/**
 * The finish, announced over the review. Goes up on the crossing alone — the
 * page's caller decides what a crossing is — and comes down on either press,
 * on Esc, or when the review stops being finished under it. Ending goes
 * through the panel, which owns the send: the card only says the word. Focus
 * is a dialog's: the end press takes the caret on open, the previous holder
 * gets it back on close.
 */
export function mountDonePopup(options: DonePopupOptions): MountedDonePopup {
  const view: PopupView = {
    options,
    before: null,
    onKey: (event) => {
      if (event.key === "Escape") hide(view);
    },
  };
  options.root.addEventListener("click", (event) => pressed(view, event));
  return {
    open: (queued) => show(view, queued),
    close: () => {
      if (!view.options.root.hidden) hide(view);
    },
  };
}

function pressed(view: PopupView, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.classList.contains("lsr-done-end")) {
    // Down before the send, not after it: the panel locks its controls for
    // the wire, and a card offering "End review" over a review already ending
    // would be a second press waiting to happen.
    hide(view);
    view.options.onEnd();
  }
  if (target.classList.contains("lsr-done-stay")) hide(view);
}

function show(view: PopupView, queued: number): void {
  const { root } = view.options;
  // A card already up keeps its place: the newest word replaces it without
  // taking the caret twice.
  if (root.hidden) {
    view.before = document.activeElement;
    document.addEventListener("keydown", view.onKey);
  }
  root.innerHTML = renderReviewDone(queued);
  root.hidden = false;
  root.querySelector<HTMLElement>(".lsr-done-end")?.focus();
}

function hide(view: PopupView): void {
  const { root } = view.options;
  root.hidden = true;
  root.innerHTML = "";
  document.removeEventListener("keydown", view.onKey);
  if (view.before instanceof HTMLElement) view.before.focus();
  view.before = null;
}
