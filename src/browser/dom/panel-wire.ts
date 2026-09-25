/**
 * Separate from the mount because none of it knows anything about the mount:
 * give it a root and prompts, and it works.
 */
import type { PanelState } from "../conversation-panel.ts";
import { currentRound } from "../conversation-rounds.ts";
import { unstampedPill } from "../queued-pill.ts";
import type { ConversationEntry, FeedbackPrompt } from "../../session-store.ts";
import { sendFeedback } from "./session-api.ts";

/**
 * Stamped like the server stamps them. Empty sends append nothing (a bare
 * "reviewer" turn reads as lost words). Stands down if the conversation moved
 * since the send began: the server writes feedback before publishing
 * `feedback`, so a fresh read already carries these words and echoing would
 * double them; a read that raced ahead is one round trip from the one that
 * does — a beat late beats double.
 */
export function echoSent(
  state: PanelState,
  before: ConversationEntry[],
  prompts: FeedbackPrompt[],
): void {
  if (prompts.length === 0 || state.conversation !== before) return;
  state.conversation = [
    ...state.conversation,
    {
      role: "reviewer",
      at: new Date().toISOString(),
      roundIndex: currentRound(state.rounds),
      prompts,
    },
  ];
}

export type Delivery = { sent: true } | { sent: false; why: string };

/** Not sent means the prompts never left the page, so nothing may be cleared. */
export async function deliver(
  key: string,
  prompts: FeedbackPrompt[],
  ended: boolean,
): Promise<Delivery> {
  try {
    const refused = await sendFeedback(key, prompts, ended);
    return refused === undefined ? { sent: true } : { sent: false, why: refused };
  } catch {
    return { sent: false, why: "the review server did not answer; try again" };
  }
}

export function generalCommentBox(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>("#lsr-general-comment");
}

/** Every thread's reply box, each naming its thread in `data-thread`. */
export function replyBoxes(root: HTMLElement): HTMLTextAreaElement[] {
  return [...root.querySelectorAll<HTMLTextAreaElement>(".lsr-thread-reply-box")];
}

export function replyBox(root: HTMLElement, thread: string): HTMLTextAreaElement | undefined {
  return replyBoxes(root).find((box) => box.dataset.thread === thread);
}

/**
 * The reply boxes live inside the scroll, so every redraw replaces them — and
 * a pill queued mid-reply is the ordinary way that happens. What was typed is
 * read before and written back after, rather than rendered in: text ending in
 * whitespace or looking like a tag does not survive markup.
 */
export function typedReplies(root: HTMLElement): Map<string, string> {
  const typed = new Map<string, string>();
  for (const box of replyBoxes(root)) {
    if (box.value !== "" && box.dataset.thread !== undefined)
      typed.set(box.dataset.thread, box.value);
  }
  return typed;
}

export function restoreReplies(root: HTMLElement, typed: Map<string, string>): void {
  for (const [thread, said] of typed) {
    const box = replyBox(root, thread);
    if (box) box.value = said;
  }
}

/**
 * Pills minus the page's round stamps (the server records arrival rounds
 * itself), plus the comment box as one more message.
 */
export function withGeneralComment(
  root: HTMLElement,
  pending: PanelState["pending"],
): FeedbackPrompt[] {
  const prompts = pending.map(unstampedPill);
  const comment = generalCommentBox(root)?.value.trim() ?? "";
  return comment ? [...prompts, { type: "message", comment }] : prompts;
}

export function clearGeneralComment(root: HTMLElement): void {
  const box = generalCommentBox(root);
  if (box) box.value = "";
}
