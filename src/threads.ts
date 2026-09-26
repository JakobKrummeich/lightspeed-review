/**
 * Threads are read off the conversation, never stored beside it: every
 * reviewer item opens one (its id is the item's), replies from either side name
 * it, and a resolve toggle flips it. One record of what was said, so a thread
 * cannot disagree with the conversation, the ledger or the round replay.
 * Imported into the browser bundle, so no filesystem here.
 */
import type {
  AnnotationPrompt,
  ConversationEntry,
  FeedbackPrompt,
  MessagePrompt,
} from "./session-types.ts";

/** The agent's own top-level messages; no reviewer item opens it. */
export const MAIN_THREAD = "main";

export interface ThreadMessage {
  role: "reviewer" | "agent";
  comment: string;
  at: string;
  roundIndex?: number;
}

export interface Thread {
  /** Empty on a legacy thread. */
  id: string;
  /**
   * Said before 3.0 gave items ids: shown so the old conversation stays
   * readable, but there is no thread id to reply in or resolve.
   */
  legacy?: true;
  /** What opened it; absent on `main`. */
  item?: AnnotationPrompt | MessagePrompt;
  /** Oldest first, the item's own comment included. */
  messages: ThreadMessage[];
  resolved: boolean;
  at: string;
  roundIndex?: number;
}

export function threadsOf(conversation: ConversationEntry[]): Thread[] {
  const threads = new Map<string, Thread>();
  for (const entry of conversation) {
    for (const prompt of entry.prompts) addToThreads(threads, entry, prompt);
  }
  return [...threads.values()];
}

function addToThreads(
  threads: Map<string, Thread>,
  entry: ConversationEntry,
  prompt: FeedbackPrompt,
): void {
  const said = messageOf(entry, prompt);
  if (prompt.type === "annotation" || prompt.type === "message") {
    if (prompt.id !== undefined) threads.set(prompt.id, opened(entry, prompt, said));
    else threads.set(`legacy ${threads.size}`, { ...opened(entry, prompt, said), legacy: true });
    return;
  }
  const thread = threadNamed(threads, prompt.thread, entry);
  if (thread === undefined) return;
  if (prompt.type === "resolve") {
    thread.resolved = prompt.resolved;
    return;
  }
  thread.messages.push(said);
  // The agent speaking into a folded thread is news the reviewer must see: a
  // reply nobody unfolds is a reply nobody reads.
  if (entry.role === "agent") thread.resolved = false;
}

/** `main` opens on first use; any other unknown thread is a reply to nothing. */
function threadNamed(
  threads: Map<string, Thread>,
  id: string,
  entry: ConversationEntry,
): Thread | undefined {
  const thread = threads.get(id) ?? (id === MAIN_THREAD ? main(entry) : undefined);
  if (thread !== undefined) threads.set(id, thread);
  return thread;
}

function opened(
  entry: ConversationEntry,
  item: AnnotationPrompt | MessagePrompt,
  said: ThreadMessage,
): Thread {
  return { id: item.id ?? "", item, messages: [said], resolved: false, ...placed(entry) };
}

function main(entry: ConversationEntry): Thread {
  return { id: MAIN_THREAD, messages: [], resolved: false, ...placed(entry) };
}

function placed(entry: ConversationEntry): { at: string; roundIndex?: number } {
  return {
    at: entry.at,
    ...(entry.roundIndex === undefined ? {} : { roundIndex: entry.roundIndex }),
  };
}

function messageOf(entry: ConversationEntry, prompt: FeedbackPrompt): ThreadMessage {
  const comment = prompt.type === "resolve" ? "" : prompt.comment;
  return { role: entry.role, comment, ...placed(entry) };
}

/** `t1`, `t2`…: short enough to type in `--to`, stable for the session's life. */
export function nextThreadId(prompts: FeedbackPrompt[]): string {
  const taken = prompts
    .map((prompt) =>
      "id" in prompt && prompt.id !== undefined ? /^t(\d+)$/.exec(prompt.id) : null,
    )
    .filter((match) => match !== null)
    .map((match) => Number(match[1]));
  return `t${Math.max(0, ...taken) + 1}`;
}

