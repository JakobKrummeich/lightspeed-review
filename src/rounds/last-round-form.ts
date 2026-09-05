import type { RoundFile, SessionRound } from "../session-store.ts";
import type { ApprovedForm } from "./approved-form.ts";
import { fileApproval, sameBlob } from "./history.ts";

/**
 * "What changed since the round I read" — the toggle for a never-approved file
 * the agent kept editing: the branch diff shows all 406 lines again, with no
 * way to find the new six. Pure, like `approved-form.ts`, whose `ApprovedForm`
 * shape it answers with — the same two-commits-and-names question, different rounds.
 */

/**
 * The last two rounds' commits and the file's names in them; undefined when the
 * question does not arise: first round, file absent from either round, blobs
 * that match (or cannot be held to), or a `needs-reapproval` file — that one
 * carries the approved-form switch instead. One comparison per file, never two.
 */
export function lastRoundForm(rounds: SessionRound[], path: string): ApprovedForm | undefined {
  const current = rounds.at(-1);
  const previous = rounds.at(-2);
  if (current === undefined || previous === undefined) return undefined;
  const file = current.files.find((entry) => entry.path === path);
  if (file === undefined) return undefined;
  const before = changedFrom(previous.files, file);
  if (before === undefined || fileApproval(rounds, path) === "needs-reapproval") return undefined;
  return {
    fromCommit: headOf(previous),
    toCommit: headOf(current),
    paths: [...new Set([before.path, path])],
  };
}

/** A head commit as `ApprovedForm` spells it: null for a round that stored none. */
function headOf(round: SessionRound): string | null {
  return round.headCommit ?? null;
}

/**
 * The file's record in the round before, when the two blobs prove an edit —
 * undefined for a sha missing or too short to trust: the switch opens on a
 * diff, so it may only be offered on "provably different". Matched by today's
 * name first, the rename's old name second (`previousPath` names the base side
 * and outlives the rename by rounds). Exported for
 * `src/browser/round-changes.ts` so page and server decide by the same comparison.
 */
export function changedFrom(
  previous: readonly RoundFile[],
  file: RoundFile,
): RoundFile | undefined {
  const before =
    previous.find((entry) => entry.path === file.path) ??
    previous.find((entry) => entry.path === file.previousPath);
  if (before === undefined || before.blob === null || file.blob === null) return undefined;
  return sameBlob(before.blob, file.blob) ? undefined : before;
}
