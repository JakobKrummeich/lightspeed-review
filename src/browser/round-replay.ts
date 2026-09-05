import { roundOf } from "./conversation-rounds.ts";
import type { DiffRenderer } from "./diff-renderer.ts";
import { escapeHtml } from "../escape-html.ts";
import type {
  ReplayAnswer,
  ReplayComment,
  ReplayData,
  ReplayState,
  ReplayStatus,
} from "../rounds/replay.ts";
import type { ConversationEntry, RoundMark } from "../session-store.ts";

/**
 * Between-rounds replay overlay: last round's comments, one card at a time,
 * with the agent's answer and the change. Pure; `dom/replay-overlay.ts` holds
 * the clicks. Only the current card renders — cards are static by spec (no
 * morph), so a move is a one-card redraw.
 */
export interface ReplayView {
  data: ReplayData;
  /**
   * The round reply blob, shown on unmapped cards as their only answer —
   * labelled as the round reply, never passed off as per-comment.
   */
  roundReply?: string;
  /** Which card is on screen, 0-based; clamped rather than trusted. */
  current: number;
}

/**
 * Chip words are the served status verbatim: the server already swapped
 * `ignored` for `unchanged`, and a second vocabulary could disagree.
 */
const STATUS_LABEL: Record<ReplayStatus, string> = {
  addressed: "addressed",
  unchanged: "unchanged",
  repeated: "repeated",
  unknown: "unknown",
};

/**
 * Why a card has no code, one sentence per non-ok state; neutral wording and
 * styling (spec bars failure styling). Literal-keyed like `NO_DIFF` in
 * `approved-form.ts`: a new server state stops compiling until answered here.
 */
const NO_ANSWERS: Record<Exclude<ReplayState, "ok">, string> = {
  unrecorded:
    "This review recorded no commits for these rounds, so what changed here cannot be shown. Nothing was rewritten.",
  unreachable:
    "History was rewritten: git no longer has the commit this comment was read against — which is what a rebase or a force-push does — so what changed here cannot be shown.",
  oversize: "The change around this comment is too large to show here. Read it in the diff below.",
};

export function renderReplayOverlay(view: ReplayView, renderer: DiffRenderer): string {
  const total = view.data.comments.length;
  const current = Math.min(Math.max(view.current, 0), Math.max(total - 1, 0));
  const comment = view.data.comments[current];
  if (comment === undefined) return "";
  return `<div class="lsr-replay-overlay" role="dialog" aria-modal="true" aria-label="What happened between rounds">
<section class="lsr-replay">
<header class="lsr-replay-head">
<p class="lsr-replay-eyebrow">Between rounds</p>
<p class="lsr-replay-progress">Comment ${current + 1} of ${total}</p>
</header>
${renderCard(comment, view.roundReply, renderer)}
<footer class="lsr-replay-nav">
<button type="button" class="lsr-replay-prev"${current === 0 ? " disabled" : ""}>Previous</button>
<span class="lsr-replay-dots" aria-label="Which comment is on screen">${dots(total, current)}</span>
<button type="button" class="lsr-replay-next">${current === total - 1 ? "Done" : "Next"}</button>
</footer>
<button type="button" class="lsr-replay-skip">Skip to the diff</button>
</section>
</div>`;
}

/**
 * Status narrowed before touching markup: the JSON was never runtime-
 * validated, and a string doubling as attribute value and record key must not
 * be taken on faith.
 */
function knownStatus(status: ReplayStatus): ReplayStatus {
  return Object.hasOwn(STATUS_LABEL, status) ? status : "unknown";
}

/** One dot per card, the current one marked; each is a press that goes there. */
function dots(total: number, current: number): string {
  return Array.from(
    { length: total },
    (_unused, index) =>
      `<button type="button" class="lsr-replay-dot" data-index="${index}" aria-label="Comment ${index + 1}" aria-current="${index === current}"></button>`,
  ).join("");
}

/**
 * One card: file+chip, the reviewer's words, the agent's answer, the change.
 * Non-`ok` states keep the first three and say why the fourth is missing.
 */
function renderCard(
  comment: ReplayComment,
  roundReply: string | undefined,
  renderer: DiffRenderer,
): string {
  const status = knownStatus(comment.status);
  return `<article class="lsr-replay-card">
<header class="lsr-replay-file">
<code class="lsr-replay-path">${escapeHtml(comment.file)}</code>
<span class="lsr-replay-chip" data-status="${status}">${STATUS_LABEL[status]}</span>
</header>
${quote(comment)}
${answerNote(comment, roundReply)}
${changes(comment, renderer)}
</article>`;
}

/**
 * The reviewer's selection and words, in the violet the "commented last
 * round" badge wears: one colour for "this is where you spoke".
 */
