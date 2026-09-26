import { escapeHtml } from "../escape-html.ts";
import { currentRound, roundSegments, type RoundSegment } from "./conversation-rounds.ts";
import { agentTurnText } from "./turn-words.ts";
import { stalePillRound, type QueuedPill } from "./queued-pill.ts";
import { MAIN_THREAD, threadsOf, type Thread, type ThreadMessage } from "../threads.ts";
import type {
  ConversationEntry,
  AnnotationPrompt,
  FeedbackPrompt,
  RoundMark,
  SessionStatus,
  Turn,
} from "../session-store.ts";

export interface PanelState {
  pending: QueuedPill[];
  /** Oldest first. */
  conversation: ConversationEntry[];
  /** Oldest first. */
  rounds: RoundMark[];
  status: SessionStatus;
  allApproved: boolean;
  turn: Turn;
  /** How many items the agent is reading; only while it digests. */
  items?: number;
}

export type ComposeState = Pick<PanelState, "status" | "allApproved" | "turn">;

/**
 * The lock matrix, one word per state. `send`: the reviewer's turn, Send sends
 * and the queued pills go with it. `locked`: the agent digests — short, and its
 * replies should answer exactly what the reviewer saw, so nothing that writes
 * is live (compose, thread replies, resolve, the line popup, the queue); the
 * diff can still be read and files approved. `queue`: the agent works, and
 * everything the reviewer writes queues for the next round. End is never
 * locked but by the review being over.
 */
export type ComposeMode = "send" | "locked" | "queue" | "ended";

export function composeMode(state: ComposeState): ComposeMode {
  if (state.status === "ended") return "ended";
  if (state.turn.holder === "reviewer") return "send";
  return state.turn.mode === "working" ? "queue" : "locked";
}

/** Nothing may be written — not sent, not queued. */
export function writesLocked(state: ComposeState): boolean {
  const mode = composeMode(state);
  return mode === "locked" || mode === "ended";
}

/** Holds even with feedback still queued: `Send & End` sends the queue on its way out. */
const APPROVED_EVERYTHING = "Every file is approved — Send & End when you are ready.";
const QUEUE_NOTE = "Queued items go into the next round.";
const LOCKED_NOTE = "Locked while the agent reads your feedback — you can still read and approve.";

/**
 * Named rather than spelled out twice: the mount patches these onto the very
 * elements this markup produced, and drift would leave a button stuck on
 * "Sending…" or promising to send a queue it is about to drop.
 */
export const SEND_LABEL = "Send to Agent";
export const QUEUE_LABEL = "Queue";
export const SENDING_LABEL = "Sending…";
export const SEND_END_LABEL = "Send & End";
export const END_ONLY_LABEL = "End without Sending";
export const REPLY_LABEL = "Reply";
export const RESOLVE_LABEL = "Resolve";
export const REOPEN_LABEL = "Reopen";

/** Whether words may reach the agent now: only on the reviewer's own turn. */
export function sendIsLocked(state: ComposeState): boolean {
  return composeMode(state) !== "send";
}

/**
 * While the agent works the primary button is not taken away but turned into
 * the tray's own verb, so a general comment can wait out the turn beside the
 * line comments instead of being held in the box, one at a time.
 */
export function queuesInstead(state: ComposeState): boolean {
  return composeMode(state) === "queue";
}

/**
 * "Agent isn't listening" still reads `Send to Agent`: that press goes to the
 * server, into the conversation, and out of the reviewer's hands — the agent's
 * next listening command is handed it. `Queue` promises a pill the reviewer can
 * still take back, and only the agent's working turn keeps that promise.
 *
 * On the reviewer's turn the label counts the tray: pills queued through the
 * agent's turn do not go out by themselves, and once the turn is back nothing
 * else on the page says they are still waiting on a press.
 */
export function sendLabel(state: ComposeState, queued = 0): string {
  if (queuesInstead(state)) return QUEUE_LABEL;
  return queued > 0 && state.status !== "ended" ? `Send ${queued} to Agent` : SEND_LABEL;
}

