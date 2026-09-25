import { REACHABLE_MODELS } from "../config.ts";
import type { StructuredOutput } from "../output.ts";
import type { SessionRecord } from "../session-store.ts";
import { roundNumber, turnLabel, type TurnLabel } from "../turn.ts";
import { HELP_END, HELP_START, HELP_WAIT, TURN_RULE, legalMoves } from "../turn-help.ts";

export interface SessionSummary {
  /** `--all` only, where rows come from many. */
  repo?: string;
  branch: string;
  base: string;
  /**
   * So the home view answers "may I send?" and "am I owed a turn?" without a
   * second command.
   */
  turn: TurnLabel;
  round: number;
  pending: number;
  /**
   * An agent resumed after compaction reads this view to find out where it was,
   * and `agent working` alone names the state without the work. Present on
   * every row or none: TOON draws a table only while the rows agree on their
   * columns.
   */
  note?: string;
}

export function sessionSummaries(
  sessions: SessionRecord[],
  options: { repo?: boolean } = {},
): SessionSummary[] {
  const live = sessions.filter((session) => session.status !== "ended");
  const noted = live.some((session) => declaredPlan(session) !== "");
  return live.map((session) => ({
    ...(options.repo === true ? { repo: session.repoRoot } : {}),
    branch: session.branch,
    base: session.base,
    turn: turnLabel(session),
    round: roundNumber(session),
    pending: session.pending.length,
    ...(noted ? { note: declaredPlan(session) } : {}),
  }));
}

function declaredPlan(session: SessionRecord): string {
  return session.turn.holder === "agent" ? (session.turn.note ?? "") : "";
}

export type HomeBlocker = "missing" | "invalid";

/** The store is one directory for every repository's sessions, so which ones
 * are this repository's is decided here. */
export interface HomeInput {
  repoRoot?: string;
  config?: HomeBlocker;
  sessions: SessionRecord[];
  all?: boolean;
}

/**
 * Names the models because `model` is the one key a fresh config cannot
 * default: a starter file with a provider the agent has no credential for fails
 * at the first `start`, one round later.
 */
const HELP_INIT_CONFIG =
  "Run `lightspeed init --config` to write .lightspeed.conf.json here, then set `model`" +
  ` to a provider/model you can reach — ${REACHABLE_MODELS.map((model) => `\`${model}\``).join(", ")}` +
  " all work";

const HELP_START_ONCE_CONFIGURED =
  'Run `lightspeed start <branch> [base] --intent "<why this branch exists>"`' +
  " once `model` names one";

/**
 * Empty means a definitive `sessions: 0` + message, never an omitted key. A
 * directory that cannot host a review says so before it says anything about
 * sessions.
 */
export function homeOutput(input: HomeInput): StructuredOutput {
  const { repoRoot } = input;
  // Ended reviews are history, not work: counted, they make one live session
  // look like several — which takes its own moves off the help — and they tally
  // repositories nobody can go back to.
  const live = input.sessions.filter((session) => session.status !== "ended");
  const mine = live.filter((session) => session.repoRoot === repoRoot);
  const place = { repo: repoRoot ?? "none" };
  if (repoRoot === undefined || input.config !== undefined) {
    return { ...place, ...blocked(input, live.length - mine.length) };
  }
  return { ...place, ...listing(input, live, mine) };
}

function listing(input: HomeInput, live: SessionRecord[], mine: SessionRecord[]): StructuredOutput {
  const all = input.all === true;
  const rows = sessionSummaries(all ? live : mine, { repo: all });
  const other = all || live.length === mine.length ? {} : { elsewhere: elsewhere(live, mine) };
  if (rows.length === 0) {
    return { sessions: 0, message: "no active review sessions", ...other, help: [HELP_START] };
  }
  return { sessions: rows, ...other, help: homeHelp(mine, all) };
}

/**
 * The count is in the message rather than beside `--all`: those reviews are not
 * reachable from a directory with no config, and saying so twice is the
 * redundancy `status` was.
 */
function blocked(input: HomeInput, away: number): StructuredOutput {
  const tail = livingElsewhere(away);
  if (input.repoRoot === undefined) {
    return {
      sessions: 0,
      message: `not inside a git repository, so no review can run here${tail}`,
      help: [
        "Run `lightspeed` from inside the repository you want reviewed",
        HELP_START_ONCE_CONFIGURED,
      ],
    };
  }
  const why =
    input.config === "missing"
      ? "no config in this repo, so no review can run here"
      : "the config in this repo cannot be read, so no review can run here";
  return {
    config: input.config,
    sessions: 0,
    message: `${why}${tail}`,
    help: [HELP_INIT_CONFIG, HELP_START_ONCE_CONFIGURED],
  };
}

function elsewhere(live: SessionRecord[], mine: SessionRecord[]): string {
  const away = live.filter((session) => !mine.includes(session));
  const repos = new Set(away.map((session) => session.repoRoot));
  return (
    `${plural(away.length, "session")} in ${plural(repos.size, "other repo")}` +
    " — `lightspeed --all` lists them"
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function livingElsewhere(away: number): string {
  if (away === 0) return "";
  return away === 1
    ? "; 1 session lives in another repo"
    : `; ${away} sessions live in other repos`;
}

/**
 * With one session, the help is its own legal moves — the same list every
 * command and every refusal is built from, so the home view cannot offer a
 * `wait` the poll answers `turn_still_yours`. With several, no one set of moves
 * is the answer, and the general four stand.
 */
function homeHelp(mine: SessionRecord[], all: boolean): [string, ...string[]] {
  const only = mine.length === 1 && !all ? mine[0] : undefined;
  if (only === undefined) return [TURN_RULE, HELP_START, HELP_WAIT, HELP_END];
  return [TURN_RULE, ...legalMoves(turnLabel(only), `${only.branch} ${only.base}`)];
}
