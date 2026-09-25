import type { LightspeedConfig } from "../config.ts";
import { ReviewError, invocationError } from "../errors.ts";
import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { SessionStore } from "../session-store.ts";
import type { SessionRecord } from "../session-types.ts";
import { stillWorking } from "../server.ts";
import { turnFacts, turnLabel } from "../turn.ts";
import { helpReopen, ifKilled, publishCall, reattachCall } from "../turn-help.ts";
import { refusalError } from "./api-client.ts";
import { allValues, hasFlag, lastValue, scanArgs } from "./args.ts";
import {
  helpLedgerDegraded,
  ledgerReport,
  makeRound,
  publishedRound,
  resolveDeps,
  type RoundDeps,
} from "./round.ts";
import { serverOrigin } from "./server-address.ts";

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
    await run.ensureServerRunning({ port: input.config.port });
    run.announce(reattached(existing, input));
    return await run.listen({ ...input, port: input.config.port });
  }
  refuseFreshOpen(existing, input, target);
  const outcome = await makeRound({ ...input, verb: "open" }, run);
  if (input.open !== false) run.openBrowser(outcome.created.url);
  const ledger = ledgerReport(outcome.created);
  // Written out before the wait rather than returned after it: the reviewer's
  // url is no use to anybody after they have sent.
  run.announce({
    ...publishedRound(outcome),
    message: "the review is open — give the reviewer the url; waiting for their first Send",
    ...(ledger.status === "degraded" ? { help: [helpLedgerDegraded(ledger)] } : {}),
    ...ifKilled(reattachCall(target)),
  });
  return await run.listen({ ...input, port: input.config.port });
}

function reattached(session: SessionRecord, input: OpenInput): StructuredOutput {
  return {
    ...turnFacts(session),
    session: {
      key: session.key,
      branch: input.branch,
      base: input.base,
      url: `${serverOrigin(input.config.port)}/session/${session.key}`,
    },
    message:
      turnLabel(session) === "agent digesting"
        ? "re-attached to the live review; handing back the batch you are digesting"
        : "re-attached to the live review; waiting for the reviewer's Send",
    ...(input.intents.length === 0 ? {} : { note: intentIgnored(input) }),
    ...ifKilled(reattachCall(`${input.branch} ${input.base}`)),
  };
}

/** Said, not dropped: an agent that typed a reason believes the reviewer reads it. */
function intentIgnored(input: OpenInput): string {
  return (
    "--intent is ignored: a live review keeps the intents it opened with; say what a round" +
    ` changed with \`${publishCall(`${input.branch} ${input.base}`)}\``
  );
}

/**
 * Checked before any git or model work: nothing is worth doing on a review the
 * reviewer ended, or on a fresh one nobody has said the reason for.
 */
function refuseFreshOpen(
  existing: SessionRecord | undefined,
  input: OpenInput,
  target: string,
): void {
  if (existing?.status === "ended" && input.reopen !== true) {
    throw new ReviewError({
      code: "session_ended",
      message: "the reviewer ended this review; only they ask for a new round",
      suggestions: [helpReopen(target)],
    });
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
