import { ReviewError } from "./errors.ts";
import type { SessionRecord } from "./session-store.ts";

export interface ResolvedSession {
  branch: string;
  base: string;
}

const NAME_THE_BRANCH = "Run the command as `lightspeed <command> <branch> [base]`";

export interface MissingSessionInput {
  repoRoot: string;
  branch: string;
  base: string;
  /** The command the agent ran, so the way out is the command it already typed. */
  verb: string;
  /** Every stored session; the live ones in this repo are what it could have meant. */
  sessions: SessionRecord[];
}

/**
 * A review nothing holds, named the way the agent named it. The old message was
 * the session key — a hash minted from the repo path and the branch pair, printed
 * nowhere an agent could have read it, so it identified the review to no one but
 * the store. What a command that missed needs is what it asked for, where it
 * looked, and what is actually open there.
 */
export function missingSession(input: MissingSessionInput): ReviewError {
  const live = input.sessions.filter(
    (session) => session.repoRoot === input.repoRoot && session.status !== "ended",
  );
  const open = `Run \`lightspeed start ${input.branch} ${input.base} --intent "<why this branch exists>"\` to open it`;
  return new ReviewError({
    code: "session_not_found",
    message: `no review session for ${input.branch} against ${input.base} in ${input.repoRoot}`,
    detail: liveDetail(live),
    suggestions: [open, ...instead(input.verb, live)],
  });
}

function liveDetail(live: SessionRecord[]): string {
  if (live.length === 0) return "no live sessions in this repo";
  const named = live.map((session) => `${session.branch} against ${session.base}`).join(", ");
  return `${live.length} live session${live.length === 1 ? "" : "s"} in this repo: ${named}`;
}

/** One live session is a command to run; several are a choice only the agent can
 * make, so it gets the form and the list above it rather than a guess. */
function instead(verb: string, live: SessionRecord[]): string[] {
  const only = live.length === 1 ? live[0] : undefined;
  if (only !== undefined) {
    return [
      `Or run \`lightspeed ${verb} ${only.branch} ${only.base}\` for the session that exists`,
    ];
  }
  if (live.length === 0) return [];
  return [`Or name one of the sessions above: \`lightspeed ${verb} <branch> [base]\``];
}

/**
 * Which review a command applies to. Explicit arguments always win — that is
 * what makes concurrent sessions unambiguous — and omitting the branch is a
 * shortcut that only works when exactly one live session belongs to this repo.
 */
export function resolveSession(
  sessions: SessionRecord[],
  repoRoot: string,
  branch: string | undefined,
  base: string | undefined,
): ResolvedSession {
  if (branch !== undefined) return { branch, base: base ?? "main" };
  const candidates = sessions.filter(
    (session) => session.repoRoot === repoRoot && session.status !== "ended",
  );
  const only = candidates[0];
  if (candidates.length === 1 && only) return { branch: only.branch, base: only.base };
  if (candidates.length === 0) {
    throw new ReviewError({
      code: "ambiguous_session",
      message: `no live review session for ${repoRoot}`,
      suggestions: [NAME_THE_BRANCH, "Run `lightspeed start <branch> [base]` to open one"],
    });
  }
  throw new ReviewError({
    code: "ambiguous_session",
    message: `${candidates.length} live review sessions for ${repoRoot}`,
    detail: candidates.map((session) => `${session.branch} ${session.base}`).join(", "),
    suggestions: [NAME_THE_BRANCH],
  });
}
