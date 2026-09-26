import type { LightspeedConfig } from "../config.ts";
import { ReviewError, invocationError } from "../errors.ts";
import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { SessionStore } from "../session-store.ts";
import type { SessionRecord } from "../session-types.ts";
import { stillWorking } from "../server.ts";
import { turnBlock, turnFacts, turnLabel, type TurnFacts } from "../turn.ts";
import {
  endedMessage,
  helpReopen,
  ifKilled,
  openRerun,
  publishCall,
  reattachCall,
  urlLast,
  waitClause,
} from "../turn-help.ts";
import { refusalError } from "./api-client.ts";
import { refuseLiveElsewhere } from "./live-elsewhere.ts";
import { allValues, hasFlag, lastValue, scanArgs } from "./args.ts";
import {
  helpLedgerDegraded,
  ledgerReport,
  makeRound,
  publishedRound,
  resolveDeps,
  type RoundDeps,
} from "./round.ts";
import { reviewUrl } from "./server-address.ts";

export interface OpenArgs {
  branch: string | undefined;
  base: string | undefined;
  open: boolean;
  model: string | undefined;
  reopen: boolean;
  intents: string[];
}

export interface OpenInput {
  repoRoot: string;
  branch: string;
  base: string;
  config: LightspeedConfig;
  intents: string[];
  open?: boolean;
  /** Only ever true because the reviewer asked; the agent never decides this. */
  reopen?: boolean;
  deps?: RoundDeps;
}

const VALUE_FLAGS = ["--base", "--model", "--intent"];
const SWITCHES = ["--no-open", "--reopen"];

export function parseOpenArgs(args: string[]): OpenArgs {
  // A flag last on the line has no value; `allValues`/`lastValue` skip the hit.
  const scanned = scanArgs(args, {
    value: VALUE_FLAGS,
    boolean: SWITCHES,
    // Fail loud: a mistyped `--intnet` once became the base branch, so the agent
    // was told the git ref was wrong rather than the flag.
    onUnknown: (flag) =>
      invocationError("unknown_flag", `unknown flag ${flag}`, [
        `Known here: ${[...VALUE_FLAGS, ...SWITCHES].join(", ")}`,
        "Run `lightspeed open --help` for what each flag does",
      ]),
  });
  return {
    branch: scanned.positional[0],
    base: lastValue(scanned, "--base") ?? scanned.positional[1],
    open: !hasFlag(scanned, "--no-open"),
    model: lastValue(scanned, "--model"),
    reopen: hasFlag(scanned, "--reopen"),
    // A blank intent is dropped here; a fresh open then reports it missing
    // rather than storing a reason nobody can read.
    intents: allValues(scanned, "--intent")
      .map((intent) => intent.trim())
      .filter((intent) => intent !== ""),
  };
}

/**
 * `open` opens the review and waits for the reviewer's first Send. On a live
 * session it opens nothing: it re-attaches — no grouping, no round — and waits,
 * which is how any waiting command killed mid-wait is recovered (D2).
 */
export async function runOpen(input: OpenInput): Promise<StructuredOutput> {
  const run = resolveDeps(input.deps);
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const existing = new SessionStore(input.config.stateDir).get(key);
  const target = `${input.branch} ${input.base}`;
  if (existing !== undefined && existing.status !== "ended") {
    // Before the wait is announced: a working agent owes the round nobody else
    // can make, so a wait would never end — and the server refuses it anyway.
    if (turnLabel(existing) === "agent working") {
      throw refusalError(
        stillWorking(existing, "nobody sends while you work; publish ends the turn"),
      );
    }
    await run.ensureServerRunning({ port: input.config.port, stateDir: input.config.stateDir });
    const url = reviewUrl(input.config.port, existing.key);
    run.announce(reattached({ ...turnFacts(existing), key: existing.key, url }, input));
    return await run.listen({ ...input, port: input.config.port });
  }
  refuseFreshOpen(existing, input, target);
  const rerun = openRerun(target, input.intents, input);
  const outcome = await makeRound({ ...input, verb: "open", rerun }, run);
  // The server found the review live after all — another open landed it while
  // this one grouped. Nothing was opened, so nothing is announced as open.
  if (outcome.created.reattached === true) {
    run.announce(reattached(outcome.created, input));
    return await run.listen({ ...input, port: input.config.port });
  }
  if (input.open !== false) run.openBrowser(outcome.created.url);
  const ledger = ledgerReport(outcome.created);
  // Written out before the wait rather than returned after it: the reviewer's
  // url is no use to anybody after they have sent.
  run.announce(
    urlLast(
      {
        ...publishedRound(outcome),
        message: "the review is open — give the reviewer the url; waiting for their first Send",
        ...(ledger.status === "degraded" ? { help: [helpLedgerDegraded(ledger)] } : {}),
        ...ifKilled(outcome.created.turn, reattachCall(target)),
      },
      outcome.created.url,
    ),
  );
  return await run.listen({ ...input, port: input.config.port });
}

/** Read off the session file, or off the server's answer when it re-attached a fresh open. */
interface LiveReview extends Partial<TurnFacts> {
  key: string;
  url: string;
}

function reattached(review: LiveReview, input: OpenInput): StructuredOutput {
  return urlLast(
    {
      ...turnBlock(review),
      session: { key: review.key, branch: input.branch, base: input.base },
      message: `re-attached to the live review; ${waitClause(review.turn)}`,
      ...(input.intents.length === 0 ? {} : { note: intentIgnored(input) }),
      ...ifKilled(review.turn, reattachCall(`${input.branch} ${input.base}`)),
    },
    review.url,
  );
}

/** Said, not dropped: an agent that typed a reason believes the reviewer reads it. */
function intentIgnored(input: OpenInput): string {
  return (
    "--intent is ignored: a live review keeps the intents it opened with; say what a round" +
    ` changed with \`${publishCall(`${input.branch} ${input.base}`)}\``
  );
}

/**
 * Checked before any git or model work: nothing is worth doing on an ended
 * review, on one that would duplicate a live review of the branch, or on a
 * fresh one nobody has said the reason for. The duplicate is named before the
 * missing --intent: an agent re-running under another base spelling needs the
 * way back to its review, not a reason for a new one.
 */
function refuseFreshOpen(
  existing: SessionRecord | undefined,
  input: OpenInput,
  target: string,
): void {
  if (existing?.status === "ended" && input.reopen !== true) {
    throw new ReviewError({
      code: "session_ended",
      message: endedMessage(existing.endedBy),
      suggestions: [helpReopen(target)],
    });
  }
  // `--reopen` is the reviewer's own request for a round on this review.
  if (input.reopen !== true) {
    refuseLiveElsewhere(new SessionStore(input.config.stateDir).list(), input);
  }
  if (input.intents.length > 0) return;
  throw new ReviewError({
    code: "intent_missing",
    message: "open needs --intent: say what this branch is for",
    detail:
      "you opened this review, so you are the only party that knows why the branch exists;" +
      " repeat --intent once per reason and the reviewer reads them above the diff",
    suggestions: [`lightspeed open ${target} --intent '<why this branch exists>'`],
  });
}
