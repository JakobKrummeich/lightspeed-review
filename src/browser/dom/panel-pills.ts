/**
 * Presses on a queued pill where the column draws it: its × takes it back, and
 * its words are edited in place. A press on the words (click, or Enter/Space —
 * they are a button) opens a box in their place; Enter saves,
 * as it adds a reply; Escape puts the words back; leaving the box saves, as
 * the rest of the panel keeps typed words rather than dropping them. Saved
 * empty, the pill is taken back, as by its ×. The lock is the ×'s: nothing
 * opens or saves while `composeFrozen`.
 */
import { editPill, type QueuedPill } from "../queued-pill.ts";
import { submitsOnEnter } from "./enter-key.ts";
import { composeFrozen, type ComposeView } from "./panel-lock.ts";

interface EditView extends ComposeView {
  readonly options: { readonly root: HTMLElement };
}

type Draw<V> = (view: V) => void;

/** True when the press was on a pill's × or its words, acted on or refused. */
export function pillPress<V extends EditView>(
  view: V,
  target: HTMLElement,
  draw: Draw<V>,
): boolean {
  if (target.classList.contains("lsr-pill-remove")) removePress(view, target, draw);
  else if (target.classList.contains("lsr-draft-text")) editPress(view, target, draw);
  else return false;
  return true;
}

/**
 * Taking a pill back writes to the queue, so it is locked with the rest. A ×
 * a redraw threw away is refused: its index is from before, and a pill saved
 * empty on the box's blur has since moved every later pill up one.
 */
function removePress<V extends EditView>(view: V, target: HTMLElement, draw: Draw<V>): void {
  if (composeFrozen(view) || !target.isConnected) return;
  const index = Number(target.dataset.index);
  view.state.pending = view.state.pending.filter((_, position) => position !== index);
  draw(view);
}

function editPress<V extends EditView>(view: V, target: HTMLElement, draw: Draw<V>): void {
  const pill = view.state.pending[Number(target.dataset.index)];
  if (composeFrozen(view) || pill === undefined) return;
  view.state.editing = pill;
  draw(view);
  // After the draw, which drew the box empty: filled here, not in markup.
  const box = editBox(view.options.root);
  if (box === null) return;
  box.value = wordsOf(pill);
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

export function editKey<V extends EditView>(view: V, event: KeyboardEvent, draw: Draw<V>): void {
  const box = event.target;
  if (!(box instanceof HTMLElement) || !box.classList.contains("lsr-draft-edit")) return;
  const field = box as HTMLTextAreaElement;
  if (event.key === "Escape" && !event.isComposing) {
    event.preventDefault();
    closeEdit(view, draw, view.state.editing);
  } else if (submitsOnEnter(event, field)) saveEdit(view, field.value, draw, true);
}

/** Leaving the box saves it; a box dropped by a redraw is not leaving it. */
export function editBlur<V extends EditView>(view: V, event: Event, draw: Draw<V>): void {
  const box = event.target;
  if (!(box instanceof HTMLElement) || !box.classList.contains("lsr-draft-edit")) return;
  if (redrawing.has(view.options.root)) return;
  saveEdit(view, (box as HTMLTextAreaElement).value, draw, false);
}

/**
 * Chrome fires `focusout` on a focused box removed from the page, so the draw
 * that replaces the column would otherwise save the box mid-write and draw
 * again inside itself. Keyed by root: every mounted panel draws its own.
 */
const redrawing = new WeakSet<HTMLElement>();

/**
 * Around the scroll's rewrite, as `typedReplies` is around a reply box: an
 * SSE redraw mid-edit must cost neither the words typed nor the caret.
 */
export function keepEdit(root: HTMLElement, write: () => void): void {
  const held = heldEdit(root);
  redrawing.add(root);
  try {
    write();
  } finally {
    redrawing.delete(root);
  }
  const box = editBox(root);
  if (held === undefined || box === null) return;
  box.value = held.value;
  if (!held.focused) return;
  box.focus();
  box.setSelectionRange(held.start, held.end);
}

interface HeldEdit {
  value: string;
  focused: boolean;
  start: number;
  end: number;
}

function heldEdit(root: HTMLElement): HeldEdit | undefined {
  const box = editBox(root);
  if (box === null) return undefined;
  const { value } = box;
  const start = box.selectionStart ?? value.length;
  const end = box.selectionEnd ?? start;
  return { value, focused: box === activeElement(), start, end };
}

/** Refused while frozen: the box stays open, disabled, words kept, as the compose box does. */
function saveEdit<V extends EditView>(
  view: V,
  comment: string,
  draw: Draw<V>,
  back: boolean,
): void {
  const { state } = view;
  if (composeFrozen(view) || state.editing === undefined) return;
  const index = state.pending.indexOf(state.editing);
  const next = editPill(state.pending, index, comment);
  // Emptied, the pill is gone and the focus has nowhere of its own to go back to.
  const kept = next.length === state.pending.length ? next[index] : undefined;
  state.pending = next;
  closeEdit(view, draw, back ? kept : undefined);
}

/** Back onto the words just closed, so the keyboard stays where it was. */
function closeEdit<V extends EditView>(
  view: V,
  draw: Draw<V>,
  focus: QueuedPill | undefined,
): void {
  const { state } = view;
  delete state.editing;
  draw(view);
  if (focus === undefined) return;
  const index = String(state.pending.indexOf(focus));
  const words = view.options.root.querySelectorAll<HTMLElement>(".lsr-draft-text");
  [...words].find((one) => one.dataset.index === index)?.focus();
}

function editBox(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>(".lsr-draft-edit");
}

function wordsOf(pill: QueuedPill): string {
  return pill.type === "resolve" ? "" : pill.comment;
}

/** No `document` outside a browser; there is then nothing focused to keep. */
function activeElement(): Element | null | undefined {
  return (globalThis as { document?: Document }).document?.activeElement;
}
