import type { ConversationEntry } from "../session-store.ts";

/**
 * The conversation panel is a fixed column, so a reviewer who is reading rather
 * than commenting pays its width on every screen; this is what the rail that
 * shuts it says while it is shut.
 */
export interface RailState {
  collapsed: boolean;
  queued: number;
}

export function railLabel(state: RailState): string {
  if (!state.collapsed) return "Hide the conversation";
  return state.queued > 0
    ? `Show the conversation — ${state.queued} queued`
    : "Show the conversation";
}

/** Only while shut: open, the pills are the count. */
export function railBadge(state: RailState): string {
  return state.collapsed && state.queued > 0 ? String(state.queued) : "";
}

/**
 * The one event that reopens a shut panel: an answer the reviewer never sees
 * is worse than the width it costs. The reviewer's own send arrives the same
 * way and must not count, and a re-group redraws the whole conversation
 * without anything being said.
 */
export function agentSpokeAgain(
  before: readonly ConversationEntry[],
  after: readonly ConversationEntry[],
): boolean {
  return after.length > before.length && after[after.length - 1]?.role === "agent";
}
