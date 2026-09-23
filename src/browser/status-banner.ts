import { renderClosingSummary, type ClosedReview } from "./closing-summary.ts";
import { escapeHtml } from "../escape-html.ts";
import type { SessionStatus, Turn } from "../session-store.ts";
import { agentTurnText } from "./turn-words.ts";

export interface StatusState {
  status: SessionStatus;
  agentWaiting: boolean;
  turn: Turn;
  /** Carried whatever the status: a page loaded on a long-ended review must show the same summary as the tab open at closing. */
  review: ClosedReview;
}

/** Pure so both the served HTML and the live SSE update render from one place. */
export function renderStatusBanner(state: StatusState): string {
  if (state.status === "ended") {
    // `role="status"`: a screen reader following the diff would otherwise get
    // no sign that everything stopped taking input. Polite by the role's
    // definition — the review is already over.
    return `${statusLine("ended")}
<div class="lsr-ended-overlay" role="status">${renderClosingSummary(state.review)}</div>`;
  }
  return `${statusLine(state.status)}
${presenceLine(state)}`;
}

function statusLine(status: SessionStatus): string {
  return `<p class="lsr-status" data-status="${escapeHtml(status)}">${escapeHtml(status)}</p>`;
}

/**
 * All three states stated: "nobody is listening" is as much news as somebody
 * is. The turn wins over waiting when both are reported — a second parked agent
 * is nothing the reviewer can act on, and the agent holding their feedback is.
 */
function presenceLine(state: StatusState): string {
  // The holder, not "is the agent working": a reading agent is not working.
  // Escaped because on the agent's turn the text carries the plan `work`
  // declared, which is the agent's own words.
  const turn = state.turn.holder;
  return `<p class="lsr-presence" data-waiting="${state.agentWaiting}" data-turn="${turn}">${escapeHtml(presenceLabel(state))}</p>`;
}

function presenceLabel(state: StatusState): string {
  if (state.turn.holder === "agent") return agentTurnText(state.turn);
  return state.agentWaiting
    ? "an agent is waiting for your feedback"
    : "no agent is waiting — send anyway, the feedback is queued";
}
