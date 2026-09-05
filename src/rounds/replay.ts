import { roundOf } from "../browser/conversation-rounds.ts";
import { parseDiff, splitHunks, type DiffHunk } from "../diff-extract.ts";
import type { DiffBetween } from "../git-file.ts";
import { sliceContext } from "../ledger/context.ts";
import { verdictFor } from "../ledger/outcomes.ts";
import type {
  AnnotationPrompt,
  AnnotationSide,
  ConversationEntry,
  DeclaredAnswer,
  LineAnchor,
  SessionRecord,
  SessionRound,
} from "../session-store.ts";
import { MAX_APPROVED_FORM_BYTES } from "./approved-form.ts";
import { changedBetween, currentName, fileApproval, fileHistory } from "./history.ts";

/**
 * Between-rounds replay: last round's comments with the agent's answers. "Last
 * round" is read exactly as the browser's "commented last round" badge reads it
 * (`src/browser/commented-files.ts`, whose `roundOf` this shares) — the two must
 * name the same comments. Recomputed from session + git, never the ledger: the
 * replay must work with the ledger off. Pure: the caller asks git.
 */

/** `readDiffBetween` bound to the session's repository. */
export type ReadBetween = (from: string, to: string, paths: string[]) => DiffBetween;

/** `readFileAtCommit` bound to the same repository, for context slicing. */
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

/** One file's contribution to a comment's answer set. */
export interface ReplayAnswer {
  /** The file's name today — a rename since the comment shows the new name. */
  file: string;
  /**
   * Empty on a declared answer = no text lines to show (empty patch, binary,
   * unreadable). Deliberately not told apart on the wire: the declaration
   * survived validation, so none is evidence against the agent's word — all
   * render as "no code change to show", never as failure.
   */
  hunks: DiffHunk[];
  /** Present when the file's patch outgrew the cap; its hunks are withheld. */
  oversized?: true;
}

/** One card: a comment the reviewer made last round, and what became of it. */
export interface ReplayComment {
  /** Null on comments stored before ids existed; such a card is never declared. */
  id: string | null;
  /** The file as last round's diff named it. */
  file: string;
  group: string;
  anchor: LineAnchor | null;
  selected_text: string;
  comment: string;
  /** The code around the selection, cut from last round's own commit. */
  context?: string;
  status: ReplayStatus;
  /** Whether the agent declared this comment's answer; false means mechanical. */
  declared: boolean;
  state: ReplayState;
  answers: ReplayAnswer[];
  /** The agent's per-comment note, present exactly when one was declared. */
  note?: string;
}

/** What `GET /api/session/:key/replay` answers. */
export interface ReplayData {
  comments: ReplayComment[];
}

/** Everything one card is judged from, shared across the cards of a replay. */
interface Review {
  session: SessionRecord;
  made: SessionRound;
  current: SessionRound;
  /** Reviewer annotations from rounds after `made`, for the `repeated` verdict. */
  later: AnnotationPrompt[];
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
  // A first round, or a session with no rounds: there is no round before this
  // one, so an empty replay is the definitive answer, not a degraded one.
  if (current === undefined || made === undefined) return { comments: [] };
  const review: Review = {
    session,
    made,
    current,
    later: annotations(session.conversation, rounds, (round) => round > made.index),
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
 * The reviewer's annotations from the rounds `match` accepts, in the order
 * they were made. Only annotations: a general message is about the review, not
 * a file, and has no code to replay.
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
  const declaration =
    prompt.id === undefined ? undefined : review.session.declarations?.[prompt.id];
  return {
    id: prompt.id ?? null,
    file: prompt.file,
    group: prompt.group,
    anchor: anchorOf(prompt),
    selected_text: prompt.selected_text,
    comment: prompt.comment,
    ...contextOf(review, prompt),
    declared: declaration !== undefined,
    ...(declaration?.note === undefined ? {} : { note: declaration.note }),
    ...outcomeOf(review, prompt, declaration),
  };
}

/**
 * The judged half of a card. Only missing/unreachable commits degrade the whole
 * card. An oversize patch of the annotated file degrades a declared card's
 * status alone — declared answers are read per-file by `declaredAnswer`, and
 * losing them over a different file's size would drop the one part the agent
 * vouched for; the mechanical fallback has only that patch, so an undeclared
 * card stays status-only `oversize`.
 */
function outcomeOf(
  review: Review,
  prompt: AnnotationPrompt,
  declaration: DeclaredAnswer | undefined,
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
  if (declaration !== undefined) {
    const answers = declaration.files.map((file) => declaredAnswer(review, from, to, file));
    return { status, state: "ok", answers };
  }
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

/** The anchor as the card carries it: whole, or honestly absent. */
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

/** The name one side of last round's diff knew the file by. */
function sideName(made: SessionRound, path: string, side: AnnotationSide): string {
  if (side === "new") return path;
  return made.files.find((entry) => entry.path === path)?.previousPath ?? path;
}

/**
 * One declared file's answer: its whole between-round patch as hunks, never
 * anchor-filtered — the agent's word is that the whole change answers the
 * comment. An unreadable patch answers with no hunks rather than failing the
 * card: absence is not evidence against the agent's word.
 */
function declaredAnswer(review: Review, from: string, to: string, file: string): ReplayAnswer {
  const read = review.ask(from, to, gitNames(review, file));
  if (read.state === "oversize") return { file, hunks: [], oversized: true };
  if (read.state === "unreachable") return { file, hunks: [] };
  const found = parseDiff(read.patch).find((entry) => entry.path === file);
  if (found === undefined || found.diff === "") return { file, hunks: [] };
  return cappedHunks(file, found.diff);
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

/** A file's hunks, unless its patch outgrew what a card should render. */
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
