/**
 * The ledger hooks the handlers call. Each one composes records and hands them
 * to `recordSafely`, which is the only place a write failure is swallowed — so
 * a broken ledger can never change what a handler does next.
 */
import { readDiffBetween } from "../git-file.ts";
import { outcomeRecords } from "../ledger/outcomes.ts";
import type { AnnotationRecord, AnnotationSide, IdSource } from "../ledger/records.ts";
import type { LedgerStore } from "../ledger/store.ts";
import {
  agentReplyRecords,
  declarationRecords,
  feedbackRecords,
  recordSafely,
  roundEndRecords,
  roundRecords,
  type LedgerWriteResult,
} from "../ledger/write.ts";
import { repoRef } from "../repo.ts";
import type { CommentDeclaration } from "../declarations.ts";
import type { FeedbackPrompt, SessionRecord } from "../session-store.ts";
import { readSessionFile } from "./session-files.ts";

/** What every hook shares: the store written through, and the id order of this run. */
export interface LedgerLog {
  /** Absent when `feedbackLog` is `off`: there is then nothing to write through. */
  ledger?: LedgerStore;
  /** One id source per server: it orders every record this run writes. */
  nextId: IdSource;
}

/** What `start` prints about the ledger: healthy with a path, off, or degraded. */
export interface LedgerReport {
  status: "on" | "off" | "degraded";
  path?: string;
  reason?: string;
}

function report(result: LedgerWriteResult): LedgerReport {
  return {
    status: result.status,
    ...(result.path === undefined ? {} : { path: result.path }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

export function logRound(
  log: LedgerLog,
  session: SessionRecord,
  round: string,
  now: string,
): LedgerReport {
  const repo = repoRef(session.repoRoot);
  const { ledger, nextId } = log;
  return report(recordSafely(ledger, roundRecords({ round, session, repo, now, nextId })));
}

/**
 * What became of the earlier rounds' annotations, judged now that the agent's
 * answer is a round of its own. Written after the round record, so the ledger
 * reads as: this is the new round, and this is what the last ones came to.
 */
export function logOutcomes(
  log: LedgerLog,
  session: SessionRecord,
  round: string,
  now: string,
): void {
  if (log.ledger === undefined) return;
  recordSafely(
    log.ledger,
    outcomeRecords({
      repo: repoRef(session.repoRoot),
      now,
      nextId: log.nextId,
      nextRound: round,
      session,
      annotations: sessionAnnotations(log.ledger, session),
      // The ledger asks a yes/no question of the patch, so a patch it could
      // not read and a patch too big to read are the same `unknown` to it.
      diffFile: (from, to, paths) => {
        const read = readDiffBetween(session.repoRoot, from, to, paths);
        return read.state === "patch" ? read.patch : undefined;
      },
    }),
  );
}

export function logFeedback(
  log: LedgerLog,
  session: SessionRecord,
  prompts: FeedbackPrompt[],
  now: string,
): void {
  // Promptless `Send & End`: nothing to write, and `repoRef` would spend a git subprocess on it.
  if (prompts.length === 0) return;
  const repo = repoRef(session.repoRoot);
  const readFile = (path: string, side: AnnotationSide) => readSessionFile(session, path, side);
  const { ledger, nextId } = log;
  recordSafely(ledger, feedbackRecords({ session, repo, prompts, readFile, now, nextId }));
}

export function logAgentReply(
  log: LedgerLog,
  session: SessionRecord,
  comment: string,
  now: string,
): void {
  const repo = repoRef(session.repoRoot);
  const { ledger, nextId } = log;
  recordSafely(ledger, agentReplyRecords({ session, repo, comment, now, nextId }));
}

export function logDeclarations(
  log: LedgerLog,
  session: SessionRecord,
  declarations: CommentDeclaration[],
  now: string,
): void {
  if (declarations.length === 0) return;
  const repo = repoRef(session.repoRoot);
  const { ledger, nextId } = log;
  recordSafely(ledger, declarationRecords({ session, repo, declarations, now, nextId }));
}

export function logRoundEnd(log: LedgerLog, session: SessionRecord, now: string): void {
  const repo = repoRef(session.repoRoot);
  const { ledger, nextId } = log;
  recordSafely(ledger, roundEndRecords({ session, repo, now, nextId }));
}

/**
 * This session's annotations by its round ids. Filters go to the store so the
 * cost is this session's lines, not the whole ledger — this runs inside
 * `POST /api/sessions`. The first round's timestamp bounds the read.
 */
function sessionAnnotations(ledger: LedgerStore, session: SessionRecord): AnnotationRecord[] {
  const rounds = session.rounds
    .map((entry) => entry.round)
    .filter((round): round is string => round !== undefined);
  if (rounds.length === 0) return [];
  const since = session.rounds[0]?.at;
  return ledger.read({ kind: "annotation", repo: session.repoRoot, rounds, since })
    .records as AnnotationRecord[];
}