/** Said into the compose row's hidden region: a Queue press empties the box and
 * adds a pill somewhere a reader following the box never looks. */
export function queuedAnnouncement(queued: number): string {
  return `Queued — ${queued} waiting for your next Send`;
}

export function composePlaceholder(state: ComposeState): string {
  const mode = composeMode(state);
  if (mode === "queue") return "General comment — Enter queues…";
  if (mode === "locked") return "Locked while the agent reads your feedback";
  return "General comment — Enter sends…";
}

/**
 * Drawn once at mount; afterwards only `renderScroll` is redrawn, so the
 * compose box being typed into is never replaced.
 */
export function renderPanel(state: PanelState): string {
  return `<div class="lsr-panel-scroll">${renderScroll(state)}</div>
<section class="lsr-compose">${renderCompose(state, state.pending.length)}</section>`;
}

/**
 * One scroll container for conversation and queue, so the compose box stays
 * pinned: a long conversation must not push send out of reach.
 */
export function renderScroll(state: PanelState): string {
  const current = currentRound(state.rounds);
  return `
  <section class="lsr-conversation">
  ${renderConversation(state)}${renderTurnLine(state)}
  </section>
  <section class="lsr-queue">
  ${state.pending.length === 0 ? `<p class="lsr-empty">${emptyTray(state)}</p>` : state.pending.map((pill, index) => renderPill(pill, index, current)).join("\n  ")}
  </section>
`;
}

/**
 * Only the working turn points at the box: on the reviewer's own the box sends,
 * and pointing at it from the tray would promise a pill that never appears.
 */
function emptyTray(state: PanelState): string {
  const mode = composeMode(state);
  if (mode === "queue") {
    return "Nothing queued — select diff text, reply in a thread, or type below.";
  }
  if (mode === "send")
    return "Nothing queued — select diff text or reply in a thread to add feedback.";
  return "Nothing queued.";
}

export function composeNote(state: ComposeState): string {
  const mode = composeMode(state);
  if (mode === "queue") return QUEUE_NOTE;
  if (mode === "locked") return LOCKED_NOTE;
  return mode === "send" && state.allApproved ? APPROVED_EVERYTHING : "";
}

/**
 * Ending is never gated — not by the turn, not by anything but the review
 * already being over. The primary button and the box are, while the agent
 * digests; while it works they queue, and say so. Both
 * `role="status"` regions are always in the markup, only filled/emptied: a
 * region added on demand is announced by no screen reader reliably.
 */
export function renderCompose(state: ComposeState, queued = 0): string {
  const ended = state.status === "ended";
  const locked = writesLocked(state);
  return `
  <p class="lsr-complete" role="status">${escapeHtml(composeNote(state))}</p>
  <textarea id="lsr-general-comment" placeholder="${escapeHtml(composePlaceholder(state))}"${locked ? " disabled" : ""}></textarea>
  <div class="lsr-compose-actions">
    <button type="button" id="lsr-send" class="lsr-primary"${locked ? " disabled" : ""}>${escapeHtml(sendLabel(state, queued))}</button>
    <button type="button" id="lsr-send-end" class="lsr-secondary"${ended ? " disabled" : ""}>${escapeHtml(endLabel(state))}</button>
  </div>
  <p id="lsr-queue-status" class="lsr-visually-hidden" role="status"></p>
  ${ended ? `<p class="lsr-ended">This review has ended.</p>` : ""}
`;
}

/**
 * On the agent's turn the queue is not the reviewer's to send, so the press
 * ends the review and leaves the pills behind — said on the button, because
 * learning it from the conversation afterwards is how a reviewer loses six comments.
 */
export function endLabel(state: ComposeState): string {
  return state.turn.holder === "agent" && state.status !== "ended"
    ? END_ONLY_LABEL
    : SEND_END_LABEL;
}

