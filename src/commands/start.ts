import type { LightspeedConfig } from "../config.ts";
import { extractDiff as extractDiffFromGit, type ExtractedDiff } from "../diff-extract.ts";
import { invocationError } from "../errors.ts";
import { groupDiff as groupDiffWithModel, type GroupDiffInput } from "../llm/grouping.ts";
import type { GroupingResult } from "../llm/grouping.ts";
import type { PreviousGroup } from "../llm/prompts.ts";
import { renderToon, type StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { currentGroupingMode } from "../rounds/session-round.ts";
import type { LedgerReport } from "../server.ts";
import { SessionStore, type SessionStatus } from "../session-store.ts";
import { turnBlock, type TurnLabel } from "../turn.ts";
import { apiRequest, jsonPost } from "./api-client.ts";
import { allValues, hasFlag, lastValue, scanArgs } from "./args.ts";
import { serverOrigin } from "./server-address.ts";
import { helpEnd, helpWait } from "./home.ts";
import { openBrowser } from "./open-browser.ts";
import { ensureServerRunning, type EnsureServerOptions } from "./server-lifecycle.ts";
import { runWait } from "./wait.ts";

export interface StartArgs {
  branch: string | undefined;
  base: string | undefined;
  /** `--no-open`: create the session but leave the browser alone. */
  open: boolean;
  /** `--model <name>`: override the configured grouping model for this run. */
  model: string | undefined;
  /** `--reopen`: the reviewer asked for another round on a review they ended. */
  reopen: boolean;
  /** `--wait`: block on the new round instead of returning to the agent's own loop. */
  wait: boolean;
  /** `--intent <text>`, repeatable: why this branch exists, in the order given. */
  intents: string[];
}

/** Seams for tests: git, the LLM, the background server and the browser. */
export interface StartDeps {
  extractDiff?: (repoRoot: string, branch: string, base: string) => ExtractedDiff;
  groupDiff?: (input: GroupDiffInput) => Promise<GroupingResult>;
  ensureServerRunning?: (options: EnsureServerOptions) => Promise<void>;
  openBrowser?: (url: string) => void;
  /** Where the publish block goes when `--wait` is about to block on top of it. */
  write?: (text: string) => void;
}

/** The seams filled in once, so the run below reads as the steps it takes
 * rather than as four fallbacks. */
function resolveDeps(deps: StartDeps = {}): Required<StartDeps> {
  return {
    extractDiff: deps.extractDiff ?? extractDiffFromGit,
    groupDiff: deps.groupDiff ?? groupDiffWithModel,
    ensureServerRunning: deps.ensureServerRunning ?? ensureServerRunning,
    openBrowser: deps.openBrowser ?? openBrowser,
    write: deps.write ?? ((text) => void process.stdout.write(text)),
  };
}

/** What `POST /api/sessions` answers. The status is the server's, not ours: a
 * review the reviewer ended stays ended until they open a new one. */
interface CreatedSession {
  key: string;
  url: string;
  status: SessionStatus;
  /** Whose move it is on the round just opened — always the reviewer's. */
  turn?: TurnLabel;
  round?: number;
  /** How the durable feedback ledger fared while recording this round. */
  ledger?: LedgerReport;
}

export interface StartInput {
  repoRoot: string;
  branch: string;
  base: string;
  config: LightspeedConfig;
  /** Why the branch exists, written by the agent that opened the review. */
  intents: string[];
  open?: boolean;
  /** Only ever true because the reviewer asked; the agent never decides this. */
  reopen?: boolean;
  /** Block on the round just published rather than returning at once. */
  wait?: boolean;
  deps?: StartDeps;
}

/** Flags that consume the next argument. `--intent` is the only repeatable one. */
const VALUE_FLAGS = ["--base", "--model", "--intent"];

const SWITCHES = ["--no-open", "--reopen", "--wait"];

const START_FLAGS = [...VALUE_FLAGS, ...SWITCHES];

export function parseStartArgs(args: string[]): StartArgs {
  // A flag last on the line has no value; `allValues`/`lastValue` skip the hit.
  const scanned = scanArgs(args, {
    value: VALUE_FLAGS,
    boolean: SWITCHES,
    // Fail loud: a mistyped `--no-opne` used to be dropped and the browser opened
    // anyway, and a mistyped `--intnet` became the base branch, so the agent was
    // told the git ref was wrong rather than the flag.
    onUnknown: unknownStartFlag,
  });
  return {
    branch: scanned.positional[0],
    base: lastValue(scanned, "--base") ?? scanned.positional[1],
    open: !hasFlag(scanned, "--no-open"),
    model: lastValue(scanned, "--model"),
    reopen: hasFlag(scanned, "--reopen"),
    wait: hasFlag(scanned, "--wait"),
    // A blank intent is dropped here; the caller reports it missing rather than
    // storing a reason nobody can read.
    intents: allValues(scanned, "--intent")
      .map((intent) => intent.trim())
      .filter(nonEmpty),
  };
}

function unknownStartFlag(flag: string): Error {
  return invocationError("unknown_flag", `unknown flag ${flag}`, [
    `Known here: ${START_FLAGS.join(", ")}`,
    "Run `lightspeed start --help` for what each flag does",
  ]);
}

function nonEmpty(value: string): boolean {
  return value !== "";
}

/**
 * Opens (or re-opens) a review: fresh diff, fresh grouping, session posted to
 * the server, browser pointed at it. Idempotent by design — an agent re-runs
 * it after every round of fixes.
 */
export async function runStart(input: StartInput): Promise<StructuredOutput> {
  const { repoRoot, branch, base, config } = input;
  const run = resolveDeps(input.deps);
  const extracted = run.extractDiff(repoRoot, branch, base);
  const grouping = await run.groupDiff({
    files: extracted.files,
    config,
    intents: input.intents,
    ...previousGrouping(input),
  });
  await run.ensureServerRunning({ port: config.port });
  const created = await publishRound(input, extracted, grouping);
  if (input.open !== false) run.openBrowser(created.url);
  const outcome = { created, extracted, grouping, branch, base, intents: input.intents };
  // `--wait` is the round and the block in one line, for the agent that has
  // nothing else to do until the reviewer answers. It blocks like `wait` does —
  // which is why the round it just published is written out first rather than
  // returned: the reviewer's url is no use to anybody after they have sent, and
  // a command that prints nothing for the length of a review is one nobody can
  // hand the person whose turn it is. The wait's own answer follows on the same
  // stdout, which is where the agent was already reading.
  if (input.wait === true) {
    run.write(`${renderToon(blockingOutput(outcome))}\n`);
    return await runWait({ repoRoot, branch, base, port: config.port });
  }
  return startOutput(outcome);
}

/** The round itself, posted to the server: this diff, this grouping, and why the
 * branch exists. The server decides whether it opens a session or a new round on
 * one — and whether an ended review may have either. */
async function publishRound(
  input: StartInput,
  extracted: ExtractedDiff,
  grouping: GroupingResult,
): Promise<CreatedSession> {
  return (await apiRequest(
    `${serverOrigin(input.config.port)}/api/sessions`,
    jsonPost({
      repoRoot: input.repoRoot,
      branch: input.branch,
      base: input.base,
      baseCommit: extracted.baseCommit,
      headCommit: extracted.headCommit,
      groups: grouping.groups,
      grouping: grouping.mode,
      intents: input.intents,
      commits: extracted.commits,
      reopen: input.reopen === true,
    }),
    // A round refused on an ended review is answered with the `--reopen` that
    // would be allowed, named for the branch on this command line.
    {
      key: sessionKey(input.repoRoot, input.branch, input.base),
      target: `${input.branch} ${input.base}`,
    },
  )) as CreatedSession;
}

/**
 * The grouping the reviewer read last round, fed back as a reading order to hold
 * steady: churn in group names/order/membership is a map the reviewer must relearn.
 * First rounds and rounds no model grouped send no field at all — `fallback` and
 * `skipped` are one catch-all group, and the hold-steady rule is the prompt's
 * strongest, so one provider outage would otherwise flatten every later round.
 * The round after a degraded one starting over is the right way round: the
 * reviewer had nothing to learn from that round's order either.
 */
function previousGrouping(input: StartInput): { previous?: PreviousGroup[] } {
  const { repoRoot, branch, base, config } = input;
  const session = new SessionStore(config.stateDir).get(sessionKey(repoRoot, branch, base));
  if (session === undefined || currentGroupingMode(session) !== "llm") return {};
  return {
    previous: session.groups.map((group) => ({
      name: group.name,
      files: group.files.map((file) => file.path),
    })),
  };
}

interface StartOutcome {
  created: CreatedSession;
  extracted: ExtractedDiff;
  grouping: GroupingResult;
  branch: string;
  base: string;
  intents: string[];
}

/** The round as it now stands, which is what both endings lead with: what was
 * published, where the reviewer reads it, and whose move it is. */
function publishedRound({
  created,
  extracted,
  grouping,
  branch,
  base,
  intents,
}: StartOutcome): StructuredOutput {
  return {
    // A round opens on the reviewer's move: nothing has been sent to the agent
    // yet, so it holds no turn and nothing but `wait` will give it one.
    ...turnBlock(created),
    // Intents echoed back so the agent sees what the reviewer will read, in
    // order. The server's `status` is not among them: `turn` above already names
    // whose move it is, and the word this block used to print stayed `feedback`
    // for rounds after that feedback was read.
    session: {
      key: created.key,
      branch,
      base,
      intents,
      url: created.url,
    },
    ledger: ledgerReport(created),
    diff: extracted.stats,
    groups: grouping.groups.map((group) => ({ name: group.name, files: group.files.length })),
    grouping: {
      mode: grouping.mode,
      ...(grouping.reason === undefined ? {} : { reason: grouping.reason }),
    },
  };
}

function ledgerReport(created: CreatedSession): LedgerReport {
  return created.ledger ?? { status: "off" };
}

function startOutput(outcome: StartOutcome): StructuredOutput {
  const target = `${outcome.branch} ${outcome.base}`;
  const ledger = ledgerReport(outcome.created);
  return {
    ...publishedRound(outcome),
    // An ended review never gets here (server refuses the round), so this help
    // assumes an active one.
    help: [
      helpWait(target),
      "The reviewer selects diff text and sends targeted comments; `wait` returns them and the turn",
      helpEnd(target),
      ...(ledger.status === "degraded" ? [helpLedgerDegraded(ledger)] : []),
    ],
  };
}

/**
 * The same round, for an agent that is about to block on it. No `help[]`: every
 * move it would name is one this command is already making, and the one thing
 * left to do with this block is give the url to the reviewer. A broken ledger
 * still says so — that warning appears nowhere else.
 */
function blockingOutput(outcome: StartOutcome): StructuredOutput {
  const ledger = ledgerReport(outcome.created);
  return {
    ...publishedRound(outcome),
    message: "published; now blocking on the reviewer — give them the url above",
    ...(ledger.status === "degraded" ? { help: [helpLedgerDegraded(ledger)] } : {}),
  };
}

/** A failing ledger loses mining data, not the review, so it is help and not an error. */
function helpLedgerDegraded(ledger: LedgerReport): string {
  return `The feedback ledger could not be written (${ledger.reason ?? "unknown"}) — fix ${ledger.path ?? "the state dir"} or set \`"feedbackLog": "off"\` in .lightspeed.conf.json`;
}
