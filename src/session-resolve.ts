import { ReviewError } from "./errors.ts";
import type { SessionRecord } from "./session-types.ts";
import { openCall } from "./open-call.ts";
import { helpReopen, publishCall, replyCall, workCall } from "./turn-help.ts";

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
  sessions: SessionRecord[];
}

/**
 * Named by branch, base and repo rather than by the session key: the key is a
 * hash printed nowhere an agent could have read it.
 */
export function missingSession(input: MissingSessionInput): ReviewError {
  const live = input.sessions.filter(
    (session) => session.repoRoot === input.repoRoot && session.status !== "ended",
  );
  const open = `Run \`${openCall(`${input.branch} ${input.base}`)}\` to open it`;
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

/** The verbs that take more than a session: a line naming only the branch would
 * be refused for the argument it left out. */
const CALLS: Record<string, (target: string) => string> = {
  reply: replyCall,
  work: workCall,
  publish: (target) => publishCall(target),
};

function callFor(verb: string, target: string): string {
  return CALLS[verb]?.(target) ?? `lightspeed ${verb} ${target}`;
}

/** One live session is a command to run; several are a choice only the agent can
 * make, so it gets the form and the list above it rather than a guess. */
function instead(verb: string, live: SessionRecord[]): string[] {
  const only = live.length === 1 ? live[0] : undefined;
  if (only !== undefined) {
    return [
      `Or run \`${callFor(verb, `${only.branch} ${only.base}`)}\` for the session that exists`,
    ];
  }
  if (live.length === 0) return [];
  return [`Or name one of the sessions above: \`${callFor(verb, "<branch> [base]")}\``];
}

/** The verbs whose unquoted text spills into the branch, and what to quote. */
const QUOTE: Record<string, string> = {
  reply: "the whole text after --to",
  publish: "the whole text after --to",
  work: "the whole plan",
};

export interface TextAsBranchInput {
  verb: string;
  repoRoot: string;
  /** The branch as typed; unset when the agent left it to the store. */
  branch: string | undefined;
  sessions: SessionRecord[];
  /** Whether git knows the name as a commit — asked last, only when it would decide. */
  isRef: (name: string) => boolean;
}

/**
 * `reply --to main fixed it`: the shell split an unquoted text, and a word past
 * the first reads as the branch. A name git does not know, no review of it, and
 * a live review here: the word was text, and the answer is to quote it — not
 * "open a review of it".
 */
export function textAsBranch(input: TextAsBranchInput): ReviewError | undefined {
  const quote = QUOTE[input.verb];
  const { branch } = input;
  if (quote === undefined || branch === undefined) return undefined;
  const live = unreviewedHere(input.sessions, input.repoRoot, branch);
  if (live.length === 0 || input.isRef(branch)) return undefined;
  const only = live.length === 1 ? live[0] : undefined;
  const target = only === undefined ? "<branch> [base]" : `${only.branch} ${only.base}`;
  return new ReviewError({
    code: "invalid_arguments",
    message: `'${branch}' is not a branch — quote ${quote}`,
    detail:
      "an unquoted text is split by the shell into words, and the words past the first read as branch and base",
    suggestions: [`Run \`${callFor(input.verb, target)}\`, each text in one pair of quotes`],
  });
}

/** The live reviews here — none when `branch` has one of its own, live or ended. */
function unreviewedHere(
  sessions: SessionRecord[],
  repoRoot: string,
  branch: string,
): SessionRecord[] {
  const here = sessions.filter((session) => session.repoRoot === repoRoot);
  if (here.some((session) => session.branch === branch)) return [];
  return here.filter((session) => session.status !== "ended");
}

/** Explicit arguments always win — that is what makes concurrent sessions unambiguous. */
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
  if (candidates.length === 0) throw noneLive(sessions, repoRoot);
  throw new ReviewError({
    code: "ambiguous_session",
    message: `${candidates.length} live review sessions for ${repoRoot}`,
    detail: candidates.map((session) => `${session.branch} ${session.base}`).join(", "),
    suggestions: [NAME_THE_BRANCH],
  });
}

function noneLive(sessions: SessionRecord[], repoRoot: string): ReviewError {
  const latest = latestHere(sessions, repoRoot);
  if (latest?.status === "ended") return endedHere(latest);
  return new ReviewError({
    code: "session_not_found",
    message: `no live review session for ${repoRoot}`,
    suggestions: [NAME_THE_BRANCH, `Run \`${openCall("<branch> [base]")}\` to open one`],
  });
}

function latestHere(sessions: SessionRecord[], repoRoot: string): SessionRecord | undefined {
  return sessions
    .filter((session) => session.repoRoot === repoRoot)
    .reduce<SessionRecord | undefined>(
      (latest, session) =>
        latest === undefined || session.updatedAt > latest.updatedAt ? session : latest,
      undefined,
    );
}

const ENDED_BY = { reviewer: "the reviewer ended", agent: "you ended" } as const;

/**
 * The last review here is over: "no live session" read as "open one", and an
 * agent reopened a review the reviewer had closed. Who closed it decides the
 * next move, so it is named.
 */
function endedHere(latest: SessionRecord): ReviewError {
  const target = `${latest.branch} ${latest.base}`;
  const what = `the review of ${latest.branch} against ${latest.base}, the latest in this repo`;
  return new ReviewError({
    code: "session_ended",
    message:
      latest.endedBy === undefined ? `${what}, is ended` : `${ENDED_BY[latest.endedBy]} ${what}`,
    suggestions: [helpReopen(target), `Another branch: \`${openCall("<branch> [base]")}\``],
  });
}
