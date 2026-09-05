import type { DiffFileStatus } from "../diff-extract.ts";
import type { RoundFile, SessionRound } from "../session-store.ts";

/**
 * What one round says about one file. `round` is the round's index, so a caller
 * can line an appearance up with the session's own `rounds[]`.
 */
export interface FileAppearance {
  round: number;
  /** The name the file went by in that round, which a later rename changes. */
  path: string;
  blob: string | null;
  status: DiffFileStatus;
  /** Whether the file was ticked approved when that round closed. */
  approved: boolean;
}

/**
 * Where a file stands with the reviewer (age is `firstSeenRound`'s question):
 * - `needs-reapproval` — approved once, then edited by the agent.
 * - `unapproved` — never approved.
 * - `approved` — approved and proven untouched since by its blob sha.
 * Hyphenated so one string serves as JSON value, `data-approval` attribute and
 * CSS selector.
 */
export type Approval = "needs-reapproval" | "unapproved" | "approved";

/** What a file's approval is worth today: what was approved, and whether it held. */
export interface SettledFile {
  /** The blob the reviewer last approved, or null when they never did. */
  approvedAtBlob: string | null;
  /** Whether the file changed in any round after that approval. */
  changedSince: boolean;
}

/**
 * Every round a file took part in, oldest first, under whatever name it had at
 * the time — a rename is followed backwards, so callers pass today's path only.
 */
export function fileHistory(rounds: SessionRound[], path: string): FileAppearance[] {
  const appearances: FileAppearance[] = [];
  let name = path;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index];
    if (round === undefined) continue;
    const file = fileIn(round, name);
    if (file === undefined) continue;
    appearances.push({
      round: round.index,
      path: name,
      blob: file.blob,
      status: file.status,
      approved: round.approvedAtEnd.includes(name),
    });
    if (file.previousPath !== undefined) name = file.previousPath;
  }
  return appearances.reverse();
}

/**
 * The name `path` goes by in a later round: a rename since makes the file show
 * up there as the new name's `previousPath`. Shared by the ledger's outcomes
 * and the between-rounds replay, so the two cannot disagree on which file a
 * verdict is about.
 */
export function currentName(current: SessionRound, path: string): string {
  return current.files.find((file) => file.previousPath === path)?.path ?? path;
}

/**
 * Whether the file differs between two rounds, `path` naming it as of `b`.
 * Absent from either round, or without a sha either round can be held to, it
 * reports changed: nothing here may claim a file is untouched without the shas
 * to prove it.
 */
export function changedBetween(a: SessionRound, b: SessionRound, path: string): boolean {
  const later = fileIn(b, path);
  const earlier = fileIn(a, later?.previousPath ?? path);
  return !sameBlob(later?.blob ?? null, earlier?.blob ?? null);
}

/**
 * New rounds hold the full sha (`--full-index`, see `src/diff-extract.ts`);
 * older rounds hold whatever width git abbreviated to, so comparison runs over
 * the length both wrote. Below git's floor of seven that stops being evidence
 * (an `--abbrev=4` record matches one edit in 65536 by luck): too short proves
 * nothing, as does a missing sha.
 */
export function sameBlob(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const width = Math.min(a.length, b.length);
  if (width < SHORTEST_TRUSTED_SHA) return false;
  return a.slice(0, width) === b.slice(0, width);
}

/** Git's own shortest abbreviation, and the shortest that can vouch for a file. */
const SHORTEST_TRUSTED_SHA = 7;

/**
 * The reviewer's standing verdict on a file: the blob they last approved and
 * whether anything moved since. A file nobody ever ticked has neither, and
 * neither has one whose approval the reviewer took back.
 */
export function settled(rounds: SessionRound[], path: string): SettledFile {
  const history = fileHistory(rounds, path);
  const approvedAt = history.findLastIndex((appearance) => appearance.approved);
  const approved = history[approvedAt];
  if (approved === undefined) return { approvedAtBlob: null, changedSince: false };
  const since = history.slice(approvedAt + 1);
  if (withdrawn(since, approved, rounds.at(-1)?.index)) {
    return { approvedAtBlob: null, changedSince: false };
  }
  return {
    approvedAtBlob: approved.blob,
    changedSince: since.some((appearance) => !sameBlob(appearance.blob, approved.blob)),
  };
}

/**
 * Approval taken back: a round closed on this file unticked while its text
 * stood where approved — leaving the tick off was a decision, and the newer
 * decision counts. The `open` round is excluded: its ticks are still live, and
 * reading its empty `approvedAtEnd` as withdrawal would undo every approval
 * the moment the next round opened.
 */
function withdrawn(
  since: FileAppearance[],
  approved: FileAppearance,
  open: number | undefined,
): boolean {
  return since.some(
    (appearance) =>
      appearance.round !== open && !appearance.approved && sameBlob(appearance.blob, approved.blob),
  );
}

/**
 * Approval is only claimed when a blob sha proves the file unmoved since its
 * tick, so a patch naming no sha is never approved: binary files, and a
 * 100%-identical rename (header-only patch). Git would give the rename's shas
 * under `--raw` — a gap in what we ask for, not in what git can tell.
 */
export function fileApproval(rounds: SessionRound[], path: string): Approval {
  const { approvedAtBlob, changedSince } = settled(rounds, path);
  if (approvedAtBlob === null) return "unapproved";
  return changedSince ? "needs-reapproval" : "approved";
}

/**
 * The round this file entered the review in — not when git first saw it: a file
 * modified long ago but shown for the first time in round 3 was first seen in
 * round 3. A file the rounds say nothing about has not been seen at all.
 */
export function firstSeenRound(rounds: SessionRound[], path: string): number | null {
  return fileHistory(rounds, path)[0]?.round ?? null;
}

/**
 * Files of the newest round that arrive already approved. The newest round's own
 * `approvedAtEnd` is blanked so `settled` answers the same before and after
 * `end` closes it — its own approvals would otherwise vouch for every file.
 */
export function carriedApproval(rounds: SessionRound[]): string[] {
  const current = rounds.at(-1);
  if (current === undefined) return [];
  const opening = [...rounds.slice(0, -1), { ...current, approvedAtEnd: [] }];
  return current.files
    .filter((file) => fileApproval(opening, file.path) === "approved")
    .map((file) => file.path);
}

/**
 * Where every file of the newest round stands given the live ticks. `approved`
 * decides by itself — a just-unticked file is unapproved whatever earlier rounds
 * say. The rounds decide the other half: a file edited out from under its
 * approval reads `needs-reapproval`, not plain `unapproved`.
 */
export function roundApproval(
  rounds: SessionRound[],
  approved: string[],
): Record<string, Approval> {
  const current = rounds.at(-1);
  if (current === undefined) return {};
  const ticked = new Set(approved);
  return Object.fromEntries(
    current.files.map((file) => [file.path, standing(rounds, file.path, ticked)]),
  );
}

function standing(rounds: SessionRound[], path: string, ticked: Set<string>): Approval {
  if (ticked.has(path)) return "approved";
  return fileApproval(rounds, path) === "needs-reapproval" ? "needs-reapproval" : "unapproved";
}

function fileIn(round: SessionRound, path: string): RoundFile | undefined {
  return round.files.find((file) => file.path === path);
}
