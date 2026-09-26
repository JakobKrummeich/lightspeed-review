/**
 * Which of the panel's controls are live and what they say, worked out from
 * the panel's state and whether a send is on the wire — and patched onto the
 * elements already there, never redrawn. One module so the button, Enter, the
 * thread replies and the resolve toggles read the same gates and cannot come
 * apart.
 */
import {
  composeNote,
  composePlaceholder,
  endLabel,
  sendLabel,
  SENDING_LABEL,
  writesLocked,
  type PanelState,
} from "../conversation-panel.ts";

/** The part of the mounted panel the gates read; the mount's view is one of these. */
export interface ComposeView {
  readonly state: PanelState;
  /**
   * Controls locked exactly this long: the one thing worth refusing is the
   * same feedback going twice, not an agent still working.
   */
  sending: boolean;
  /**
   * Held for the panel's life: only the scroll half is redrawn, so a
   * half-typed comment outlives an SSE reply.
   */
  readonly scrollHost: HTMLElement | null;
  readonly composeHost: HTMLElement | null;
}

/**
 * Everything that writes — the compose row, a thread reply, a resolve toggle,
 * taking a pill back — reads this one answer: frozen while a send is on the
 * wire, while the agent digests, and on an ended review.
 */
export function composeFrozen(view: ComposeView): boolean {
  return view.sending || writesLocked(view.state);
}

/**
 * Patched into existing elements: re-rendering would replace the textarea and
 * lose a comment typed mid-flight — the very thing the lock prevents. A
 * disabled textarea keeps its words, so a draft outlives the agent's
 * digesting turn. Ending stays pressable whatever the turn.
 */
export function lockControls(view: ComposeView): void {
  const frozen = composeFrozen(view);
  const label = view.sending ? SENDING_LABEL : sendLabel(view.state, view.state.pending.length);
  patch(view, "#lsr-send", frozen, label);
  patch(view, "#lsr-send-end", view.sending || view.state.status === "ended", endLabel(view.state));
  patch(view, "#lsr-general-comment", frozen);
  sayMode(view);
  lockThreads(view, frozen);
}

/** The placeholder names what Enter does; the note what the lock means. */
function sayMode(view: ComposeView): void {
  const box = view.composeHost?.querySelector<HTMLTextAreaElement>("#lsr-general-comment");
  if (box) box.placeholder = composePlaceholder(view.state);
  const note = view.composeHost?.querySelector(".lsr-complete");
  if (note) note.textContent = composeNote(view.state);
}

function lockThreads(view: ComposeView, frozen: boolean): void {
  for (const selector of THREAD_CONTROLS) {
    for (const control of view.scrollHost?.querySelectorAll<HTMLButtonElement>(selector) ?? []) {
      control.disabled = frozen;
    }
  }
}

/**
 * In the scroll, redrawn with it: every draw re-locks them. A thread's foot is
 * drawn only while the page takes writing, so for its controls the lock is
 * what a send on the wire needs.
 */
const THREAD_CONTROLS = [
  ".lsr-thread-reply-box",
  ".lsr-thread-reply-add",
  ".lsr-thread-resolve",
  ".lsr-pill-remove",
];

function patch(view: ComposeView, id: string, disabled: boolean, label?: string): void {
  const control = composeControl(view, id);
  if (!control) return;
  control.disabled = disabled;
  if (label !== undefined) control.textContent = label;
}

function composeControl(
  view: ComposeView,
  id: string,
): HTMLButtonElement | HTMLTextAreaElement | null {
  return view.composeHost?.querySelector<HTMLButtonElement | HTMLTextAreaElement>(id) ?? null;
}
