import { changedBetween, currentName, settled } from "../rounds/history.ts";
import type { SessionRecord, SessionRound } from "../session-store.ts";
import {
  buildOutcomeRecord,
  VERDICTS,
  type AnnotationRecord,
  type IdSource,
  type OutcomeRecord,
  type RepoRef,
  type Verdict,
} from "./records.ts";

/**
 * What became of each annotation, judged when the next round opens. Every
 * `start` re-judges all earlier annotations — evidence keeps arriving, and the
 * read side keeps the newest outcome per annotation as the standing one. Pure:
 * round facts come from `src/rounds/history.ts`; the caller injects the one
 * thing only git knows, the diff between two commits.
 */

/**
 * The diff of some paths between two commits, or undefined when git cannot
 * produce one. A rebase or force-push makes a commit unreachable, and that is
 * the normal case rather than an error: it yields `unknown`, never a guess.
 */
export type ReadFileDiff = (from: string, to: string, paths: string[]) => string | undefined;

/** Everything a verdict is decided from, and nothing else. */
export interface OutcomeFacts {
  /** Whether both commits were reachable, so the rounds can be compared at all. */
  comparable: boolean;
  fileTouched: boolean;
  reAnnotated: boolean;
  approved: boolean;
}

export interface OutcomesInput {
  repo: RepoRef;
  now: string;
  nextId: IdSource;
  /** Ledger id of the round `start` has just opened. */
  nextRound: string;
  /** The session as it stands after that `start`, so its newest round is the open one. */
  session: SessionRecord;
  /** This session's annotations as the ledger has them, oldest first. */
  annotations: AnnotationRecord[];
  diffFile: ReadFileDiff;
}

/** The session's rounds seen from the one now opening: what a judgement reads. */
interface Review {
  rounds: SessionRound[];
  current: SessionRound;
  annotations: AnnotationRecord[];
  diffFile: ReadFileDiff;
}

/** One annotation's evidence: the facts plus what they were read from. */
interface Judgement extends OutcomeFacts {
  fromCommit: string | null;
  toCommit: string | null;
  patch: string | undefined;
}

export function outcomeRecords(input: OutcomesInput): OutcomeRecord[] {
  const rounds = input.session.rounds;
  const current = rounds.at(-1);
  if (current === undefined) return [];
  const review: Review = {
    rounds,
    current,
    annotations: input.annotations,
    diffFile: askOnce(input.diffFile),
  };
  const records: OutcomeRecord[] = [];
  for (const annotation of input.annotations) {
    const made = earlierRound(review, annotation.round);
    if (made === undefined) continue;
    records.push(outcomeRecord(input, annotation, judge(review, annotation, made)));
  }
  return records;
}

/**
 * Every annotation of a round names the same few files, and each ask is a git
 * subprocess, so the same question is put to git once per `start` rather than
 * once per annotation.
 */
function askOnce(diffFile: ReadFileDiff): ReadFileDiff {
  const answers = new Map<string, string | undefined>();
  return (from, to, paths) => {
    const key = [from, to, ...paths].join("\0");
    if (!answers.has(key)) answers.set(key, diffFile(from, to, paths));
    return answers.get(key);
  };
}

function roundWithId(review: Review, id: string): SessionRound | undefined {
  return review.rounds.find((round) => round.round === id);
}

/**
 * The round an annotation was made in, or undefined when it is not one this
 * session still remembers, or is the round now opening — whose annotations
 * nothing has responded to yet.
 */
function earlierRound(review: Review, id: string): SessionRound | undefined {
  const made = roundWithId(review, id);
  return made === undefined || made.index >= review.current.index ? undefined : made;
}

function judge(review: Review, annotation: AnnotationRecord, made: SessionRound): Judgement {
  const path = currentName(review.current, annotation.file);
  const patch = responsePatch(review, made, [annotation.file, path]);
  return {
    fromCommit: made.headCommit ?? null,
    toCommit: review.current.headCommit ?? null,
    patch,
    comparable: patch !== undefined,
    fileTouched: changedBetween(made, review.current, path),
    reAnnotated: raisedAfter(review, annotation, made, path),
    approved: heldApproval(review.rounds, path),
  };
}

/** What the agent did to the file between the two rounds' head commits. */
function responsePatch(review: Review, made: SessionRound, paths: string[]): string | undefined {
  const from = made.headCommit;
  const to = review.current.headCommit;
  if (from === undefined || to === undefined) return undefined;
  return review.diffFile(from, to, [...new Set(paths)]);
}

/**
 * Whether the reviewer marked the same file again in a round after this one.
 * `path` is the annotated file's name in the round now opening, which is what
 * every other annotation's file is compared under.
 */
function raisedAfter(
  review: Review,
  annotation: AnnotationRecord,
  made: SessionRound,
  path: string,
): boolean {
  return review.annotations.some(
    (other) =>
      other.id !== annotation.id &&
      currentName(review.current, other.file) === path &&
      madeAfter(review, other.round, made.index),
  );
}

function madeAfter(review: Review, id: string, index: number): boolean {
  const round = roundWithId(review, id);
  return round !== undefined && round.index > index;
}

/** Whether the reviewer's approval of the file still stands today. */
function heldApproval(rounds: SessionRound[], path: string): boolean {
  const { approvedAtBlob, changedSince } = settled(rounds, path);
  return approvedAtBlob !== null && !changedSince;
}

function outcomeRecord(
  input: OutcomesInput,
  annotation: AnnotationRecord,
  judgement: Judgement,
): OutcomeRecord {
  return buildOutcomeRecord({
    id: input.nextId("evt", input.now),
    at: input.now,
    repo: input.repo,
    about: annotation.id,
    next_round: input.nextRound,
    from_commit: judgement.fromCommit,
    to_commit: judgement.toCommit,
    file_touched: judgement.fileTouched,
    // An empty diff is an answer — "nothing changed" — not a patch to store.
    ...(judgement.patch === undefined || judgement.patch === ""
      ? {}
      : { response_patch: judgement.patch }),
    re_annotated: judgement.reAnnotated,
    approved: judgement.approved,
    verdict: verdictFor(judgement),
  });
}

type VerdictTest = (facts: OutcomeFacts) => boolean;

/** No diff between the two rounds: the commits are gone, so nothing is provable. */
const unjudgeable: VerdictTest = (facts) => !facts.comparable;

/** The reviewer marked the same file again after this comment. */
const raisedAgain: VerdictTest = (facts) => facts.comparable && facts.reAnnotated;

/** The agent changed the file, or the reviewer signed it off as it stands. */
const respondedTo: VerdictTest = (facts) =>
  facts.comparable && !facts.reAnnotated && (facts.fileTouched || facts.approved);

/** Comparable, never raised again, and nothing moved: the comment went nowhere. */
const wentNowhere: VerdictTest = (facts) =>
  facts.comparable && !facts.reAnnotated && !facts.fileTouched && !facts.approved;

/**
 * The question behind each verdict, keyed by the union so a new verdict fails to
 * typecheck until it has one. The four tests are mutually exclusive and cover
 * every combination of the facts — an invariant the tests pin — so the order
 * they are asked in does not matter.
 */
const VERDICT_TESTS: Record<Verdict, VerdictTest> = {
  addressed: respondedTo,
  ignored: wentNowhere,
  repeated: raisedAgain,
  unknown: unjudgeable,
};

export function verdictFor(facts: OutcomeFacts): Verdict {
  return VERDICTS.find((verdict) => VERDICT_TESTS[verdict](facts)) ?? "unknown";
}
