import type { ConversationEntry } from "../session-store.ts";

/**
 * The conversation panel is a fixed column of the page, so a reviewer who is
 * reading rather than commenting pays its width on every screen. It can be
 * shut, and this is what the rail that shuts it has to say while it is.
 */
export interface RailState {
  collapsed: boolean;
  /** Feedback the reviewer has queued but not sent yet. */
  queued: number;
}

/** The control names the state it is in, not the state a click would leave. */
export function railLabel(state: RailState): string {
  if (!state.collapsed) return "Hide the conversation";
  return state.queued > 0
    ? `Show the conversation — ${state.queued} queued`
    : "Show the conversation";
}

/**
 * A number on the rail, and only when a shut panel is holding something the
 * reviewer would otherwise have no way to see. Open, the pills are the count.
 */
export function railBadge(state: RailState): string {
  return state.collapsed && state.queued > 0 ? String(state.queued) : "";
}

/**
 * Whether the agent has just added to the conversation, which is the one event
 * that reopens a shut panel: an answer the reviewer never sees is worse than
 * the width it costs. The reviewer's own send arrives the same way and must not
 * count, and a re-group redraws the whole conversation without anything being
 * said.
 */
export function agentSpokeAgain(
  before: readonly ConversationEntry[],
  after: readonly ConversationEntry[],
): boolean {
  return after.length > before.length && after[after.length - 1]?.role === "agent";
}
