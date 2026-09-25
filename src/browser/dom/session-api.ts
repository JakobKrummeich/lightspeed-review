import type { DiffGroup } from "../../diff-extract.ts";
import type { ApprovedFormData } from "../../rounds/approved-form.ts";
import type { ReplayData } from "../../rounds/replay.ts";
import type { Approval } from "../../rounds/history.ts";
import type {
  ConversationEntry,
  FeedbackPrompt,
  ReviewCloser,
  RoundFile,
  RoundMark,
  SessionStatus,
  Turn,
} from "../../session-store.ts";

/** The slice of the stored session the review page renders. */
export interface SessionData {
  intents: string[];
  /** Subjects, newest first. */
  commits: string[];
  groups: DiffGroup[];
  approved: string[];
  approval: Record<string, Approval>;
  conversation: ConversationEntry[];
  /**
   * Oldest first. The type claims only what the page reads: marks, plus
   * per-round files whose blobs decide the `Since last round` switch
   * (`round-changes.ts`). `files` optional because only the wire carries it.
   */
  rounds: (RoundMark & { files?: RoundFile[] })[];
  pending: FeedbackPrompt[];
  status: SessionStatus;
  turn: Turn;
  /**
   * Absent reads as "not written down", not as either party — the closing
   * summary says so in words.
   */
  endedBy?: ReviewCloser;
}

export async function fetchSession(key: string): Promise<SessionData> {
  const response = await fetch(`/api/session/${key}/data`);
  if (!response.ok) throw new Error(`session ${key} could not be loaded`);
  return (await response.json()) as SessionData;
}

/**
 * Undefined is an ordinary answer: added, deleted, renamed or binary on that
 * side — the diff is all the code there is.
 */
export async function fetchFileSide(
  key: string,
  path: string,
  side: "old" | "new",
): Promise<string | undefined> {
  const query = new URLSearchParams({ path, side });
  const response = await fetch(`/api/session/${key}/file?${query}`);
  if (!response.ok) return undefined;
  return ((await response.json()) as { contents?: unknown }).contents as string | undefined;
}

/**
 * Fetched only on toggle press: costs a git subprocess, most files are never
 * toggled, and the payload is large enough. Undefined is an answer, not a
 * failure to handle later.
 */
export async function fetchApprovedForm(
  key: string,
  path: string,
): Promise<ApprovedFormData | undefined> {
  const query = new URLSearchParams({ path });
  const response = await fetch(`/api/session/${key}/approved-form?${query}`);
  if (!response.ok) return undefined;
  return (await response.json()) as ApprovedFormData;
}

/** Fetched on press for the same reasons as `fetchApprovedForm`; undefined is an answer here too. */
export async function fetchLastRoundForm(
  key: string,
  path: string,
): Promise<ApprovedFormData | undefined> {
  const query = new URLSearchParams({ path });
  const response = await fetch(`/api/session/${key}/last-round-form?${query}`);
  if (!response.ok) return undefined;
  return (await response.json()) as ApprovedFormData;
}

/**
 * Asked once per round (load and re-group), never per card. Failure is the
 * caller's to swallow: the diff must never wait on the replay.
 */
export async function fetchReplay(key: string): Promise<ReplayData> {
  const response = await fetch(`/api/session/${key}/replay`);
  if (!response.ok) throw new Error(`replay for ${key} could not be loaded`);
  return (await response.json()) as ReplayData;
}

export async function persistApproved(key: string, approved: string[]): Promise<void> {
  await post(`/api/session/${key}/approved`, { approved });
}

/**
 * The compose row is locked while the send runs, so an answer that never
 * comes would lock the review for good. A minute dwarfs a local kilobyte write
 * yet can be waited out; being wrong is cheap — nothing is cleared on failure,
 * and a send that landed echoes back down the stream.
 */
const FEEDBACK_TIMEOUT_MS = 60_000;

export async function sendFeedback(
  key: string,
  prompts: FeedbackPrompt[],
  ended: boolean,
): Promise<void> {
  await post(`/api/session/${key}/feedback`, { prompts, ended }, FEEDBACK_TIMEOUT_MS);
}

async function post(path: string, body: unknown, timeoutMs?: number): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
  });
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
}
