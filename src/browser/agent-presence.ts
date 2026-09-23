/**
 * Two separate facts: `waiting` is a live connection — somebody would read the
 * next send at once; `turn` is whose move it is, and the only thing Send is gated on.
 */
import type { Turn } from "../session-store.ts";

export interface AgentPresence {
  waiting: boolean;
  turn: Turn;
}

/**
 * SSE payloads are untrusted text: a frame that does not spell out an agent's
 * turn leaves it with the reviewer, so an older server or a garbled frame can
 * only ever hand Send back — never take it away on nobody's word.
 */
export function readPresence(data: string): AgentPresence {
  try {
    const frame = JSON.parse(data) as { waiting?: unknown; turn?: unknown } | null;
    return { waiting: frame?.waiting === true, turn: readTurn(frame?.turn) };
  } catch {
    return { waiting: false, turn: reviewerHolds() };
  }
}

/** `at` empty: nobody said when. */
function reviewerHolds(): Turn {
  return { holder: "reviewer", at: "" };
}

function readTurn(value: unknown): Turn {
  if (typeof value !== "object" || value === null) return reviewerHolds();
  const { holder, mode, at, note } = value as Record<string, unknown>;
  const stamped = text(at) ?? "";
  if (holder !== "agent") return { holder: "reviewer", at: stamped };
  const plan = text(note);
  return {
    holder: "agent",
    // A mode nobody knows reads as `reading`, not as a hole: `mode` only decides
    // which sentence the panel writes, the holder beside it still takes Send
    // away, and "the agent has your feedback" is the claim that assumes least.
    mode: mode === "working" ? "working" : "reading",
    at: stamped,
    ...(plan === undefined ? {} : { note: plan }),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
