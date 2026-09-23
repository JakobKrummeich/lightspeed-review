import { renderReviewDone } from "../review-done.ts";

export interface MountedDonePopup {
  /** `sendsQueue` is false on the agent's turn, where ending takes nothing with it. */
  open(queued: number, sendsQueue: boolean): void;
  close(): void;
}

export interface DonePopupOptions {
  root: HTMLElement;
  onEnd(): void;
}

interface PopupView {
  readonly options: DonePopupOptions;
  before: Element | null;
  onKey(event: KeyboardEvent): void;
}

/**
 * Goes up on the crossing alone — the page's caller decides what a crossing
 * is — and comes down on either press, on Esc, or when the review stops being
 * finished under it. Ending goes through the panel, which owns the send: the
 * card only says the word. Focus is a dialog's: the end press takes the caret
 * on open, the previous holder gets it back on close.
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
    open: (queued, sendsQueue) => show(view, queued, sendsQueue),
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

function show(view: PopupView, queued: number, sendsQueue: boolean): void {
  const { root } = view.options;
  // A card already up keeps its place: the newest word replaces it without
  // taking the caret twice.
  if (root.hidden) {
    view.before = document.activeElement;
    document.addEventListener("keydown", view.onKey);
  }
  root.innerHTML = renderReviewDone(queued, sendsQueue);
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
