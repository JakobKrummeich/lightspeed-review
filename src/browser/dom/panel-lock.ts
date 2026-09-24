/**
 * Which of the panel's controls are live and what they say, worked out from
 * the panel's state and whether a send is on the wire — and patched onto the
 * elements already there, never redrawn. One module so the button, Enter and
 * the question card's Answer read the same two gates and cannot come apart.
 */
import {
  composePlaceholder,
  endLabel,
  sendIsLocked,
  sendLabel,
  SENDING_LABEL,
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
 * Answer's `disabled` and Enter's own guard read this one answer, so the
 * two cannot come apart.
 */
export function sendRefused(view: ComposeView): boolean {
  return view.sending || sendIsLocked(view.state);
}

/**
 * The compose row's own lock: the primary button's `disabled` and `press`
 * (which the box's Enter goes through) read it, so the one that queues on the
 * agent's turn cannot stay live where the other has stopped.
 */
export function composeFrozen(view: ComposeView): boolean {
  return view.sending || view.state.status === "ended";
}

/**
 * Patched into existing elements: re-rendering would replace the textarea and
 * lose a comment typed mid-flight — the very thing the lock prevents.
 *
 * No control is taken away by the turn: the primary button queues on the
 * agent's turn, ending stays pressable (both say so on themselves), and typing
 * is never gated. The placeholder follows, since it names what Enter does.
 */
export function lockControls(view: ComposeView): void {
  const frozen = composeFrozen(view);
  const label = view.sending ? SENDING_LABEL : sendLabel(view.state, view.state.pending.length);
  patch(view, "#lsr-send", frozen, label);
  patch(view, "#lsr-send-end", frozen, endLabel(view.state));
  patch(view, "#lsr-general-comment", frozen);
  const box = view.composeHost?.querySelector<HTMLTextAreaElement>("#lsr-general-comment");
  if (box) box.placeholder = composePlaceholder(view.state);
  // The question card is in the scroll, not the compose row, but it sends, so it
  // answers to the same one gate rather than to a rule of its own.
  const answering = view.scrollHost?.querySelector<HTMLButtonElement>(".lsr-answer-send");
  if (answering) answering.disabled = sendRefused(view);
}

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
