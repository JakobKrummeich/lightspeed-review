import type { DiffNames } from "./git-file.ts";
import type { DeclaredAnswer, SessionRecord } from "./session-store.ts";

/**
 * The agent's answer to one reviewer comment (id from `poll` output): a note
 * and/or the files it led to. This file owns the whole server path — shape
 * check, session validation, session update. Only the agent knows these facts,
 * so nothing here fills one in: absence renders as "unknown", never a guess.
 */
export interface CommentDeclaration {
  /** The annotation's id, as `poll` printed it. */
  id: string;
  /** The per-comment answer; absent when the files speak for themselves. */
  note?: string;
  /** Paths the comment led to changes in; empty for a question or a decision. */
  files: string[];
}

/**
 * The names git says changed between two commits, injected so validation stays
 * pure. The server passes `listDiffNames` bound to the session's repository.
 */
export type ReadRoundDiff = (from: string, to: string) => DiffNames;

/** One rejected entry and why, spelt for the error the agent reads. */
export interface DeclarationProblem {
  id: string;
  reason: string;
}

/**
 * Shape check of the untrusted `declarations` field: `undefined` = malformed,
 * whole request 400s. An absent field never reaches here — declaring nothing is valid.
 */
export function parseDeclarations(value: unknown): CommentDeclaration[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: CommentDeclaration[] = [];
  for (const entry of value) {
    const declaration = parseDeclaration(entry);
    if (declaration === undefined) return undefined;
    parsed.push(declaration);
  }
  return parsed;
}

function parseDeclaration(value: unknown): CommentDeclaration | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { id, note, files } = value as { id?: unknown; note?: unknown; files?: unknown };
  const paths = parseFiles(files);
  if (!isId(id) || !isNote(note) || paths === undefined) return undefined;
  return { id, ...(note === undefined ? {} : { note }), files: paths };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isNote(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** Absent files are an empty list; a list is only paths, each said once. */
function parseFiles(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    return undefined;
  }
  return [...new Set(value as string[])];
}

/**
 * All entries judged, every problem reported — the agent fixes the whole thing
 * in one round trip. One problem rejects the whole request: no half-stored typo.
 */
export function validateDeclarations(
  session: SessionRecord,
  declarations: CommentDeclaration[],
  readDiff: ReadRoundDiff,
): DeclarationProblem[] {
  const rounds = annotationRounds(session);
  const problems: DeclarationProblem[] = [];
  const seen = new Set<string>();
  for (const declaration of declarations) {
    if (seen.has(declaration.id)) {
      problems.push({ id: declaration.id, reason: "declared twice in one reply" });
      continue;
    }
    seen.add(declaration.id);
    problems.push(...entryProblems(session, declaration, rounds, readDiff));
  }
  return problems;
}

function entryProblems(
  session: SessionRecord,
  declaration: CommentDeclaration,
  rounds: Map<string, number | undefined>,
  readDiff: ReadRoundDiff,
): DeclarationProblem[] {
  if (!rounds.has(declaration.id)) {
    return [
      {
        id: declaration.id,
        reason: "no reviewer comment has this id; ids come from `lightspeed poll` output",
      },
    ];
  }
  if (declaration.note === undefined && declaration.files.length === 0) {
    return [{ id: declaration.id, reason: "declares nothing: give a note, files, or both" }];
  }
  return declaredFileProblems(session, declaration, rounds.get(declaration.id), readDiff);
}

/**
 * Declarable ids: annotation prompts with their round. Pre-id prompts are not
 * in the map, so declaring one is "unknown id" — never reachable by guesswork.
 */
function annotationRounds(session: SessionRecord): Map<string, number | undefined> {
  const rounds = new Map<string, number | undefined>();
  for (const entry of session.conversation) {
    for (const prompt of entry.prompts) {
      if (prompt.type === "annotation" && prompt.id !== undefined) {
        rounds.set(prompt.id, entry.roundIndex);
      }
    }
  }
  return rounds;
}

/**
 * A declared file must appear in the between-round diff (comment round's head
 * vs current round's): the reviewer is shown its hunks as the answer. Membership
 * in git's own file list refuses `../`, globs and absolute paths the same as an
 * untouched file. Unknowable history (rebase, pre-commit-recording session)
 * accepts the declaration as stated: rendered unverified, never wrong.
 */
function declaredFileProblems(
  session: SessionRecord,
  declaration: CommentDeclaration,
  madeInRound: number | undefined,
  readDiff: ReadRoundDiff,
): DeclarationProblem[] {
  const { from, to } = roundCommits(session, madeInRound);
  if (from === undefined || to === undefined || declaration.files.length === 0) return [];
  // Same commit both sides: no between-round diff yet. Said with the way out, not as "empty diff".
  if (from === to) {
    return declaration.files.map((file) => ({
      id: declaration.id,
      reason:
        `${file} cannot be checked yet: no round has been started since this comment` +
        ` (still at ${shortCommit(to)}). Commit your changes and run \`lightspeed start\`` +
        " before declaring files, or declare with --note only",
    }));
  }
  const diff = readDiff(from, to);
  if (diff.state === "unknowable") return [];
  const changed = new Set(diff.files);
  return declaration.files
    .filter((file) => !changed.has(file))
    .map((file) => ({
      id: declaration.id,
      reason:
        `${file} is not in the between-round diff (${shortCommit(from)}..${shortCommit(to)});` +
        " declare only files that diff lists, by their exact paths",
    }));
}

/** The comment's round's head and the current round's, where both are recorded. */
function roundCommits(
  session: SessionRecord,
  madeInRound: number | undefined,
): { from: string | undefined; to: string | undefined } {
  return {
    from: session.rounds.find((round) => round.index === madeInRound)?.headCommit,
    to: session.rounds.at(-1)?.headCommit,
  };
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * Newest declaration per comment wins: wholesale replacement makes re-sending
 * the same reply safe and a corrected one effective.
 */
export function withDeclarations(
  session: SessionRecord,
  declarations: CommentDeclaration[],
  now: string,
): SessionRecord {
  if (declarations.length === 0) return session;
  const merged: Record<string, DeclaredAnswer> = { ...session.declarations };
  for (const declaration of declarations) {
    merged[declaration.id] = {
      ...(declaration.note === undefined ? {} : { note: declaration.note }),
      files: declaration.files,
      at: now,
    };
  }
  return { ...session, declarations: merged };
}