/** Every id a reply may name: each item's thread, and `main`. */
export function threadIds(prompts: FeedbackPrompt[]): Set<string> {
  const ids = new Set<string>([MAIN_THREAD]);
  for (const prompt of prompts) {
    if ((prompt.type === "annotation" || prompt.type === "message") && prompt.id !== undefined) {
      ids.add(prompt.id);
    }
  }
  return ids;
}

/**
 * The threads worth naming in a suggested `--to`: those of the held batch that
 * are still open, else every open thread. Never a resolved one — the reviewer
 * closed it — and never `main`, which the caller names itself when this is empty.
 */
export function openIds(conversation: ConversationEntry[], held: FeedbackPrompt[] = []): string[] {
  const open = threadsOf(conversation)
    .filter((thread) => !thread.resolved && thread.legacy !== true && thread.id !== MAIN_THREAD)
    .map((thread) => thread.id);
  const inBatch = batchItems(held, conversation)
    .map((item) => item.id)
    .filter((id) => open.includes(id));
  return inBatch.length > 0 ? inBatch : open;
}

/**
 * How many items a batch holds, as the agent is handed them: one per thread it
 * touches, however many words went into that thread.
 */
export function batchSize(prompts: FeedbackPrompt[]): number {
  const touched = prompts.map((prompt) =>
    prompt.type === "reply" || prompt.type === "resolve" ? prompt.thread : prompt.id,
  );
  return new Set(touched.filter((id) => id !== undefined)).size;
}

export type BatchItemStatus = "new" | "reply" | "resolved" | "reopened";

/**
 * One thread as the agent is handed it: what is new in it since the agent last
 * spoke, and — for a reply — what the agent itself said last, so the answer
 * can be read without scrolling back.
 */
export interface BatchItem {
  id: string;
  status: BatchItemStatus;
  file?: string;
  side?: "old" | "new";
  line_start?: number;
  line_end?: number;
  selected_text?: string;
  /** The agent's last words in this thread, before this batch. */
  you?: string;
  /** What the reviewer said in this batch, oldest first; empty for a bare resolve. */
  reviewer: string[];
}

/**
 * One item per thread, in the order the reviewer first touched it. A resolve
 * with a reply says `resolved`, carrying the reply: resolving is the news.
 */
export function batchItems(
  prompts: FeedbackPrompt[],
  conversation: ConversationEntry[],
): BatchItem[] {
  const threads = new Map(threadsOf(conversation).map((thread) => [thread.id, thread]));
  const items = new Map<string, BatchItem>();
  for (const prompt of prompts) {
    const id = prompt.type === "reply" || prompt.type === "resolve" ? prompt.thread : prompt.id;
    if (id === undefined) continue;
    const item = items.get(id) ?? blankItem(id, threads.get(id));
    items.set(id, withPrompt(item, prompt));
  }
  return [...items.values()];
}

function blankItem(id: string, thread: Thread | undefined): BatchItem {
  const you = thread?.messages.findLast((message) => message.role === "agent")?.comment;
  return {
    id,
    status: "reply",
    ...anchorOf(thread?.item),
    ...(you === undefined ? {} : { you }),
    reviewer: [],
  };
}

function anchorOf(item: AnnotationPrompt | MessagePrompt | undefined): Partial<BatchItem> {
  if (item?.type !== "annotation") return {};
  return {
    file: item.file,
    ...(item.side === undefined
      ? {}
      : { side: item.side, line_start: item.line_start, line_end: item.line_end }),
    selected_text: item.selected_text,
  };
}

function withPrompt(item: BatchItem, prompt: FeedbackPrompt): BatchItem {
  if (prompt.type === "resolve") {
    return { ...item, status: prompt.resolved ? "resolved" : "reopened" };
  }
  const reviewer = [...item.reviewer, prompt.comment];
  if (prompt.type === "reply") return { ...item, reviewer };
  // A new item: nothing the agent said can precede it.
  const fresh = { ...item, ...anchorOf(prompt), status: "new" as const, reviewer };
  delete fresh.you;
  return fresh;
}
