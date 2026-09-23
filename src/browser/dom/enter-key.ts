/** Bare Enter sends, modifiers write multi-line comments. */
export type EnterAction =
  | "submit"
  /** Break the line here, because the browser will not do it itself. */
  | "newline"
  | "default";

/** So the decision can be made without a DOM. */
export interface EnterKeydown {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /**
   * True while an IME is composing, when Enter picks a candidate rather than
   * ending the comment. Submitting there would swallow the word being typed.
   */
  isComposing: boolean;
}

/**
 * Shift+Enter and Alt+Enter are left to the browser, which already types a
 * newline for them. Ctrl+Enter and Cmd+Enter are the same intent from reviewers
 * used to the opposite convention, but browsers type nothing for those, so the
 * caller has to — see `applyNewline`.
 */
export function enterAction(event: EnterKeydown): EnterAction {
  if (event.key !== "Enter" || event.isComposing) return "default";
  if (event.shiftKey || event.altKey) return "default";
  if (event.ctrlKey || event.metaKey) return "newline";
  return "submit";
}

export interface EditableField {
  value: string;
  /** Null in fields that report no caret, which is read as the end of the text. */
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
}

/**
 * Types a newline via `execCommand`: deprecated, but the only call that keeps
 * the native undo stack and fires `input`. Where missing or refused, spliced
 * in by hand — costing only undo history.
 */
export function typeNewline(field: EditableField): void {
  if (insertedByBrowser()) return;
  applyNewline(field);
}

function insertedByBrowser(): boolean {
  // Read off `globalThis` because this module is also run without a DOM.
  const host = (globalThis as { document?: { execCommand?: unknown } }).document;
  if (typeof host?.execCommand !== "function") return false;
  return (host.execCommand as (name: string, ui: boolean, value: string) => boolean)(
    "insertText",
    false,
    "\n",
  );
}

/** Exported for the tests; `typeNewline` is what the page calls. */
export function applyNewline(field: EditableField): void {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.value = `${field.value.slice(0, start)}\n${field.value.slice(end)}`;
  field.setSelectionRange(start + 1, start + 1);
}

/**
 * The comment boxes' one Enter: types the newline the browser will not, and
 * reports whether this keystroke is the box's button. A submit is swallowed
 * whatever the caller then does with it, so an Enter on an empty box types no
 * blank first line to hide the placeholder saying what Enter is waiting for.
 */
export function submitsOnEnter(
  event: EnterKeydown & { preventDefault(): void },
  field: EditableField,
): boolean {
  const action = enterAction(event);
  if (action === "default") return false;
  event.preventDefault();
  if (action === "newline") typeNewline(field);
  return action === "submit";
}