/**
 * At the foot of the conversation, where the answer will appear — after Send
 * the eye is here, not on the header's corner. The reviewer's own turn says
 * nothing: Send is live and the page is theirs. Silent once ended: the closing
 * summary is about to cover the page.
 */
function renderTurnLine(state: PanelState): string {
  if (state.turn.holder !== "agent" || state.status === "ended") return "";
  // Decorative; the sentence beside them carries the meaning.
  return `
  <p class="lsr-working">
    <span class="lsr-working-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    ${escapeHtml(agentTurnText(state.turn, state.items))}
  </p>`;
}

/**
 * Threads, not a stream: every item the reviewer sent is a card with its whole
 * exchange stacked under it, oldest first, and a reply box at the foot. Placed
 * by the round the item opened in, so a thread stays where it was read. A
 * conversation that never crossed a round boundary gets no round rule: one
 * label over everything is furniture.
 */
function renderConversation(state: PanelState): string {
  const segments = roundSegments(cardsOf(state), state.rounds);
  const ruled = segments.length > 1;
  const pending = pendingResolves(state.pending);
  const mode = composeMode(state);
  const parts: string[] = [];
  for (const segment of segments) {
    if (ruled) parts.push(renderRoundMark(segment));
    for (const card of segment.entries) {
      parts.push(renderThread(card, segment, pending.get(card.id), mode));
    }
  }
  return parts.join("\n  ");
}

/** A thread as the panel draws it: `main` split into one card per post. */
interface Card extends Thread {
  /** The agent has spoken in it since the reviewer's last Send. */
  fresh: boolean;
  main: boolean;
}

/**
 * Threads stay where they opened, but a thread the agent spoke in since the
 * reviewer's last Send is news: left in place, an answer in an old thread sat
 * rounds above the fold. Those move to the foot of the current round, latest
 * activity last, as a chat reads. Each `main` post is its own card — one
 * ever-growing card read as one old thread.
 */
function cardsOf(state: PanelState): Card[] {
  const lastSend = state.conversation.findLast((entry) => entry.role === "reviewer")?.at ?? "";
  const cards = threadsOf(state.conversation)
    .flatMap(splitMain)
    .map((thread) => ({
      ...thread,
      // Legacy words are history from before 3.0: never news, whatever their stamp.
      fresh:
        thread.legacy !== true &&
        thread.messages.some((said) => said.role === "agent" && said.at > lastSend),
    }));
  // Stable, so threads opened in one moment keep the order they were sent in.
  const settled = cards.filter((card) => !card.fresh).sort((a, b) => order(a.at, b.at));
  const current = currentRound(state.rounds);
  const news = cards
    .filter((card) => card.fresh)
    .map((card) => ({ ...card, at: latestOf(card), roundIndex: current }))
    .sort((a, b) => order(a.at, b.at));
  return [...settled, ...news];
}

function splitMain(thread: Thread): Omit<Card, "fresh">[] {
  if (thread.id !== MAIN_THREAD) return [{ ...thread, main: false }];
  return thread.messages.map((said) => ({
    ...thread,
    messages: [said],
    at: said.at,
    ...(said.roundIndex === undefined ? {} : { roundIndex: said.roundIndex }),
    main: true,
  }));
}

function latestOf(thread: Thread): string {
  return thread.messages.reduce((latest, said) => (said.at > latest ? said.at : latest), thread.at);
}

function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A resolve is queued like any pill and travels with the next Send, but the
 * thread folds at the press: tidying the overview is what the toggle is for.
 * The last queued toggle per thread wins.
 */
function pendingResolves(pending: readonly QueuedPill[]): Map<string, boolean> {
  const resolves = new Map<string, boolean>();
  for (const pill of pending) if (pill.type === "resolve") resolves.set(pill.thread, pill.resolved);
  return resolves;
}

function renderRoundMark(segment: RoundSegment<Card>): string {
  // Escaped: comes from a session file, which may be hand-edited.
  const name = escapeHtml(`Round ${segment.round + 1}`);
  const note = segment.current ? "reviewing now" : "earlier round";
  return `<div class="lsr-round-mark" data-round-state="${roundState(segment)}" role="separator" aria-label="${name}, ${note}">
    <span class="lsr-round-name">${name}</span>
    <span class="lsr-round-note">${note}</span>
  </div>`;
}

