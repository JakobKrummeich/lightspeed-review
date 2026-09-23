import { parsePrompt } from "./feedback-prompt.ts";
import { approvalPaths, type ApprovalPaths } from "./review-files.ts";
import type { FeedbackPrompt, ReviewCloser, SessionRecord } from "./session-store.ts";
import { reviewerTurn, type HelpForm, type TurnLabel } from "./turn.ts";

export interface FeedbackRequest {
  prompts: FeedbackPrompt[];
  ended: boolean;
}

/**
 * The payload must carry the evidence: a silent end with nothing approved and
 * one with everything approved are otherwise the same bytes. Counts and not
 * paths: the agent already knows the files, and a hundred paths it did not ask
 * for are a hundred paths of its context spent — `lightspeed approvals` names
 * them.
 */
export interface EndApproval {
  /**
   * `signed-off` is about acceptance, not reading: a review whose approvals came
   * out of a sweep lane is signed off by someone nobody asked to read those
   * files — `swept` says how much of it that was.
   */
  verdict: EndVerdict;
  approved: number;
  unapproved: number;
  /** Counted inside `approved`, not beside it. */
  swept: number;
  total: number;
}

export const END_VERDICTS = ["signed-off", "partial", "none", "empty"] as const;

export type EndVerdict = (typeof END_VERDICTS)[number];

export interface PollPayload {
  status: string;
  ended: boolean;
  prompts: FeedbackPrompt[];
  /**
   * Added by the delivery handler, not by `drainPending`: the turn moves with
   * the bytes, so only the handler knows what it became. Absent from a payload
   * an older server wrote.
   */
  turn?: TurnLabel;
  round?: number;
  /** Absent from an older server's payload, which reads as `full` — the only form it ever sent. */
  helpForm?: HelpForm;
  /**
   * Transport, not review: echoed by the client to
   * `POST /api/session/:key/delivered` to say the prompts arrived, and never
   * printed — no agent acts on it.
   */
  delivery?: string;
  /**
   * Only on an ended payload, and absent from one an older server wrote: a
   * reader must treat its absence as "not stated", never as "nothing approved".
   */
  approval?: EndApproval;
  endedBy?: ReviewCloser;
}

/**
 * A `Send & End` with nothing queued adds no entry: an empty "reviewer" entry
 * reads as words lost, not words never said. The turn does not move here — the
 * reviewer's Send never hands it over, only delivery to a live `wait` does —
 * except on the end, which owes nobody a move.
 */
export function withFeedback(
  session: SessionRecord,
  feedback: FeedbackRequest,
  now: string,
): SessionRecord {
  return {
    ...session,
    // `Send & End` only comes from the browser, so an end through here is a person's.
    ...(feedback.ended ? { ...closedBy(session, "reviewer"), turn: reviewerTurn(now) } : {}),
    pending: [...session.pending, ...feedback.prompts],
    conversation:
      feedback.prompts.length === 0
        ? session.conversation
        : [
            ...session.conversation,
            { role: "reviewer", at: now, ...currentRound(session), prompts: feedback.prompts },
          ],
    status: feedback.ended ? "ended" : "feedback",
    updatedAt: now,
  };
}

/**
 * A question hands the turn back — it is the agent asking to be answered, and
 * Send has to send for that. Plain speech does not: an agent that answers one comment
 * and keeps editing is still working, and handing sending back between its
 * sentences would flip the reviewer's button between Send and Queue for the
 * length of a round.
 */
export function withAgentReply(
  session: SessionRecord,
  comment: string,
  now: string,
  kind?: "question",
): SessionRecord {
  return {
    ...session,
    conversation: [
      ...session.conversation,
      {
        role: "agent",
        at: now,
        ...currentRound(session),
        prompts: [{ type: "message", comment, ...(kind === undefined ? {} : { kind }) }],
      },
    ],
    ...(kind === "question" ? { turn: reviewerTurn(now) } : {}),
    updatedAt: now,
  };
}

/**
 * Stamped at append time: afterwards nothing but the clock ties a message to a
 * round. It is the round on screen, not the round the words are about — a `say`
 * answering round 2 lands after fix+`start`, so it stamps round 3, the diff the
 * reviewer reads alongside it. No rounds stamps nothing, not round 0.
 */
function currentRound(session: SessionRecord): { roundIndex?: number } {
  const roundIndex = session.rounds.at(-1)?.index;
  return roundIndex === undefined ? {} : { roundIndex };
}

/**
 * An ended session always answers so a waiting agent is never left blocking on
 * a review that is over; `undefined` means "keep waiting".
 */
export function drainPending(
  session: SessionRecord,
): { session: SessionRecord; payload: PollPayload } | undefined {
  const ended = session.status === "ended";
  if (session.pending.length === 0 && !ended) return undefined;
  return {
    session: { ...session, pending: [] },
    payload: {
      status: session.status,
      ended,
      prompts: session.pending,
      ...(ended ? endEvidence(session) : {}),
    },
  };
}

/**
 * The counts come off one account of the review (`approvalPaths`), so they
 * cannot disagree with what `lightspeed approvals` prints. A sweep lane's
 * approvals are counted twice over — once as approved, once as swept — because
 * they are both, and an agent told only the first would take a tick nobody was
 * asked to earn for a reading.
 */
function endEvidence(session: SessionRecord): { approval: EndApproval; endedBy?: ReviewCloser } {
  const paths = approvalPaths(session.groups, session.approved);
  return {
    approval: {
      verdict: endVerdict(paths),
      approved: paths.approved.length,
      unapproved: paths.unapproved.length,
      swept: paths.swept.length,
      total: paths.total,
    },
    ...(session.endedBy === undefined ? {} : { endedBy: session.endedBy }),
  };
}

/**
 * A review holding nothing is `empty` and not `signed-off`: approving none of no
 * files decides nothing.
 */
function endVerdict(paths: ApprovalPaths): EndVerdict {
  if (paths.total === 0) return "empty";
  if (paths.approved.length === 0) return "none";
  return paths.approved.length === paths.total ? "signed-off" : "partial";
}

/**
 * First close wins: a second close (agent `end` after reviewer `Send & End`, or
 * a stale tab) must not rewrite who decided. Neither route refuses a second
 * close — `end` stays idempotent, a stale tab deserves no error — so the guard
 * is here, on the one field a second close could falsify.
 */
export function closedBy(session: SessionRecord, closer: ReviewCloser): { endedBy?: ReviewCloser } {
  return session.status === "ended" ? {} : { endedBy: closer };
}

/**
 * The browser is untrusted like any client, and a malformed prompt would reach
 * the agent as a `wait` result, so the shape is checked here.
 */
export function parseFeedbackRequest(payload: unknown): FeedbackRequest | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { prompts, ended } = payload as { prompts?: unknown; ended?: unknown };
  if (!Array.isArray(prompts) || typeof ended !== "boolean") return undefined;
  const parsed: FeedbackPrompt[] = [];
  for (const prompt of prompts) {
    const valid = parsePrompt(prompt);
    if (!valid) return undefined;
    parsed.push(valid);
  }
  return { prompts: parsed, ended };
}
