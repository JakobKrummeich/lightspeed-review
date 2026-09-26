import { commitsSince } from "../git-state.ts";
import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { SessionStore } from "../session-store.ts";
import type { SessionRecord } from "../session-types.ts";
import { roundNumber, turnBlock, turnLabel, type TurnFacts } from "../turn.ts";
import { helpReopen, nextRule } from "../turn-help.ts";
import { apiRequest } from "./api-client.ts";
import { serverOrigin } from "./server-address.ts";

export interface EndInput {
  repoRoot: string;
  branch: string;
  base: string;
  port: number;
  stateDir: string;
}

/**
 * Never gated on the turn: ending is the one move both sides can always make,
 * and an agent that cannot end a review it opened is an agent that leaks them.
 * Never refused, then — but what it is about to lose is read off the session
 * file before the server closes it, and said.
 */
export async function runEnd(input: EndInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const target = `${input.branch} ${input.base}`;
  const before = new SessionStore(input.stateDir).get(key);
  const closed = (await apiRequest(
    `${serverOrigin(input.port)}/api/session/${key}/end`,
    { method: "POST" },
    { key, target },
  )) as Partial<TurnFacts>;
  const warning = unpublishedWarning(before, input, target);
  return {
    ...turnBlock(closed),
    // No `status`: `turn: ended` above is the same fact, said once.
    session: { key, branch: input.branch, base: input.base },
    message:
      before?.status === "ended"
        ? "this review was already ended; there was nothing left to close"
        : "the review session is closed; the browser shows it as ended",
    ...(warning === undefined ? {} : { help: [warning] }),
    next: nextRule("ended", target),
  };
}

/**
 * Commits made while working and never published are work the reviewer never
 * saw, and the agent's user believes it was reviewed unless the agent says so.
 */
function unpublishedWarning(
  before: SessionRecord | undefined,
  input: EndInput,
  target: string,
): string | undefined {
  if (before === undefined) return undefined;
  const count = unpublishedCommits(before, input);
  if (count === 0) return undefined;
  const commits = count === 1 ? "1 commit" : `${count} commits`;
  return (
    `${commits} on ${input.branch} since round ${roundNumber(before)} never reached the reviewer:` +
    ` you ended while working, before publishing — tell your user. ${helpReopen(target)}`
  );
}

/** Only while working: any other turn has nothing of the agent's in flight. */
function unpublishedCommits(before: SessionRecord, input: EndInput): number {
  const published = before.rounds.at(-1)?.headCommit;
  if (turnLabel(before) !== "agent working" || published === undefined) return 0;
  return commitsSince(input.repoRoot, published, input.branch) ?? 0;
}
