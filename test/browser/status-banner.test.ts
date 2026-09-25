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
const READING: Turn = { holder: "agent", mode: "digesting", at: "2025-01-01T00:06:00.000Z" };

function banner(over: Partial<StatusState> = {}): StatusState {
  return { status: "open", agentWaiting: false, turn: REVIEWERS, review, ...over };
}

/** The store's status word ("FEEDBACK" in the header's corner) is not news to
 * the reviewer: the presence label says whose move it is, whatever the status. */
test("says no status word beside the presence label, in any status", () => {
  for (const status of ["open", "feedback"] as const) {
    const html = renderStatusBanner(banner({ status, agentWaiting: true }));

    assert.doesNotMatch(html, /lsr-status|data-status/, `a ${status} session shows a status line`);
    assert.doesNotMatch(html, new RegExp(`>${status}<`), `a ${status} session says its status`);
    assert.equal(presenceText(html), "Agent is listening");
  }
  const ended = renderStatusBanner(banner({ status: "ended" }));
  assert.doesNotMatch(ended, /lsr-status|>ended</, "an ended review says so only in its overlay");
});

/** What the header shows, as opposed to what its tooltip carries. */
function presenceText(html: string): string | undefined {
  return /<p class="lsr-presence"[^>]*>([^<]*)<\/p>/.exec(html)?.[1]?.replaceAll("&#39;", "'");
}

function presenceTitle(html: string): string | undefined {
  return /<p class="lsr-presence"[^>]*title="([^"]*)"/.exec(html)?.[1];
}

/** A fact about a live connection, never a timer. */
test("says the agent is listening while an agent polls on the reviewer's turn", () => {
  const html = renderStatusBanner(banner({ agentWaiting: true }));

  assert.match(html, /data-waiting="true"/);
  assert.equal(presenceText(html), "Agent is listening");
  assert.equal(presenceTitle(html), "an agent is listening: your next Send reaches it at once");
});

test("says the agent isn't listening when no agent polls, rather than hiding the fact", () => {
  const html = renderStatusBanner(banner({ agentWaiting: false }));

  assert.match(html, /data-waiting="false"/);
  assert.equal(presenceText(html), "Agent isn't listening");
});

/** It does not say "queued": that is the Queue button's word, and this Send leaves the page. */
test("keeps the send-anyway advice in the tooltip when nobody is listening", () => {
  const html = renderStatusBanner(banner({ agentWaiting: false }));

  assert.equal(
    presenceTitle(html),
    "no agent is listening — Send anyway, it is handed over when the agent next listens",
  );
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

test("does not claim an agent is listening on an ended review", () => {
  const html = renderStatusBanner(banner({ status: "ended", agentWaiting: true }));

  assert.doesNotMatch(html, /listening/i);
});

test("says how many items the agent is reading while it digests", () => {
  const html = renderStatusBanner(banner({ turn: READING, items: 5 }));

  assert.match(html, /data-turn="agent"/);
  assert.equal(presenceText(html), "Agent is reading your 5 items");
  assert.equal(
    presenceText(renderStatusBanner(banner({ turn: READING, items: 1 }))),
    "Agent is reading your 1 item",
  );
});

test("a digesting turn with no count said reads as your feedback", () => {
  const html = renderStatusBanner(banner({ turn: READING }));

  assert.equal(presenceText(html), "Agent is reading your feedback");
});

/** The whole sentence in the header; the corner cuts it with an ellipsis, the tooltip has it all. */
test("a declared plan is what the header says it is working on", () => {
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

  assert.equal(presenceText(html), "Working on: splitting the helper out");
  assert.equal(presenceTitle(html), "Working on: splitting the helper out");
});

test("work with no plan says it is working on your feedback", () => {
  const html = renderStatusBanner(
    banner({ turn: { holder: "agent", mode: "working", at: "2025-01-01T00:07:00.000Z" } }),
  );

  assert.equal(presenceText(html), "Working on your feedback");
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

test("the turn beats listening, since what became of the feedback is the news", () => {
  // A second agent parked listening while the first is off digesting says
  // nothing the reviewer can act on; what became of their feedback does.
  const html = renderStatusBanner(banner({ agentWaiting: true, turn: READING, items: 2 }));

  assert.equal(presenceText(html), "Agent is reading your 2 items");
  assert.doesNotMatch(html, /listening/i);
});

test("does not claim an agent is working on an ended review", () => {
  const html = renderStatusBanner(banner({ status: "ended", turn: READING }));

  assert.doesNotMatch(html, /agent is reading/i);
  assert.doesNotMatch(html, /working on/i);
});
