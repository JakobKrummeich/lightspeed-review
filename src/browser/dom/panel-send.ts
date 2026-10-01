/**
 * The panel's one way out: Send, Send & End and the page's own `end()` all go
 * through `send`, and the status change an end causes is drawn by `setStatus`,
 * the same one a fresh session uses. Apart from the mount so the panel's size
 * gates have room; the mount hands in its `draw`, as it does to the pills.
 */
import { renderCompose } from "../conversation-panel.ts";
import { updateMemory, type ReviewMemoryStorage } from "../review-memory.ts";
import type { FeedbackPrompt } from "../../session-store.ts";
import { batchSize } from "../../threads.ts";
import { lockControls, sayNotSent, type ComposeView } from "./panel-lock.ts";
import type { PanelLight } from "./panel-light.ts";
import {
  clearGeneralComment,
  deliver,
  echoSent,
  generalCommentBox,
  onTheWire,
} from "./panel-wire.ts";
import type { SessionData } from "./session-api.ts";

/** The part of the mounted panel a send reads; the mount's view is one of these. */
interface SendView extends ComposeView {
  readonly options: {
    readonly root: HTMLElement;
    readonly key: string;
    readonly storage: ReviewMemoryStorage;
    readonly light?: PanelLight;
    onEnd(sent: FeedbackPrompt[]): void;
  };
}

export async function send<V extends SendView>(
  view: V,
  ended: boolean,
  draw: (view: V) => void,
): Promise<void> {
  const { options, state } = view;
  // One press at a time: a second mid-wire would send the same prompts twice.
  if (view.sending) return;
  const prompts = onTheWire(view.state, options.root, ended);
  if (prompts === undefined) return;
  // Conversation before the send, so the echo below can tell whether it is
  // still the one it was written for.
  const before = state.conversation;
  setSending(view, true);
  const delivery = await deliver(options.key, prompts, ended);
  if (!delivery.sent) {
    setSending(view, false);
    sayNotSent(view, delivery.why);
    return;
  }
  // Not a duplicate of the server's copy: this half is instant and holds even
  // with a dead SSE stream; the `feedback` event brings the server's copy —
  // the truth, and all another tab ever sees.
  echoSent(state, before, prompts);
  clearSent(view, prompts, ended);
  draw(view);
  if (ended) setStatus(view, "ended");
  // After the status: lifting the send lock must never reopen a closed review.
  setSending(view, false);
  // Not left to the SSE round trip: every control must stop at the moment the
  // reviewer said done.
  if (ended) options.onEnd(prompts);
}

/**
 * Cleared only for what actually went out. An end on the agent's turn sends
 * nothing — the button says `End without Sending` and the round card promises
 * the queue — so the pills and the half-typed comment stay exactly where the
 * reviewer left them, to go out when the review is reopened.
 */
function clearSent(view: SendView, prompts: FeedbackPrompt[], ended: boolean): void {
  if (prompts.length === 0) return;
  const { options, state } = view;
  // Lit before the box empties and the draw takes the drafts away, which both
  // follow at once: the light is laid over them and holds neither up.
  options.light?.sent(ended);
  state.pending = [];
  clearGeneralComment(options.root);
  // Both halves at once, ahead of the delayed write: a reload must not offer
  // to send what the server now owns.
  updateMemory(options.storage, options.key, { pending: [], draft: "" });
}

/** The only thing that replaces the compose box, and only when it must. */
export function setStatus(view: SendView, status: SessionData["status"]): void {
  if (status === view.state.status) return;
  view.state.status = status;
  // Carried across the re-render, as the answer box is across a redraw: the row
  // is replaced, and the words in it are the reviewer's whether they went out or
  // not. An end that sent nothing keeps them for the round after the reopen.
  const typed = generalCommentBox(view.options.root)?.value ?? "";
  if (view.composeHost) {
    view.composeHost.innerHTML = renderCompose(view.state, batchSize(view.state.pending));
  }
  const box = generalCommentBox(view.options.root);
  if (box) box.value = typed;
  // The fresh row knows nothing of a send in flight, and the status change the
  // send itself causes must not hand the buttons back early.
  setSending(view, view.sending);
}

function setSending(view: SendView, sending: boolean): void {
  view.sending = sending;
  lockControls(view);
}
