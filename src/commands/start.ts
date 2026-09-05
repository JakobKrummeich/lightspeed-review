import type { LightspeedConfig } from "../config.ts";
import { extractDiff as extractDiffFromGit, type ExtractedDiff } from "../diff-extract.ts";
import { validationError } from "../errors.ts";
import { groupDiff as groupDiffWithModel, type GroupDiffInput } from "../llm/grouping.ts";
import type { GroupingResult } from "../llm/grouping.ts";
import type { PreviousGroup } from "../llm/prompts.ts";
import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { currentGroupingMode } from "../rounds/session-round.ts";
import type { LedgerReport } from "../server.ts";
import { SessionStore, type SessionStatus } from "../session-store.ts";
import { apiRequest, jsonPost } from "./api-client.ts";
import { allValues, hasFlag, lastValue, scanArgs } from "./args.ts";
import { serverOrigin } from "./server-address.ts";
import { helpPoll } from "./home.ts";
import { openBrowser } from "./open-browser.ts";
import { ensureServerRunning, type EnsureServerOptions } from "./server-lifecycle.ts";

export interface StartArgs {
  branch: string | undefined;
  base: string | undefined;
  /** `--no-open`: create the session but leave the browser alone. */
  open: boolean;
  /** `--model <name>`: override the configured grouping model for this run. */
  model: string | undefined;
  /** `--reopen`: the reviewer asked for another round on a review they ended. */
  reopen: boolean;
  /** `--intent <text>`, repeatable: why this branch exists, in the order given. */
  intents: string[];
}

/** Seams for tests: git, the LLM, the background server and the browser. */
export interface StartDeps {
  extractDiff?: (repoRoot: string, branch: string, base: string) => ExtractedDiff;
  groupDiff?: (input: GroupDiffInput) => Promise<GroupingResult>;
  ensureServerRunning?: (options: EnsureServerOptions) => Promise<void>;
  openBrowser?: (url: string) => void;
}

/** What `POST /api/sessions` answers. The status is the server's, not ours: a
 * review the reviewer ended stays ended until they open a new one. */
interface CreatedSession {
  key: string;
  url: string;
  status: SessionStatus;
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
  deps?: StartDeps;
}

/** Flags that consume the next argument. `--intent` is the only repeatable one. */
const VALUE_FLAGS = ["--base", "--model", "--intent"];

const SWITCHES = ["--no-open", "--reopen"];

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
    // A blank intent is dropped here; the caller reports it missing rather than
    // storing a reason nobody can read.
    intents: allValues(scanned, "--intent")
      .map((intent) => intent.trim())
      .filter(nonEmpty),
  };
}

function unknownStartFlag(flag: string): Error {
  return validationError(`unknown flag ${flag}`, [
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
  const { repoRoot, branch, base, config, deps = {} } = input;
  const extracted = (deps.extractDiff ?? extractDiffFromGit)(repoRoot, branch, base);
  const grouping = await (deps.groupDiff ?? groupDiffWithModel)({
    files: extracted.files,
    config,
    intents: input.intents,
    ...previousGrouping(input),
  });
  await (deps.ensureServerRunning ?? ensureServerRunning)({ port: config.port });
  const created = (await apiRequest(
    `${serverOrigin(config.port)}/api/sessions`,
    jsonPost({
      repoRoot,
      branch,
      base,
      baseCommit: extracted.baseCommit,
      headCommit: extracted.headCommit,
      groups: grouping.groups,
      grouping: grouping.mode,
      intents: input.intents,
      commits: extracted.commits,
      reopen: input.reopen === true,
    }),
  )) as CreatedSession;
  if (input.open !== false) (deps.openBrowser ?? openBrowser)(created.url);
  return startOutput({ created, extracted, grouping, branch, base, intents: input.intents });
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

function startOutput({
  created,
  extracted,
  grouping,
  branch,
  base,
  intents,
}: StartOutcome): StructuredOutput {
  const target = `${branch} ${base}`;
  const ledger = created.ledger ?? { status: "off" as const };
  return {
    // Intents echoed back so the agent sees what the reviewer will read, in order.
    session: {
      key: created.key,
      branch,
      base,
      intents,
      url: created.url,
      status: created.status,
    },
    ledger,
    diff: extracted.stats,
    groups: grouping.groups.map((group) => ({ name: group.name, files: group.files.length })),
    grouping: {
      mode: grouping.mode,
      ...(grouping.reason === undefined ? {} : { reason: grouping.reason }),
    },
    // An ended review never gets here (server refuses the round), so this help
    // assumes an active one.
    help: [
      helpPoll(target),
      "The reviewer selects diff text and sends targeted comments; poll returns them",
      ...(ledger.status === "degraded" ? [helpLedgerDegraded(ledger)] : []),
    ],
  };
}

/** A failing ledger loses mining data, not the review, so it is help and not an error. */
function helpLedgerDegraded(ledger: LedgerReport): string {
  return `The feedback ledger could not be written (${ledger.reason ?? "unknown"}) — fix ${ledger.path ?? "the state dir"} or set \`"feedbackLog": "off"\` in .lightspeed.conf.json`;
}
