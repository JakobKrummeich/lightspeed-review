import { renderStatusBanner, type StatusState } from "../status-banner.ts";
import type { AgentPresence } from "../agent-presence.ts";
import type { SessionData } from "./session-api.ts";
import type { ConversationEntry, FeedbackPrompt } from "../../session-store.ts";

export interface MountedStatusBanner {
  /** Both halves of who is on the review, as the `presence` frame states them. */
  setPresence(presence: AgentPresence): void;
  /** A fresh read of the session: its status, and the figures its end sums up. */
  setSession(session: SessionData): void;
  /**
   * Send & End pressed with these prompts. Closes on what the page already
   * knows, not on the server's next word.
   */
  setEndedByReviewer(sent: FeedbackPrompt[]): void;
}

/**
 * Keeps the header banner in step with the SSE stream. Writes only when the
 * rendered string differs: the initial state is server-rendered, and a
 * session event that changed nothing the banner says is not news.
 */
export function mountStatusBanner(session: SessionData): MountedStatusBanner {
  const root = document.querySelector<HTMLElement>("#lsr-status-banner");
  let state: StatusState = {
    status: session.status,
    agentWaiting: false,
    agentWorking: false,
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
    setPresence: ({ waiting, working }) =>
      draw({ ...state, agentWaiting: waiting, agentWorking: working }),
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
 * Conversation with the just-sent prompts appended, mirroring the server's
 * write. Promptless ends append nothing (`withFeedback`'s rule): a bare
 * "reviewer" entry would be a comment nobody made — and one the card counted.
 */
function withSent(conversation: ConversationEntry[], sent: FeedbackPrompt[]): ConversationEntry[] {
  if (sent.length === 0) return conversation;
  return [...conversation, { role: "reviewer", at: new Date().toISOString(), prompts: sent }];
}
