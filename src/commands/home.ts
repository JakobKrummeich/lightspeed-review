import { REACHABLE_MODELS } from "../config.ts";
import type { StructuredOutput } from "../output.ts";
import type { SessionRecord } from "../session-store.ts";
import { roundNumber, turnLabel, type HelpForm, type TurnLabel } from "../turn.ts";

/** One row of the home view session table. */
export interface SessionSummary {
  /** Which repository's review this is; `--all` only, where rows come from many. */
  repo?: string;
  branch: string;
  base: string;
  /**
   * Whose move it is, so the home view answers "may I send?" and "am I owed a
   * turn?" without a second command. `pending` beside it is what the reviewer
   * queued and no `wait` has taken yet.
   */
  turn: TurnLabel;
  round: number;
  pending: number;
  /**
   * The plan a working agent declared, which is the one thing on the record
   * only that agent knew. An agent resumed after compaction reads this view to
   * find out where it was, and `agent working` alone names the state without
   * the work. Present on every row or none: TOON draws a table only while the
   * rows agree on their columns.
   */
  note?: string;
}

/**
 * The `start` command as it must be typed, for every line that sends an agent
 * to it. `--intent` is not optional — a `start` without one exits 2 on
 * `intent_missing` — so no help line may spell one without it, whatever else
 * that line is about: a dead server, a corrupt session file, a 404.
 */
export function startCall(target: string): string {
  return `lightspeed start ${target} --intent "<why this branch exists>"`;
}

/** The canonical help line, for the places that know no particular review. */
export const HELP_START = `Run \`${startCall("<branch> [base]")}\` to open a review session; repeat --intent once per reason`;

/** The one rule an agent must not get wrong, so it is worded once and repeated
 * verbatim everywhere a blocking command is mentioned. */
export const BLOCKS_IN_FOREGROUND =
  "it blocks until the reviewer sends, so never background it or wrap it in a timeout";

/**
 * The rule the whole protocol reduces to, quoted wherever an agent might guess
 * at it instead.
 */
export const TURN_RULE = "Queue always. End always. Send only on your turn.";

export function helpWait(target: string): string {
  return (
    `Run \`lightspeed wait ${target}\` in the foreground to take the turn when the reviewer sends` +
    ` — ${BLOCKS_IN_FOREGROUND}`
  );
}

export const HELP_WAIT = helpWait("<branch> [base]");

export function helpAsk(target: string): string {
  return (
    `Run \`lightspeed ask "<question>" ${target}\` to put a question to the reviewer and wait for` +
    ` the answer — ${BLOCKS_IN_FOREGROUND}`
  );
}

export function helpSay(target: string): string {
  return (
    `Run \`lightspeed say "<text>" ${target}\` to answer without blocking;` +
    " add `--for <id>` to pin the answer under the comment it answers"
  );
}

export function helpWork(target: string): string {
  return (
    `Run \`lightspeed work "<plan>" ${target}\` before you start editing:` +
    " the reviewer's banner names the plan for as long as you are quiet"
  );
}

/** `--intent` is required on every round, not only the first, so the line that
 * sends an agent back to `start` carries it: without it the command it just read
 * exits 2 with `intent_missing`, which is a wasted turn this text caused. */
export function helpNextRound(target: string): string {
  return (
    `Address the feedback, commit, then run \`lightspeed start ${target}` +
    ' --intent "<why this branch exists>"` to show the updated diff —' +
    " --intent is required on every round"
  );
}

/** The same move made by an agent that is going to block on what it publishes:
 * one command, and the turn given up deliberately rather than waited for. It is
 * the move offered to an agent mid-edit, where a bare `wait` is refused. */
export function helpPublishAndWait(target: string): string {
  return (
    `Run \`lightspeed start ${target} --wait --intent "<why this branch exists>"\`` +
    " to publish what you changed and block on the next round"
  );
}

