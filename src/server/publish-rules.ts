/**
 * Publish ends a working turn with new commits, and nothing else. Read by the
 * server, which enforces it, and by the CLI before it extracts or groups
 * anything: a model call spent on a publish the server will refuse is a wait
 * and a bill for nothing.
 */
import type { AgentNote } from "../feedback.ts";
import type { SessionRecord } from "../session-types.ts";
import { unknownNotes } from "./agent-notes.ts";
import type { DomainErrorBody } from "./http.ts";
import { nothingToPublish, reviewerHolds, stillDigesting } from "./turn-refusals.ts";

export function publishRefusal(
  session: SessionRecord,
  sameHead: boolean,
  notes: readonly AgentNote[],
): DomainErrorBody | undefined {
  const turn = session.turn;
  if (turn.holder === "reviewer") return reviewerHolds(session, "publish");
  if (turn.mode === "digesting") return stillDigesting(session);
  return sameHead ? nothingToPublish(session) : unknownNotes(session, notes);
}
