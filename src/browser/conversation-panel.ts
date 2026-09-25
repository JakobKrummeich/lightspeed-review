import { escapeHtml } from "../escape-html.ts";
import { currentRound, roundSegments, type RoundSegment } from "./conversation-rounds.ts";
import { agentTurnText } from "./turn-words.ts";
import { stalePillRound, type QueuedPill } from "./queued-pill.ts";
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
}

export type ComposeState = Pick<PanelState, "status" | "allApproved" | "turn">;

/** Holds even with feedback still queued: `Send & End` sends the queue on its way out. */
const APPROVED_EVERYTHING = "Every file is approved — Send & End when you are ready.";

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
export const ANSWER_LABEL = "Answer";

/**
 * Whether words may reach the agent now. It takes no button away: the primary
 * button queues instead while it holds on an open review (`queuesInstead`),
 * and the question card's Answer is refused. An ended review is locked by its
 * own status, and everything else only while the agent holds the turn.
 */
export function sendIsLocked(state: ComposeState): boolean {
  return state.status === "ended" || state.turn.holder === "agent";
}

/**
 * Queue always: on the agent's turn the primary button is not taken away but
 * turned into the tray's own verb, so a general comment can wait out the turn
 * beside the line comments instead of being held in the box, one at a time.
 * An ended review queues nothing — there is no next send to queue for.
 */
export function queuesInstead(state: ComposeState): boolean {
  return sendIsLocked(state) && state.status !== "ended";
}

/**
 * "No agent is waiting" still reads `Send to Agent`: that press goes to the
 * server, into the conversation, and out of the reviewer's hands — the agent's
 * next `wait` is handed it. `Queue` promises a pill the reviewer can still take
 * back, and only the agent's turn keeps that promise.
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
  return queuesInstead(state)
    ? "General comment — Enter queues…"
    : "General comment — Enter sends…";
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
 * Only the agent's turn points at the box: on the reviewer's own the box sends,
 * and pointing at it from the tray would promise a pill that never appears.
 */
function emptyTray(state: PanelState): string {
  return queuesInstead(state)
    ? "Nothing queued — select diff text, or type below, to add feedback."
    : "Nothing queued — select diff text to add feedback.";
}

export function composeNote(state: ComposeState): string {
  return state.status !== "ended" && state.allApproved ? APPROVED_EVERYTHING : "";
}

/**
 * Ending is never gated — not by the turn, not by anything but the review
 * already being over — and neither is the primary button, which queues on the
 * agent's turn; both say what they will do instead of being taken away. Both
 * `role="status"` regions are always in the markup, only filled/emptied: a
 * region added on demand is announced by no screen reader reliably.
 */
export function renderCompose(state: ComposeState, queued = 0): string {
  const ended = state.status === "ended";
  return `
  <p class="lsr-complete" role="status">${escapeHtml(composeNote(state))}</p>
  <textarea id="lsr-general-comment" placeholder="${escapeHtml(composePlaceholder(state))}"${ended ? " disabled" : ""}></textarea>
  <div class="lsr-compose-actions">
    <button type="button" id="lsr-send" class="lsr-primary"${ended ? " disabled" : ""}>${escapeHtml(sendLabel(state, queued))}</button>
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
    ${escapeHtml(agentTurnText(state.turn))}
  </p>`;
}

/**
 * A question is open while nothing has been said after it: the agent asked and
 * then blocked, so the next words in the conversation are the answer, whatever
 * else they are about. Identity, not a flag — the renderer below asks "is this
 * that prompt?" and two questions with the same words are still two questions.
 */
function openQuestion(state: PanelState): FeedbackPrompt | undefined {
  if (state.status === "ended") return undefined;
  const last = state.conversation.at(-1);
  if (last?.role !== "agent") return undefined;
  const asked = last.prompts.at(-1);
  return asked?.type === "message" && asked.kind === "question" ? asked : undefined;
}

interface EntryContext {
  open?: FeedbackPrompt;
}

