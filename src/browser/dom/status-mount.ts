import { renderStatusBanner, type StatusState } from "../status-banner.ts";
import type { AgentPresence } from "../agent-presence.ts";
import { presenceOf } from "../../turn.ts";
import type { SessionData } from "./session-api.ts";
import type { ConversationEntry, FeedbackPrompt } from "../../session-store.ts";

export interface MountedStatusBanner {
  setPresence(presence: AgentPresence): void;
  setSession(session: SessionData): void;
  /** Closes on what the page already knows, not on the server's next word. */
  setEndedByReviewer(sent: FeedbackPrompt[]): void;
}

/**
 * Writes only when the rendered string differs: the initial state is
 * server-rendered, and a session event that changed nothing the banner says
 * is not news.
 */
export function mountStatusBanner(session: SessionData): MountedStatusBanner {
  const root = document.querySelector<HTMLElement>("#lsr-status-banner");
  // The turn comes off the page's own session, not off the first SSE frame: a
  // reload mid-turn must say what the agent is doing straight away.
  let state: StatusState = {
    status: session.status,
    agentWaiting: false,
    ...presenceOf(session),
    review: session,
  };
  let drawn = renderStatusBanner(state);
  const draw = (next: StatusState) => {
    state = next;
    const html = renderStatusBanner(state);
    if (!root || html === drawn) return;
    drawn = html;
    root.innerHTML = html;
  };
  return {
    setPresence: ({ waiting, turn, items }) => {
      const next: StatusState = { ...state, agentWaiting: waiting, turn };
      if (items === undefined) delete next.items;
      else next.items = items;
      draw(next);
    },
    setSession: (fresh) => draw({ ...state, status: fresh.status, review: fresh }),
    setEndedByReviewer: (sent) =>
      draw({
        ...state,
        status: "ended",
        review: {
          ...state.review,
          endedBy: "reviewer",
          conversation: withSent(state.review.conversation, sent),
        },
      }),
  };
}

/**
 * Mirrors the server's write. Promptless ends append nothing (`withFeedback`'s
 * rule): a bare "reviewer" entry would be a comment nobody made — and one the
 * card counted.
 */
function withSent(conversation: ConversationEntry[], sent: FeedbackPrompt[]): ConversationEntry[] {
  if (sent.length === 0) return conversation;
  return [...conversation, { role: "reviewer", at: new Date().toISOString(), prompts: sent }];
}
