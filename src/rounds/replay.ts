import { roundOf } from "../browser/conversation-rounds.ts";
import { parseDiff, splitHunks, type DiffHunk } from "../diff-extract.ts";
import type { DiffBetween } from "../git-file.ts";
import { sliceContext } from "../ledger/context.ts";
import { verdictFor } from "../ledger/outcomes.ts";
import type {
  AnnotationPrompt,
  AnnotationSide,
  ConversationEntry,
  LineAnchor,
  SessionRecord,
  SessionRound,
} from "../session-store.ts";
import { threadsOf } from "../threads.ts";
import { MAX_APPROVED_FORM_BYTES } from "./approved-form.ts";
import { changedBetween, currentName, fileApproval, fileHistory } from "./history.ts";

/**
 * "Last round" is read exactly as the browser's "commented last round" badge
 * reads it (`src/browser/commented-files.ts`, whose `roundOf` this shares) — the
 * two must name the same comments. Recomputed from session + git, never the
 * ledger: the replay must work with the ledger off. Pure: the caller asks git.
 */

export type ReadBetween = (from: string, to: string, paths: string[]) => DiffBetween;

export type ReadFileAt = (commit: string, path: string) => string | undefined;

/**
 * The ledger's verdict vocabulary with one word swapped: `ignored` is served as
 * `unchanged`, decided in the spec — "ignored" implies bad faith the data
 * cannot prove, and a question the agent answered in words is the same empty
 * diff as a comment it walked past.
 */
export type ReplayStatus = "addressed" | "unchanged" | "repeated" | "unknown";

/**
 * `ok` is the only state with answers; the rest are status-only cards:
 * `unrecorded` — rounds from before commits were stored (no rebase blamed);
 * `unreachable` — commits a rebase or force-push took away; `oversize` — a
 * between-round diff too big to read.
 */
export type ReplayState = "ok" | "unrecorded" | "unreachable" | "oversize";

export interface ReplayAnswer {
  /** The file's name today — a rename since the comment shows the new name. */
  file: string;
  /** Empty = the file has no text lines to show between the rounds. */
  hunks: DiffHunk[];
  /** Present when the file's patch outgrew the cap; its hunks are withheld. */
  oversized?: true;
}

export interface ReplayComment {
  /** Null on comments stored before ids existed; such a card has no thread to answer in. */
  id: string | null;
  /** The file as last round's diff named it. */
  file: string;
  group: string;
  anchor: LineAnchor | null;
  selected_text: string;
  comment: string;
  context?: string;
  status: ReplayStatus;
  /** Whether the agent answered in the comment's thread (`note`). */
  declared: boolean;
  state: ReplayState;
  /** Always read off the anchor (the mechanical answer); the agent's words are `note`. */
  answers: ReplayAnswer[];
  /** The agent's last words in the comment's thread — a `publish --to` "done: …" note. */
  note?: string;
}

/** What `GET /api/session/:key/replay` answers. */
export interface ReplayData {
  comments: ReplayComment[];
}

interface Review {
  session: SessionRecord;
  made: SessionRound;
  current: SessionRound;
  /** Reviewer annotations from rounds after `made`, for the `repeated` verdict. */
  later: AnnotationPrompt[];
  /** The agent's last words per thread id. */
  answered: Map<string, string>;
  ask: ReadBetween;
  readFileAt: ReadFileAt;
}

export function replayData(
  session: SessionRecord,
  readBetween: ReadBetween,
  readFileAt: ReadFileAt,
): ReplayData {
  const rounds = session.rounds;
  const current = rounds.at(-1);
  const made = rounds.at(-2);
  // No round before this one: an empty replay is the definitive answer, not a
  // degraded one.
  if (current === undefined || made === undefined) return { comments: [] };
  const review: Review = {
    session,
    made,
    current,
    later: annotations(session.conversation, rounds, (round) => round > made.index),
    answered: agentAnswers(session.conversation),
    ask: askOnce(readBetween),
    readFileAt,
  };
  return {
    comments: annotations(session.conversation, rounds, (round) => round === made.index).map(
      (prompt) => replayComment(review, prompt),
    ),
  };
}