/** The two states the stylesheet knows, as a type rather than a convention. */
function roundState(segment: RoundSegment<Card>): "current" | "earlier" {
  return segment.current ? "current" : "earlier";
}

/**
 * Resolved folds the whole thread to its head, which keeps the item's words as
 * a one-line summary so the fold still says which thread it is.
 */
function renderThread(
  card: Card,
  segment: RoundSegment<Card>,
  queued: boolean | undefined,
  mode: ComposeMode,
): string {
  const resolved = queued ?? card.resolved;
  const body = resolved ? "" : `\n    ${renderThreadBody(card)}`;
  return `<article class="lsr-thread" data-round-state="${roundState(segment)}" data-resolved="${resolved}"${card.fresh ? ` data-new="true"` : ""}${card.legacy ? ` data-legacy="true"` : ""}>
    ${renderThreadHead(card, resolved, queued !== undefined)}${body}${renderThreadFoot(card, resolved, mode)}
  </article>`;
}

function renderThreadHead(card: Card, resolved: boolean, queued: boolean): string {
  const file = card.item?.type === "annotation" ? renderFilePress(card.item) : "";
  const summary = resolved
    ? `<p class="lsr-thread-summary">${escapeHtml(threadSummary(card))}</p>`
    : "";
  if (card.legacy) return `<header class="lsr-thread-head">${file}</header>${summary}`;
  const id = escapeHtml(card.id);
  return `<header class="lsr-thread-head"><span class="lsr-thread-id">${id}</span>${newMark(card)}${file}${queuedMark(resolved, queued)}</header>${summary}`;
}

const WAITING_LINE = `\n    <p class="lsr-thread-waiting">Waiting for the agent…</p>`;

/**
 * The card's foot offers only what the reviewer can do in it now. Reply and
 * Resolve once the agent has had the last word and the page takes writing —
 * their own turn, or the agent's working one, which queues. Their own last
 * word is the agent's to answer, and says so quietly rather than inviting a
 * second message on top. A folded thread's Reopen follows the page's lock
 * alone: whoever spoke last, reopening is the reviewer's call. Legacy words
 * and `main` posts have no thread to answer in.
 */
function renderThreadFoot(card: Card, resolved: boolean, mode: ComposeMode): string {
  if (!answerable(card)) return "";
  if (!resolved && !agentSpokeLast(card)) return mode === "ended" ? "" : WAITING_LINE;
  if (!takesWriting(mode)) return "";
  const id = escapeHtml(card.id);
  if (resolved) return threadFoot(renderToggle(id, true));
  return threadFoot(`${renderReplyControls(id)}\n      ${renderToggle(id, false)}`);
}

/** Legacy words and `main` posts have no thread to answer in. */
function answerable(card: Card): boolean {
  return card.legacy !== true && !card.main;
}

function agentSpokeLast(card: Card): boolean {
  return card.messages.at(-1)?.role === "agent";
}

/** The reviewer's turn sends, the agent's working one queues; nothing else writes. */
function takesWriting(mode: ComposeMode): boolean {
  return mode === "send" || mode === "queue";
}

function threadFoot(controls: string): string {
  return `\n    <footer class="lsr-thread-foot">\n      ${controls}\n    </footer>`;
}

function newMark(card: Card): string {
  return card.fresh ? `<span class="lsr-thread-new">new</span>` : "";
}

function queuedMark(resolved: boolean, queued: boolean): string {
  if (!queued) return "";
  return `<span class="lsr-thread-queued">${resolved ? "resolves" : "reopens"} on your next Send</span>`;
}

function renderToggle(id: string, resolved: boolean): string {
  return `<button type="button" class="lsr-thread-resolve" data-thread="${id}" aria-expanded="${!resolved}">${resolved ? REOPEN_LABEL : RESOLVE_LABEL}</button>`;
}

