import { escapeHtml } from "../escape-html.ts";
import { currentRound, roundSegments, type RoundSegment } from "./conversation-rounds.ts";
import { stalePillRound, type QueuedPill } from "./queued-pill.ts";
import type {
  ConversationEntry,
  AnnotationPrompt,
  DeclaredAnswer,
  FeedbackPrompt,
  RoundMark,
  SessionStatus,
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
  /** An agent is off acting on feedback a poll already took away. */
  agentWorking: boolean;
  /**
   * The agent's per-comment answers (`poll --for <id> --note`), keyed by the
   * comment's own id. Optional because only the live session carries them;
   * everything else that builds a panel builds conversation and rounds.
   */
  declarations?: Record<string, DeclaredAnswer>;
}

/** The compose row's half of that state, which is all `renderCompose` needs. */
export type ComposeState = Pick<PanelState, "status" | "allApproved">;

/**
 * Said once every file is ticked. Holds even with feedback still queued:
 * `Send & End` sends the queue on its way out.
 */
const APPROVED_EVERYTHING = "Every file is approved — Send & End when you are ready.";

/**
 * Named rather than spelled out twice: the mount patches these onto the very
 * element this markup produced, and drift would leave the button stuck on
 * "Sending…".
 */
export const SEND_LABEL = "Send to Agent";
export const SENDING_LABEL = "Sending…";

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
  ${renderConversation(state)}${renderWorking(state)}
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
 * Compose box and send buttons, disabled once ended. The `role="status"`
 * region is always in the markup, only filled/emptied: a region added on
 * demand is announced by no screen reader reliably.
 */
export function renderCompose(state: ComposeState): string {
  const ended = state.status === "ended";
  return `
  <p class="lsr-complete" role="status">${escapeHtml(composeNote(state))}</p>
  <textarea id="lsr-general-comment" placeholder="General comment — Enter sends…"${ended ? " disabled" : ""}></textarea>
  <div class="lsr-compose-actions">
    <button type="button" id="lsr-send" class="lsr-primary"${ended ? " disabled" : ""}>${SEND_LABEL}</button>
    <button type="button" id="lsr-send-end" class="lsr-secondary"${ended ? " disabled" : ""}>Send &amp; End</button>
  </div>
  ${ended ? `<p class="lsr-ended">This review has ended.</p>` : ""}
`;
}

/**
 * "Agent working" indicator at the foot of the conversation, where the answer
 * will appear — after Send the eye is here, not on the header's corner.
 * Silent once ended: the closing summary is about to cover the page.
 */
function renderWorking(state: PanelState): string {
  if (!state.agentWorking || state.status === "ended") return "";
  // Decorative; the sentence beside them carries the meaning.
  return `
  <p class="lsr-working">
    <span class="lsr-working-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    the agent is working on your feedback
  </p>`;
}

/**
 * History ruled into rounds. A conversation that never crossed a round
 * boundary stays a plain stream: one label over everything is furniture.
 */
function renderConversation(state: PanelState): string {
  const segments = roundSegments(state.conversation, state.rounds);
  const ruled = segments.length > 1;
  const parts: string[] = [];
  for (const segment of segments) {
    if (ruled) parts.push(renderRoundMark(segment));
    for (const entry of segment.entries) {
      parts.push(renderEntry(entry, segment, state.declarations));
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
  declarations?: Record<string, DeclaredAnswer>,
): string {
  return `<article class="lsr-entry" data-round-state="${roundState(segment)}" data-role="${entry.role}">
    <header class="lsr-entry-role">${entry.role}</header>
    ${entry.prompts.map((prompt) => renderPrompt(prompt, declarations)).join("\n    ")}
  </article>`;
}

function renderPrompt(
  prompt: FeedbackPrompt,
  declarations?: Record<string, DeclaredAnswer>,
): string {
  return `<div class="lsr-prompt">${renderPromptBody(prompt)}${renderAnswer(prompt, declarations)}</div>`;
}

/**
 * The agent's declared answer (`poll --for <id> --note`), rendered inside the
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