/**
 * Only annotations: a general message is about the review, not a file, and has
 * no code to replay.
 */
function annotations(
  conversation: readonly ConversationEntry[],
  rounds: readonly SessionRound[],
  match: (round: number) => boolean,
): AnnotationPrompt[] {
  return conversation
    .filter((entry) => entry.role === "reviewer" && match(roundOf(entry, rounds)))
    .flatMap((entry) => entry.prompts)
    .filter((prompt) => prompt.type === "annotation");
}

function agentAnswers(conversation: ConversationEntry[]): Map<string, string> {
  const answers = new Map<string, string>();
  for (const thread of threadsOf(conversation)) {
    const last = thread.messages.findLast((message) => message.role === "agent");
    if (last !== undefined && thread.legacy !== true) answers.set(thread.id, last.comment);
  }
  return answers;
}

/**
 * The same question is put to git once per replay rather than once per card:
 * every undeclared comment on one file asks for the same patch.
 */
function askOnce(readBetween: ReadBetween): ReadBetween {
  const answers = new Map<string, DiffBetween>();
  return (from, to, paths) => {
    const key = [from, to, ...paths].join("\0");
    const known = answers.get(key);
    if (known !== undefined) return known;
    const answer = readBetween(from, to, paths);
    answers.set(key, answer);
    return answer;
  };
}

function replayComment(review: Review, prompt: AnnotationPrompt): ReplayComment {
  const note = prompt.id === undefined ? undefined : review.answered.get(prompt.id);
  return {
    id: prompt.id ?? null,
    file: prompt.file,
    group: prompt.group,
    anchor: anchorOf(prompt),
    selected_text: prompt.selected_text,
    comment: prompt.comment,
    ...contextOf(review, prompt),
    declared: note !== undefined,
    ...(note === undefined ? {} : { note }),
    ...outcomeOf(review, prompt),
  };
}

/**
 * The judged half of a card. Only missing/unreachable commits degrade the whole
 * card; an oversize patch leaves it status-only `oversize`.
 */
function outcomeOf(
  review: Review,
  prompt: AnnotationPrompt,
): { status: ReplayStatus; state: ReplayState; answers: ReplayAnswer[] } {
  const path = currentName(review.current, prompt.file);
  const from = review.made.headCommit;
  const to = review.current.headCommit;
  if (from === undefined || to === undefined) {
    return { status: "unknown", state: "unrecorded", answers: [] };
  }
  const read = review.ask(from, to, gitNames(review, prompt.file, path));
  if (read.state === "unreachable") {
    return { status: "unknown", state: "unreachable", answers: [] };
  }
  const status = read.state === "patch" ? statusOf(review, path) : "unknown";
  if (read.state === "oversize") return { status, state: "oversize", answers: [] };
  return { status, state: "ok", answers: mechanicalAnswers(prompt, path, read.patch) };
}

/**
 * Every name to hand git for one file's between-round diff: the rounds'
 * rename chain (`fileHistory` follows `previousPath` backwards), plus both
 * endpoints in case the rounds recorded nothing — `--find-renames` needs both
 * ends of a rename named to pair them up.
 */
function gitNames(review: Review, ...names: string[]): string[] {
  const known = names.flatMap((name) =>
    fileHistory(review.session.rounds, name).map((appearance) => appearance.path),
  );
  return [...new Set([...known, ...names])];
}

/**
 * The verdict, re-judged from blobs and the conversation rather than read off
 * the ledger — the facts and tests are `src/ledger/outcomes.ts`'s own, so the
 * two readers agree, and the replay still works with the ledger off. Only
 * reached when the between-round diff was readable, so `comparable` is true.
 */
function statusOf(review: Review, path: string): ReplayStatus {
  const verdict = verdictFor({
    comparable: true,
    fileTouched: changedBetween(review.made, review.current, path),
    reAnnotated: review.later.some((other) => currentName(review.current, other.file) === path),
    approved: fileApproval(review.session.rounds, path) === "approved",
  });
  return verdict === "ignored" ? "unchanged" : verdict;
}

