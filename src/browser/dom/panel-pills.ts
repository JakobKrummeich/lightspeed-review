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

/**
 * True when the press was on a pill's × or its words, acted on or refused.
 * Asked first of every click: the pill is named by the index the press read
 * while it is still the drawn one, before an open box's save — which, saved
 * empty, moves every later pill up one — and then acted on by identity. A
 * control a redraw threw away is refused: its index is from before.
 */
export function pillPress<V extends EditView>(
  view: V,
  target: HTMLElement,
  draw: Draw<V>,
): boolean {
  const remove = target.classList.contains("lsr-pill-remove");
  if (!remove && !target.classList.contains("lsr-draft-text")) return false;
  const pill = target.isConnected ? view.state.pending[Number(target.dataset.index)] : undefined;
  if (composeFrozen(view) || pill === undefined) return true;
  if (remove) takeBack(view, pill, draw);
  else {
    settleEdit(view);
    openEdit(view, pill, draw);
  }
  return true;
}

/** A pill taken back takes its own open box with it, typed words and all; any other is saved. */
function takeBack<V extends EditView>(view: V, pill: QueuedPill, draw: Draw<V>): void {
  const { state } = view;
  if (pill === state.editing) delete state.editing;
  settleEdit(view);
  state.pending = state.pending.filter((one) => one !== pill);
  draw(view);
}

function openEdit<V extends EditView>(view: V, pill: QueuedPill, draw: Draw<V>): void {
  view.state.editing = pill;
  draw(view);
  // After the draw, which drew the box empty: filled here, not in markup.
  const box = editBox(view.options.root);
  if (box === null) return;
  box.value = wordsOf(pill);
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

/**
 * A mouse press on a control while a box is open keeps the focus in the box.
 * Left to move, it would blur the box on mousedown, whose save redraws the
 * column and throws the pressed control away before its click: the press
 * would be lost, and a second one needed. The click then leaves the box
 * itself (`leaveEdit`).
 */
export function holdEdit(view: EditView, event: MouseEvent): void {
  const target = event.target;
  if (view.state.editing === undefined || !(target instanceof HTMLElement)) return;
  if (pressable(target)) event.preventDefault();
}

/**
 * A press on any other control while a box is open is the box's leaving
 * (`holdEdit` kept the focus in it): saved and drawn closed before the control
 * acts. A click on no control — a drag out of the box let go elsewhere —
 * leaves it open.
 */
export function leaveEdit<V extends EditView>(view: V, target: HTMLElement, draw: Draw<V>): void {
  if (pressable(target) && settleEdit(view)) draw(view);
}

/** A card's head folds on a press anywhere on it, so it is a control too. */
function pressable(target: HTMLElement): boolean {
  return target.closest("button") !== null || target.closest("[data-fold]") !== null;
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

/**
 * Leaving the box saves it; a box dropped by a redraw is not leaving it, nor is
 * a switch to another window (`windowLeft`). The
 * save's redraw replaces what the focus was headed for — the next control on a
 * Tab, a reply box clicked into — so the focus is put on its twin in the fresh
 * column, or it would land nowhere.
 */
export function editBlur<V extends EditView>(view: V, event: FocusEvent, draw: Draw<V>): void {
  const box = event.target;
  if (!(box instanceof HTMLElement) || !box.classList.contains("lsr-draft-edit")) return;
  if (redrawing.has(view.options.root) || windowLeft(event)) return;
  const before = view.state.pending;
  const edited = view.state.editing;
  const saved = saveEdit(view, (box as HTMLTextAreaElement).value, draw, false);
  if (saved === false) return;
  // Pills by identity: one saved empty moved every later pill up one.
  refocusTwin(view.options.root, event.relatedTarget, (index) => {
    const was = before[Number(index)];
    return positionOf(view.state.pending, was === edited ? saved : was);
  });
}

function refocusTwin(
  root: HTMLElement,
  headed: EventTarget | null,
  moved: (index: string) => string | undefined,
): void {
  if (!(headed instanceof HTMLElement) || headed.isConnected) return;
  twinOf(root, headed, moved)?.focus();
}

function positionOf(
  pending: readonly QueuedPill[],
  pill: QueuedPill | undefined,
): string | undefined {
  const index = pill === undefined ? -1 : pending.indexOf(pill);
  return index < 0 ? undefined : String(index);
}

/** Same kind of control, same data — a pill's index as it now stands, or none if it is gone. */
function twinOf(
  root: HTMLElement,
  gone: HTMLElement,
  moved: (index: string) => string | undefined,
): HTMLElement | undefined {
  const want: Record<string, string | undefined> = { ...gone.dataset };
  if (want.index !== undefined) {
    want.index = moved(want.index);
    if (want.index === undefined) return undefined;
  }
  const same = (one: HTMLElement): boolean =>
    one.className === gone.className &&
    Object.keys(want).length === Object.keys(one.dataset).length &&
    Object.entries(want).every(([name, value]) => one.dataset[name] === value);
  return [...root.querySelectorAll<HTMLElement>(gone.tagName.toLowerCase())].find(same);
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

/**
 * The pill as saved, undefined if saved empty (and so taken back), false if
 * refused: while frozen the box stays open, disabled, words kept, as the
 * compose box does.
 */
function saveEdit<V extends EditView>(
  view: V,
  comment: string,
  draw: Draw<V>,
  back: boolean,
): QueuedPill | undefined | false {
  const { state } = view;
  const before = state.pending;
  const index = state.editing === undefined ? -1 : before.indexOf(state.editing);
  if (!settleEdit(view, comment)) return false;
  // Emptied, the pill is gone and the focus has nowhere of its own to go back to.
  const kept = state.pending.length === before.length ? state.pending[index] : undefined;
  closeEdit(view, draw, back ? kept : undefined);
  return kept;
}

/** The open box's words into its pill, and the box closed; not drawn. False when refused. */
function settleEdit(view: EditView, comment = editBox(view.options.root)?.value): boolean {
  const { state } = view;
  if (composeFrozen(view) || state.editing === undefined || comment === undefined) return false;
  state.pending = editPill(state.pending, state.pending.indexOf(state.editing), comment);
  delete state.editing;
  return true;
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

/**
 * The window lost the focus — another window or app took it — not the box:
 * nothing in the page is taking it, and the page no longer has it. The box
 * stays open with its words; the browser gives it the focus back on return.
 */
function windowLeft(event: FocusEvent): boolean {
  const page = (globalThis as { document?: Document }).document;
  return event.relatedTarget === null && page?.hasFocus?.() === false;
}

/** No `document` outside a browser; there is then nothing focused to keep. */
function activeElement(): Element | null | undefined {
  return (globalThis as { document?: Document }).document?.activeElement;
}
