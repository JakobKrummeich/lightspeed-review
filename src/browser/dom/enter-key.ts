/**
 * What a keypress in a comment box means: bare Enter sends, modifiers write
 * multi-line comments.
 */
export type EnterAction =
  /** Take the same path the send button takes. */
  | "submit"
  /** Break the line here, because the browser will not do it itself. */
  | "newline"
  /** Not our keystroke — leave it to the browser. */
  | "default";

/** The parts of a `keydown` this decision reads, so it can be decided without a DOM. */
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

/** The parts of a text field `applyNewline` writes through; a textarea is one. */
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

/**
 * Splices a newline in where the caret is, replacing whatever is selected, and
 * leaves the caret after it. Exported for the tests; `typeNewline` is what the
 * page calls.
 */
export function applyNewline(field: EditableField): void {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.value = `${field.value.slice(0, start)}\n${field.value.slice(end)}`;
  field.setSelectionRange(start + 1, start + 1);
}