function threadSummary(thread: Thread): string {
  return thread.messages[0]?.comment ?? "the agent's own messages";
}

/**
 * Each message its own block, never nested deeper: you → agent → you… for as
 * many turns as it takes. What the reviewer can do next is the foot's.
 */
function renderThreadBody(card: Card): string {
  const selection =
    card.item?.type === "annotation"
      ? `<pre class="lsr-prompt-selection">${escapeHtml(card.item.selected_text)}</pre>\n    `
      : "";
  return `${selection}${card.messages.map(renderMessage).join("\n    ")}`;
}

function renderMessage(message: ThreadMessage): string {
  const who = message.role === "reviewer" ? "you" : "agent";
  return `<div class="lsr-message" data-role="${message.role}">
      <p class="lsr-message-role">${who}</p>
      <p class="lsr-prompt-comment">${escapeHtml(message.comment)}</p>
    </div>`;
}

/**
 * A reply is one more pill: it goes out with the rest of the batch on the next
 * Send, as the resolve toggle does, so replying in three threads is still one
 * turn for the agent. `id` is escaped by the caller.
 */
function renderReplyControls(id: string): string {
  return `<textarea class="lsr-thread-reply-box" data-thread="${id}" placeholder="Reply — Enter adds it to your next Send…" aria-label="Reply in ${id}"></textarea>
      <button type="button" class="lsr-thread-reply-add lsr-secondary" data-thread="${id}">${REPLY_LABEL}</button>`;
}

function renderPill(pill: QueuedPill, index: number, current: number): string {
  return `<div class="lsr-pill">
    ${renderStaleBadge(pill, current)}${renderPillThread(pill)}${renderPromptBody(pill)}
    <button type="button" class="lsr-pill-remove" data-index="${index}" title="Remove">×</button>
  </div>`;
}

/** A reply in the tray names the thread it goes to; the card it will land under is elsewhere. */
function renderPillThread(pill: QueuedPill): string {
  if (pill.type !== "reply") return "";
  return `<span class="lsr-pill-thread">${escapeHtml(`reply in ${pill.thread}`)}</span>\n    `;
}

/** No stamp, no badge: absence is not a claim. */
function renderStaleBadge(pill: QueuedPill, current: number): string {
  const stale = stalePillRound(pill, current);
  if (stale === undefined) return "";
  // Escaped: comes from `localStorage`, which may be hand-edited.
  const name = escapeHtml(`round ${stale + 1}`);
  const why = escapeHtml(
    `Queued in round ${stale + 1} — the diff has changed since, so its lines may not line up.`,
  );
  return `<span class="lsr-pill-round" role="note" title="${why}" aria-label="${why}">${name}</span>\n    `;
}

function renderPromptBody(prompt: FeedbackPrompt): string {
  if (prompt.type === "resolve") {
    return `<p class="lsr-prompt-comment">${escapeHtml(`${prompt.resolved ? "resolve" : "reopen"} ${prompt.thread}`)}</p>`;
  }
  const comment = `<p class="lsr-prompt-comment">${escapeHtml(prompt.comment)}</p>`;
  if (prompt.type !== "annotation") return comment;
  return `${renderFilePress(prompt)}
    <pre class="lsr-prompt-selection">${escapeHtml(prompt.selected_text)}</pre>
    ${comment}`;
}

/**
 * Basename only; full path in the tooltip — every comment paying the path's
 * width glued the card into one block. Without an anchor the press still opens the file.
 */
function renderFilePress(prompt: AnnotationPrompt): string {
  const path = escapeHtml(prompt.file);
  const anchor =
    prompt.side === undefined ? "" : ` data-side="${prompt.side}" data-line="${prompt.line_start}"`;
  const name = escapeHtml(prompt.file.split("/").at(-1) ?? prompt.file);
  return `<button type="button" class="lsr-prompt-file" data-file="${path}"${anchor} title="${path}">${name}</button>`;
}
