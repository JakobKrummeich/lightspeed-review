import { escapeHtml } from "../escape-html.ts";
import { currentRound, roundSegments, type RoundSegment } from "./conversation-rounds.ts";
import { agentTurnText } from "./turn-words.ts";
import { stalePillRound, type QueuedPill } from "./queued-pill.ts";
import type {
  ConversationEntry,
  AnnotationPrompt,
  DeclaredAnswer,
  FeedbackPrompt,
  RoundMark,
  SessionStatus,
  Turn,
} from "../session-store.ts";

export interface PanelState {
  /** Queued in the browser, not sent yet. */
  pending: QueuedPill[];
  /** Already delivered, oldest first. */
  conversation: ConversationEntry[];
  /** Every round of the review, oldest first: what the history is cut along. */
  rounds: RoundMark[];
  status: SessionStatus;
  /** Every file of the review is ticked: there is nothing left to read. */
  allApproved: boolean;
  /**
   * Whose move it is. The agent holding it takes Send away and nothing else:
   * queueing, ending and typing stay live whatever it says.
   */
  turn: Turn;
  /**
   * The agent's per-comment answers (`say --for <id>`), keyed by the comment's
   * own id. Optional because only the live session carries them; everything
   * else that builds a panel builds conversation and rounds.
   */
  declarations?: Record<string, DeclaredAnswer>;
}

/** The compose row's half of that state, which is all `renderCompose` needs. */
export type ComposeState = Pick<PanelState, "status" | "allApproved" | "turn">;

/**
 * Said once every file is ticked. Holds even with feedback still queued:
 * `Send & End` sends the queue on its way out.
 */
const APPROVED_EVERYTHING = "Every file is approved — Send & End when you are ready.";

/**
 * Named rather than spelled out twice: the mount patches these onto the very
 * elements this markup produced, and drift would leave a button stuck on
 * "Sending…" or promising to send a queue it is about to drop.
 */
export const SEND_LABEL = "Send to Agent";
export const SENDING_LABEL = "Sending…";
export const SEND_END_LABEL = "Send & End";
/** Ending is never gated, but on the agent's turn it takes nothing with it. */
export const END_ONLY_LABEL = "End without Sending";
/** The question card's own press. One word, because it does one thing. */
export const ANSWER_LABEL = "Answer";

/**
 * Whether Send is off. The one gate in the page, and it gates one control: an
 * ended review is locked by its own status, and everything else is locked only
 * while the agent holds the turn.
 */
export function sendIsLocked(state: ComposeState): boolean {
  return state.status === "ended" || state.turn.holder === "agent";
}

/**
 * The whole right-hand panel. Drawn once at mount; afterwards only
 * `renderScroll` is redrawn, so the compose box being typed into is never replaced.
 */
export function renderPanel(state: PanelState): string {
  return `<div class="lsr-panel-scroll">${renderScroll(state)}</div>
<section class="lsr-compose">${renderCompose(state)}</section>`;
}

/**
 * Conversation and queued pills. They share one scroll container so the
 * compose box stays pinned: a long conversation must not push send out of reach.
 */
export function renderScroll(state: PanelState): string {
  const current = currentRound(state.rounds);
  return `
  <section class="lsr-conversation">
  ${renderConversation(state)}${renderTurnLine(state)}
  </section>
  <section class="lsr-queue">
  ${state.pending.length === 0 ? `<p class="lsr-empty">Nothing queued — select diff text to add feedback.</p>` : state.pending.map((pill, index) => renderPill(pill, index, current)).join("\n  ")}
  </section>
`;
}

/** All-approved note; empty for an ended review. */
export function composeNote(state: ComposeState): string {
  return state.status !== "ended" && state.allApproved ? APPROVED_EVERYTHING : "";
}

/**
 * Compose box and send buttons. Ending is never gated — not by the turn, not by
 * anything but the review already being over — so only Send carries the turn's
 * lock, and the end button says what it will do instead of being taken away.
 * The `role="status"` region is always in the markup, only filled/emptied: a
 * region added on demand is announced by no screen reader reliably.
 */
export function renderCompose(state: ComposeState): string {
  const ended = state.status === "ended";
  return `
  <p class="lsr-complete" role="status">${escapeHtml(composeNote(state))}</p>
  <textarea id="lsr-general-comment" placeholder="General comment — Enter sends…"${ended ? " disabled" : ""}></textarea>
  <div class="lsr-compose-actions">
    <button type="button" id="lsr-send" class="lsr-primary"${sendIsLocked(state) ? " disabled" : ""}>${SEND_LABEL}</button>
    <button type="button" id="lsr-send-end" class="lsr-secondary"${ended ? " disabled" : ""}>${escapeHtml(endLabel(state))}</button>
  </div>
  ${ended ? `<p class="lsr-ended">This review has ended.</p>` : ""}
`;
}

/**
 * What ending does from here. On the agent's turn the queue is not the
 * reviewer's to send, so the press ends the review and leaves the pills behind
 * — said on the button, because learning it from the conversation afterwards is
 * how a reviewer loses six comments.
 */
export function endLabel(state: ComposeState): string {
  return state.turn.holder === "agent" && state.status !== "ended"
    ? END_ONLY_LABEL
    : SEND_END_LABEL;
}

/**
 * Whose move it is, at the foot of the conversation, where the answer will
 * appear — after Send the eye is here, not on the header's corner. The
 * reviewer's own turn says nothing: Send is live and the page is theirs.
 * Silent once ended: the closing summary is about to cover the page.
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
 * The question the reviewer still owes an answer to, or none. A question is open
 * while nothing has been said after it: the agent asked and then blocked, so the
 * next words in the conversation are the answer, whatever else they are about.
 * Identity, not a flag — the renderer below asks "is this that prompt?" and two
 * questions with the same words are still two questions.
 */
