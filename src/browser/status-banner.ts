import { renderClosingSummary, type ClosedReview } from "./closing-summary.ts";
import { escapeHtml } from "../escape-html.ts";
import type { SessionStatus, Turn } from "../session-store.ts";
import { agentTurnText, listeningText, presenceWord } from "./turn-words.ts";

export interface StatusState {
  status: SessionStatus;
  agentWaiting: boolean;
  turn: Turn;
  /** How many items the agent is reading; only while it digests. */
  items?: number;
  /** False while the page's event stream is down: presence is then unknown. Absent is connected. */
  connected?: boolean;
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
 * The header says a short word beside a dot; the whole sentence — the plan,
 * the item count, what a Send does now — rides in `title`, one hover away.
 */
function presenceLine(state: StatusState): string {
  const attributes = `data-waiting="${state.agentWaiting}" data-turn="${state.turn.holder}"`;
  const sentence = presenceSentence(state);
  if (state.connected === false) {
    // Greyed, dotless, and said: beside the "connection lost" chip, a header
    // still reading "Agent listening" is a claim the page can no longer back.
    const why = `the page lost the review server; last known: ${sentence.said}`;
    return `<p class="lsr-presence" ${attributes} data-connection="lost" title="${escapeHtml(why)}">Connection lost</p>`;
  }
  // Escaped because on the agent's turn the tooltip carries the plan `work`
  // declared, which is the agent's own words — inside an attribute, so the
  // quote matters as much as the angle brackets.
  const word = presenceWord(state.turn, state.agentWaiting);
  const dot = `<span class="lsr-presence-dot" aria-hidden="true"></span>`;
  return `<p class="lsr-presence" ${attributes} title="${escapeHtml(sentence.detail)}">${dot}${escapeHtml(word)}</p>`;
}

/** `said` is the fact alone; `detail` adds what the reviewer's Send does about it. */
function presenceSentence(state: StatusState): { said: string; detail: string } {
  if (state.turn.holder === "agent") {
    const said = agentTurnText(state.turn, state.items);
    return { said, detail: said };
  }
  const said = listeningText(state.agentWaiting);
  // Not "queued": on this page that is the Queue button's word, for pills the
  // reviewer can still take back, and this Send leaves the page for good.
  const then = state.agentWaiting
    ? "your next Send reaches it at once"
    : "Send anyway, it is handed over when the agent next listens";
  return { said, detail: `${said} — ${then}` };
}
