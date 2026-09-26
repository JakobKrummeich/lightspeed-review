import { escapeHtml } from "../escape-html.ts";
import { currentRound } from "./conversation-rounds.ts";
import { agentTurnText } from "./turn-words.ts";
import type { QueuedPill } from "./queued-pill.ts";
import type { DeliveryFacts } from "./delivery.ts";
import type { ThreadFold } from "./review-memory.ts";
import { renderDrafts, renderGroups, type ColumnState } from "./thread-cards.ts";
import type { ConversationEntry, RoundMark, SessionStatus, Turn } from "../session-store.ts";

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
  /** How far the reviewer's sent words got: held by the server, or picked up. */
  delivery: DeliveryFacts;
  /** The reviewer's own card folds, remembered per review. */
  folds: Record<string, ThreadFold>;
  resolvedShown: boolean;
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
 * pinned: a long conversation must not push send out of reach. New unsent
 * comments sit just above the box they were typed near; the tray under them
 * only counts what goes out on the next Send.
 */
export function renderScroll(state: PanelState): string {
  const column = columnOf(state);
  return `
  <section class="lsr-conversation">
  ${renderGroups(column)}${renderTurnLine(state)}
  </section>
  ${renderDrafts(column)}
  <section class="lsr-queue">
  ${state.pending.length === 0 ? `<p class="lsr-empty">${emptyTray(state)}</p>` : queueCount(state.pending.length)}
  </section>
`;
}

function columnOf(state: PanelState): ColumnState {
  return {
    conversation: state.conversation,
    pending: state.pending,
    mode: composeMode(state),
    status: state.status,
    round: currentRound(state.rounds),
    delivery: state.delivery,
    folds: state.folds,
    resolvedShown: state.resolvedShown,
  };
}

/** The pills themselves are drawn where they will land; this only counts them. */
function queueCount(queued: number): string {
  const rest = queued === 1 ? "it goes" : "they go";
  return `<p class="lsr-queue-count">${queued} not sent yet · ${rest} out with your next Send</p>`;
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
