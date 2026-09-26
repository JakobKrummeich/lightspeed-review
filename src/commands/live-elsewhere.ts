import { resolve } from "node:path";
import { ReviewError } from "../errors.ts";
import { quietGit } from "../git-state.ts";
import type { SessionRecord } from "../session-types.ts";
import { WAITS_FOR_SEND, reattachCall } from "../turn-help.ts";

export interface OpenTarget {
  repoRoot: string;
  branch: string;
  base: string;
}

/**
 * Sessions are keyed by the strings typed — repo root, branch, base — so
 * `open feat origin/main` beside a live `feat main`, or the same open from
 * another worktree, silently made a second review. The agent then waited in
 * the new one while the reviewer's Send sat in the first. Refused here, before
 * any git or model work, naming the command that re-attaches to the first.
 */
export function refuseLiveElsewhere(sessions: readonly SessionRecord[], input: OpenTarget): void {
  const live = liveReviewElsewhere(sessions, input);
  if (live === undefined) return;
  const moved = live.repoRoot === input.repoRoot ? "" : `cd ${live.repoRoot} && `;
  const where = live.repoRoot === input.repoRoot ? "" : ` in ${live.repoRoot}`;
  throw new ReviewError({
    code: "live_review_elsewhere",
    message:
      `a review of ${live.branch} against ${live.base} is live${where} —` +
      ` opening ${input.branch} ${input.base} would start a second one`,
    detail:
      "the reviewer's comments and Sends are in that review; a second one splits them," +
      " and nothing you run in it would ever answer the first",
    suggestions: [
      `Run \`${moved}${reattachCall(`${live.branch} ${live.base}`)}\` to re-attach to it — ${WAITS_FOR_SEND}`,
    ],
  });
}

/**
 * The same repository by git's common dir, so every worktree of it counts; the
 * same branch; and a base naming the same thing. The other key is the only
 * thing checked: its session is this open's own, re-attached or refused
 * elsewhere. No git is run unless some live review shares the branch name.
 */
function liveReviewElsewhere(
  sessions: readonly SessionRecord[],
  input: OpenTarget,
): SessionRecord | undefined {
  const candidates = sessions.filter(
    (session) =>
      session.status !== "ended" &&
      session.branch === input.branch &&
      !(session.repoRoot === input.repoRoot && session.base === input.base),
  );
  if (candidates.length === 0) return undefined;
  const here = commonDir(input.repoRoot);
  if (here === undefined) return undefined;
  return candidates.find(
    (session) =>
      (session.repoRoot === input.repoRoot || commonDir(session.repoRoot) === here) &&
      sameBase(input.repoRoot, session.base, input.base),
  );
}

/** Relative (`.git`) in a main worktree, absolute in a linked one — so resolved either way. */
function commonDir(repoRoot: string): string | undefined {
  const said = quietGit(repoRoot, ["rev-parse", "--git-common-dir"])?.trim();
  return said === undefined || said === "" ? undefined : resolve(repoRoot, said);
}

/**
 * `main`, `refs/heads/main`, `origin/main` and `refs/remotes/origin/main` all
 * name main. A remote-tracking ref behind its branch still names it: the
 * reviewer is reading "this branch against main" either way. Two names at one
 * commit are the same base too — the diff they give is the same diff.
 */
function sameBase(repoRoot: string, one: string, other: string): boolean {
  const remotes = (quietGit(repoRoot, ["remote"]) ?? "").split("\n").filter(Boolean);
  if (shortName(one, remotes) === shortName(other, remotes)) return true;
  const [first, second] = [commitOf(repoRoot, one), commitOf(repoRoot, other)];
  return first !== undefined && first === second;
}

function shortName(base: string, remotes: readonly string[]): string {
  const name = base.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
  const remote = remotes.find((candidate) => name.startsWith(`${candidate}/`));
  return remote === undefined ? name : name.slice(remote.length + 1);
}

function commitOf(repoRoot: string, name: string): string | undefined {
  return quietGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`])?.trim();
}
