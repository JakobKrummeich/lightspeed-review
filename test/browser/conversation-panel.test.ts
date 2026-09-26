import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderCompose,
  renderPanel,
  renderScroll,
  QUEUE_LABEL,
  SEND_LABEL,
  type PanelState,
} from "../../src/browser/conversation-panel.ts";
import type { ConversationEntry, FeedbackPrompt, Turn } from "../../src/session-store.ts";

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

const REVIEWERS_TURN: Turn = { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" };
const AGENTS_TURN: Turn = { holder: "agent", mode: "digesting", at: "2025-01-01T00:06:00.000Z" };
const WORKING: Turn = { holder: "agent", mode: "working", at: "2025-01-01T00:07:00.000Z" };

const oneRound = [{ index: 0, at: "2025-01-01T00:00:00.000Z" }];
const twoRounds = [...oneRound, { index: 1, at: "2025-01-02T00:00:00.000Z" }];

function panelState(over: Partial<PanelState> = {}): PanelState {
  return {
    pending: [],
    conversation: [],
    rounds: oneRound,
    status: "open",
    allApproved: false,
    turn: REVIEWERS_TURN,
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

test("the agent's reply in a thread is shown, escaped, with the agent as its author", () => {
  const withId: FeedbackPrompt = { ...annotation, id: "t1" };
  const html = renderPanel(
    panelState({
      conversation: [
        { role: "reviewer", at: "2025-01-01T00:00:00.000Z", roundIndex: 0, prompts: [withId] },
        {
          role: "agent",
          at: "2025-01-01T00:06:00.000Z",
          roundIndex: 0,
          prompts: [{ type: "reply", thread: "t1", comment: "kept as-is <deliberately>" }],
        },
      ],
    }),
  );

  assert.match(html, /data-role="agent"/);
  assert.match(html, /kept as-is &lt;deliberately&gt;/, "the reply is escaped");
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
  const html = renderCompose({ status: "open", allApproved: false, turn: REVIEWERS_TURN });

  assert.match(html, /<textarea[^>]*id="lsr-general-comment"/);
  assert.match(html, /id="lsr-send"[^>]*>Send to Agent</);
  assert.doesNotMatch(html, /lsr-panel-scroll/);
  assert.doesNotMatch(html, /disabled/);
});

test("the label in the compose markup is the constant the panel patches back", () => {
  // The row is rendered once and patched in place: the in-flight label the mount writes must be
  // the same string this markup came out with.
  const html = renderCompose({ status: "open", allApproved: false, turn: REVIEWERS_TURN });

  assert.match(html, new RegExp(`id="lsr-send"[^>]*>${SEND_LABEL}<`));
});

test("while the agent works the primary button queues, and says so", () => {
  const html = renderCompose({ status: "open", allApproved: false, turn: WORKING });

  // The press parks the comment in the tray instead of being taken away.
  assert.match(html, new RegExp(`id="lsr-send"[^>]*>${QUEUE_LABEL}<`));
  assert.doesNotMatch(html, /id="lsr-send"[^>]*disabled/);
  assert.match(html, /placeholder="General comment — Enter queues…"/);
  assert.match(html, /Queued items go into the next round\./);
});

test("while the agent digests the compose row is locked, not queued, and says why", () => {
  const html = renderCompose({ status: "open", allApproved: false, turn: AGENTS_TURN });

  assert.match(html, /id="lsr-send"[^>]*disabled/);
  assert.match(html, /<textarea id="lsr-general-comment"[^>]*disabled/);
  assert.match(html, /placeholder="Locked while the agent reads your feedback"/);
  assert.match(
    html,
    /Locked while the agent reads your feedback — you can still read and approve\./,
  );
  // Ending is never locked but by the review being over.
  assert.doesNotMatch(html, /id="lsr-send-end"[^>]*disabled/);
});

test("on the reviewer's turn the primary button sends, and Enter says it sends", () => {
  const html = renderCompose({ status: "open", allApproved: false, turn: REVIEWERS_TURN });

  assert.match(html, new RegExp(`id="lsr-send"[^>]*>${SEND_LABEL}<`));
  assert.match(html, /placeholder="General comment — Enter sends…"/);
});

test("an ended review offers no queue, whoever held the turn when it ended", () => {
  const html = renderCompose({ status: "ended", allApproved: false, turn: AGENTS_TURN });

  assert.match(html, new RegExp(`id="lsr-send"[^>]*disabled[^>]*>${SEND_LABEL}<`));
});

test("a queued general comment is a pill in the tray, like a queued annotation", () => {
  const html = renderScroll(
    panelState({
      pending: [annotation, { type: "message", comment: "and the migration is missing" }],
      turn: AGENTS_TURN,
    }),
  );

  assert.equal(html.match(/class="lsr-pill"/g)?.length, 2);
  assert.match(html, /and the migration is missing/);
  assert.match(html, /class="lsr-pill-remove" data-index="1"/);
});

test("on the reviewer's turn the button counts the queue it is about to send", () => {
  const turn = { status: "open", allApproved: false, turn: REVIEWERS_TURN } as const;

  // Nothing else says the tray is still waiting once the turn comes back.
  assert.match(renderCompose(turn, 3), /id="lsr-send"[^>]*>Send 3 to Agent</);
  assert.match(renderCompose(turn, 0), new RegExp(`id="lsr-send"[^>]*>${SEND_LABEL}<`));
  assert.match(renderPanel(panelState({ pending: [annotation] })), />Send 1 to Agent</);
});

test("the count is the reviewer's to send: a working turn queues and an ended review shows none", () => {
  assert.match(
    renderCompose({ status: "open", allApproved: false, turn: WORKING }, 3),
    new RegExp(`id="lsr-send"[^>]*>${QUEUE_LABEL}<`),
  );
  // Locked, still counted: the number is what goes out once the turn is back.
  assert.match(
    renderCompose({ status: "open", allApproved: false, turn: AGENTS_TURN }, 3),
    /id="lsr-send"[^>]*disabled[^>]*>Send 3 to Agent</,
  );
  assert.match(
    renderCompose({ status: "ended", allApproved: false, turn: REVIEWERS_TURN }, 3),
    new RegExp(`id="lsr-send"[^>]*>${SEND_LABEL}<`),
  );
});

test("the compose row carries a polite, hidden region for what a Queue press did", () => {
  const html = renderCompose({ status: "open", allApproved: false, turn: AGENTS_TURN });

  assert.match(html, /<p id="lsr-queue-status" class="lsr-visually-hidden" role="status"><\/p>/);
});

test("an empty tray while the agent works points at the box as well as the diff", () => {
  const working = renderScroll(panelState({ turn: WORKING }));
  const reviewers = renderScroll(panelState());
  const digesting = renderScroll(panelState({ turn: AGENTS_TURN }));

  assert.match(working, /Nothing queued — select diff text, reply in a thread, or type below\./);
  // On the reviewer's turn the box sends rather than queues: pointing at it
  // from the queue would promise a pill that never appears.
  assert.match(
    reviewers,
    /Nothing queued — select diff text or reply in a thread to add feedback\./,
  );
  // Locked: nothing to point at.
  assert.match(digesting, /<p class="lsr-empty">Nothing queued\.<\/p>/);
});

test("an approved review says so above the button that finishes it", () => {
  const html = renderCompose({ status: "open", allApproved: true, turn: REVIEWERS_TURN });

  assert.match(html, /Every file is approved/);
  assert.ok(
    html.indexOf("Every file is approved") < html.indexOf(`id="lsr-send-end"`),
    "the sentence sits above the button it points at",
  );
});

test("the live region is in the markup whether or not it has anything to say", () => {
  // A role="status" element inserted with its text is announced by no screen reader reliably;
  // text arriving in an existing region is.
  const quiet = renderCompose({ status: "open", allApproved: false, turn: REVIEWERS_TURN });

  // Read off the tag, not one spelling of it: the claim is "there and empty", not attribute order.
  const region = /<p[^>]*role="status"[^>]*>([\s\S]*?)<\/p>/;
  assert.equal(region.exec(quiet)?.[1], "");
  assert.match(
    region.exec(renderCompose({ status: "open", allApproved: true, turn: REVIEWERS_TURN }))?.[1] ??
      "",
    /^Every file is approved/,
  );
});

test("an ended review is nudged toward nothing, whatever its ticks say", () => {
  const html = renderCompose({ status: "ended", allApproved: true, turn: REVIEWERS_TURN });

  assert.doesNotMatch(html, /Every file is approved/);
  assert.match(html, /This review has ended/);
});

test("an ended compose half refuses input on its own", () => {
  const html = renderCompose({ status: "ended", allApproved: false, turn: REVIEWERS_TURN });

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
  const html = renderScroll(panelState({ conversation: delivered, turn: AGENTS_TURN, items: 3 }));

  assert.match(html, /Agent is reading your 3 items/);
  assert.ok(
    html.indexOf("lsr-working") > html.indexOf("done, wrapped it"),
    "it waits where the next answer will be written, under everything said so far",
  );
  assert.ok(
    html.indexOf("lsr-working") < html.indexOf("lsr-queue"),
    "and inside the conversation rather than among the pills waiting to be sent",
  );
});

test("an agent at work on a plan says what it is working on at the foot", () => {
  const html = renderScroll(
    panelState({
      turn: {
        holder: "agent",
        mode: "working",
        at: "2025-01-01T00:07:00.000Z",
        note: "answering your question about the cache",
      },
    }),
  );

  assert.match(html, /<\/span>\s*Working on: answering your question about the cache\s*<\/p>/);
});

test("an agent at work with no plan says it is working on your feedback", () => {
  const html = renderScroll(
    panelState({ turn: { holder: "agent", mode: "working", at: "2025-01-01T00:07:00.000Z" } }),
  );

  assert.match(html, /Working on your feedback/);
});

test("the breathing dots are hidden from a reader the sentence already tells", () => {
  const html = renderScroll(panelState({ turn: AGENTS_TURN }));

  assert.match(html, /class="lsr-working-dots" aria-hidden="true"/);
});

test("nobody is said to be working when nobody is", () => {
  assert.doesNotMatch(renderScroll(panelState({ conversation: delivered })), /lsr-working/);
});

test("an ended review says nothing about work still going on", () => {
  // The agent may still be running when the review ends, but nobody here waits on it any more.
  const html = renderScroll(panelState({ status: "ended", turn: AGENTS_TURN }));

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

function entry(
  role: "reviewer" | "agent",
  at: string,
  prompts: FeedbackPrompt[],
): ConversationEntry {
  return { role, at, roundIndex: 0, prompts };
}

const t1: FeedbackPrompt = { ...annotation, id: "t1", side: "new", line_start: 3, line_end: 3 };
const t2: FeedbackPrompt = { type: "message", id: "t2", comment: "why a new table?" };

const exchange: ConversationEntry[] = [
  entry("reviewer", "2025-01-01T00:00:00.000Z", [t1, t2]),
  entry("agent", "2025-01-01T00:05:00.000Z", [
    { type: "reply", thread: "t2", comment: "to keep the old reads cheap" },
  ]),
  entry("reviewer", "2025-01-01T00:06:00.000Z", [
    { type: "reply", thread: "t2", comment: "and the writes?" },
  ]),
  entry("agent", "2025-01-01T00:07:00.000Z", [{ type: "reply", thread: "t2", comment: "batched" }]),
];

test("every item is a thread card named by its id, with its exchange stacked in time order", () => {
  const html = renderScroll(panelState({ conversation: exchange }));

  assert.equal(html.match(/<article class="lsr-thread"/g)?.length, 2);
  assert.match(html, /<span class="lsr-thread-id">t1<\/span>/);
  assert.match(html, /<span class="lsr-thread-id">t2<\/span>/);
  const order = ["why a new table?", "to keep the old reads cheap", "and the writes?", "batched"];
  const at = order.map((said) => html.indexOf(said));
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
    "the exchange reads top to bottom",
  );
  assert.ok(at.every((index) => index > html.indexOf("t2</span>")));
});

test("each message is its own block, never nested, and says who spoke", () => {
  const html = renderScroll(panelState({ conversation: exchange }));

  assert.equal(html.match(/<div class="lsr-message" data-role="agent">/g)?.length, 2);
  assert.equal(html.match(/<div class="lsr-message" data-role="reviewer">/g)?.length, 3);
  assert.match(html, /<p class="lsr-message-role">you<\/p>/);
  assert.match(html, /<p class="lsr-message-role">agent<\/p>/);
  assert.doesNotMatch(html, /lsr-message"[^]*?<div class="lsr-message"[^]*?<\/div>\s*<\/div>/);
});

test("a line thread keeps its jump to the lines and its quoted selection", () => {
  const html = renderScroll(panelState({ conversation: exchange }));

  assert.match(
    html,
    /class="lsr-prompt-file" data-file="src\/api\/users.ts" data-side="new" data-line="3"/,
  );
  assert.match(html, /<pre class="lsr-prompt-selection">\+const user = 1;<\/pre>/);
});

/** One card, from its id to the end of its article. */
function cardOf(html: string, id: string): string {
  const start = html.lastIndexOf(
    "<article",
    html.indexOf(`<span class="lsr-thread-id">${id}</span>`),
  );
  return html.slice(start, html.indexOf("</article>", start));
}

/** The box on its own row, so its placeholder has the card's width; the two presses in a row under it. */
test("a thread the agent answered last ends in a footer: reply box, then Reply and Resolve in one row", () => {
  const card = cardOf(renderScroll(panelState({ conversation: exchange })), "t2");

  assert.match(
    card,
    /<footer class="lsr-thread-foot">\s*<textarea class="lsr-thread-reply-box" data-thread="t2"[^>]*aria-label="Reply in t2"><\/textarea>\s*<div class="lsr-thread-actions">\s*<button type="button" class="lsr-thread-action lsr-thread-reply-add" data-thread="t2">Reply<\/button>\s*<button type="button" class="lsr-thread-action lsr-thread-resolve" data-thread="t2" aria-expanded="true">Resolve<\/button>\s*<\/div>\s*<\/footer>/,
  );
  assert.ok(card.indexOf("batched") < card.indexOf("lsr-thread-foot"));
  const head = card.slice(0, card.indexOf("</header>"));
  assert.doesNotMatch(head, /lsr-thread-resolve/, "Resolve left the header");
});

test("while the agent works the footer stays, since everything the reviewer writes queues", () => {
  const card = cardOf(renderScroll(panelState({ conversation: exchange, turn: WORKING })), "t2");

  assert.match(card, /lsr-thread-foot/);
  assert.match(card, />Resolve<\/button>/);
});

/** Nothing the reviewer could press is drawn: the page takes no writing now. */
test("while the agent digests, or once the review ended, an answered thread has no footer", () => {
  for (const over of [{ turn: AGENTS_TURN }, { status: "ended" as const }]) {
    const card = cardOf(renderScroll(panelState({ conversation: exchange, ...over })), "t2");

    assert.doesNotMatch(card, /lsr-thread-foot|lsr-thread-reply-box|lsr-thread-resolve/);
    assert.doesNotMatch(card, /Waiting for the agent/);
  }
});

/** The reviewer's own last word is the agent's to answer; a Reply there would only pile on. */
test("a thread the reviewer spoke in last waits quietly for the agent instead of a footer", () => {
  for (const turn of [REVIEWERS_TURN, AGENTS_TURN, WORKING]) {
    const card = cardOf(renderScroll(panelState({ conversation: exchange, turn })), "t1");

    assert.match(card, /<p class="lsr-thread-waiting">Waiting for the agent…<\/p>/, turn.holder);
    assert.doesNotMatch(card, /lsr-thread-foot|lsr-thread-reply-box|lsr-thread-resolve/);
  }
  const ended = cardOf(renderScroll(panelState({ conversation: exchange, status: "ended" })), "t1");
  assert.doesNotMatch(ended, /Waiting for the agent/);
});

test("a resolve toggle folds the whole thread to its head and a one-line summary", () => {
  const resolved = [
    ...exchange,
    entry("reviewer", "2025-01-01T00:08:00.000Z", [
      { type: "resolve", thread: "t2", resolved: true },
    ]),
  ];
  const html = renderScroll(panelState({ conversation: resolved }));

  assert.match(html, /data-resolved="true"/);
  assert.match(html, /<p class="lsr-thread-summary">why a new table\?<\/p>/);
  assert.match(
    cardOf(html, "t2"),
    /<footer class="lsr-thread-foot">\s*<div class="lsr-thread-actions">\s*<button type="button" class="lsr-thread-action lsr-thread-resolve" data-thread="t2" aria-expanded="false">Reopen<\/button>\s*<\/div>\s*<\/footer>/,
  );
  assert.doesNotMatch(html, /batched/, "the exchange is folded away");
  assert.doesNotMatch(html, /data-thread="t2" placeholder/, "and its reply box with it");
  assert.doesNotMatch(cardOf(html, "t2"), /Waiting for the agent/);
});

test("a resolved thread offers Reopen only while the reviewer can write", () => {
  const resolved = [
    ...exchange,
    entry("reviewer", "2025-01-01T00:08:00.000Z", [
      { type: "resolve", thread: "t2", resolved: true },
    ]),
  ];

  const working = renderScroll(panelState({ conversation: resolved, turn: WORKING }));
  assert.match(cardOf(working, "t2"), />Reopen<\/button>/);
  for (const over of [{ turn: AGENTS_TURN }, { status: "ended" as const }]) {
    const card = cardOf(renderScroll(panelState({ conversation: resolved, ...over })), "t2");
    assert.doesNotMatch(card, /lsr-thread-foot|Reopen/);
  }
});

test("a queued resolve folds the thread at once and says it goes with the next Send", () => {
  const html = renderScroll(
    panelState({
      conversation: exchange,
      pending: [{ type: "resolve", thread: "t2", resolved: true }],
    }),
  );

  assert.match(html, /resolves on your next Send/);
  assert.match(html, /<p class="lsr-thread-summary">why a new table\?<\/p>/);
  // The pill in the tray says the same, so it can be taken back.
  assert.match(html, /<p class="lsr-prompt-comment">resolve t2<\/p>/);
});

test("a queued reply names its thread in the tray", () => {
  const html = renderScroll(
    panelState({ pending: [{ type: "reply", thread: "t2", comment: "ok, go" }] }),
  );

  assert.match(html, /<span class="lsr-pill-thread">reply in t2<\/span>/);
  assert.match(html, /ok, go/);
});

/**
 * `main` is the agent speaking unprompted: each post is news on its own, and
 * one ever-growing card read as one old thread. The reviewer answers it from
 * the general comment box, so there is nothing to resolve and no reply box.
 */
test("each --to main post is its own card, with no resolve toggle and no reply box", () => {
  const html = renderScroll(
    panelState({
      conversation: [
        entry("agent", "2025-01-01T00:05:00.000Z", [
          { type: "reply", thread: "main", comment: "rebased on main first" },
        ]),
        entry("agent", "2025-01-01T00:09:00.000Z", [
          { type: "reply", thread: "main", comment: "and dropped the flag" },
        ]),
      ],
    }),
  );

  assert.equal(html.match(/<span class="lsr-thread-id">main<\/span>/g)?.length, 2);
  assert.ok(html.indexOf("rebased on main first") < html.indexOf("and dropped the flag"));
  assert.doesNotMatch(html, /data-thread="main"/);
});

/** The last Send, then the agent's words since: the part of the panel that is news. */
function sinceLastSend(): ConversationEntry[] {
  return [
    { role: "reviewer", at: "2025-01-01T00:00:00.000Z", roundIndex: 0, prompts: [t1, t2] },
    {
      role: "reviewer",
      at: "2025-01-01T00:06:00.000Z",
      roundIndex: 0,
      prompts: [{ type: "resolve", thread: "t1", resolved: true }],
    },
    {
      role: "agent",
      at: "2025-01-02T00:03:00.000Z",
      roundIndex: 1,
      prompts: [{ type: "reply", thread: "main", comment: "pushed the retry change" }],
    },
    {
      role: "agent",
      at: "2025-01-02T00:05:00.000Z",
      roundIndex: 1,
      prompts: [{ type: "reply", thread: "t1", comment: "one more thing on this" }],
    },
  ];
}

test("the agent answering in a resolved thread unfolds it, marked new", () => {
  const html = renderScroll(panelState({ conversation: sinceLastSend(), rounds: twoRounds }));

  const t1Card = html.slice(html.indexOf("t1</span>"));
  assert.match(
    html,
    /<article class="lsr-thread" data-round-state="current" data-resolved="false" data-new="true">\s*<header class="lsr-thread-head"><span class="lsr-thread-id">t1/,
  );
  assert.match(t1Card, /one more thing on this/);
  assert.match(t1Card, /<span class="lsr-thread-new">new<\/span>/);
});

/**
 * Left where the thread opened, an answer in an old thread sat rounds above
 * the fold. Surfaced at the foot, latest activity last, as a chat reads.
 */
test("threads the agent spoke in since the last Send move to the current round, latest last", () => {
  const html = renderScroll(panelState({ conversation: sinceLastSend(), rounds: twoRounds }));

  const current = html.indexOf('data-round-state="current" role="separator"');
  const order = ["why a new table?", "pushed the retry change", "one more thing on this"].map(
    (said) => html.indexOf(said),
  );
  assert.ok(order[0]! < current, "t2 has nothing new and stays in round 1");
  assert.ok(current < order[1]! && order[1]! < order[2]!, "main, then t1, by latest activity");
  const t2Card = html.slice(html.indexOf("t2</span>"), html.indexOf("t2</span>") + 300);
  assert.doesNotMatch(t2Card, /lsr-thread-new/);
});

/** 2.x said things before items had ids: readable, but there is no id to answer in. */
test("words from before items had ids are shown read-only", () => {
  const legacy: FeedbackPrompt = {
    type: "message",
    comment: "should the retry be per-request or per-batch?",
    kind: "question",
  };
  const html = renderScroll(
    panelState({ conversation: [entry("agent", "2025-01-01T00:05:00.000Z", [legacy])] }),
  );

  assert.match(html, /data-legacy="true"/);
  assert.match(html, /per-request or per-batch/);
  assert.doesNotMatch(html, /lsr-thread-reply-box|lsr-thread-resolve|lsr-thread-id/);
});

test("a thread escapes like everything else either side writes", () => {
  const html = renderScroll(
    panelState({
      conversation: [
        entry("reviewer", "2025-01-01T00:00:00.000Z", [
          { type: "message", id: "t1", comment: "<script>alert(1)</script>" },
        ]),
        entry("agent", "2025-01-01T00:05:00.000Z", [
          { type: "reply", thread: "t1", comment: "<SCRIPT src=x>" },
        ]),
      ],
    }),
  );

  // Case-insensitive and open-ended: a regexp that only knows the exact lower-case
  // tag would pass while the panel served `<SCRIPT>` or `<script src=x>`.
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;/);
});

test("threads are placed by the round they opened in", () => {
  const html = renderScroll(
    panelState({
      rounds: twoRounds,
      conversation: [
        ...exchange,
        {
          role: "reviewer",
          at: "2025-01-02T00:01:00.000Z",
          roundIndex: 1,
          prompts: [{ type: "message", id: "t3", comment: "one more" }],
        },
      ],
    }),
  );

  const round2 = html.indexOf("Round 2");
  assert.ok(html.indexOf("t2</span>") < round2 && round2 < html.indexOf("t3</span>"));
});
