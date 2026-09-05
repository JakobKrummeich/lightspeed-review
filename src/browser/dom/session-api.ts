import type { DiffGroup } from "../../diff-extract.ts";
import type { ApprovedFormData } from "../../rounds/approved-form.ts";
import type { ReplayData } from "../../rounds/replay.ts";
import type { Approval } from "../../rounds/history.ts";
import type {
  ConversationEntry,
  DeclaredAnswer,
  FeedbackPrompt,
  ReviewCloser,
  RoundFile,
  RoundMark,
  SessionStatus,
} from "../../session-store.ts";

/** The slice of the stored session the review page renders. */
export interface SessionData {
  /** Why the branch exists, as this round states it. */
  intents: string[];
  /** Subjects of the commits the branch adds, newest first. */
  commits: string[];
  groups: DiffGroup[];
  approved: string[];
  /**
   * Where each file of this round stands with the reviewer, derived server-side
   * from the rounds before it.
   */
  approval: Record<string, Approval>;
  conversation: ConversationEntry[];
  /**
   * Every round, oldest first; the panel rules the conversation along it. The
   * type claims only what the page reads: marks, plus per-round files whose
   * blobs decide the `Since last round` switch (`round-changes.ts`). `files`
   * optional because only the wire carries it.
   */
  rounds: (RoundMark & { files?: RoundFile[] })[];
  pending: FeedbackPrompt[];
  /**
   * Agent's per-comment answers (`poll --for <id> --note`), keyed by comment
   * id; the panel shows each note under the comment it answers.
   */
  declarations?: Record<string, DeclaredAnswer>;
  status: SessionStatus;
  /**
   * Who closed it, when recorded. Absent reads as "not written down", not as
   * either party — the closing summary says so in words.
   */
  endedBy?: ReviewCloser;
}

export async function fetchSession(key: string): Promise<SessionData> {
  const response = await fetch(`/api/session/${key}/data`);
  if (!response.ok) throw new Error(`session ${key} could not be loaded`);
  return (await response.json()) as SessionData;
}

/**
 * One whole version of a file. Undefined is an ordinary answer: added,
 * deleted, renamed or binary on that side — the diff is all the code there is.
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
 * What the agent did to a file after approval. Fetched only on toggle press:
 * costs a git subprocess, most files are never toggled, and the payload is
 * large enough. Undefined is an answer, not a failure to handle later.
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

/**
 * What the agent did between the last two rounds to an unapproved file: the
 * diff switch's other endpoint, fetched on press for the same reasons.
 * Undefined is an answer here too.
 */
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
 * What became of last round's comments. Asked once per round (load and
 * re-group), never per card. Failure is the caller's to swallow: the diff
 * must never wait on the replay.
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
 * Send timeout. The compose row is locked while this call runs, so an answer
 * that never comes would lock the review for good. A minute dwarfs a local
 * kilobyte write yet can be waited out; being wrong is cheap — nothing is
 * cleared on failure, and a send that landed echoes back down the stream.
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