function openQuestion(state: PanelState): FeedbackPrompt | undefined {
  if (state.status === "ended") return undefined;
  const last = state.conversation.at(-1);
  if (last?.role !== "agent") return undefined;
  const asked = last.prompts.at(-1);
  return asked?.type === "message" && asked.kind === "question" ? asked : undefined;
}

/** What an entry needs from the panel's state, so the walk below passes one thing. */
interface EntryContext {
  declarations?: Record<string, DeclaredAnswer>;
  /** The one question drawn with a live answer box, by identity. */
  open?: FeedbackPrompt;
}

/**
 * History ruled into rounds. A conversation that never crossed a round
 * boundary stays a plain stream: one label over everything is furniture.
 */
function renderConversation(state: PanelState): string {
  const segments = roundSegments(state.conversation, state.rounds);
  const ruled = segments.length > 1;
  const context: EntryContext = { declarations: state.declarations, open: openQuestion(state) };
  const parts: string[] = [];
  for (const segment of segments) {
    if (ruled) parts.push(renderRoundMark(segment));
    for (const entry of segment.entries) {
      parts.push(renderEntry(entry, segment, context));
    }
  }
  return parts.join("\n  ");
}

/**
 * The line between two rounds: which round follows, and whether it is the one
 * on screen — answers "was this the round I already had?" while scrolling.
 */
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
    <header class="lsr-entry-role">${entry.role}</header>
    ${entry.prompts.map((prompt) => renderPrompt(prompt, context)).join("\n    ")}
  </article>`;
}

function renderPrompt(prompt: FeedbackPrompt, context: EntryContext): string {
  const asked = isQuestion(prompt);
  return `<div class="lsr-prompt"${asked ? ` data-kind="question"` : ""}>${renderQuestionLabel(asked)}${renderPromptBody(prompt)}${renderAnswerBox(prompt === context.open)}${renderAnswer(prompt, context.declarations)}</div>`;
}

function isQuestion(prompt: FeedbackPrompt): boolean {
  return prompt.type === "message" && prompt.kind === "question";
}

/**
 * A question wears its label even once answered. The card is how a reviewer
 * scrolling back tells the sentence they were asked from the sentences the agent
 * merely said — and a card that lost its label on being answered would make the
 * history read as if nobody had ever asked anything.
 */
function renderQuestionLabel(asked: boolean): string {
  return asked ? `<p class="lsr-question-label">the agent is asking</p>\n    ` : "";
}

/**
 * The answer box under the open question, and the reason `ask` exists as its own
 * verb: the reviewer answers in one press, and the queue they have been building
 * stays queued. Sending the queue along would make answering a question cost
 * them six half-finished comments.
 *
 * Only the open question gets one. An answered question with a box under it
 * would invite an answer to a question the agent has stopped waiting on.
 */
function renderAnswerBox(open: boolean): string {
  if (!open) return "";
  return `\n    <div class="lsr-answer">
    <textarea class="lsr-answer-box" placeholder="Answer — sends this alone…" aria-label="Answer the agent's question"></textarea>
    <button type="button" class="lsr-answer-send">${ANSWER_LABEL}</button>
    </div>`;
}

/**
 * The agent's declared answer (`say "<text>" --for <id>`), rendered inside the
 * prompt it answers. Files-only declarations show nothing: "I touched these"
 * is the between-rounds diff's story.
 */
function renderAnswer(
  prompt: FeedbackPrompt,
  declarations?: Record<string, DeclaredAnswer>,
): string {
  if (prompt.type !== "annotation" || prompt.id === undefined) return "";
  const note = declarations?.[prompt.id]?.note;
  if (note === undefined) return "";
  return `\n    <div class="lsr-prompt-answer">
    <p class="lsr-prompt-answer-label">the agent's answer</p>
    <p class="lsr-prompt-answer-note">${escapeHtml(note)}</p>
    </div>`;
}

function renderPill(pill: QueuedPill, index: number, current: number): string {
  return `<div class="lsr-pill">
    ${renderStaleBadge(pill, current)}${renderPromptBody(pill)}
    <button type="button" class="lsr-pill-remove" data-index="${index}" title="Remove">×</button>
  </div>`;
}

/**
 * Badge on a pill that outlived its round: still sendable, but its lines may
 * no longer be the lines on screen. No stamp, no badge: absence is not a claim.
 */
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
  const comment = `<p class="lsr-prompt-comment">${escapeHtml(prompt.comment)}</p>`;
  if (prompt.type === "message") return comment;
  return `${renderFilePress(prompt)}
    <pre class="lsr-prompt-selection">${escapeHtml(prompt.selected_text)}</pre>
    ${comment}`;
}

/**
 * The comment's file as a press leading back to its lines. Basename only; full
 * path in the tooltip — every comment paying the path's width glued the card
 * into one block. Anchor rides along as data; without one the press still
 * opens the file.
 */
function renderFilePress(prompt: AnnotationPrompt): string {
  const path = escapeHtml(prompt.file);
  const anchor =
    prompt.side === undefined ? "" : ` data-side="${prompt.side}" data-line="${prompt.line_start}"`;
  const name = escapeHtml(prompt.file.split("/").at(-1) ?? prompt.file);
  return `<button type="button" class="lsr-prompt-file" data-file="${path}"${anchor} title="${path}">${name}</button>`;
}
