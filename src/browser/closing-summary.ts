import type { DiffGroup } from "../diff-extract.ts";
import { escapeHtml } from "../escape-html.ts";
import { reviewPaths } from "../review-files.ts";
import type { ConversationEntry, ReviewCloser, RoundMark } from "../session-store.ts";

/**
 * Own interface rather than `SessionRecord`: both server (stored record) and
 * page (session payload) render it, and neither may count fields differently.
 */
export interface ClosedReview {
  /** The grouping on screen, which is the review the reviewer just read. */
  groups: DiffGroup[];
  conversation: ConversationEntry[];
  rounds: RoundMark[];
  /** Paths ticked approved when it closed. */
  approved: string[];
  endedBy?: ReviewCloser;
}

/** One count and what it counts, already named for the number in front of it. */
export interface ClosingFigure {
  count: number;
  /** Singular or plural to match `count`: "1 round", "4 rounds". */
  label: string;
}

export interface ClosingSummary {
  /** How much of the review was approved, as a sentence of its own. */
  verdict: string;
  figures: ClosingFigure[];
  /** Who closed it, where the words went, and that there is nothing left to do. */
  note: string;
}

/** The review's outcome, counted off the session record, never estimated. */
export function closingSummary(review: ClosedReview): ClosingSummary {
  const paths = reviewPaths(review.groups);
  const commentsSent = commentCount(review.conversation, "reviewer");
  return {
    verdict: verdict(paths, review.approved),
    figures: figures(review, paths, commentsSent),
    note: note(review.endedBy, commentsSent),
  };
}

/**
 * Largest unit first, zeros dropped: a short review must not read as a list of
 * things the reviewer failed to do. No files means no figures at all — the
 * verdict says everything about an empty review. `lines changed` is taken from
 * the diff, not recounted: see `linesChanged`.
 */
function figures(review: ClosedReview, paths: Set<string>, commentsSent: number): ClosingFigure[] {
  if (paths.size === 0) return [];
  return [
    figure(review.rounds.length, "round"),
    figure(review.groups.length, "group"),
    figure(paths.size, "file"),
    figure(linesChanged(review.groups), "line changed", "lines changed"),
    figure(commentsSent, "comment sent", "comments sent"),
    figure(commentCount(review.conversation, "agent"), "agent reply", "agent replies"),
  ].filter((entry) => entry.count > 0);
}

function figure(count: number, singular: string, many?: string): ClosingFigure {
  return { count, label: plural(count, singular, many) };
}

/**
 * Same readings as `EndApproval.verdict` in `src/feedback.ts` — everything,
 * nothing, a fraction, or no files at all — so the page and the poll payload
 * cannot disagree about how a review closed.
 */
function verdict(paths: Set<string>, approved: string[]): string {
  const total = paths.size;
  if (total === 0) return "There was nothing here to approve.";
  // Counted over the review's paths, not `approved.length`: ticks left by an
  // earlier grouping would overcount. Same intersection as the header counter
  // (`overallCounterLabel` in `src/browser/diff-view.ts`) and `EndApproval`.
  const ticked = [...paths].filter((path) => approved.includes(path)).length;
  if (ticked === total) return `All ${digits(total)} ${plural(total, "file")} approved.`;
  if (ticked === 0) return `No ${plural(total, "file")} approved.`;
  return `${digits(ticked)} of ${digits(total)} files approved.`;
}

/**
 * The last line: who ended it, and that the reviewer is free to go. The
 * delivery half only claims what this page can answer for — nothing is still
 * sitting in the browser — not that an agent picked the prompts up, which is
 * unknowable here.
 */
function note(endedBy: ReviewCloser | undefined, commentsSent: number): string {
  const delivered = commentsSent === 0 ? "" : " Everything you sent has left this page.";
  return `${closer(endedBy)}${delivered} You can close this tab.`;
}

/** A record that does not say who ended it must not be read as either party. */
function closer(endedBy: ReviewCloser | undefined): string {
  if (endedBy === "reviewer") return "You ended this review.";
  if (endedBy === "agent") return "The agent ended this review.";
  return "This review is ended.";
}

/**
 * Counted per comment, not per turn: five annotations sent in one press are
 * five comments, and the panel shows them as five.
 */
function commentCount(conversation: ConversationEntry[], role: "reviewer" | "agent"): number {
  return conversation
    .filter((entry) => entry.role === role)
    .reduce((total, entry) => total + entry.prompts.length, 0);
}

/**
 * Per file, never per listing: a file two groups name counts once, like the
 * file count. Numbers come from `countChangedLines` in `src/diff-extract.ts`,
 * which undercounts lines starting `++`/`--` by design — repeated rather than
 * corrected, so the card never disagrees with the header bar and file rows.
 */
function linesChanged(groups: DiffGroup[]): number {
  const perPath = new Map<string, number>();
  for (const group of groups) {
    for (const file of group.files) perPath.set(file.path, file.insertions + file.deletions);
  }
  return [...perPath.values()].reduce((total, lines) => total + lines, 0);
}

function plural(count: number, singular: string, many = `${singular}s`): string {
  return count === 1 ? singular : many;
}

/**
 * Comma-separated thousands, not `toLocaleString`: must read the same for
 * every locale and on server as in browser.
 */
function digits(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+$)/g, ",");
}

/**
 * The closing summary, the last thing the page says. Deliberately quiet:
 * verdict, figures under a rule, one closing line.
 */
export function renderClosingSummary(review: ClosedReview): string {
  const summary = closingSummary(review);
  // No list rather than an empty one: the list draws the rule above the
  // figures, and a rule over nothing promises a paragraph that never comes.
  const figures =
    summary.figures.length === 0
      ? ""
      : `\n<ul class="lsr-closing-figures">${summary.figures.map(renderFigure).join("")}</ul>`;
  return `<section class="lsr-closing" aria-label="What this review came to">
<p class="lsr-closing-eyebrow">End of review</p>
<h2 class="lsr-closing-verdict">${escapeHtml(summary.verdict)}</h2>${figures}
<p class="lsr-closing-note">${escapeHtml(summary.note)}</p>
</section>`;
}

/** List item, not definition list: read aloud it is already "2 rounds". */
function renderFigure(figure: ClosingFigure): string {
  return `<li class="lsr-closing-figure"><span class="lsr-closing-count">${digits(figure.count)}</span><span class="lsr-closing-label">${escapeHtml(figure.label)}</span></li>`;
}
