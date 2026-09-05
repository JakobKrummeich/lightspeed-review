import { parsePrompt } from "./feedback-prompt.ts";
import { approvalPaths, type ApprovalPaths } from "./review-files.ts";
import type { FeedbackPrompt, ReviewCloser, SessionRecord } from "./session-store.ts";

export interface FeedbackRequest {
  prompts: FeedbackPrompt[];
  ended: boolean;
}

/**
 * How much was approved at close. The payload must carry the evidence: a silent
 * end with nothing approved and one with everything approved are otherwise the
 * same bytes. Counts and not paths: the agent polling is the one that wrote the
 * branch, it already knows the files, and a hundred paths it did not ask for are
 * a hundred paths of its context spent. `lightspeed approvals` names them when
 * something actually turns on which file — the help line says so.
 */
export interface EndApproval {
  /**
   * What the counts add up to, so nothing has to add them up: `signed-off` is
   * every file approved, `partial` some approved and some not, `none` nothing
   * approved at all, `empty` a review that closed holding no files. Only
   * `signed-off` is a sign-off, and it is one about acceptance, not reading: a
   * review whose approvals came out of a sweep lane is signed off by someone
   * nobody asked to read those files — `swept` says how much of it that was.
   */
  verdict: EndVerdict;
  /** How many of the review's files were ticked approved when it closed. */
  approved: number;
  /** How many nobody signed off on. */
  unapproved: number;
  /**
   * How many of those approvals a sweep lane took in one press: files the review
   * filed as bulk, so the tick says accepted and never says read. Counted inside
   * `approved`, not beside it.
   */
  swept: number;
  /** How many distinct files the review's latest grouping holds, so nobody sums. */
  total: number;
}

/** The four readings of a closed review, as a closed set an agent can branch on. */
export const END_VERDICTS = ["signed-off", "partial", "none", "empty"] as const;

export type EndVerdict = (typeof END_VERDICTS)[number];

/** What a poll hands back to the waiting agent. */
export interface PollPayload {
  status: string;
  ended: boolean;
  prompts: FeedbackPrompt[];
  /**
   * Only on an ended payload, and absent from one an older server wrote: a
   * reader must treat its absence as "not stated", never as "nothing approved".
   */
  approval?: EndApproval;
  /** Only on an ended payload, and only when the record says who closed it. */
  endedBy?: ReviewCloser;
}

/**
 * Queued in `pending` for the next poll to drain; kept in `conversation` as the
 * history that survives draining. A `Send & End` with nothing queued adds no
 * turn: an empty "reviewer" entry reads as words lost, not words never said.
 */
export function withFeedback(
  session: SessionRecord,
  feedback: FeedbackRequest,
  now: string,
): SessionRecord {
  return {
    ...session,
    // `Send & End` only comes from the browser, so an end through here is a person's.
    ...(feedback.ended ? closedBy(session, "reviewer") : {}),
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

/** `poll --agent-reply`: the agent answers the reviewer mid-review. */
export function withAgentReply(
  session: SessionRecord,
  comment: string,
  now: string,
): SessionRecord {
  return {
    ...session,
    conversation: [
      ...session.conversation,
      { role: "agent", at: now, ...currentRound(session), prompts: [{ type: "message", comment }] },
    ],
    updatedAt: now,
  };
}

/**
 * Stamped at append time: afterwards nothing but the clock ties a message to a
 * round. It is the round on screen, not the round the words are about — an
 * `--agent-reply` answering round 2 lands after fix+`start`, so it stamps round
 * 3, the diff the reviewer reads alongside it. No rounds stamps nothing, not round 0.
 */
function currentRound(session: SessionRecord): { roundIndex?: number } {
  const roundIndex = session.rounds.at(-1)?.index;
  return roundIndex === undefined ? {} : { roundIndex };
}

/**
 * Hands the queued prompts to one poller. An ended session always answers so a
 * waiting agent is never left blocking on a review that is over; an open one
 * with nothing queued answers with `undefined`, meaning "keep waiting".
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
 * Read off the same account as the counts beside it, so the word and the numbers
 * cannot part ways. A review holding nothing is `empty` and not `signed-off`:
 * approving none of no files decides nothing.
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
 * is here, on the one field a second close could falsify. Already ended with no
 * recorded closer keeps saying nobody wrote it down.
 */
export function closedBy(session: SessionRecord, closer: ReviewCloser): { endedBy?: ReviewCloser } {
  return session.status === "ended" ? {} : { endedBy: closer };
}

/**
 * The browser is untrusted like any client, and a malformed prompt would reach
 * the agent as a poll result, so the shape is checked here.
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
