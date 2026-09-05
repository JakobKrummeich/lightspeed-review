/**
 * Who is on the other end, per the server's `presence` frame. Separate facts:
 * `waiting` reads the next send at once; `working` has taken the last one and
 * is not listening.
 */
export interface AgentPresence {
  /** An agent is blocked in `poll` for this session. */
  waiting: boolean;
  /** An agent took this session's prompts and has not answered them yet. */
  working: boolean;
}

/**
 * SSE payloads are untrusted text: anything but explicit true means nobody
 * there, so older servers or non-JSON frames claim nothing.
 */
export function readPresence(data: string): AgentPresence {
  try {
    const frame = JSON.parse(data) as { waiting?: unknown; working?: unknown } | null;
    return { waiting: frame?.waiting === true, working: frame?.working === true };
  } catch {
    return { waiting: false, working: false };
  }
}
