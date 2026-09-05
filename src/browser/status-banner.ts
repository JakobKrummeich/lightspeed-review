import { renderClosingSummary, type ClosedReview } from "./closing-summary.ts";
import { escapeHtml } from "../escape-html.ts";
import type { SessionStatus } from "../session-store.ts";

export interface StatusState {
  status: SessionStatus;
  /** True while an agent is blocked in `poll` for this session. */
  agentWaiting: boolean;
  /** True while an agent is off acting on feedback a poll already took away. */
  agentWorking: boolean;
  /**
   * The review itself, carried whatever the status: a page loaded on a
   * long-ended review must show the same summary as the tab open at closing.
   */
  review: ClosedReview;
}

/**
 * The header status area plus, once the review is closed, a full-page overlay.
 * Pure so both the served HTML and the live SSE update render from one place.
 */
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
 * is. Working wins over waiting when both are reported — a second parked
 * agent is nothing the reviewer can act on.
 */
function presenceLine(state: StatusState): string {
  const label = presenceLabel(state);
  return `<p class="lsr-presence" data-waiting="${state.agentWaiting}" data-working="${state.agentWorking}">${label}</p>`;
}

function presenceLabel(state: StatusState): string {
  if (state.agentWorking) return "the agent is working on your feedback";
  return state.agentWaiting
    ? "an agent is waiting for your feedback"
    : "no agent is waiting — send anyway, the feedback is queued";
}
