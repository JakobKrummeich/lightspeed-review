import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderCompose,
  renderPanel,
  renderScroll,
  SEND_LABEL,
  type PanelState,
} from "../../src/browser/conversation-panel.ts";
import type { ConversationEntry, FeedbackPrompt } from "../../src/session-store.ts";

const annotation: FeedbackPrompt = {
  type: "annotation",
  file: "src/api/users.ts",
  group: "API",
  selected_text: "+const user = 1;",
  comment: "wrap in a transaction",
};

const delivered: ConversationEntry[] = [
  { role: "reviewer", at: "2025-01-01T00:00:00.000Z", roundIndex: 0, prompts: [annotation] },
  {
    role: "agent",
    at: "2025-01-01T00:05:00.000Z",
    roundIndex: 0,
    prompts: [{ type: "message", comment: "done, wrapped it" }],
  },
];

const oneRound = [{ index: 0, at: "2025-01-01T00:00:00.000Z" }];
const twoRounds = [...oneRound, { index: 1, at: "2025-01-02T00:00:00.000Z" }];

/** A panel with nothing in it, and whichever of those the test is about. */
function panelState(over: Partial<PanelState> = {}): PanelState {
  return {
    pending: [],
    conversation: [],
    rounds: oneRound,
    status: "open",
    allApproved: false,
    agentWorking: false,
    ...over,
  };
}

test("shows a queued annotation as a pill with its file and comment", () => {
  const html = renderPanel(panelState({ pending: [annotation] }));

  assert.match(html, /lsr-pill/);
  assert.match(html, /src\/api\/users.ts/);
  assert.match(html, /wrap in a transaction/);
});

test("says the queue is empty rather than showing a blank panel", () => {
  const html = renderPanel(panelState());

  assert.match(html, /nothing queued/i);
});

test("renders delivered conversation entries with their author", () => {
  const html = renderPanel(panelState({ conversation: delivered }));

  assert.match(html, /data-role="reviewer"/);
  assert.match(html, /data-role="agent"/);
  assert.match(html, /done, wrapped it/);
});

