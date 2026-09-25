import type { LightspeedConfig } from "../config.ts";
import { ReviewError, invocationError } from "../errors.ts";
import type { AgentNote } from "../feedback.ts";
import { branchState } from "../git-state.ts";
import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { SessionStore } from "../session-store.ts";
import type { SessionRecord } from "../session-types.ts";
import { turnFacts, turnLabel } from "../turn.ts";
import { publishCall } from "../turn-help.ts";
import { allValues, lastValue, scanArgs } from "./args.ts";
import {
  helpLedgerDegraded,
  ledgerReport,
  makeRound,
  publishedRound,
  resolveDeps,
  type RoundDeps,
} from "./round.ts";
import { takeToPairs } from "./to-args.ts";

export interface PublishArgs {
  branch: string | undefined;
  base: string | undefined;
  model: string | undefined;
  intents: string[];
  notes: AgentNote[];
}

export interface PublishInput {
  repoRoot: string;
  branch: string;
  base: string;
  config: LightspeedConfig;
  intents: string[];
  notes: AgentNote[];
  deps?: RoundDeps;
}

const VALUE_FLAGS = ["--base", "--model", "--intent"];

export function parsePublishArgs(args: string[]): PublishArgs {
  const { notes, rest } = takeToPairs(args, "publish");
  const scanned = scanArgs(rest, {
    value: VALUE_FLAGS,
    onUnknown: (flag) =>
      invocationError("unknown_flag", `unknown flag ${flag}`, [
        `Known here: --to, ${VALUE_FLAGS.join(", ")}`,
        "Run `lightspeed publish --help` for what each flag does",
      ]),
  });
  return {
    branch: scanned.positional[0],
    base: lastValue(scanned, "--base") ?? scanned.positional[1],
    model: lastValue(scanned, "--model"),
    intents: allValues(scanned, "--intent")
      .map((intent) => intent.trim())
      .filter((intent) => intent !== ""),
    notes,
  };
}

/**
 * The end of a working turn: the commits become the next round, the `--to`
 * notes land in the threads they addressed, and the command waits for the
 * reviewer's next Send. A re-run after a kill is recognised before any
 * grouping is paid for — HEAD is still the round it opened.
 */
export async function runPublish(input: PublishInput): Promise<StructuredOutput> {
  const run = resolveDeps(input.deps);
  const target = `${input.branch} ${input.base}`;
  if (input.intents.length === 0) {
    throw new ReviewError({
      code: "intent_missing",
      message: "publish needs --intent: say what this round changed",
      detail: "the reviewer reads it above the diff, and the grouping model reads it too",
      suggestions: [publishCall(target)],
    });
  }
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const existing = new SessionStore(input.config.stateDir).get(key);
  if (existing !== undefined && alreadyPublished(existing, input)) {
    await run.ensureServerRunning({ port: input.config.port });
    run.announce({
      ...turnFacts(existing),
      message: "this round is already published; waiting for the reviewer's Send",
    });
    return await run.listen({ ...input, port: input.config.port });
  }
  const outcome = await makeRound({ ...input, verb: "publish" }, run);
  const ledger = ledgerReport(outcome.created);
  run.announce({
    ...publishedRound(outcome),
    message: "published; waiting for the reviewer's next Send",
    ...(ledger.status === "degraded" ? { help: [helpLedgerDegraded(ledger)] } : {}),
  });
  return await run.listen({ ...input, port: input.config.port });
}

/**
 * The last hand-back was a publish, the round it opened is still HEAD, and the
 * agent is not working on a new one: this is that publish, re-run.
 */
function alreadyPublished(session: SessionRecord, input: PublishInput): boolean {
  if (session.status === "ended" || session.lastHandback?.verb !== "publish") return false;
  if (turnLabel(session) === "agent working") return false;
  const head = branchState(input.repoRoot, input.branch).head;
  return head !== undefined && head === session.rounds.at(-1)?.headCommit;
}
