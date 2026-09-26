/**
 * Whether a thread's anchor still points at what the reviewer selected. An
 * item keeps the `file:line` it was drawn at, in the round it was drawn in;
 * rounds later that number may name a blank line or some other code, and an
 * agent opening today's file there answers about the wrong thing. Server-side
 * only: it reads git, which the browser bundle (`threads.ts`) must not.
 */
import { readFileAtCommit } from "./git-file.ts";
import type { SessionRecord, SessionRound } from "./session-types.ts";
import type { BatchItem } from "./threads.ts";

type ReadFile = (repoRoot: string, commit: string, path: string) => string | undefined;

export function withDrift(
  items: BatchItem[],
  session: Pick<SessionRecord, "repoRoot" | "rounds">,
  read: ReadFile = readFileAtCommit,
): BatchItem[] {
  return items.map((item) => (drifted(item, session, read) ? { ...item, outdated: true } : item));
}

/**
 * Claims a change only when it can show one: the lines read differently now,
 * or the file is gone. An unknowable past (no commit recorded, git cannot
 * produce the file) claims nothing — a false "outdated" sends the agent hunting.
 */
function drifted(
  item: BatchItem,
  session: Pick<SessionRecord, "repoRoot" | "rounds">,
  read: ReadFile,
): boolean {
  const anchor = anchorOf(item);
  if (anchor === undefined) return false;
  const commits = commitsOf(anchor, session.rounds);
  if (commits === undefined) return false;
  const was = read(session.repoRoot, commits.before, anchor.file);
  if (was === undefined) return false;
  const is = read(session.repoRoot, commits.after, anchor.file);
  if (is === undefined) return true;
  return linesOf(was, anchor) !== linesOf(is, anchor);
}

interface Anchor {
  anchoredIn: number;
  file: string;
  side: "old" | "new" | undefined;
  start: number;
  end: number;
}

function anchorOf(item: BatchItem): Anchor | undefined {
  if (item.status === "resolved" || item.anchoredIn === undefined) return undefined;
  if (item.file === undefined || item.line_start === undefined) return undefined;
  const { anchoredIn, file, side, line_start: start } = item;
  return { anchoredIn, file, side, start, end: item.line_end ?? start };
}

/** Nothing to compare when the anchor's round is the one on screen or its commits are unknown. */
function commitsOf(
  anchor: Anchor,
  rounds: readonly SessionRound[],
): { before: string; after: string } | undefined {
  const now = rounds.at(-1);
  const then = rounds.find((round) => round.index === anchor.anchoredIn);
  if (now === undefined || then === undefined || now.index === then.index) return undefined;
  const before = commitOf(then, anchor.side);
  const after = commitOf(now, anchor.side);
  if (before === undefined || after === undefined || before === after) return undefined;
  return { before, after };
}

function commitOf(round: SessionRound, side: "old" | "new" | undefined): string | undefined {
  return side === "old" ? round.baseCommit : round.headCommit;
}

function linesOf(text: string, anchor: Anchor): string {
  return text
    .split("\n")
    .slice(anchor.start - 1, anchor.end)
    .join("\n");
}
