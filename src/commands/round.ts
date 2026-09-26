import type { LightspeedConfig } from "../config.ts";
import { extractDiff as extractDiffFromGit, type ExtractedDiff } from "../diff-extract.ts";
import type { AgentNote } from "../feedback.ts";
import { groupDiff as groupDiffWithModel, type GroupDiffInput } from "../llm/grouping.ts";
import type { GroupingResult } from "../llm/grouping.ts";
import type { PreviousGroup } from "../llm/prompts.ts";
import { printBlock, type StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { currentGroupingMode } from "../rounds/session-round.ts";
import type { LedgerReport } from "../server.ts";
import { SessionStore, type SessionStatus } from "../session-store.ts";
import { turnBlock, type TurnLabel } from "../turn.ts";
import { apiRequest, jsonPost } from "./api-client.ts";
import { listen, type ListenInput } from "./listen.ts";
import { serverOrigin } from "./server-address.ts";
import { openBrowser } from "./open-browser.ts";
import { ensureServerRunning, type EnsureServerOptions } from "./server-lifecycle.ts";

/** Seams for tests. */
export interface RoundDeps {
  extractDiff?: (repoRoot: string, branch: string, base: string) => ExtractedDiff;
  groupDiff?: (input: GroupDiffInput) => Promise<GroupingResult>;
  ensureServerRunning?: (options: EnsureServerOptions) => Promise<void>;
  openBrowser?: (url: string) => void;
  /** Where the round (or re-attach) block is shown before the wait begins. */
  announce?: (block: StructuredOutput) => void;
  /** The wait itself; tests stub it so a round can be published without a reviewer. */
  listen?: (input: ListenInput) => Promise<StructuredOutput>;
}

const DEFAULT_DEPS: Required<RoundDeps> = {
  extractDiff: extractDiffFromGit,
  groupDiff: groupDiffWithModel,
  ensureServerRunning,
  openBrowser,
  announce: printBlock,
  listen,
};

/** A seam left `undefined` is the real thing, not a hole. */
export function resolveDeps(deps: RoundDeps = {}): Required<RoundDeps> {
  const given = Object.fromEntries(
    Object.entries(deps).filter(([, value]) => value !== undefined),
  ) as RoundDeps;
  return { ...DEFAULT_DEPS, ...given };
}

/** The status is the server's, not ours: a review the reviewer ended stays ended
 * until they open a new one. */
export interface CreatedSession {
  key: string;
  url: string;
  status: SessionStatus;
  turn?: TurnLabel;
  round?: number;
  ledger?: LedgerReport;
  /** `open` on a live session: nothing was opened, the agent re-attached. */
  reattached?: boolean;
  /** A re-run `publish` the server recognised: nothing was posted twice. */
  rerun?: boolean;
}

export interface RoundInput {
  repoRoot: string;
  branch: string;
  base: string;
  config: LightspeedConfig;
  intents: string[];
  verb: "open" | "publish";
  /** Only ever true because the reviewer asked; the agent never decides this. */
  reopen?: boolean;
  notes?: AgentNote[];
  deps?: RoundDeps;
}

/**
 * Extract, group and post: the half of `open` and `publish` that makes a round.
 * The server decides whether it opens one — and whether an ended review may.
 */
export async function makeRound(
  input: RoundInput,
  run: Required<RoundDeps>,
): Promise<RoundOutcome> {
  const extracted = run.extractDiff(input.repoRoot, input.branch, input.base);
  const grouping = await run.groupDiff({
    files: extracted.files,
    config: input.config,
    intents: input.intents,
    ...previousGrouping(input),
  });
  await run.ensureServerRunning({ port: input.config.port });
  const created = await publishRound(input, extracted, grouping);
  const { branch, base, intents } = input;
  return { created, extracted, grouping, branch, base, intents };
}

/** The server decides whether this opens a session or a new round on one — and
 * whether an ended review may have either. */
async function publishRound(
  input: RoundInput,
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
      verb: input.verb,
      notes: input.notes ?? [],
    }),
    {
      key: sessionKey(input.repoRoot, input.branch, input.base),
      target: `${input.branch} ${input.base}`,
    },
  )) as CreatedSession;
}

/**
 * Fed back as a reading order to hold steady: churn in group
 * names/order/membership is a map the reviewer must relearn. First rounds and
 * rounds no model grouped send no field at all — `fallback` and `skipped` are
 * one catch-all group, and the hold-steady rule is the prompt's strongest, so
 * one provider outage would otherwise flatten every later round. The round
 * after a degraded one starting over is the right way round: the reviewer had
 * nothing to learn from that round's order either.
 */
function previousGrouping(input: RoundInput): { previous?: PreviousGroup[] } {
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

export interface RoundOutcome {
  created: CreatedSession;
  extracted: ExtractedDiff;
  grouping: GroupingResult;
  branch: string;
  base: string;
  intents: string[];
}

export function publishedRound({
  created,
  extracted,
  grouping,
  branch,
  base,
  intents,
}: RoundOutcome): StructuredOutput {
  return {
    ...turnBlock(created),
    // No `status`: `turn` above already names whose move it is, and the word
    // this block once printed stayed `feedback` for rounds after that feedback
    // was read.
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
      ...(grouping.fix === undefined ? {} : { fix: grouping.fix }),
    },
  };
}

export function ledgerReport(created: CreatedSession): LedgerReport {
  return created.ledger ?? { status: "off" };
}

/** A failing ledger loses mining data, not the review, so it is help and not an error. */
export function helpLedgerDegraded(ledger: LedgerReport): string {
  return `The feedback ledger could not be written (${ledger.reason ?? "unknown"}) — fix ${ledger.path ?? "the state dir"} or set \`"feedbackLog": "off"\` in .lightspeed.conf.json`;
}
