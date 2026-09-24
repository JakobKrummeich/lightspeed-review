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
 *
 * The header says a short fixed label; the full sentence rides in `title`. The
 * plan `work` declares ran long, got cut off in the header's corner, and is
 * already written out at the foot of the conversation — but that panel can be
 * collapsed, and the no-agent advice is said nowhere else, so the sentence
 * stays one hover away instead of being dropped.
 */
function presenceLine(state: StatusState): string {
  // Escaped because on the agent's turn the title carries the plan `work`
  // declared, which is the agent's own words — inside an attribute, so the
  // quote matters as much as the angle brackets.
  const turn = state.turn.holder;
  const { label, detail } = presenceWords(state);
  return `<p class="lsr-presence" data-waiting="${state.agentWaiting}" data-turn="${turn}" title="${escapeHtml(detail)}">${escapeHtml(label)}</p>`;
}

/**
 * "Working" covers reading too: whether the agent has only picked the feedback
 * up or is already changing code is the conversation's to say, not the header's.
 * The reviewer's move does not start with "Agent is": beside "Agent is working"
 * it read as the same news, when one asks for the reviewer and the other does not.
 */
function presenceWords(state: StatusState): { label: string; detail: string } {
  if (state.turn.holder === "agent") {
    return { label: "Agent is working", detail: agentTurnText(state.turn) };
  }
  return state.agentWaiting
    ? { label: "Waiting for your feedback", detail: "an agent is waiting for your feedback" }
    : {
        label: "No agent is waiting",
        // Not "queued": on this page that is the Queue button's word, for pills the
        // reviewer can still take back, and this Send leaves the page for good.
        detail: "no agent is waiting — send anyway, it is handed over when the agent next waits",
      };
}
