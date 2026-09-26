import { ReviewError, invocationError } from "../errors.ts";
import { DEFAULT_PATH_LIMIT, type StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { approvalPaths, type ApprovalPaths } from "../review-files.ts";
import { SessionStore } from "../session-store.ts";
import { HELP_OPEN } from "../turn-help.ts";
import { hasFlag, scanArgs } from "./args.ts";

export interface ApprovalsArgs {
  /** Unset when the reviewer left it to `resolveSession` to work out. */
  branch: string | undefined;
  base: string | undefined;
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
  return invocationError("unknown_flag", `unknown flag ${flag}`, [
    `Known here: ${APPROVALS_FLAGS.join(", ")}`,
    "Run `lightspeed approvals --help` for what each flag does",
  ]);
}

/**
 * The only place that prints the paths behind the waiting commands' counts: they run on
 * every round and its payload is read whether or not anyone needs a file list.
 * Read off the store rather than the server: a review is worth asking about
 * after it ended, and the server may already be stopped.
 */
export function runApprovals(input: ApprovalsInput): StructuredOutput {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const session = new SessionStore(input.stateDir).get(key);
  if (session === undefined) {
    throw new ReviewError({
      code: "session_not_found",
      message: `no review session ${key}`,
      detail: `nothing on disk holds a review of ${input.branch} against ${input.base}`,
      suggestions: [HELP_OPEN],
    });
  }
  const paths = approvalPaths(session.groups, session.approved);
  const listed = listing(paths, input.full ?? false);
  return {
    // No `status`: a second word for the review's state went stale between
    // rounds, and the help below already says whether this review is over.
    session: { key, branch: input.branch, base: input.base },
    counts: countBlock(paths, listed.omitted),
    ...namedPaths(listed.paths),
    help: [
      ...(listed.omitted > 0 ? [HELP_FULL] : []),
      session.status === "ended"
        ? "This review is over: these are the ticks it ended on"
        : "This review is still open: these are the ticks so far, not a verdict",
      // On every review with no swept lane this was two lines explaining a
      // count that read 0.
      ...(paths.swept.length > 0 ? [SWEPT_HELP] : []),
    ],
  };
}

const SWEPT_HELP =
  "`swept` files were approved in a lane the review filed as bulk, so the tick says" +
  " accepted and not read — ask the reviewer to read one when a change of yours needs it";

/** Only the lists with something in them: `unapproved[3]` reads as the answer,
 * `approval: {approved: [], ...}` reads as a form. */
function namedPaths(paths: Record<PathList, string[]>): StructuredOutput {
  return Object.fromEntries(
    PATH_LISTS.filter((name) => paths[name].length > 0).map((name) => [name, paths[name]]),
  );
}

type PathList = "approved" | "unapproved" | "swept";

const PATH_LISTS: readonly PathList[] = ["approved", "unapproved", "swept"];

interface Listing {
  paths: Record<PathList, string[]>;
  /** Paths the cap held back, across all three lists. */
  omitted: number;
}

/** None of the lists is reordered: what is shown is the head of the review's own
 * order, not a sample. */
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
 * Never cut: the numbers an agent decides on are read off the whole review, and
 * they are the same four counts a waiting command reports under its verdict, which is why
 * the two can be compared at all.
 */
function countBlock(paths: ApprovalPaths, omitted: number): StructuredOutput {
  return {
    approved: paths.approved.length,
    unapproved: paths.unapproved.length,
    swept: paths.swept.length,
    total: paths.total,
    // `omitted: 0` said nothing on every review small enough to print whole,
    // which is nearly all of them; the `--full` help line says the rest.
    ...(omitted > 0 ? { omitted } : {}),
  };
}
