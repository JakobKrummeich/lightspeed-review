import { annotationsFrom, renderAnnotationPopup, type SelectionFragment } from "../annotation.ts";
import { submitsOnEnter } from "./enter-key.ts";
import { popupPosition } from "./popup-position.ts";
import { selectionFragments } from "./selection-fragments.ts";
import type { AnnotationPrompt } from "../../session-store.ts";

export interface AnnotationPopupOptions {
  /** Selections outside it are ignored. */
  diffRoot: HTMLElement;
  onQueue(prompts: AnnotationPrompt[]): void;
}

/**
 * One popup element reused per selection, appended to `<body>` to float above
 * the scrolling diff. Deliberately not persisted across reload (unlike the
 * panel's queue, `review-memory.ts`): a reload takes the selection with it,
 * and a restored comment with no fragments would be a sentence about nothing.
 */
export function mountAnnotationPopup(options: AnnotationPopupOptions): void {
  const popup = document.createElement("div");
  popup.className = "lsr-popup";
  popup.hidden = true;
  document.body.append(popup);
  let fragments: SelectionFragment[] = [];

  document.addEventListener("mouseup", () => {
    // Let the click that dismisses the popup finish before reading the selection.
    setTimeout(() => {
      const selection = document.getSelection();
      if (!selection || popup.contains(selection.anchorNode)) return;
      fragments = selectionFragments(selection, options.diffRoot);
      if (fragments.length === 0) {
        popup.hidden = true;
        return;
      }
      popup.innerHTML = renderAnnotationPopup(fragments);
      showAt(popup, selection.getRangeAt(0).getBoundingClientRect());
    }, 0);
  });

  function queue(): boolean {
    const box = commentBox(popup);
    const prompts = annotationsFrom(fragments, box?.value ?? "");
    if (prompts.length === 0) return false;
    options.onQueue(prompts);
    // Emptied, not merely hidden: a second Enter would queue the same annotation again.
    if (box) box.value = "";
    fragments = [];
    popup.hidden = true;
    document.getSelection()?.removeAllRanges();
    return true;
  }

  popup.addEventListener("click", (event) => {
    if (!(event.target instanceof HTMLElement) || event.target.id !== "lsr-queue-feedback") return;
    queue();
  });

  popup.addEventListener("keydown", (event) => {
    const field = commentBox(popup);
    if (field === null || event.target !== field) return;
    // An empty comment queues nothing (`queue` refuses it); the Enter is still swallowed.
    if (submitsOnEnter(event, field)) queue();
  });
}

function commentBox(popup: HTMLElement): HTMLTextAreaElement | null {
  return popup.querySelector<HTMLTextAreaElement>("#lsr-annotation-comment");
}

function showAt(popup: HTMLElement, rect: DOMRect): void {
  // Shown before measuring: `display: none` elements measure zero height.
  popup.hidden = false;
  const { top, left } = popupPosition({
    selection: rect,
    popup: { width: popup.offsetWidth, height: popup.offsetHeight },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
  });
  popup.style.top = `${top}px`;
  popup.style.left = `${left}px`;
  commentBox(popup)?.focus();
}
