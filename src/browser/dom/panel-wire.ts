/**
 * The panel's boxes and the wire under them: where the reviewer's words are
 * read from, how they reach the server, and how they land in the conversation
 * without waiting for a round trip. Separate from the mount because none of it
 * knows anything about the mount — give it a root and prompts, and it works.
 */
import type { PanelState } from "../conversation-panel.ts";
import { currentRound } from "../conversation-rounds.ts";
import { unstampedPill } from "../queued-pill.ts";
import type { ConversationEntry, FeedbackPrompt } from "../../session-store.ts";
import { sendFeedback } from "./session-api.ts";

/**
 * Echoes the sent prompts onto the conversation, stamped like the server
 * stamps them. Empty sends append nothing (a bare "reviewer" turn reads as
 * lost words). Stands down if the conversation moved since the send began:
 * the server writes feedback before publishing `feedback`, so a fresh read
 * already carries these words and echoing would double them; a read that
 * raced ahead is one round trip from the one that does — a beat late beats double.
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

/** False means the prompts never left the page, so nothing may be cleared. */
export async function deliver(
  key: string,
  prompts: FeedbackPrompt[],
  ended: boolean,
): Promise<boolean> {
  try {
    await sendFeedback(key, prompts, ended);
    return true;
  } catch {
    console.error("lightspeed: feedback was not delivered — nothing was cleared");
    return false;
  }
}

export function generalCommentBox(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>("#lsr-general-comment");
}

/** The open question's box, or none — there is at most one open question. */
export function answerBox(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>(".lsr-answer-box");
}

/** Written back rather than rendered in, for the reason the compose draft is:
 * text ending in whitespace or looking like a tag does not survive markup. */
export function restoreAnswer(root: HTMLElement, said: string): void {
  if (said === "") return;
  const box = answerBox(root);
  if (box) box.value = said;
}

/**
 * What goes on the wire: pills minus the page's round stamps (the server
 * records arrival rounds itself), plus the comment box as one more message.
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