test("the agent's answer to a specific comment appears under that comment", () => {
  // `poll --for --note` answers one comment by id; the panel must show the declaration with the
  // words it answers, not only in the replay.
  const withId: FeedbackPrompt = { ...annotation, id: "evt_1" };
  const other: FeedbackPrompt = { ...annotation, id: "evt_2", comment: "rename this" };
  const html = renderPanel(
    panelState({
      conversation: [
        {
          role: "reviewer",
          at: "2025-01-01T00:00:00.000Z",
          roundIndex: 0,
          prompts: [withId, other],
        },
      ],
      declarations: {
        evt_1: { note: "kept as-is <deliberately>", files: [], at: "2025-01-01T00:06:00.000Z" },
      },
    }),
  );

  const prompts = html.split('lsr-prompt"');
  assert.equal(prompts.length, 3, "expected two prompts in the card");
  assert.match(prompts[1] ?? "", /lsr-prompt-answer/);
  assert.match(prompts[1] ?? "", /the agent's answer/);
  assert.match(prompts[1] ?? "", /kept as-is &lt;deliberately&gt;/, "the note is escaped");
  assert.doesNotMatch(prompts[2] ?? "", /lsr-prompt-answer/, "the unanswered comment stays bare");
});

test("a declaration without a note, or without a matching id, adds nothing", () => {
  const withId: FeedbackPrompt = { ...annotation, id: "evt_1" };
  const html = renderPanel(
    panelState({
      conversation: [
        { role: "reviewer", at: "2025-01-01T00:00:00.000Z", roundIndex: 0, prompts: [withId] },
      ],
      // Files-only declaration for this comment; a note for a comment not here.
      declarations: {
        evt_1: { files: ["src/api/users.ts"], at: "2025-01-01T00:06:00.000Z" },
        evt_9: { note: "about someone else", files: [], at: "2025-01-01T00:06:00.000Z" },
      },
    }),
  );

  assert.doesNotMatch(html, /lsr-prompt-answer/);
  assert.doesNotMatch(html, /about someone else/);
});

test("offers a general comment box and both send buttons while the session is open", () => {
  const html = renderPanel(panelState());

  assert.match(html, /<textarea[^>]*id="lsr-general-comment"/);
  assert.match(html, /id="lsr-send"[^>]*>Send to Agent</);
  assert.match(html, /id="lsr-send-end"[^>]*>Send &amp; End</);
});

test("an ended session disables sending and says so", () => {
  const html = renderPanel(panelState({ conversation: delivered, status: "ended" }));

  assert.match(html, /id="lsr-send"[^>]*disabled/);
  assert.match(html, /id="lsr-send-end"[^>]*disabled/);
  assert.match(html, /ended/i);
});

test("escapes reviewer text so a comment cannot inject markup", () => {
  const evil: FeedbackPrompt = { type: "message", comment: '<img src=x onerror="alert(1)">' };

  const html = renderPanel(panelState({ pending: [evil] }));

  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("a queued pill carries the index that removes it", () => {
  const html = renderPanel(
    panelState({ pending: [annotation, { type: "message", comment: "looks good" }] }),
  );

  assert.match(html, /class="lsr-pill-remove" data-index="0"/);
  assert.match(html, /class="lsr-pill-remove" data-index="1"/);
});

test("a pill that outlived its round wears a badge naming the round it was queued in", () => {
  const html = renderScroll(
    panelState({ pending: [{ ...annotation, round: 0 }], rounds: twoRounds }),
  );

  assert.match(html, /class="lsr-pill-round"[^>]*>round 1</);
  assert.match(html, /may not line up/i, "the badge explains itself to hover and screen reader");
});

test("a pill queued in the round on screen wears no badge", () => {
  const html = renderScroll(
    panelState({ pending: [{ ...annotation, round: 1 }], rounds: twoRounds }),
  );

  assert.doesNotMatch(html, /lsr-pill-round/);
});

test("a pill with no stamp wears no badge — absence is not a guess", () => {
  const html = renderScroll(panelState({ pending: [annotation], rounds: twoRounds }));

  assert.doesNotMatch(html, /lsr-pill-round/);
});

test("the panel scrolls its history separately from the pinned compose box", () => {
  const html = renderPanel(panelState());
  const scroll = html.indexOf(`<div class="lsr-panel-scroll">`);
  const compose = html.indexOf(`<section class="lsr-compose">`);
  assert.ok(scroll >= 0, "history and queue share one scroll container");
  assert.ok(compose > html.indexOf("</div>"), "compose sits outside the scroll container");
  assert.ok(scroll < compose, "the scroll container comes first");
});

test("the redrawn half holds the history and the queue and nothing the reviewer types into", () => {
  const html = renderScroll(panelState({ pending: [annotation], conversation: delivered }));

  assert.match(html, /data-role="reviewer"/);
  assert.match(html, /lsr-pill/);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /id="lsr-send"/);
});

test("the compose half is rendered on its own so a redraw never has to touch it", () => {
  const html = renderCompose({ status: "open", allApproved: false });

  assert.match(html, /<textarea[^>]*id="lsr-general-comment"/);
  assert.match(html, /id="lsr-send"[^>]*>Send to Agent</);
  assert.doesNotMatch(html, /lsr-panel-scroll/);
  assert.doesNotMatch(html, /disabled/);
});

test("the label in the compose markup is the constant the panel patches back", () => {
  // The row is rendered once and patched in place: the in-flight label the mount writes must be
  // the same string this markup came out with.
  const html = renderCompose({ status: "open", allApproved: false });

  assert.match(html, new RegExp(`id="lsr-send"[^>]*>${SEND_LABEL}<`));
});

test("an approved review says so above the button that finishes it", () => {
  const html = renderCompose({ status: "open", allApproved: true });

  assert.match(html, /Every file is approved/);
  assert.ok(
    html.indexOf("Every file is approved") < html.indexOf(`id="lsr-send-end"`),
    "the sentence sits above the button it points at",
  );
});

test("the live region is in the markup whether or not it has anything to say", () => {
  // A role="status" element inserted with its text is announced by no screen reader reliably;
  // text arriving in an existing region is.
  const quiet = renderCompose({ status: "open", allApproved: false });

  // Read off the tag, not one spelling of it: the claim is "there and empty", not attribute order.
  const region = /<p[^>]*role="status"[^>]*>([\s\S]*?)<\/p>/;
  assert.equal(region.exec(quiet)?.[1], "");
  assert.match(
    region.exec(renderCompose({ status: "open", allApproved: true }))?.[1] ?? "",
    /^Every file is approved/,
  );
});

test("an ended review is nudged toward nothing, whatever its ticks say", () => {
  const html = renderCompose({ status: "ended", allApproved: true });

  assert.doesNotMatch(html, /Every file is approved/);
  assert.match(html, /This review has ended/);
});

test("an ended compose half refuses input on its own", () => {
  const html = renderCompose({ status: "ended", allApproved: false });

  assert.match(html, /<textarea[^>]*disabled/);
  assert.match(html, /id="lsr-send"[^>]*disabled/);
  assert.match(html, /id="lsr-send-end"[^>]*disabled/);
  assert.match(html, /ended/i);
});

test("a single-round review is not ruled into rounds it does not have", () => {
  const html = renderScroll(panelState({ conversation: delivered }));

  assert.doesNotMatch(html, /lsr-round-mark/);
  assert.doesNotMatch(html, /Round 1/);
});

test("a second round rules a labelled line across the conversation", () => {
  const html = renderScroll(
    panelState({
      conversation: [
        ...delivered,
        { role: "reviewer", at: "2025-01-02T00:01:00.000Z", roundIndex: 1, prompts: [annotation] },
      ],
      rounds: twoRounds,
    }),
  );

  assert.match(html, /class="lsr-round-mark"[^>]*data-round-state="earlier"[\s\S]*?Round 1/);
  assert.match(html, /class="lsr-round-mark"[^>]*data-round-state="current"[\s\S]*?Round 2/);
  assert.ok(
    html.indexOf("Round 1") < html.indexOf("done, wrapped it"),
    "a round's line comes before the messages it labels",
  );
  assert.match(html, /reviewing now/);
});

test("an entry says which round it belongs to, so an old one can be told apart", () => {
  const html = renderScroll(
    panelState({
      conversation: [
        ...delivered,
        { role: "agent", at: "2025-01-02T00:01:00.000Z", roundIndex: 1, prompts: [annotation] },
      ],
      rounds: twoRounds,
    }),
  );
  // Read off the tag, not one spelling of it: the attribution is the claim, not attribute order.
  const states = [...html.matchAll(/<article[^>]*data-round-state="(\w+)"/g)].map(
    ([, state]) => state,
  );

  assert.deepEqual(states, ["earlier", "earlier", "current"]);
});

test("a fresh round with nothing said in it still marks where the old talk ends", () => {
  const html = renderScroll(panelState({ conversation: delivered, rounds: twoRounds }));

  assert.match(html, /data-round-state="current"[\s\S]*?Round 2/);
  assert.ok(
    html.indexOf("Round 2") > html.indexOf("done, wrapped it"),
    "the empty round's line sits under everything said before it",
  );
});

test("the round line is a separator to a screen reader, named as one", () => {
  const html = renderScroll(panelState({ conversation: delivered, rounds: twoRounds }));

  assert.match(html, /role="separator"/);
  assert.match(html, /aria-label="Round 2, reviewing now"/);
});

test("an agent away with the feedback is said at the foot of the conversation", () => {
  const html = renderScroll(panelState({ conversation: delivered, agentWorking: true }));

  assert.match(html, /the agent is working on your feedback/);
  assert.ok(
    html.indexOf("lsr-working") > html.indexOf("done, wrapped it"),
    "it waits where the next answer will be written, under everything said so far",
  );
  assert.ok(
    html.indexOf("lsr-working") < html.indexOf("lsr-queue"),
    "and inside the conversation rather than among the pills waiting to be sent",
  );
});

test("the breathing dots are hidden from a reader the sentence already tells", () => {
  const html = renderScroll(panelState({ agentWorking: true }));

  assert.match(html, /class="lsr-working-dots" aria-hidden="true"/);
});

test("nobody is said to be working when nobody is", () => {
  assert.doesNotMatch(renderScroll(panelState({ conversation: delivered })), /lsr-working/);
});

test("an ended review says nothing about work still going on", () => {
  // The agent may still be running when the review ends, but nobody here waits on it any more.
  const html = renderScroll(panelState({ status: "ended", agentWorking: true }));

  assert.doesNotMatch(html, /lsr-working/);
});

test("one send button is the primary action and the other is secondary", () => {
  const html = renderPanel(panelState());
  assert.match(html, /id="lsr-send" class="lsr-primary"/);
  assert.match(html, /id="lsr-send-end" class="lsr-secondary"/);
});

test("a comment names its file by basename, as a press that leads back to the lines", () => {
  const anchored: FeedbackPrompt = {
    ...annotation,
    side: "new",
    line_start: 12,
    line_end: 14,
  };

  const html = renderPanel(
    panelState({ conversation: [{ ...delivered[0]!, prompts: [anchored] }] }),
  );

  assert.match(
    html,
    /<button type="button" class="lsr-prompt-file" data-file="src\/api\/users.ts" data-side="new" data-line="12" title="src\/api\/users.ts">users.ts<\/button>/,
  );
});

test("a comment queued before any anchor existed is still a press, just without one", () => {
  const html = renderPanel(panelState({ pending: [annotation] }));

  assert.match(
    html,
    /<button type="button" class="lsr-prompt-file" data-file="src\/api\/users.ts" title="src\/api\/users.ts">users.ts<\/button>/,
  );
});

test("the chapter name is not repeated under every comment", () => {
  const html = renderPanel(panelState({ pending: [annotation], conversation: delivered }));

  assert.doesNotMatch(html, /lsr-prompt-group/);
  assert.doesNotMatch(html, /class="lsr-prompt-file"[^>]*>API/);
});

test("comments in one card stand apart: each prompt is its own block", () => {
  const html = renderPanel(panelState({ conversation: delivered }));

  assert.match(html, /<div class="lsr-prompt">/);
});
