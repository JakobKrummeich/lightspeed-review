import type { SessionRound } from "../session-store.ts";
import { fileApproval, fileHistory } from "./history.ts";

/**
 * "What changed after approval" — the second half of the per-file toggle: what
 * the agent did to the file after sign-off, which the branch diff cannot say
 * without re-reading the whole file. Pure, like the rest of `src/rounds/`: it
 * names which two commits to diff, the caller asks git.
 */

/** Which two commits hold the reviewer's approved form and today's. */
export interface ApprovedForm {
  /**
   * Head commit of the round whose close recorded the standing approval — the
   * tree the reviewer read — or null when that round recorded none (pre-commit session).
   */
  fromCommit: string | null;
  /** The head commit of the round being reviewed, by the same rule. */
  toCommit: string | null;
  /**
   * Every name the file has gone by from the approval to now, oldest first and
   * each one once. Git is given all of them, because `--find-renames` needs
   * both ends of a rename named to pair them up.
   */
  paths: string[];
}

/**
 * Undefined when the question does not arise: the file is not `needs-reapproval`.
 * A withdrawn approval counts as none — `fileApproval` reads it that way — so an
 * unticked file offers no toggle either.
 */
export function approvedForm(rounds: SessionRound[], path: string): ApprovedForm | undefined {
  if (fileApproval(rounds, path) !== "needs-reapproval") return undefined;
  const history = fileHistory(rounds, path);
  const at = history.findLastIndex((appearance) => appearance.approved);
  const approved = history[at];
  // Unreachable: `needs-reapproval` is only reported for a file some round closed
  // on. Narrowing, not asserting, keeps that a type invariant.
  if (approved === undefined) return undefined;
  const approvingRound = rounds.find((round) => round.index === approved.round);
  return {
    fromCommit: approvingRound?.headCommit ?? null,
    toCommit: rounds.at(-1)?.headCommit ?? null,
    paths: [...new Set(history.slice(at).map((appearance) => appearance.path))],
  };
}

/**
 * Beyond this the patch is unreadable in a browser, and half a patch would pose
 * as the whole change; such a diff is named and measured instead.
 */
export const MAX_APPROVED_FORM_BYTES = 512 * 1024;

/**
 * Why there is no diff on the wire, stated plainly rather than papered over:
 * - `identical` — same bytes: edited in between, back where the reviewer left it.
 * - `binary` — changed but no lines to show (including text-then, binary-now).
 * - `unreachable` — rebase/force-push made a commit unreachable; not guessed at.
 * - `unrecorded` — a round recorded no commit (pre-commit session); nothing was
 *   rewritten, and saying "rebase" would send the reviewer hunting one.
 * - `oversize` — past `MAX_APPROVED_FORM_BYTES`, or more than git could hand back.
 */
export type ApprovedFormState =
  "diff" | "identical" | "binary" | "unreachable" | "unrecorded" | "oversize";

/** What `GET /api/session/:key/approved-form` answers. */
export interface ApprovedFormData {
  /** The file's name today, as the reviewer asked for it. */
  path: string;
  /**
   * Every name git was given, oldest first. Shipped so the page can hand the
   * reviewer the command that produced this — a renamed file's change is
   * invisible to a `git diff` that names only today's path.
   */
  paths: string[];
  from: string | null;
  to: string | null;
  state: ApprovedFormState;
  /** The patch, present exactly when `state` is `diff`. */
  diff?: string;
  /**
   * Patch size when known: `state` is `oversize` and git handed the patch over.
   * A patch too large for git's own buffer is never sized.
   */
  bytes?: number;
}