/**
 * A conversation that never crossed a round boundary stays a plain stream: one
 * label over everything is furniture.
 */
function renderConversation(state: PanelState): string {
  const segments = roundSegments(state.conversation, state.rounds);
  const ruled = segments.length > 1;
  const context: EntryContext = { open: openQuestion(state) };
  const parts: string[] = [];
  for (const segment of segments) {
    if (ruled) parts.push(renderRoundMark(segment));
    for (const entry of segment.entries) {
      parts.push(renderEntry(entry, segment, context));
    }
  }
  return parts.join("\n  ");
}

function renderRoundMark(segment: RoundSegment): string {
  // Escaped: comes from a session file, which may be hand-edited.
  const name = escapeHtml(`Round ${segment.round + 1}`);
  const note = segment.current ? "reviewing now" : "earlier round";
  return `<div class="lsr-round-mark" data-round-state="${roundState(segment)}" role="separator" aria-label="${name}, ${note}">
    <span class="lsr-round-name">${name}</span>
    <span class="lsr-round-note">${note}</span>
  </div>`;
}

/** The two states the stylesheet knows, as a type rather than a convention. */
function roundState(segment: RoundSegment): "current" | "earlier" {
  return segment.current ? "current" : "earlier";
}

function renderEntry(
  entry: ConversationEntry,
  segment: RoundSegment,
  context: EntryContext,
): string {
  return `<article class="lsr-entry" data-round-state="${roundState(segment)}" data-role="${entry.role}">
    ${renderRoleLabel(entry)}${entry.prompts.map((prompt) => renderPrompt(prompt, context)).join("\n    ")}
  </article>`;
}

/**
 * A card that opens with a question is headed by the question's own label,
 * "the agent is asking", which already says who speaks: the role label over it
 * stacked two headers of one voice, in one colour.
 */
function renderRoleLabel(entry: ConversationEntry): string {
  const first = entry.prompts[0];
  if (first !== undefined && isQuestion(first)) return "";
  return `<header class="lsr-entry-role">${entry.role}</header>\n    `;
}

function renderPrompt(prompt: FeedbackPrompt, context: EntryContext): string {
  const asked = isQuestion(prompt);
  return `<div class="lsr-prompt"${asked ? ` data-kind="question"` : ""}>${renderQuestionLabel(asked)}${renderPromptBody(prompt)}${renderAnswerBox(prompt === context.open)}</div>`;
}

function isQuestion(prompt: FeedbackPrompt): boolean {
  return prompt.type === "message" && prompt.kind === "question";
}

/**
 * A question wears its label even once answered: a card that lost its label on
 * being answered would make the history read as if nobody had ever asked anything.
 */
function renderQuestionLabel(asked: boolean): string {
  return asked ? `<p class="lsr-question-label">the agent is asking</p>\n    ` : "";
}

/**
 * The reviewer answers in one press and the queue they have been building
 * stays queued: sending it along would make answering a question cost them
 * six half-finished comments. Only the open question gets a box — one under
 * an answered question would invite an answer to a question the agent has
 * stopped waiting on.
 */
function renderAnswerBox(open: boolean): string {
  if (!open) return "";
  return `\n    <div class="lsr-answer">
    <textarea class="lsr-answer-box" placeholder="Answer — sends this alone…" aria-label="Answer the agent's question"></textarea>
    <button type="button" class="lsr-answer-send">${ANSWER_LABEL}</button>
    </div>`;
}

function renderPill(pill: QueuedPill, index: number, current: number): string {
  return `<div class="lsr-pill">
    ${renderStaleBadge(pill, current)}${renderPromptBody(pill)}
    <button type="button" class="lsr-pill-remove" data-index="${index}" title="Remove">×</button>
  </div>`;
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
    return `<p class="lsr-prompt-comment">${escapeHtml(`${prompt.resolved ? "resolved" : "reopened"} ${prompt.thread}`)}</p>`;
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
