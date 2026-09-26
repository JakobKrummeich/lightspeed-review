import type { LightspeedConfig } from "../config.ts";
import { ReviewError, invocationError } from "../errors.ts";
import type { AgentNote } from "../feedback.ts";
import { branchState } from "../git-state.ts";
import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { SessionStore } from "../session-store.ts";
import type { SessionRecord } from "../session-types.ts";
import { turnFacts, turnLabel } from "../turn.ts";
import { handbackOf, isRerun } from "../turn-moves.ts";
import { ifKilled, publishCall, publishLine, publishRerun, waitClause } from "../turn-help.ts";
import { publishRefusal } from "../server.ts";
import { refusalError, sessionGone, type SessionRef } from "./api-client.ts";
import { allValues, lastValue, scanArgs } from "./args.ts";
import {
  helpLedgerDegraded,
  ledgerReport,
  makeRound,
  publishedRound,
  resolveDeps,
  type RoundDeps,
} from "./round.ts";
import { branchAndBase, takeToPairs } from "./to-args.ts";

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
  const session = branchAndBase(scanned.positional, "publish");
  return {
    branch: session.branch,
    base: lastValue(scanned, "--base") ?? session.base,
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
  const head = branchState(input.repoRoot, input.branch).head;
  const recovery = publishRerun(target, input.intents, input.notes);
  if (existing !== undefined && alreadyPublished(existing, head, input)) {
    await run.ensureServerRunning({ port: input.config.port, stateDir: input.config.stateDir });
    run.announce({
      ...turnFacts(existing),
      rerun: true,
      message: `this round is already published; ${waitClause(turnLabel(existing))}`,
      ...ifKilled(turnLabel(existing), recovery),
    });
    return await run.listen({ ...input, port: input.config.port });
  }
  refuseLocally(existing, input, { key, target }, head);
  // The re-run line, never its re-attach fallback: mid-grouping the turn is
  // still the agent's working one, and `open` refuses to wait on that.
  const outcome = await makeRound(
    { ...input, verb: "publish", rerun: publishLine(target, input.intents, input.notes) },
    run,
  );
  const ledger = ledgerReport(outcome.created);
  run.announce({
    ...publishedRound(outcome),
    ...(outcome.created.rerun === true ? { rerun: true } : {}),
    message: `published; ${waitClause(outcome.created.turn)}`,
    ...(ledger.status === "degraded" ? { help: [helpLedgerDegraded(ledger)] } : {}),
    ...ifKilled(outcome.created.turn, recovery),
  });
  return await run.listen({ ...input, port: input.config.port });
}

/**
 * The server's own rules, read off the same session file before any extraction
 * or model call: a grouping paid for and then refused is minutes and money for
 * nothing. The server still checks — this only answers first.
 */
function refuseLocally(
  existing: SessionRecord | undefined,
  input: PublishInput,
  about: SessionRef,
  head: string | undefined,
): void {
  if (existing === undefined) throw sessionGone(404, about);
  if (existing.status === "ended") throw sessionGone(409, about, existing.endedBy);
  // No tip read, no telling a re-run from a refusal: the server compares the
  // extracted HEAD and decides.
  if (head === undefined) return;
  const refusal = publishRefusal(
    existing,
    head === existing.rounds.at(-1)?.headCommit,
    input.notes,
  );
  if (refusal !== undefined) throw refusalError(refusal);
}

/**
 * The round the last publish opened is still HEAD, the agent is not working on
 * a new one, and the server would call these words a re-run of that publish.
 */
function alreadyPublished(
  session: SessionRecord,
  head: string | undefined,
  input: PublishInput,
): boolean {
  if (session.status === "ended" || turnLabel(session) === "agent working") return false;
  if (head === undefined || head !== session.rounds.at(-1)?.headCommit) return false;
  return isRerun(
    session,
    handbackOf(session, "publish", { intents: input.intents, notes: input.notes }),
  );
}
