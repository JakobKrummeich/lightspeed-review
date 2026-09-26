/**
 * A thread card's foot: what the reviewer can do in that thread right now.
 * Its own module because the panel around it is already as long as one file
 * should be; it knows cards only by the few facts it reads.
 */
import { escapeHtml } from "../escape-html.ts";
import type { ThreadMessage } from "../threads.ts";

const REPLY_LABEL = "Reply";
const RESOLVE_LABEL = "Resolve";
const REOPEN_LABEL = "Reopen";

/** The panel's card, as far as its foot is concerned. */
interface FootCard {
  id: string;
  legacy?: true;
  main: boolean;
  messages: readonly Pick<ThreadMessage, "role">[];
}

/** The panel's `ComposeMode`, restated so the two modules do not import each other; a new mode fails to type-check at the call. */
type FootMode = "send" | "locked" | "queue" | "ended";

const WAITING_LINE = `\n    <p class="lsr-thread-waiting">Waiting for the agent…</p>`;

/**
 * The card's foot offers only what the reviewer can do in it now: Reply and
 * Resolve (Reopen once folded) whenever the page takes writing — their own
 * turn, or the agent's working one, which queues — whoever spoke last, since
 * a second message in a row is theirs to send. Legacy words and `main` posts
 * have no thread to answer in.
 */
export function renderThreadFoot(card: FootCard, resolved: boolean, mode: FootMode): string {
  if (!answerable(card)) return "";
  return `${waitingLine(card, resolved, mode)}${writingFoot(card.id, resolved, mode)}`;
}

/**
 * Said only while the agent holds the turn — digesting or working — and owes
 * this thread an answer. On the reviewer's own turn nobody is waited on: the
 * next word there is theirs to write.
 */
function waitingLine(card: FootCard, resolved: boolean, mode: FootMode): string {
  const agentsTurn = mode === "queue" || mode === "locked";
  return agentsTurn && !resolved && !agentSpokeLast(card) ? WAITING_LINE : "";
}

function writingFoot(rawId: string, resolved: boolean, mode: FootMode): string {
  if (!takesWriting(mode)) return "";
  const id = escapeHtml(rawId);
  if (resolved) return threadFoot(actionRow(renderToggle(id, true)));
  return threadFoot(
    `${renderReplyBox(id)}\n      ${actionRow(`${renderReplyAdd(id)}${renderToggle(id, false)}`)}`,
  );
}

/** Legacy words and `main` posts have no thread to answer in. */
function answerable(card: FootCard): boolean {
  return card.legacy !== true && !card.main;
}

function agentSpokeLast(card: FootCard): boolean {
  return card.messages.at(-1)?.role === "agent";
}

/** The reviewer's turn sends, the agent's working one queues; nothing else writes. */
function takesWriting(mode: FootMode): boolean {
  return mode === "send" || mode === "queue";
}

function threadFoot(controls: string): string {
  return `\n    <footer class="lsr-thread-foot">\n      ${controls}\n    </footer>`;
}

/** Under the box, never beside it: a box sharing its row is too narrow to show its own placeholder. */
function actionRow(buttons: string): string {
  return `<div class="lsr-thread-actions">${buttons}\n      </div>`;
}

function renderToggle(id: string, resolved: boolean): string {
  return `\n        <button type="button" class="lsr-thread-action lsr-thread-resolve" data-thread="${id}" aria-expanded="${!resolved}">${resolved ? REOPEN_LABEL : RESOLVE_LABEL}</button>`;
}

/**
 * A reply is one more pill: it goes out with the rest of the batch on the next
 * Send, as the resolve toggle does, so replying in three threads is still one
 * turn for the agent. `id` is escaped by the caller.
 */
function renderReplyBox(id: string): string {
  return `<textarea class="lsr-thread-reply-box" data-thread="${id}" placeholder="Reply — Enter adds it to your next Send…" aria-label="Reply in ${id}"></textarea>`;
}

function renderReplyAdd(id: string): string {
  return `\n        <button type="button" class="lsr-thread-action lsr-thread-reply-add" data-thread="${id}">${REPLY_LABEL}</button>`;
}