function anchorOf(prompt: AnnotationPrompt): LineAnchor | null {
  if (prompt.side === undefined) return null;
  const { side, line_start, line_end, col_start, col_end } = prompt;
  return {
    side,
    line_start,
    line_end,
    ...(col_start === undefined ? {} : { col_start }),
    ...(col_end === undefined ? {} : { col_end }),
  };
}

/**
 * The code around the selection, cut from the commit the reviewer was reading:
 * last round's head for a new-side anchor, last round's base for an old-side
 * one, under the name that side of last round's diff used. A file git cannot
 * read leaves the card without context rather than guessing.
 */
function contextOf(review: Review, prompt: AnnotationPrompt): { context?: string } {
  const side = prompt.side ?? "new";
  const commit = side === "old" ? review.made.baseCommit : review.made.headCommit;
  if (commit === undefined) return {};
  const text = review.readFileAt(commit, sideName(review.made, prompt.file, side));
  const sliced = sliceContext(text, prompt);
  return sliced.context === undefined ? {} : { context: sliced.context };
}

function sideName(made: SessionRound, path: string, side: AnnotationSide): string {
  if (side === "new") return path;
  return made.files.find((entry) => entry.path === path)?.previousPath ?? path;
}

/**
 * The mechanical fallback, decided in the spec: same-file hunks only, chosen by
 * anchor overlap, and no inference beyond that. An empty patch means the file
 * was not touched, which is an empty answer set — a fact, not a failure.
 */
function mechanicalAnswers(prompt: AnnotationPrompt, path: string, patch: string): ReplayAnswer[] {
  if (patch === "") return [];
  const found = parseDiff(patch).find((entry) => entry.path === path);
  // A binary file's section has no text lines, which is no hunks to offer.
  if (found === undefined || found.diff === "") return [];
  const answer = cappedHunks(found.path, found.diff);
  if (answer.oversized) return [answer];
  return [{ ...answer, hunks: anchoredHunks(prompt, answer.hunks) }];
}

function cappedHunks(file: string, diff: string): ReplayAnswer {
  if (Buffer.byteLength(diff, "utf8") > MAX_APPROVED_FORM_BYTES) {
    return { file, hunks: [], oversized: true };
  }
  return { file, hunks: splitHunks(diff).hunks };
}

/**
 * Only a new-side anchor maps: its lines live in last round's head — the old
 * side of the between-round diff. Old-side anchors and anchorless comments get
 * the whole file rather than a guess. An anchor that overlaps nothing gets the
 * nearest hunk: the closest change is the likeliest response, stated by
 * proximity, not claimed as the answer.
 */
function anchoredHunks(prompt: AnnotationPrompt, hunks: DiffHunk[]): DiffHunk[] {
  if (prompt.side !== "new") return hunks;
  const overlapping = hunks.filter((hunk) => distance(hunk, prompt) === 0);
  if (overlapping.length > 0) return overlapping;
  const nearest = [...hunks].sort((a, b) => distance(a, prompt) - distance(b, prompt))[0];
  return nearest === undefined ? [] : [nearest];
}

/**
 * How far a hunk's old-side range is from the anchored lines, zero when they
 * overlap. A count of 0 (a pure insertion) still occupies its position for
 * nearness — an insertion right at the commented line is the closest possible
 * answer to it.
 */
function distance(hunk: DiffHunk, anchor: LineAnchor): number {
  const range = oldRange(hunk);
  if (range === undefined) return Number.POSITIVE_INFINITY;
  if (range.end < anchor.line_start) return anchor.line_start - range.end;
  if (range.start > anchor.line_end) return range.start - anchor.line_end;
  return 0;
}

/** The `-start,count` of a hunk's `@@` header, as 1-based inclusive lines. */
function oldRange(hunk: DiffHunk): { start: number; end: number } | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? /.exec(hunk.header);
  if (match === null) return undefined;
  const start = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  return { start, end: start + Math.max(count, 1) - 1 };
}
