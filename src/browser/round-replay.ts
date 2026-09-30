import { roundOf } from "./conversation-rounds.ts";
import type { DiffRenderer } from "./diff-renderer.ts";
import { saidKey } from "./message-news.ts";
import { mainCardKey } from "./thread-groups.ts";
import { MAIN_THREAD } from "../threads.ts";
import { escapeHtml } from "../escape-html.ts";
import type {
  ReplayAnswer,
  ReplayComment,
  ReplayData,
  ReplayState,
  ReplayStatus,
} from "../rounds/replay.ts";
import type { ConversationEntry, FeedbackPrompt, RoundMark } from "../session-store.ts";

/**
 * Pure; `dom/replay-overlay.ts` holds the clicks. Only the current card
 * renders — cards are static by spec (no morph), so a move is a one-card redraw.
 */
export interface ReplayView {
  data: ReplayData;
  roundReply?: string;
  /**
   * The agent's messages the conversation panel showed before this round came
   * (`saidKey`): the replay tells what is new, and never repeats them.
   */
  seen: ReadonlySet<string>;
  /** 0-based; clamped rather than trusted. */
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
 * Neutral wording and styling (spec bars failure styling). Literal-keyed like
 * `NO_DIFF` in `approved-form.ts`: a new server state stops compiling until
 * answered here.
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
${renderCard(comment, answerOf(comment, view.roundReply, view.seen), renderer)}
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

function dots(total: number, current: number): string {
  return Array.from(
    { length: total },
    (_unused, index) =>
      `<button type="button" class="lsr-replay-dot" data-index="${index}" aria-label="Comment ${index + 1}" aria-current="${index === current}"></button>`,
  ).join("");
}

function renderCard(
  comment: ReplayComment,
  answer: Answer | undefined,
  renderer: DiffRenderer,
): string {
  const status = knownStatus(comment.status);
  return `<article class="lsr-replay-card">
<header class="lsr-replay-file">
<code class="lsr-replay-path">${escapeHtml(comment.file)}</code>
<span class="lsr-replay-chip" data-status="${status}">${STATUS_LABEL[status]}</span>
</header>
${quote(comment)}
${answerNote(answer)}
${changes(comment, renderer)}
</article>`;
}

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

interface Answer {
  label: "The agent's answer" | "The agent's round reply";
  text: string;
}

/**
 * The round reply is labelled as exactly that: the label keeps the blob from
 * passing as a per-comment answer. A note the panel already showed is left
 * off, and does not fall back to the round reply either: the comment was
 * answered, just not anew — the round reply there would pass as its answer.
 */
function answerOf(
  comment: ReplayComment,
  roundReply: string | undefined,
  seen: ReadonlySet<string>,
): Answer | undefined {
  if (comment.note !== undefined) {
    if (comment.note === "" || noteSeen(comment, seen)) return undefined;
    return { label: "The agent's answer", text: comment.note };
  }
  // A status-only card (history rewritten, commits gone) borrows nothing: the
  // round reply beside "cannot be shown" would read as this comment's answer.
  if (comment.state !== "ok" || roundReply === undefined || roundReply === "") return undefined;
  return { label: "The agent's round reply", text: roundReply };
}

/** A note without its thread or stamp cannot be told seen, so it counts as new. */
function noteSeen(comment: ReplayComment, seen: ReadonlySet<string>): boolean {
  if (comment.id === null || comment.note_at === undefined) return false;
  return seen.has(saidKey(comment.id, comment.note_at));
}

/** No answer: no section, not an empty frame. */
function answerNote(answer: Answer | undefined): string {
  if (answer === undefined) return "";
  return `<div class="lsr-replay-answer">
<p class="lsr-replay-label">${answer.label}</p>
<p class="lsr-replay-note">${escapeHtml(answer.text)}</p>
</div>`;
}

/**
 * Whether the replay has anything the reviewer has not seen: a change, or the
 * agent's words the panel never drew. Without either every card would be the
 * reviewer's own comment over "No code change", so it does not open on its
 * own (the reopen control still offers it). A status-only card counts only
 * when a change is there but too big to show: "history was rewritten" says
 * nothing new about the code.
 */
export function replayHasNews(view: Pick<ReplayView, "data" | "roundReply" | "seen">): boolean {
  return view.data.comments.some(
    (comment) =>
      comment.state === "oversize" ||
      (comment.state === "ok" && comment.answers.length > 0) ||
      answerOf(comment, view.roundReply, view.seen) !== undefined,
  );
}

/**
 * An empty answer set is a fact (answered in words, or no edit), never
 * failure-styled. The unanswered marker sits here because it qualifies this
 * section: hunks matched mechanically, not vouched for.
 */
function changes(comment: ReplayComment, renderer: DiffRenderer): string {
  if (comment.state !== "ok") {
    const sentence = Object.hasOwn(NO_ANSWERS, comment.state)
      ? NO_ANSWERS[comment.state]
      : "What changed here cannot be shown.";
    return `<p class="lsr-replay-state">${sentence}</p>`;
  }
  const marker =
    comment.note !== undefined
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

/** Both header sides use today's name: the rename story is the diff below's to tell. */
function hunkPatch(answer: ReplayAnswer): string {
  const head = `--- a/${answer.file}\n+++ b/${answer.file}\n`;
  return head + answer.hunks.map((hunk) => withNewline(hunk.header) + hunk.body).join("\n");
}

function withNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Read by position, not stamp alone — replies land on both sides of the round
 * boundary (a `reply` carries the old stamp, a `publish --to` note the new);
 * what they share is coming after the comments they answer. Only the agent's
 * top-level words count here (`--to main`, or a 2.x message): a note in an
 * item's thread is shown on that item's own card. Words the panel already showed
 * (`seen`) are left out: the replay tells only what the reviewer has not read.
 */
export function agentRoundReply(
  conversation: readonly ConversationEntry[],
  rounds: readonly RoundMark[],
  seen: ReadonlySet<string>,
): string | undefined {
  const made = rounds.at(-2)?.index;
  if (made === undefined) return undefined;
  const lastComment = conversation.findLastIndex(
    (entry) => entry.role === "reviewer" && roundOf(entry, rounds) === made,
  );
  const said = conversation
    .slice(lastComment + 1)
    .filter((entry) => entry.role === "agent" && roundOf(entry, rounds) >= made)
    .flatMap((entry) => entry.prompts.flatMap((prompt) => topLevelWords(entry.at, prompt)))
    .filter((words) => words.text !== "" && (words.key === undefined || !seen.has(words.key)))
    .map((words) => words.text);
  return said.length === 0 ? undefined : said.join("\n\n");
}

/**
 * The agent's top-level words, under the key the panel files them by
 * (`saidKey`, of the card they draw on). A legacy message has no card key to
 * name here, so it never reads as seen.
 */
function topLevelWords(at: string, prompt: FeedbackPrompt): { key?: string; text: string }[] {
  if (prompt.type === "reply" && prompt.thread === MAIN_THREAD) {
    return [{ key: saidKey(mainCardKey(at), at), text: prompt.comment.trim() }];
  }
  if (prompt.type !== "message") return [];
  const text = prompt.comment.trim();
  return [prompt.id === undefined ? { text } : { key: saidKey(prompt.id, at), text }];
}
