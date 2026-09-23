import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatusBanner, type StatusState } from "../../src/browser/status-banner.ts";
import type { ClosedReview } from "../../src/browser/closing-summary.ts";
import type { Turn } from "../../src/session-store.ts";

const review: ClosedReview = {
  groups: [
    {
      name: "Auth",
      rationale: "why auth",
      files: [
        {
          path: "src/auth.ts",
          status: "modified",
          diff: "",
          insertions: 4,
          deletions: 1,
          oversized: false,
        },
      ],
    },
  ],
  conversation: [],
  rounds: [{ index: 0, at: "2025-01-01T00:00:00.000Z" }],
  approved: ["src/auth.ts"],
  endedBy: "reviewer",
};

const REVIEWERS: Turn = { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" };
const READING: Turn = { holder: "agent", mode: "reading", at: "2025-01-01T00:06:00.000Z" };

function banner(over: Partial<StatusState> = {}): StatusState {
  return { status: "open", agentWaiting: false, turn: REVIEWERS, review, ...over };
}

test("shows the session status", () => {
  const html = renderStatusBanner(banner({ agentWaiting: false }));

  assert.match(html, /data-status="open"/);
  assert.match(html, />open</);
});

/** What the header shows, as opposed to what its tooltip carries. */
function presenceText(html: string): string | undefined {
  return /<p class="lsr-presence"[^>]*>([^<]*)<\/p>/.exec(html)?.[1];
}

function presenceTitle(html: string): string | undefined {
  return /<p class="lsr-presence"[^>]*title="([^"]*)"/.exec(html)?.[1];
}

/** Not "Agent is waiting": beside "Agent is working" that read as the same
 * news, when one is the reviewer's move and the other is not. */
test("says the move is the reviewer's while an agent polls", () => {
  const html = renderStatusBanner(banner({ agentWaiting: true }));

  assert.match(html, /data-waiting="true"/);
  assert.equal(presenceText(html), "Waiting for your feedback");
  assert.equal(presenceTitle(html), "an agent is waiting for your feedback");
});

test("says nobody is waiting when no agent polls, rather than hiding the fact", () => {
  const html = renderStatusBanner(banner({ agentWaiting: false }));

  assert.match(html, /data-waiting="false"/);
  assert.equal(presenceText(html), "No agent is waiting");
});

/** The queued-anyway advice is said nowhere else on the page, so the short
 * label keeps it one hover away rather than dropping it. */
test("keeps the send-anyway advice in the tooltip when nobody is waiting", () => {
  const html = renderStatusBanner(banner({ agentWaiting: false }));

  assert.equal(presenceTitle(html), "no agent is waiting — send anyway, the feedback is queued");
});

test("covers the page with what the review came to once it is closed", () => {
  const html = renderStatusBanner(banner({ status: "ended" }));

  assert.match(html, /lsr-ended-overlay/);
  assert.match(html, /All 1 file approved\./);
  assert.match(html, /You ended this review\./);
  // The reviewer never touches the CLI, so no command is suggested to them.
  assert.doesNotMatch(html, /lightspeed/);
});

test("shows no overlay while the review is still open", () => {
  const html = renderStatusBanner(banner({ agentWaiting: false }));

  assert.doesNotMatch(html, /lsr-ended-overlay/);
});

test("does not claim an agent is waiting on an ended review", () => {
  const html = renderStatusBanner(banner({ status: "ended", agentWaiting: true }));

  assert.doesNotMatch(html, /waiting for your feedback/i);
});

/** The header is a corner, not a sentence: the detail is written at the foot
 * of the conversation, and a long plan in the header only got cut off there. */
test("says only that the agent is working once the turn is the agent's", () => {
  const html = renderStatusBanner(banner({ turn: READING }));

  assert.match(html, /data-turn="agent"/);
  assert.equal(presenceText(html), "Agent is working");
});

test("a declared plan stays out of the header text, one hover away in the tooltip", () => {
  const html = renderStatusBanner(
    banner({
      turn: {
        holder: "agent",
        mode: "working",
        at: "2025-01-01T00:07:00.000Z",
        note: "splitting the helper out",
      },
    }),
  );

  assert.equal(presenceText(html), "Agent is working");
  assert.equal(presenceTitle(html), "implementing: splitting the helper out");
});

test("work with no plan says the same short thing", () => {
  const html = renderStatusBanner(
    banner({ turn: { holder: "agent", mode: "working", at: "2025-01-01T00:07:00.000Z" } }),
  );

  assert.equal(presenceText(html), "Agent is working");
  assert.equal(presenceTitle(html), "the agent is implementing your feedback");
});

test("a plan cannot inject markup into the header", () => {
  const html = renderStatusBanner(
    banner({
      turn: {
        holder: "agent",
        mode: "working",
        at: "2025-01-01T00:07:00.000Z",
        note: '"><script>alert(1)</script>',
      },
    }),
  );

  // Case-insensitive and open-ended: a regexp that only knows the exact lower-case
  // tag would pass while the banner served `<SCRIPT>` or `<script src=x>`.
  assert.doesNotMatch(html, /<script/i);
  // The quote is what would break out of the tooltip attribute.
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});

test("the turn beats waiting, since what became of the feedback is the news", () => {
  // A second agent parked on the wait while the first is off working says
  // nothing the reviewer can act on; what became of their feedback does.
  const html = renderStatusBanner(banner({ agentWaiting: true, turn: READING }));

  assert.equal(presenceText(html), "Agent is working");
  assert.doesNotMatch(html, /waiting for your feedback/i);
});

test("does not claim an agent is working on an ended review", () => {
  const html = renderStatusBanner(banner({ status: "ended", turn: READING }));

  assert.doesNotMatch(html, /agent is working/i);
  assert.doesNotMatch(html, /has your feedback/i);
});