export function helpEnd(target: string): string {
  return `Run \`lightspeed end ${target}\` to close the session`;
}

export const HELP_END = helpEnd("<branch> [base]");

/** A review that ended stays ended — an agent must not reopen one uninvited —
 * so every command that meets an ended session says so the same way. */
export function helpReopen(target: string): string {
  return (
    `Run \`lightspeed start ${target} --reopen --intent "<why>"\`` +
    " once the reviewer asks for one"
  );
}

/** The moves the protocol has, named so one list can order them and two
 * renderings can spell them. */
type Move = "wait" | "publish" | "ask" | "say" | "work" | "next round" | "reopen";

/**
 * The moves that are legal from a turn, in the order they are usually wanted.
 * Every `help[]` about the turn is built from this one list — the commands', and
 * the server's when it refuses a move — so nothing can advertise a move the
 * server answers with exit 2. That is not hypothetical: `work` and `say` both
 * closed with `wait` while the agent held the turn, which the poll refuses.
 *
 * `wait` is therefore offered on the reviewer's turn and nowhere else. An agent
 * that holds it is handed the moves that give it up deliberately instead —
 * publish the round, or ask — and `work` leads on a turn just delivered,
 * because declaring the silence is what an agent does before it starts editing,
 * and is dropped once it has, since redeclaring is a no-op.
 */
function movesFor(turn: TurnLabel): [Move, ...Move[]] {
  if (turn === "ended") return ["reopen"];
  if (turn === "reviewer") return ["wait"];
  if (turn === "agent working") return ["publish", "ask", "say"];
  return ["work", "say", "ask", "next round"];
}

const SPELT: Record<Move, (target: string) => string> = {
  wait: helpWait,
  publish: helpPublishAndWait,
  ask: helpAsk,
  say: helpSay,
  work: helpWork,
  "next round": helpNextRound,
  reopen: helpReopen,
};

/**
 * The same moves for a reader that has already been given them in full this
 * round. The command an agent is most likely to want next is written out whole;
 * the rest are the verb and what it takes, because by here the agent has the
 * long form above in its own transcript.
 */
const RECALLED: Record<Move, (target: string) => string> = {
  wait: (target) => `\`lightspeed wait ${target}\``,
  publish: (target) => `\`lightspeed start ${target} --wait --intent "<why>"\``,
  ask: () => '`ask "<q>"`',
  say: () => '`say "<text>"`',
  work: (target) => `\`lightspeed work "<plan>" ${target}\``,
  "next round": (target) => `commit then \`start ${target} --intent "<why>"\``,
  reopen: (target) => `the reviewer asks, then \`start ${target} --reopen --intent "<why>"\``,
};

/**
 * It lives here, with the lines it is made of, rather than in `turn.ts`: those
 * lines read `turn.ts` for the label, and a module cannot import its readers.
 */
export function legalMoves(turn: TurnLabel, target: string): [string, ...string[]] {
  const [first, ...rest] = movesFor(turn);
  return [SPELT[first](target), ...rest.map((move) => SPELT[move](target))];
}

/** The one-line form of that same list, in that same order. */
export function nextMoves(turn: TurnLabel, target: string): string {
  return `Next: ${movesFor(turn)
    .map((move) => RECALLED[move](target))
    .join(" | ")}`;
}

/**
 * The help an answer closes with. The full block is worth its tokens once per
 * round — it is how an agent learns the protocol from one answer — and after
 * that it is the same bytes again: measured at 146 of an `ask` answer's 187
 * tokens, with one clause of it repeated nineteen times in a single transcript.
 * A server too old to have an opinion gets the full block, which is what it
 * always sent.
 */
export function turnHelp(
  turn: TurnLabel,
  target: string,
  form: HelpForm | undefined,
): [string, ...string[]] {
  return form === "short" ? [nextMoves(turn, target)] : legalMoves(turn, target);
}

