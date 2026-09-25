import { REACHABLE_MODELS } from "../config.ts";
import type { StructuredOutput } from "../output.ts";
import type { SessionRecord } from "../session-types.ts";
import { openCall } from "../open-call.ts";
import { batchItems, batchSize, openIds } from "../threads.ts";
import { roundNumber, turnLabel, type TurnLabel } from "../turn.ts";
import {
  HELP_END,
  HELP_OPEN,
  TURN_RULES,
  WAITS_FOR_SEND,
  nextRule,
  reattachCall,
} from "../turn-help.ts";

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
  /**
   * A waiting command is parked on this repo's one live session — read off the
   * server, the only side that knows. Absent means nobody asked: nobody listening.
   */
  listening?: boolean;
}

/**
 * Names the models because `model` is the one key a fresh config cannot
 * default: a starter file with a provider the agent has no credential for fails
 * at the first `open`, one round later.
 */
const HELP_INIT_CONFIG =
  "Run `lightspeed init --config` to write .lightspeed.conf.json here, then set `model`" +
  ` to a provider/model you can reach — ${REACHABLE_MODELS.map((model) => `\`${model}\``).join(", ")}` +
  " all work";

const HELP_OPEN_ONCE_CONFIGURED = `Run \`${openCall("<branch> [base]")}\` once \`model\` names one`;

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
    return { sessions: 0, message: "no active review sessions", ...other, help: [HELP_OPEN] };
  }
  return { sessions: rows, ...other, ...homeNext(mine, input) };
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
        HELP_OPEN_ONCE_CONFIGURED,
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
    help: [HELP_INIT_CONFIG, HELP_OPEN_ONCE_CONFIGURED],
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
 * With one session, the answer is its `next:` rule — the same one every
 * command ends in, so home cannot offer a move the server refuses. With
 * several, no one rule is the answer, and the general rules stand.
 */
function homeNext(mine: SessionRecord[], input: HomeInput): StructuredOutput {
  const only = mine.length === 1 && input.all !== true ? mine[0] : undefined;
  if (only === undefined) return { help: [...TURN_RULES, HELP_OPEN, HELP_END] };
  const target = `${only.branch} ${only.base}`;
  const label = turnLabel(only);
  if (label === "reviewer") return { next: reviewersNext(only, target, input.listening === true) };
  return agentsNext(only, target, label);
}

function agentsNext(only: SessionRecord, target: string, label: TurnLabel): StructuredOutput {
  const held = only.batch?.prompts ?? [];
  const resolved = batchItems(held, only.conversation)
    .filter((item) => item.status === "resolved")
    .map((item) => item.id);
  // The same ids the batch itself offered: open ones only, never a resolved one.
  const rule = nextRule(label, target, openIds(only.conversation, held), resolved);
  // An agent resumed after compaction no longer holds the batch it is digesting.
  if (label !== "agent digesting") return { next: rule };
  return {
    next: {
      reread: `Lost the batch? Run \`${reattachCall(target)}\`: it hands back the batch you are digesting at once, and posts nothing`,
      ...rule,
    },
  };
}

/**
 * "Run open" only when nobody is listening: re-attaching beside a running wait
 * supersedes it, and the agent's own command exits with nothing. Unless the
 * wait is one the agent cannot see — a leftover from a killed shell — which it
 * must be able to take over rather than be stranded behind.
 */
function reviewersNext(
  session: SessionRecord,
  target: string,
  listening: boolean,
): Record<string, string> {
  if (listening) {
    return {
      listening:
        "A waiting command is already waiting for the reviewer's Send on this review — leave it" +
        " running; it receives the batch. If you cannot see that command's output, run" +
        ` \`${reattachCall(target)}\` now: the newest wait takes over and the old one exits`,
    };
  }
  const sent = batchSize(session.pending);
  if (sent === 0) return nextRule("reviewer", target);
  return {
    receive: `the reviewer sent ${plural(sent, "item")} — \`${reattachCall(target)}\` receives them; ${WAITS_FOR_SEND}`,
  };
}
