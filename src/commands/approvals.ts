import { ReviewError, validationError } from "../errors.ts";
import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { approvalPaths, type ApprovalPaths } from "../review-files.ts";
import { SessionStore } from "../session-store.ts";
import { hasFlag, scanArgs } from "./args.ts";
import { HELP_START } from "./home.ts";

export interface ApprovalsArgs {
  /** Unset when the reviewer left it to `resolveSession` to work out. */
  branch: string | undefined;
  base: string | undefined;
  /** `--full`: print every path instead of stopping at the per-list cap. */
  full: boolean;
}

export interface ApprovalsInput {
  repoRoot: string;
  branch: string;
  base: string;
  stateDir: string;
  full?: boolean;
}

const APPROVALS_FLAGS = ["--full"];

/**
 * How many paths of one list a bare listing prints. A branch-sized review fits
 * under it whole, and the reviews that do not are exactly the ones whose full
 * account costs the reading agent most; a path is also read to find something,
 * and nobody finds anything in the four hundredth line. `--full` lifts it in one
 * word. No byte budget beside it, unlike `feedback list`: a path has a length a
 * copied hunk does not, so counting paths bounds the answer on its own.
 */
export const DEFAULT_PATH_LIMIT = 50;

const HELP_FULL =
  `A bare listing stops at ${DEFAULT_PATH_LIMIT} paths per list:` +
  " add `--full` for every path behind these counts";

export function parseApprovalsArgs(args: string[]): ApprovalsArgs {
  const scanned = scanArgs(args, {
    boolean: ["--full"],
    // Fail loud: a mistyped flag read as a branch name would name a review
    // nobody opened, and answer `session_not_found` to a command that was right.
    onUnknown: unknownApprovalsFlag,
  });
  return {
    branch: scanned.positional[0],
    base: scanned.positional[1],
    full: hasFlag(scanned, "--full"),
  };
}

function unknownApprovalsFlag(flag: string): Error {
  return validationError(`unknown flag ${flag}`, [
    `Known here: ${APPROVALS_FLAGS.join(", ")}`,
    "Run `lightspeed approvals --help` for what each flag does",
  ]);
}

/**
 * The paths behind poll's counts, and the only place that prints them. Poll runs
 * on every round and its payload is read whether or not anyone needs a file
 * list, so the lists live here, behind a command an agent runs when something
 * turns on which file — naming a swept change it wants read, or chasing what was
 * left unapproved. Read off the store rather than the server: a review is worth
 * asking about after it ended, and the server may already be stopped.
 */
export function runApprovals(input: ApprovalsInput): StructuredOutput {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const session = new SessionStore(input.stateDir).get(key);
  if (session === undefined) {
    throw new ReviewError({
      code: "session_not_found",
      message: `no review session ${key}`,
      detail: `nothing on disk holds a review of ${input.branch} against ${input.base}`,
      suggestions: [HELP_START],
    });
  }
  const paths = approvalPaths(session.groups, session.approved);
  const listed = listing(paths, input.full ?? false);
  return {
    session: { key, branch: input.branch, base: input.base, status: session.status },
    approval: listed.paths,
    count: countBlock(paths, listed.omitted),
    help: [
      ...(listed.omitted > 0 ? [HELP_FULL] : []),
      session.status === "ended"
        ? "This review is over; these are the ticks it ended on"
        : "This review is still open, so these are the ticks so far and not a verdict",
      "`swept` files were approved in a lane the review filed as bulk, so the tick says" +
        " accepted and not read — ask the reviewer to read one when a change of yours needs it",
    ],
  };
}

type PathList = "approved" | "unapproved" | "swept";

const PATH_LISTS: readonly PathList[] = ["approved", "unapproved", "swept"];

interface Listing {
  paths: Record<PathList, string[]>;
  /** Paths the cap held back, across all three lists. */
  omitted: number;
}

/** The three lists as printed: each cut at the cap, none of them reordered, so
 * what is shown is the head of the review's own order and not a sample. */
function listing(paths: ApprovalPaths, full: boolean): Listing {
  const cut = (list: string[]) => (full ? list : list.slice(0, DEFAULT_PATH_LIMIT));
  const listed = {
    approved: cut(paths.approved),
    unapproved: cut(paths.unapproved),
    swept: cut(paths.swept),
  };
  const omitted = PATH_LISTS.reduce(
    (held, name) => held + paths[name].length - listed[name].length,
    0,
  );
  return { paths: listed, omitted };
}

/**
 * The account itself, never cut. A capped list renders under a length that is
 * the page's and not the tick's, so the numbers an agent decides on live beside
 * it and are read off the whole review — the same four counts poll reports under
 * its verdict, which is why the two can be compared at all.
 */
function countBlock(paths: ApprovalPaths, omitted: number): StructuredOutput {
  return {
    approved: paths.approved.length,
    unapproved: paths.unapproved.length,
    swept: paths.swept.length,
    total: paths.total,
    omitted,
    has_more: omitted > 0,
  };
}
