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
  return withBatch(withIds(withAnswers(withRecoveredDelivery(withTurn))));
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
 * it, or the agent would be holding a batch that is also still queued.
 */
function withRecoveredDelivery(session: SessionRecord & V2Fields): SessionRecord & V2Fields {
  if (session.delivering === undefined) return session;
  const { delivering, ...rest } = session;
  const digesting = session.turn.holder === "agent" && session.turn.mode === "digesting";
  return {
    ...rest,
    pending: [...delivering.prompts, ...session.pending],
    ...(digesting ? { turn: { holder: "reviewer" as const, at: session.turn.at } } : {}),
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
 * 2.x minted no id for a general message, so a queued one would reach the
 * agent as an item it cannot reply to. It gets a thread id here — in the queue
 * and on the conversation entry that recorded it.
 */
function withIds(session: SessionRecord): SessionRecord {
  let conversation = session.conversation;
  let minted = [...conversation.flatMap((entry) => entry.prompts), ...session.pending];
  const pending = session.pending.map((prompt) => {
    if (prompt.type !== "message" || prompt.id !== undefined) return prompt;
    const id = nextThreadId(minted);
    const named = { ...prompt, id };
    minted = [...minted, named];
    conversation = namedInConversation(conversation, prompt.comment, id);
    return named;
  });
  return { ...session, pending, conversation };
}

function namedInConversation(
  conversation: ConversationEntry[],
  comment: string,
  id: string,
): ConversationEntry[] {
  const at = conversation.findLastIndex((entry) =>
    entry.prompts.some((p) => p.type === "message" && p.id === undefined && p.comment === comment),
  );
  if (at === -1) return conversation;
  const entry = conversation[at]!;
  const prompts = entry.prompts.map((p) =>
    p.type === "message" && p.id === undefined && p.comment === comment ? { ...p, id } : p,
  );
  return conversation.map((e, index) => (index === at ? { ...entry, prompts } : e));
}

/**
 * A 2.x agent turn has no batch on record — the delivery was confirmed and
 * dropped. What it was holding is rebuilt from the reviewer's words since the
 * agent last spoke, so a re-attaching `open` is handed something to digest.
 */
function withBatch(session: SessionRecord): SessionRecord {
  if (session.turn.holder !== "agent" || session.batch !== undefined) return session;
  const lastAgent = session.conversation.findLastIndex((entry) => entry.role === "agent");
  const prompts = session.conversation
    .slice(lastAgent + 1)
    .filter((entry) => entry.role === "reviewer")
    .flatMap((entry) => entry.prompts);
  const batch: Batch = { id: "migrated", prompts, at: session.turn.at, acked: true };
  return { ...session, batch };
}
