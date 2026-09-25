import { renderClosingSummary, type ClosedReview } from "./closing-summary.ts";
import { escapeHtml } from "../escape-html.ts";
import type { SessionStatus, Turn } from "../session-store.ts";
import { agentTurnText, listeningText } from "./turn-words.ts";

export interface StatusState {
  status: SessionStatus;
  agentWaiting: boolean;
  turn: Turn;
  /** How many items the agent is reading; only while it digests. */
  items?: number;
  /** Carried whatever the status: a page loaded on a long-ended review must show the same summary as the tab open at closing. */
  review: ClosedReview;
}

/**
 * Pure so both the served HTML and the live SSE update render from one place.
 * No word for the session's status beside the presence label: `open`,
 * `feedback` and `ended` are the store's states, not news to the reviewer —
 * the label says whose move it is, and an ended review says so in its overlay.
 */
export function renderStatusBanner(state: StatusState): string {
  if (state.status === "ended") {
    // `role="status"`: a screen reader following the diff would otherwise get
    // no sign that everything stopped taking input. Polite by the role's
    // definition — the review is already over.
    return `<div class="lsr-ended-overlay" role="status">${renderClosingSummary(state.review)}</div>`;
  }
  return presenceLine(state);
}

/**
 * Every state stated: "nobody is listening" is as much news as somebody is.
 * The turn wins over listening when both are reported — a second parked agent
 * is nothing the reviewer can act on, and the agent holding their feedback is.
 *
 * The label is the whole sentence; the header's corner cuts a long plan off
 * with an ellipsis, so the full sentence also rides in `title`, one hover away.
 */
function presenceLine(state: StatusState): string {
  // Escaped because on the agent's turn the label carries the plan `work`
  // declared, which is the agent's own words — inside an attribute, so the
  // quote matters as much as the angle brackets.
  const turn = state.turn.holder;
  const { label, detail } = presenceWords(state);
  return `<p class="lsr-presence" data-waiting="${state.agentWaiting}" data-turn="${turn}" title="${escapeHtml(detail)}">${escapeHtml(label)}</p>`;
}

function presenceWords(state: StatusState): { label: string; detail: string } {
  if (state.turn.holder === "agent") {
    const said = agentTurnText(state.turn, state.items);
    return { label: said, detail: said };
  }
  const label = listeningText(state.agentWaiting);
  return state.agentWaiting
    ? { label, detail: "an agent is listening: your next Send reaches it at once" }
    : {
        label,
        // Not "queued": on this page that is the Queue button's word, for pills the
        // reviewer can still take back, and this Send leaves the page for good.
        detail:
          "no agent is listening — Send anyway, it is handed over when the agent next listens",
      };
}