/** Stored sessions as home-view rows. Ended ones are history, not work. */
export function sessionSummaries(
  sessions: SessionRecord[],
  options: { repo?: boolean } = {},
): SessionSummary[] {
  const live = sessions.filter((session) => session.status !== "ended");
  // One shape for every row, decided once for the whole table rather than per
  // row: a row that omits a key the next one has costs the table its columns.
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

/** Why no review can run in this directory, when none can. */
export type HomeBlocker = "missing" | "invalid";

/** Everything the home view is about: where it ran, whether a review can run
 * there, and every session on the machine — the store is one directory for all
 * of them, so which ones are this repository's is decided here. */
export interface HomeInput {
  /** The repository the command ran in; absent when it was not run in one. */
  repoRoot?: string;
  config?: HomeBlocker;
  sessions: SessionRecord[];
  /** `--all`: every repository's sessions, each under the repo it belongs to. */
  all?: boolean;
}

/**
 * The models an agent can reach out of the box, named because `model` is the
 * one key a fresh config cannot default: a starter file with a provider the
 * agent has no credential for fails at the first `start`, one round later.
 */
const HELP_INIT_CONFIG =
  "Run `lightspeed init --config` to write .lightspeed.conf.json here, then set `model`" +
  ` to a provider/model you can reach — ${REACHABLE_MODELS.map((model) => `\`${model}\``).join(", ")}` +
  " all work";

const HELP_START_ONCE_CONFIGURED =
  'Run `lightspeed start <branch> [base] --intent "<why this branch exists>"`' +
  " once `model` names one";

/**
 * Content-first: the session table is the content, `help[]` the disclosure.
 * Empty means a definitive `sessions: 0` + message, never an omitted key.
 *
 * A directory that cannot host a review says so before it says anything about
 * sessions. That reading used to be thrown away in a bare catch, so the one
 * view an agent opens knowing nothing answered `sessions: 0` and pointed at
 * `start` — a command that fails the same way, one turn later.
 */
export function homeOutput(input: HomeInput): StructuredOutput {
  const { repoRoot } = input;
  // Ended reviews are history rather than work, and they are that everywhere:
  // counted, they make one live session look like several — which takes its own
  // moves off the help — and they tally repositories nobody can go back to.
  const live = input.sessions.filter((session) => session.status !== "ended");
  const mine = live.filter((session) => session.repoRoot === repoRoot);
  const place = { repo: repoRoot ?? "none" };
  if (repoRoot === undefined || input.config !== undefined) {
    return { ...place, ...blocked(input, live.length - mine.length) };
  }
  return { ...place, ...listing(input, live, mine) };
}

/** The view a working repository gets: its own rows, what it is not showing,
 * and the moves that follow from them. */
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
 * Nothing can run here, so the sessions that exist are a footnote and the help
 * is the one thing that changes that. The count is in the message rather than
 * beside `--all`: those reviews are not reachable from a directory with no
 * config, and saying so twice is the redundancy `status` was.
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

/** The sessions this view is not showing, and the flag that shows them. */
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

/** What is on disk but out of reach from here, or nothing at all to say. */
function livingElsewhere(away: number): string {
  if (away === 0) return "";
  return away === 1
    ? "; 1 session lives in another repo"
    : `; ${away} sessions live in other repos`;
}

/**
 * With one session to be about, the help is that session's own legal moves —
 * the same list every command and every refusal is built from, so the home view
 * cannot offer a `wait` the poll answers `turn_still_yours`. With several, no
 * one set of moves is the answer, and the general four stand.
 */
function homeHelp(mine: SessionRecord[], all: boolean): [string, ...string[]] {
  const only = mine.length === 1 && !all ? mine[0] : undefined;
  if (only === undefined) return [TURN_RULE, HELP_START, HELP_WAIT, HELP_END];
  return [TURN_RULE, ...legalMoves(turnLabel(only), `${only.branch} ${only.base}`)];
}
