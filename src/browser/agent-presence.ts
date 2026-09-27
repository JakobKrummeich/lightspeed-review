/**
 * Two separate facts: `waiting` is a live connection — somebody would read the
 * next send at once; `turn` is whose move it is, and the only thing that decides
 * whether Send sends or queues.
 */
import type { Turn } from "../session-store.ts";

export interface AgentPresence {
  waiting: boolean;
  turn: Turn;
  /** How many items the agent is reading; only while it digests. */
  items?: number;
  /** Only on a review that has ended; an older server never says it. */
  ended?: true;
}

/**
 * SSE payloads are untrusted text: a frame that does not spell out an agent's
 * turn leaves it with the reviewer, so an older server or a garbled frame can
 * only ever hand sending back — never turn Send into Queue on nobody's word.
 */
export function readPresence(data: string): AgentPresence {
  try {
    const frame = JSON.parse(data) as {
      waiting?: unknown;
      turn?: unknown;
      items?: unknown;
      ended?: unknown;
    } | null;
    return {
      waiting: frame?.waiting === true,
      turn: readTurn(frame?.turn),
      ...extras(frame?.items, frame?.ended),
    };
  } catch {
    return { waiting: false, turn: reviewerHolds() };
  }
}

/** The facts a frame may leave out, each kept only when it is well formed. */
function extras(items: unknown, ended: unknown): Pick<AgentPresence, "items" | "ended"> {
  return {
    ...(Number.isInteger(items) && (items as number) > 0 ? { items: items as number } : {}),
    ...(ended === true ? { ended } : {}),
  };
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
    // A mode nobody knows reads as `digesting`, not as a hole: it is the
    // strictest lock, and "the agent is reading" is the claim that assumes least.
    mode: mode === "working" ? "working" : "digesting",
    at: stamped,
    ...(plan === undefined ? {} : { note: plan }),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Only what the panel draws off a turn: the holder, and for the agent its mode
 * and plan. A fresh `at` alone is the same turn restated, not news to redraw for.
 */
export function sameTurn(one: Turn, other: Turn): boolean {
  if (one.holder !== other.holder) return false;
  if (one.holder !== "agent" || other.holder !== "agent") return true;
  return one.mode === other.mode && one.note === other.note;
}
