/**
 * What `reply` and `publish` share: both post the agent's notes into threads,
 * and a note naming a thread that does not exist is refused before anything
 * is written.
 */
import type { AgentNote } from "../feedback.ts";
import type { FeedbackPrompt, SessionRecord } from "../session-types.ts";
import { threadIds } from "../threads.ts";
import type { DomainErrorBody } from "./http.ts";
import { logAgentReply, type LedgerLog } from "./ledger-log.ts";
import { unknownThreads } from "./turn-refusals.ts";

export function everyPrompt(session: SessionRecord): FeedbackPrompt[] {
  return [...session.conversation.flatMap((entry) => entry.prompts), ...session.pending];
}

export function knownThreads(session: SessionRecord, sent: FeedbackPrompt[] = []): Set<string> {
  return threadIds([...everyPrompt(session), ...sent]);
}

export function unknownNotes(
  session: SessionRecord,
  notes: readonly AgentNote[],
): DomainErrorBody | undefined {
  const known = knownThreads(session);
  const unknown = notes.map((note) => note.to).filter((to) => !known.has(to));
  return unknown.length === 0 ? undefined : unknownThreads(session, unknown, known);
}

export function logReplies(
  log: LedgerLog,
  session: SessionRecord,
  notes: readonly AgentNote[],
  now: string,
): void {
  for (const note of notes) logAgentReply(log, session, note.text, now);
}
