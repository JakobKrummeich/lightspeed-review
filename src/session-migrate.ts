import type {
  Batch,
  ConversationEntry,
  FeedbackPrompt,
  SessionRecord,
  Turn,
} from "./session-types.ts";
import { nextThreadId } from "./threads.ts";

/** What a 2.x session file may still carry that 3.0 no longer writes. */
interface V2Fields {
  turn?: Turn | { holder: "agent"; mode: "reading"; at: string; note?: string };
  delivering?: { id: string; prompts: FeedbackPrompt[]; at: string };
  declarations?: Record<string, { note?: string; files: string[]; at: string }>;
}

/**
 * Best effort, never lossy for what the reviewer sent: a 2.x session opens
 * under 3.0 without crashing, its conversation stays readable, and nothing the
 * reviewer queued is dropped. Each step is a no-op on a file 3.0 wrote, so a
 * session is migrated on every read rather than once — no version field to
 * trust, and no half-migrated file.
 */
export function migrateV2(parsed: SessionRecord & V2Fields): SessionRecord {
  const withTurn = { ...parsed, turn: migratedTurn(parsed) } as SessionRecord & V2Fields;
  return withIds(withBatch(withAnswers(withRecoveredDelivery(withTurn))));
}

/**
 * A session from before turns existed opens with the reviewer holding it: a
 * lock nobody can lift is a review nobody can finish. `reading` was 2.x's word
 * for what 3.0 calls digesting.
 */
function migratedTurn(parsed: SessionRecord & V2Fields): Turn {
  const turn = parsed.turn;
  if (turn === undefined) return { holder: "reviewer", at: parsed.updatedAt };
  if (turn.holder === "agent" && (turn.mode as string) === "reading") {
    return { holder: "agent", mode: "digesting", at: turn.at };
  }
  return turn as Turn;
}

/**
 * A 2.x delivery nobody confirmed goes back to the head of the queue, as
 * 2.x's own next poll would have put it — and a digesting turn goes back with
 * it, or the agent would be holding a batch that is also still queued. Under a
 * working turn it was read — the agent declared work on it — so it is the
 * batch, and queuing it again would hand the reviewer's words over twice.
 */
function withRecoveredDelivery(session: SessionRecord & V2Fields): SessionRecord & V2Fields {
  if (session.delivering === undefined) return session;
  const { delivering, ...rest } = session;
  const turn = session.turn;
  if (turn.holder === "agent" && turn.mode === "working") {
    const { id, prompts, at } = delivering;
    return { ...rest, batch: { id, prompts, at, acked: true } };
  }
  return {
    ...rest,
    pending: [...delivering.prompts, ...session.pending],
    ...(turn.holder === "agent" ? { turn: { holder: "reviewer" as const, at: turn.at } } : {}),
  };
}

/**
 * 2.x's `say --for` answers become the agent's reply in the thread they
 * answered, so the old exchange reads as a thread under 3.0.
 */
function withAnswers(session: SessionRecord & V2Fields): SessionRecord & V2Fields {
  if (session.declarations === undefined) return session;
  const { declarations, ...rest } = session;
  const answers: ConversationEntry[] = Object.entries(declarations)
    .filter(([, declared]) => declared.note !== undefined && declared.note !== "")
    .map(([thread, declared]) => ({
      role: "agent",
      at: declared.at,
      prompts: [{ type: "reply", thread, comment: declared.note! }],
    }));
  const conversation = [...session.conversation, ...answers].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  );
  return { ...rest, conversation };
}

/**
 * 2.x minted no id for a general message (and none for a line comment with the
 * ledger off), so such an item would reach the agent as one it cannot reply
 * to. It gets a thread id here — in the batch, in the queue, and on the
 * conversation entry that recorded it. The batch first: it was sent first.
 */
function withIds(session: SessionRecord): SessionRecord {
  let conversation = session.conversation;
  let minted = [
    ...conversation.flatMap((entry) => entry.prompts),
    ...session.pending,
    ...(session.batch?.prompts ?? []),
  ];
  const name = (prompt: FeedbackPrompt, latest: boolean): FeedbackPrompt => {
    if (prompt.type === "reply" || prompt.type === "resolve" || prompt.id !== undefined) {
      return prompt;
    }
    const named = { ...prompt, id: nextThreadId(minted) };
    minted = [...minted, named];
    conversation = namedInConversation(conversation, prompt, named, latest);
    return named;
  };
  const batch = session.batch && {
    ...session.batch,
    prompts: session.batch.prompts.map((prompt) => name(prompt, false)),
  };
  const pending = session.pending.map((prompt) => name(prompt, true));
  return { ...session, pending, conversation, ...(batch === undefined ? {} : { batch }) };
}

/**
 * The same words stand in the conversation without an id; the queue's copy is
 * the latest one, the batch's the earliest.
 */
function namedInConversation(
  conversation: ConversationEntry[],
  unnamed: FeedbackPrompt,
  named: FeedbackPrompt,
  latest: boolean,
): ConversationEntry[] {
  const same = (prompt: FeedbackPrompt) => identity(prompt) === identity(unnamed);
  const holds = (entry: ConversationEntry) => entry.prompts.some(same);
  const at = latest ? conversation.findLastIndex(holds) : conversation.findIndex(holds);
  if (at === -1) return conversation;
  const entry = conversation[at]!;
  const index = entry.prompts.findIndex(same);
  const prompts = entry.prompts.map((prompt, position) => (position === index ? named : prompt));
  return conversation.map((e, position) => (position === at ? { ...entry, prompts } : e));
}

function identity(prompt: FeedbackPrompt): string {
  return JSON.stringify(prompt);
}

/**
 * A 2.x agent turn has no batch on record — the delivery was confirmed and
 * dropped. What it was holding is rebuilt from the reviewer's words up to the
 * moment the turn moved (2.x moved it on delivery), since the agent last spoke
 * before then — minus whatever is still queued, which 2.x also wrote into the
 * conversation and which the next delivery hands over. When the queue took
 * every word, the agent was handed nothing: the turn goes back to the reviewer.
 */
function withBatch(session: SessionRecord): SessionRecord {
  const turn = session.turn;
  if (turn.holder !== "agent" || session.batch !== undefined) return session;
  const said = session.conversation;
  const lastAgent = said.findLastIndex((entry) => entry.role === "agent" && entry.at < turn.at);
  const sent = said
    .slice(lastAgent + 1)
    .filter((entry) => entry.role === "reviewer" && entry.at <= turn.at)
    .flatMap((entry) => entry.prompts);
  const prompts = withoutQueued(sent, session.pending);
  // Only when the queue accounts for every word: an agent turn with nothing
  // said since is still the agent's, but one whose every word is still queued
  // was handed nothing.
  if (prompts.length === 0 && sent.length > 0 && turn.mode === "digesting") {
    return { ...session, turn: { holder: "reviewer", at: turn.at } };
  }
  const batch: Batch = { id: "migrated", prompts, at: turn.at, acked: true };
  return { ...session, batch };
}

/** Each queued item cancels one identical sent one: the same words may be said twice. */
function withoutQueued(sent: FeedbackPrompt[], queued: FeedbackPrompt[]): FeedbackPrompt[] {
  const left = queued.map(identity);
  return sent.filter((prompt) => {
    const at = left.indexOf(identity(prompt));
    if (at === -1) return true;
    left.splice(at, 1);
    return false;
  });
}