function quote(comment: ReplayComment): string {
  const selected =
    comment.selected_text === ""
      ? ""
      : `\n<pre class="lsr-replay-selected">${escapeHtml(comment.selected_text)}</pre>`;
  return `<blockquote class="lsr-replay-quote">
<p class="lsr-replay-quote-label">You said</p>${selected}
<p class="lsr-replay-comment">${escapeHtml(comment.comment)}</p>
</blockquote>`;
}

/**
 * The agent's words: declared note, or (unmapped cards) the round reply
 * labelled as exactly that — the label keeps the blob from passing as a
 * per-comment answer. Neither: no section, not an empty frame.
 */
function answerNote(comment: ReplayComment, roundReply: string | undefined): string {
  const fallback = comment.declared ? undefined : roundReply;
  const text = comment.note ?? fallback;
  if (text === undefined || text === "") return "";
  const label = comment.note !== undefined ? "The agent's answer" : "The agent's round reply";
  return `<div class="lsr-replay-answer">
<p class="lsr-replay-label">${label}</p>
<p class="lsr-replay-note">${escapeHtml(text)}</p>
</div>`;
}

/**
 * What changed: one block per answer file. An empty answer set is a fact
 * (answered in words, or no edit), never failure-styled. The undeclared
 * marker sits here because it qualifies this section: hunks matched
 * mechanically, not vouched for.
 */
function changes(comment: ReplayComment, renderer: DiffRenderer): string {
  if (comment.state !== "ok") {
    const sentence = Object.hasOwn(NO_ANSWERS, comment.state)
      ? NO_ANSWERS[comment.state]
      : "What changed here cannot be shown.";
    return `<p class="lsr-replay-state">${sentence}</p>`;
  }
  const marker = comment.declared
    ? ""
    : `<span class="lsr-replay-unmapped">agent did not map this</span>`;
  if (comment.answers.length === 0) {
    return `<div class="lsr-replay-changes">
<p class="lsr-replay-label">What changed${marker}</p>
<p class="lsr-replay-nochange">No code change — see the reply.</p>
</div>`;
  }
  return `<div class="lsr-replay-changes">
<p class="lsr-replay-label">What changed${marker}</p>
${comment.answers.map((answer) => answerFile(answer, renderer)).join("\n")}
</div>`;
}

/** One file of the answer set: its name, and its hunks or the reason for none. */
function answerFile(answer: ReplayAnswer, renderer: DiffRenderer): string {
  return `<div class="lsr-replay-answer-file">
<p class="lsr-replay-answer-path"><code>${escapeHtml(answer.file)}</code></p>
${answerBody(answer, renderer)}
</div>`;
}

function answerBody(answer: ReplayAnswer, renderer: DiffRenderer): string {
  if (answer.oversized === true) {
    return `<p class="lsr-replay-nochange">The change to this file is too large to show here. Read it in the diff below.</p>`;
  }
  if (answer.hunks.length === 0) {
    // One wording for empty patch, binary file and uncuttable patch: the
    // server does not tell them apart on purpose, and none is failure.
    return `<p class="lsr-replay-nochange">No code change to show for this file.</p>`;
  }
  return `<div class="lsr-replay-diff">${renderer.renderFile(hunkPatch(answer))}</div>`;
}

/**
 * Hunks reassembled into the smallest unified diff the renderer takes. Both
 * header sides use today's name: the rename story is the diff below's to tell.
 */
function hunkPatch(answer: ReplayAnswer): string {
  const head = `--- a/${answer.file}\n+++ b/${answer.file}\n`;
  return head + answer.hunks.map((hunk) => withNewline(hunk.header) + hunk.body).join("\n");
}

function withNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * The round reply for fallback cards: everything the agent said since the
 * reviewer's last words of the commented round. Read by position, not stamp
 * alone — replies land on both sides of the round boundary (`poll
 * --agent-reply` carries the old stamp, post-`start` the new); what they share
 * is coming after the comments they answer.
 */
export function agentRoundReply(
  conversation: readonly ConversationEntry[],
  rounds: readonly RoundMark[],
): string | undefined {
  const made = rounds.at(-2)?.index;
  if (made === undefined) return undefined;
  const lastComment = conversation.findLastIndex(
    (entry) => entry.role === "reviewer" && roundOf(entry, rounds) === made,
  );
  const said = conversation
    .slice(lastComment + 1)
    .filter((entry) => entry.role === "agent" && roundOf(entry, rounds) >= made)
    .flatMap((entry) => entry.prompts)
    .filter((prompt) => prompt.type === "message")
    .map((prompt) => prompt.comment.trim())
    .filter((text) => text !== "");
  return said.length === 0 ? undefined : said.join("\n\n");
}
