import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as tick } from "node:timers/promises";
import { mountPanel } from "../../../src/browser/dom/panel-mount.ts";
import type { SessionData } from "../../../src/browser/dom/session-api.ts";
import type {
  AnnotationPrompt,
  ConversationEntry,
  FeedbackPrompt,
  SessionStatus,
  Turn,
} from "../../../src/session-store.ts";
import { keydown } from "./fake-keys.ts";
import { asPanelRoot, FakeNode, installFakeElements, type FakeWindow } from "./fake-panel-dom.ts";
import { FakeStorage } from "../fake-storage.ts";
import { readMemory, updateMemory } from "../../../src/browser/review-memory.ts";
import { SAVE_DELAY_MS } from "../../../src/browser/dom/save-later.ts";

const REVIEWERS: Turn = { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" };
const READING: Turn = { holder: "agent", mode: "digesting", at: "2025-01-01T00:06:00.000Z" };

const working = (note: string): Turn => ({
  holder: "agent",
  mode: "working",
  at: "2025-01-01T00:07:00.000Z",
  note,
});

const WORKING = working("rewriting the parser");

const annotation: FeedbackPrompt = {
  type: "annotation",
  file: "src/api/users.ts",
  group: "API",
  selected_text: "+const user = 1;",
  comment: "wrap in a transaction",
};

const reply: ConversationEntry = {
  role: "agent",
  at: "2025-01-01T00:05:00.000Z",
  // Posted to `main`, so it is news the column shows open rather than folded-away history.
  prompts: [{ type: "reply", thread: "main", comment: "wrapped it in a transaction" }],
};

function session(over: Partial<SessionData> = {}): SessionData {
  // Assigned rather than spread: a `Partial` spread widens fields to `| undefined`, which SessionData refuses.
  const base: SessionData = {
    intents: [],
    commits: [],
    groups: [],
    approved: [],
    approval: {},
    conversation: [],
    rounds: [{ index: 0, at: "2025-01-01T00:00:00.000Z" }],
    pending: [],
    status: "open" as SessionStatus,
    turn: { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" },
  };
  return Object.assign(base, over);
}

function mount(
  t: TestContext,
  initial: SessionData = session(),
  storage: FakeStorage = new FakeStorage(),
  onJump: (
    file: string,
    anchor: { side: "old" | "new"; line: number } | undefined,
  ) => void = () => {},
): {
  root: FakeNode;
  panel: ReturnType<typeof mountPanel>;
  box: () => FakeNode | null;
  storage: FakeStorage;
  page: FakeWindow;
  ended: () => boolean;
} {
  // Clicks are checked against HTMLElement, so it is installed here rather than by each clicking
  // test — forgetting is a ReferenceError inside a listener.
  const page = installFakeElements((undo) => t.after(undo));
  const root = new FakeNode();
  let ended = false;
  const panel = mountPanel({
    root: asPanelRoot(root),
    key: "key",
    session: initial,
    storage,
    onEnd: () => {
      ended = true;
    },
    onPending: () => {},
    onJump,
  });
  return {
    root,
    panel,
    storage,
    page,
    box: () => root.querySelector("#lsr-general-comment"),
    ended: () => ended,
  };
}

/** What the tray counts: every queued pill, wherever the column draws it. */
function queuedIn(root: FakeNode): number {
  const count = root.querySelector(".lsr-queue-count")?.textContent ?? "";
  return Number(/^(\d+)/.exec(count)?.[1] ?? 0);
}

function type(root: FakeNode, box: FakeNode, text: string): void {
  box.value = text;
  root.dispatch("input", { target: box });
}

/** Long enough for a put-off write to have run. */
const stored = (): Promise<void> => tick(SAVE_DELAY_MS + 20);

interface SentFeedback {
  path: string;
  prompts: FeedbackPrompt[];
  ended: boolean;
}

function stubFetch(t: TestContext): SentFeedback[] {
  const sent: SentFeedback[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Omit<SentFeedback, "path">;
    sent.push({ path: String(input), ...body });
    return new Response(null, { status: 204 });
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return sent;
}

test("an agent reply leaves the half-written comment and its textarea untouched", (t) => {
  const { root, panel, box } = mount(t);
  const typing = box();
  assert.ok(typing, "the compose box is mounted");
  typing.value = "this rename is wrong beca";

  panel.update(session({ conversation: [reply] }));

  assert.equal(box(), typing, "the reviewer keeps typing into the very same element");
  assert.equal(typing.value, "this rename is wrong beca");
  assert.match(
    root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "",
    /wrapped it in a transaction/,
  );
});

test("a reply arriving with an update is drawn live", (t) => {
  // `reply` publishes a session change; the redraw must show it live, not only
  // on the next visit's mount.
  const { root, panel } = mount(t);
  const asked: ConversationEntry = {
    role: "reviewer",
    at: "2025-01-01T00:00:00.000Z",
    roundIndex: 0,
    prompts: [
      {
        type: "annotation",
        id: "t7",
        file: "src/api/users.ts",
        group: "API",
        selected_text: "+const user = 1;",
        comment: "wrap in a transaction",
      },
    ],
  };

  const answered: ConversationEntry = {
    role: "agent",
    at: "2025-01-01T01:00:00.000Z",
    roundIndex: 0,
    prompts: [{ type: "reply", thread: "t7", comment: "held as designed" }],
  };

  panel.update(session({ conversation: [asked, answered] }));

  const scroll = root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "";
  assert.match(scroll, /held as designed/);
});

/** A panel taller than its box, with the reader parked wherever `at` says. */
function scrolledTo(root: FakeNode, at: number): FakeNode {
  const host = root.querySelector(".lsr-panel-scroll")!;
  Object.assign(host, { scrollHeight: 1000, clientHeight: 200, scrollTop: at });
  return host;
}

test("a reply arriving while the reviewer reads the live end keeps them at it", (t) => {
  const { root, panel } = mount(t);
  const host = scrolledTo(root, 800);

  panel.update(session({ conversation: [reply] }));

  assert.equal(host.scrollTop, host.scrollHeight, "the newest talk is what stays on screen");
});

test("an agent taking the feedback away is said at the foot of the conversation", (t) => {
  const { root, panel } = mount(t);

  panel.setTurn(READING, 2);

  assert.match(
    root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "",
    /Agent is reading your 2 items/,
    "the marker stands where the answer will be written",
  );

  panel.setTurn(REVIEWERS);

  assert.doesNotMatch(
    root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "",
    /lsr-working/,
    "the agent handed the turn back, so nobody is working",
  );
});

test("the agent's declared plan is what the foot of the conversation says", (t) => {
  const { root, panel } = mount(t);

  panel.setTurn(working("splitting the transaction helper out"));

  assert.match(
    root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "",
    /<\/span>\s*Working on: splitting the transaction helper out\s*<\/p>/,
  );
});

test("a plan out of a hand-edited session is escaped like any other text", (t) => {
  const { root, panel } = mount(t);

  panel.setTurn(working("<img src=x onerror=alert(1)>"));

  assert.doesNotMatch(root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "", /<img/);
});

test("the working marker arrives on screen rather than just below the fold", (t) => {
  const { root, panel } = mount(t);
  const host = scrolledTo(root, 800);

  panel.setTurn(READING);

  // The reviewer just pressed Send, so they are at the live end: a marker below the fold is no marker.
  assert.equal(host.scrollTop, host.scrollHeight);
});

test("the agent's working turn turns Send into Queue and leaves everything pressable", (t) => {
  const { root, panel } = mount(t);

  panel.setTurn(WORKING);

  // Queue always: the primary button keeps working, it just parks the words in the tray
  // instead of sending them onto somebody else's turn.
  assert.equal(root.querySelector("#lsr-send")?.disabled, false);
  assert.equal(root.querySelector("#lsr-send")?.textContent, "Queue");
  assert.equal(
    root.querySelector("#lsr-general-comment")?.placeholder,
    "General comment — Enter queues…",
  );
  assert.equal(root.querySelector("#lsr-send-end")?.disabled, false);
  assert.equal(root.querySelector("#lsr-general-comment")?.disabled, false);
});

test("a locked end says on itself that it carries nothing", (t) => {
  const { root, panel } = mount(t);
  assert.equal(root.querySelector("#lsr-send-end")?.textContent, "Send & End");

  panel.setTurn(READING);
  assert.equal(root.querySelector("#lsr-send-end")?.textContent, "End without Sending");

  panel.setTurn(REVIEWERS);
  assert.equal(root.querySelector("#lsr-send-end")?.textContent, "Send & End");
});

test("the turn coming back hands Send back without replacing the compose box", (t) => {
  const { root, panel, box } = mount(t);
  const typing = box();
  typing!.value = "half a thought";
  panel.setTurn(working("rewriting the parser"));

  panel.setTurn(REVIEWERS);

  assert.equal(root.querySelector("#lsr-send")?.disabled, false);
  assert.equal(root.querySelector("#lsr-send")?.textContent, "Send to Agent");
  assert.equal(
    root.querySelector("#lsr-general-comment")?.placeholder,
    "General comment — Enter sends…",
  );
  assert.equal(box(), typing, "the very element they were typing into");
  assert.equal(typing!.value, "half a thought");
});

test("a session that opens on the agent's turn queues before any SSE frame", (t) => {
  const { root } = mount(t, session({ turn: WORKING }));

  // A reload is not an escape: the turn is server truth, and the page draws it
  // from the session it was handed rather than waiting to be told.
  assert.equal(root.querySelector("#lsr-send")?.textContent, "Queue");
});

test("a press on Queue sends nothing to the agent", (t) => {
  const { root, panel } = mount(t, session({ pending: [] }));
  const sent = stubFetch(t);
  panel.queue([annotation]);
  panel.setTurn(WORKING);

  root.dispatch("click", { target: root.querySelector("#lsr-send") });

  // Send only on your turn: the pills stay in the tray, and nothing is put on
  // the wire on somebody else's turn.
  assert.deepEqual(sent, []);
  assert.equal(queuedIn(root), 1, "an empty box queues nothing more");
});

test("Enter on the agent's turn queues the comment, like the button beneath it", (t) => {
  const { root, panel, box } = mount(t);
  const sent = stubFetch(t);
  box()!.value = "one more thing";
  panel.setTurn(WORKING);

  const event = keydown(box(), { key: "Enter" });
  root.dispatch("keydown", event);

  assert.equal(event.defaultPrevented, true, "the keystroke is a queue, not a newline");
  assert.deepEqual(sent, []);
  assert.match(shown(root), /one more thing/);
  assert.equal(box()?.value, "");
});

test("general comments queue on the agent's turn one after another, beside the pills", async (t) => {
  const { root, panel, box, storage } = mount(t);
  const sent = stubFetch(t);
  panel.setTurn(working("rewriting the parser"));
  const second: FeedbackPrompt = { ...annotation, comment: "and roll it back on error" };

  panel.queue([annotation]);
  type(root, box()!, "the migration is missing");
  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  panel.queue([second]);
  type(root, box()!, "  and the changelog  ");
  root.dispatch("click", { target: root.querySelector("#lsr-send") });

  assert.deepEqual(sent, [], "queueing is not sending");
  assert.equal(box()?.value, "", "the box is emptied for the next one");
  const pills = root.querySelectorAll(".lsr-pill-remove");
  assert.equal(pills.length, 4, "nothing queued overwrote anything else");
  const order = [
    /wrap in a transaction/,
    /the migration is missing/,
    /roll it back/,
    /and the changelog/,
  ];
  const html = shown(root);
  const places = order.map((comment) => html.search(comment));
  assert.deepEqual(
    places,
    [...places].sort((one, other) => one - other),
    "in the order queued",
  );
  // Kept like any pill, and the typed half is gone from the draft: a reload must not
  // offer the same words twice, once as a pill and once in the box.
  await stored();
  const remembered = readMemory(storage, "key");
  assert.deepEqual(
    remembered.pending.map((pill) => ("comment" in pill ? pill.comment : undefined)),
    [
      "wrap in a transaction",
      "the migration is missing",
      "and roll it back on error",
      "and the changelog",
    ],
  );
  assert.equal(remembered.draft, "");
});

test("everything queued on the agent's turn goes out in order on the next Send", async (t) => {
  const { root, panel, box } = mount(t);
  const sent = stubFetch(t);
  panel.setTurn(WORKING);
  panel.queue([annotation]);
  type(root, box()!, "the migration is missing");
  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  type(root, box()!, "and the changelog");
  root.dispatch("keydown", keydown(box(), { key: "Enter" }));

  panel.setTurn(REVIEWERS);
  type(root, box()!, "ship it after that");
  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  // One send, the tray in the order it was built and the box last — exactly what
  // a queued annotation has always gone out as, with no round stamps on the wire.
  assert.deepEqual(sent, [
    {
      path: "/api/session/key/feedback",
      prompts: [
        annotation,
        { type: "message", comment: "the migration is missing" },
        { type: "message", comment: "and the changelog" },
        { type: "message", comment: "ship it after that" },
      ],
      ended: false,
    },
  ]);
  assert.equal(queuedIn(root), 0, "sent is no longer queued");
});

test("text in the box and a Queue press on the agent's turn put nothing on the wire", async (t) => {
  const { root, panel, box } = mount(t);
  const sent = stubFetch(t);
  panel.setTurn(WORKING);
  type(root, box()!, "the migration is missing");

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.deepEqual(sent, [], "no POST: the words wait in the tray for the reviewer's own Send");
  assert.match(shown(root), /the migration is missing/);
});

test("a Queue press says what it did to a screen reader, politely", (t) => {
  const { root, panel, box } = mount(t);
  panel.setTurn(WORKING);
  panel.queue([annotation]);
  const status = () => root.querySelector("#lsr-queue-status")?.textContent;

  type(root, box()!, "the migration is missing");
  root.dispatch("click", { target: root.querySelector("#lsr-send") });

  // The box empties and a pill appears out of sight of a reader following the box.
  assert.equal(status(), "Queued — 2 waiting for your next Send");

  root.dispatch("click", { target: root.querySelector(".lsr-pill-remove") });
  // Emptied by the next redraw, so queueing the same count again is news again.
  assert.equal(status(), "");
});

test("a Queue press hands the box back, so the next comment is typed straight away", (t) => {
  const { root, panel, box } = mount(t);
  panel.setTurn(WORKING);
  type(root, box()!, "one");

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  assert.equal(box()?.focused, true, "back in the box after a queued comment");

  box()!.focused = false;
  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  assert.equal(box()?.focused, true, "and after a press on an empty box, which queues nothing");
  assert.equal(queuedIn(root), 1);
});

test("a Queue press while an end is on the wire queues nothing", async (t) => {
  const flight = heldFetch(t);
  const { root, panel, box } = mount(t);
  panel.setTurn(WORKING);
  type(root, box()!, "one more thing");

  root.dispatch("click", { target: root.querySelector("#lsr-send-end") });
  await tick(0);
  root.dispatch("click", { target: root.querySelector("#lsr-send") });

  // The review may be about to close: nothing moves until the end is answered.
  assert.equal(queuedIn(root), 0);
  assert.equal(box()?.value, "one more thing");
  assert.deepEqual(
    flight.sent.map((sent) => sent.prompts),
    [[]],
    "the end carried nothing",
  );
});

test("the turn coming back counts the queue on the button, and a send clears the count", async (t) => {
  const { root, panel, box } = mount(t);
  const sent = stubFetch(t);
  panel.setTurn(WORKING);
  panel.queue([annotation]);
  type(root, box()!, "the migration is missing");
  root.dispatch("click", { target: root.querySelector("#lsr-send") });

  panel.setTurn(REVIEWERS);
  assert.equal(root.querySelector("#lsr-send")?.textContent, "Send 2 to Agent");

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.equal(sent.length, 1);
  assert.equal(root.querySelector("#lsr-send")?.textContent, "Send to Agent");
});

test("a general comment restored from a reload in a later round wears no stale badge", (t) => {
  const storage = new FakeStorage();
  updateMemory(storage, "key", {
    pending: [
      { ...annotation, round: 0 },
      { type: "message", comment: "and the migration is missing", round: 0 },
    ],
  });
  const rounds = [
    { index: 0, at: "2025-01-01T00:00:00.000Z" },
    { index: 1, at: "2025-01-02T00:00:00.000Z" },
  ];

  const { root } = mount(t, session({ rounds }), storage);

  // The annotation still warns its lines may have moved; the message has no lines to move.
  assert.equal(queuedIn(root), 2);
  assert.equal(root.querySelectorAll(".lsr-pill-round").length, 1);
});

test("a queued general comment comes out of the tray like any pill", (t) => {
  const { root, panel, box } = mount(t);
  panel.setTurn(WORKING);
  type(root, box()!, "never mind this one");
  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  assert.match(shown(root), /never mind this one/, "queued first");

  root.dispatch("click", { target: root.querySelector(".lsr-pill-remove") });

  assert.doesNotMatch(shown(root), /never mind this one/);
  assert.equal(queuedIn(root), 0);
});

test("ending on the agent's turn ends the review and leaves the queue queued", async (t) => {
  const { root, panel, ended, storage, box } = mount(t);
  const sent = stubFetch(t);
  panel.queue([annotation]);
  type(root, box()!, "and one more thing");
  panel.setTurn(working("rewriting the parser"));

  root.dispatch("click", { target: root.querySelector("#lsr-send-end") });
  await tick(0);

  // End always: the review closes on the reviewer's word whoever holds the
  // turn. Send only on your turn: the pills do not ride out with it.
  assert.deepEqual(sent, [{ path: "/api/session/key/feedback", prompts: [], ended: true }]);
  assert.equal(ended(), true);
  // And the button said `End without Sending`, so what was not sent is still
  // there: on the page, and on disk for the reload after a reopen. Dropping it
  // would be the one thing the label promised would not happen.
  assert.equal(queuedIn(root), 1, "the queue is still queued");
  assert.equal(box()?.value, "and one more thing");
  await stored();
  const remembered = readMemory(storage, "key");
  assert.equal(remembered.pending.length, 1);
  assert.equal(remembered.draft, "and one more thing");
});

test("a reviewer reading an earlier round is not yanked back down by a reply", (t) => {
  const { root, panel } = mount(t);
  const host = scrolledTo(root, 120);

  panel.update(session({ conversation: [reply] }));

  assert.equal(host.scrollTop, 120, "they chose to be up here");
});

test("a new round redraws the history without touching the draft", (t) => {
  const { root, panel, box } = mount(t, session({ conversation: [reply] }));
  const typing = box();
  assert.ok(typing, "the compose box is mounted");
  typing.value = "still not right";

  panel.update(
    session({
      conversation: [reply],
      rounds: [
        { index: 0, at: "2025-01-01T00:00:00.000Z" },
        { index: 1, at: "2025-01-02T00:00:00.000Z" },
      ],
    }),
  );

  const scroll = root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "";
  assert.match(scroll, /wrapped it in a transaction/);
  assert.doesNotMatch(scroll, /Round 2/, "rounds are not ruled into the column");
  assert.equal(box(), typing);
  assert.equal(typing.value, "still not right");
});

test("queuing an annotation redraws the pills without replacing the compose box", (t) => {
  const { root, panel, box } = mount(t);
  const typing = box();

  panel.queue([
    {
      type: "annotation",
      file: "src/api.ts",
      group: "API",
      selected_text: "+x",
      comment: "naming",
    },
  ]);

  assert.equal(box(), typing);
  assert.match(root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "", /lsr-pill/);
});

test("a review that ends while the reviewer types locks the controls", (t) => {
  const { root, panel } = mount(t);

  panel.update(session({ status: "ended" }));

  assert.equal(root.querySelector("#lsr-send")?.disabled, true);
  assert.equal(root.querySelector("#lsr-send-end")?.disabled, true);
  assert.equal(root.querySelector("#lsr-general-comment")?.disabled, true);
});

test("Enter in the compose box sends it, like the button beneath it", async (t) => {
  const sent = stubFetch(t);
  const { root, box } = mount(t);
  const typing = box();
  assert.ok(typing);
  typing.value = "ship it";

  const event = keydown(typing);
  root.dispatch("keydown", event);
  await tick(0);

  assert.equal(event.defaultPrevented, true, "the keystroke is a send, not a newline");
  assert.deepEqual(sent, [
    {
      path: "/api/session/key/feedback",
      prompts: [{ type: "message", comment: "ship it" }],
      ended: false,
    },
  ]);
  assert.equal(typing.value, "", "the sent comment leaves the box");
});

test("Shift+Enter stays the browser's newline", async (t) => {
  const sent = stubFetch(t);
  const { root, box } = mount(t);
  const typing = box();
  assert.ok(typing);
  typing.value = "first line";

  const event = keydown(typing, { shiftKey: true });
  root.dispatch("keydown", event);
  await tick(0);

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(sent, []);
  assert.equal(typing.value, "first line");
});

test("Ctrl+Enter types the newline browsers leave out", async (t) => {
  const sent = stubFetch(t);
  const { root, box } = mount(t);
  const typing = box();
  assert.ok(typing);
  typing.value = "onetwo";
  typing.setSelectionRange(3, 3);

  const event = keydown(typing, { ctrlKey: true });
  root.dispatch("keydown", event);
  await tick(0);

  assert.equal(event.defaultPrevented, true);
  assert.equal(typing.value, "one\ntwo");
  assert.deepEqual(sent, []);
});

test("an Enter in an empty box sends nothing and types nothing", async (t) => {
  const sent = stubFetch(t);
  const { root, box } = mount(t);
  const typing = box();
  assert.ok(typing);

  const event = keydown(typing);
  root.dispatch("keydown", event);
  await tick(0);

  assert.deepEqual(sent, []);
  assert.equal(event.defaultPrevented, true);
  assert.equal(typing.value, "", "no blank line hides the placeholder that says what Enter does");
});

test("an Enter in an empty box does not fire the queued pills off", async (t) => {
  const sent = stubFetch(t);
  const { root, panel, box } = mount(t);
  panel.queue([
    {
      type: "annotation",
      file: "src/api.ts",
      group: "API",
      selected_text: "+x",
      comment: "naming",
    },
  ]);

  root.dispatch("keydown", keydown(box()));
  await tick(0);

  assert.deepEqual(sent, [], "pills are sent by the button, never by a stray keystroke");
});

test("a keystroke from anywhere else in the panel is not a send", async (t) => {
  const sent = stubFetch(t);
  const { root, box } = mount(t);
  box()!.value = "ship it";

  const event = keydown(root.querySelector("#lsr-send"));
  root.dispatch("keydown", event);
  await tick(0);

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(sent, []);
});

function note(root: FakeNode): FakeNode | null {
  return root.querySelector(".lsr-complete");
}

test("approving the last file says so without touching what the reviewer is typing", (t) => {
  const { root, panel, box } = mount(t);
  const typing = box();
  assert.ok(typing);
  typing.value = "one more thought";
  assert.equal(note(root)?.textContent, "", "the region is there and silent");

  panel.setAllApproved(true);

  assert.match(note(root)?.textContent ?? "", /Every file is approved/);
  assert.equal(box(), typing, "the compose row was patched, not redrawn");
  assert.equal(typing.value, "one more thought");
});

test("unticking a file takes the note back", (t) => {
  const { root, panel } = mount(t);
  panel.setAllApproved(true);

  panel.setAllApproved(false);

  assert.equal(note(root)?.textContent, "");
});

test("a review that ends has nothing left to nudge toward", (t) => {
  const { root, panel } = mount(t);
  panel.setAllApproved(true);

  panel.update(session({ status: "ended" }));

  assert.equal(note(root)?.textContent, "", "the ended compose row says the review is over");
  assert.match(root.querySelector(".lsr-compose")?.innerHTML ?? "", /This review has ended/);
});

test("Send & End with nothing queued ends the review", async (t) => {
  const sent = stubFetch(t);
  const { root, panel, ended } = mount(t);
  panel.setAllApproved(true);

  root.dispatch("click", { target: root.querySelector("#lsr-send-end") });
  await tick(0);

  assert.deepEqual(sent, [{ path: "/api/session/key/feedback", prompts: [], ended: true }]);
  assert.equal(ended(), true, "the page locks the moment the reviewer says they are done");
  assert.equal(root.querySelector("#lsr-send-end")?.disabled, true);
});

test("the word given elsewhere ends the review exactly as the panel's own button does", async (t) => {
  const sent = stubFetch(t);
  const { root, panel, ended, box } = mount(t);
  type(root, box()!, "one last thing");

  panel.end();
  await tick(0);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.ended, true);
  assert.deepEqual(
    sent[0]?.prompts.map((prompt) => ("comment" in prompt ? prompt.comment : undefined)),
    ["one last thing"],
    "the comment box is sent, not dropped",
  );
  assert.equal(ended(), true);
  assert.equal(root.querySelector("#lsr-send-end")?.disabled, true);
});

test("Send to Agent with nothing queued sends nothing", async (t) => {
  const sent = stubFetch(t);
  const { root } = mount(t);

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.deepEqual(sent, [], "there is nothing to send");
});

const queued: FeedbackPrompt[] = [
  {
    type: "annotation",
    file: "src/api.ts",
    group: "API",
    selected_text: "+const x = 1;",
    comment: "this name says nothing",
    side: "new",
    line_start: 12,
    line_end: 14,
  },
  { type: "message", comment: "and the migration is missing" },
];

test("the queue a reload interrupted is back, in the order it was queued", (t) => {
  const storage = new FakeStorage();
  updateMemory(storage, "key", { pending: queued });

  const { root } = mount(t, session(), storage);

  // Read off the root: "back after a reload" means part of the very first draw.
  const pills = root.innerHTML;
  assert.match(pills, /this name says nothing/);
  assert.match(pills, /and the migration is missing/);
  assert.ok(
    pills.indexOf("this name says nothing") < pills.indexOf("and the migration is missing"),
    "the pills stand in the order the reviewer queued them",
  );
});

test("a restored pill sends exactly what it would have sent before the reload", async (t) => {
  const sent = stubFetch(t);
  const storage = new FakeStorage();
  updateMemory(storage, "key", { pending: queued });
  const { root } = mount(t, session(), storage);

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.deepEqual(sent, [{ path: "/api/session/key/feedback", prompts: queued, ended: false }]);
});

test("a half-typed comment is back in the box the reviewer left it in", (t) => {
  const storage = new FakeStorage();
  updateMemory(storage, "key", { draft: "this rename is wrong beca" });

  const { box } = mount(t, session(), storage);

  assert.equal(box()?.value, "this rename is wrong beca");
});

test("another review's queue is not offered to this one", (t) => {
  const storage = new FakeStorage();
  updateMemory(storage, "other-branch", { pending: queued, draft: "not for here" });

  const { root, box } = mount(t, session(), storage);

  assert.match(root.innerHTML, /Nothing queued/);
  assert.equal(box()?.value, "");
});

test("queueing and un-queueing a pill are both remembered at once", (t) => {
  const { root, panel, storage } = mount(t);

  panel.queue(queued);
  assert.deepEqual(
    readMemory(storage, "key").pending,
    queued.map((prompt) => ({ ...prompt, round: 0 })),
  );

  root.dispatch("click", { target: root.querySelector(".lsr-pill-remove") });

  assert.deepEqual(readMemory(storage, "key").pending, [{ ...queued[1], round: 0 }]);
});

test("a pill is stamped with the round on screen when it is queued", (t) => {
  const { panel, storage } = mount(
    t,
    session({
      rounds: [
        { index: 0, at: "2025-01-01T00:00:00.000Z" },
        { index: 1, at: "2025-01-02T00:00:00.000Z" },
      ],
    }),
  );

  panel.queue([queued[0]!]);

  assert.equal(readMemory(storage, "key").pending[0]?.round, 1);
});

test("a new round arriving over SSE badges the queued pills without a reload", (t) => {
  const { root, panel } = mount(t);
  panel.queue(queued);
  assert.doesNotMatch(root.innerHTML, /lsr-pill-round/, "no badge in the pill's own round");

  panel.update(
    session({
      rounds: [
        { index: 0, at: "2025-01-01T00:00:00.000Z" },
        { index: 1, at: "2025-01-02T00:00:00.000Z" },
      ],
    }),
  );

  assert.match(root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "", /lsr-pill-round/);
  assert.match(root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "", /round 1/);
});

test("a restored pill from an earlier round is badged on the very first draw", (t) => {
  const storage = new FakeStorage();
  updateMemory(storage, "key", { pending: queued.map((prompt) => ({ ...prompt, round: 0 })) });

  const { root } = mount(
    t,
    session({
      rounds: [
        { index: 0, at: "2025-01-01T00:00:00.000Z" },
        { index: 1, at: "2025-01-02T00:00:00.000Z" },
      ],
    }),
    storage,
  );

  assert.match(root.innerHTML, /lsr-pill-round/);
});

test("the stamp stays on the page — what is sent is the prompt alone", async (t) => {
  const sent = stubFetch(t);
  const { root, panel } = mount(t);
  panel.queue(queued);

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.deepEqual(sent, [{ path: "/api/session/key/feedback", prompts: queued, ended: false }]);
});

test("typing is written down once the reviewer stops", async (t) => {
  const { root, box, storage } = mount(t);

  type(root, box()!, "the transaction here is");
  assert.equal(readMemory(storage, "key").draft, "", "not on every keystroke");
  await stored();

  assert.equal(readMemory(storage, "key").draft, "the transaction here is");
});

test("a tab closed mid-sentence keeps the sentence", (t) => {
  const { root, box, storage, page } = mount(t);
  type(root, box()!, "half a thought");

  page.leave();

  assert.equal(readMemory(storage, "key").draft, "half a thought");
});

test("what was sent is not offered again after a reload", async (t) => {
  stubFetch(t);
  const { root, box, panel, storage } = mount(t);
  panel.queue(queued);
  type(root, box()!, "and one more thing");
  // Draft written before the send: sending after the write must clear the record; sending before
  // it is cleared by the delayed write landing on an empty box anyway.
  await stored();
  assert.equal(readMemory(storage, "key").draft, "and one more thing", "stored before sending");

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.deepEqual(readMemory(storage, "key").pending, []);
  assert.equal(readMemory(storage, "key").draft, "");
});

test("feedback the server refused is still queued for the next try", async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 500 });
  t.after(() => {
    globalThis.fetch = real;
  });
  const { root, panel, storage } = mount(t);
  panel.queue(queued);

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.deepEqual(
    readMemory(storage, "key").pending,
    queued.map((prompt) => ({ ...prompt, round: 0 })),
  );
});

test("a Send the server refuses because the agent took the turn keeps everything and says why", async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      {
        error: {
          code: "agent_holds_turn",
          message: "the agent is reading your last batch; wait for its answer",
        },
      },
      { status: 409 },
    );
  t.after(() => {
    globalThis.fetch = real;
  });
  const { root, panel, box, storage } = mount(t);
  panel.queue(queued);
  type(root, box()!, "and one more thing");

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.equal(box()!.value, "and one more thing");
  assert.equal(readMemory(storage, "key").pending.length, queued.length);
  assert.match(
    root.querySelector(".lsr-complete")?.textContent ?? "",
    /Not sent — the agent is reading your last batch; wait for its answer/,
  );
});

/**
 * The page believed the turn was the reviewer's, but the agent took it on the
 * wire: the end is refused whole, so the review stays open and every word stays.
 */
test("a Send & End refused because the agent took the turn ends nothing and keeps every word", async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      {
        error: {
          code: "agent_holds_turn",
          message: "the agent holds the turn, so words sent with the end would never be read",
        },
      },
      { status: 409 },
    );
  t.after(() => {
    globalThis.fetch = real;
  });
  const { root, panel, box, storage, ended } = mount(t);
  panel.queue(queued);
  type(root, box()!, "and one more thing");

  root.dispatch("click", { target: root.querySelector("#lsr-send-end") });
  await tick(0);

  assert.equal(ended(), false);
  assert.equal(root.querySelector("#lsr-send-end")?.disabled, false);
  assert.equal(box()!.value, "and one more thing");
  assert.equal(readMemory(storage, "key").pending.length, queued.length);
  assert.match(
    root.querySelector(".lsr-complete")?.textContent ?? "",
    /Not sent — the agent holds the turn, so words sent with the end would never be read/,
  );
});

function shown(root: FakeNode): string {
  return root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "";
}

test("what was just sent is in the conversation before the server has said a word", async (t) => {
  stubFetch(t);
  const { root, panel, box } = mount(t);
  panel.queue(queued);
  type(root, box()!, "and one more thing");

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.match(shown(root), /data-role="reviewer"/, "the panel names who said it");
  assert.match(shown(root), /this name says nothing/, "the queued pill became a message");
  assert.match(shown(root), /and one more thing/, "and so did the general comment");
  assert.doesNotMatch(shown(root), /lsr-pill/, "and it left the queue as it went");
});

test("the server's own copy replaces the echo instead of doubling it", async (t) => {
  stubFetch(t);
  const { root, panel } = mount(t);
  panel.queue([queued[0]!]);
  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  panel.update(
    session({
      conversation: [
        {
          role: "reviewer",
          at: "2025-01-01T00:01:00.000Z",
          prompts: [{ ...(queued[0] as AnnotationPrompt), id: "t1" }],
        },
      ],
    }),
  );

  assert.equal(
    shown(root).match(/this name says nothing/g)?.length,
    1,
    "the fresh read is the whole conversation, echo and all",
  );
});

test("a fresh read that lands mid-flight is not echoed on top of", async (t) => {
  const flight = heldFetch(t);
  const { root, panel } = mount(t);
  panel.queue([queued[0]!]);

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);
  // The server publishes `feedback` after writing, so a read started on that publish can return
  // before this send's answer — already carrying the words the echo would add.
  panel.update(
    session({
      conversation: [
        {
          role: "reviewer",
          at: "2025-01-01T00:01:00.000Z",
          prompts: [{ ...(queued[0] as AnnotationPrompt), id: "t1" }],
        },
      ],
    }),
  );
  flight.settle(true);
  await settled();

  assert.equal(
    shown(root).match(/this name says nothing/g)?.length,
    1,
    "the reviewer is shown what they sent once, not twice",
  );
});

test("the echoed items are named as the server will name them, so they draw as open threads", async (t) => {
  stubFetch(t);
  const { root, box } = mount(t, session({ conversation: [opened] }));
  type(root, box()!, "still not right");

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.match(shown(root), /data-key="t2"[^>]*data-group="waiting"/);
  assert.doesNotMatch(shown(root), /data-legacy/);
});

test("a Send & End that carried nothing adds no turn to the conversation", async (t) => {
  stubFetch(t);
  const { root } = mount(t);

  root.dispatch("click", { target: root.querySelector("#lsr-send-end") });
  await tick(0);

  assert.doesNotMatch(
    shown(root),
    /lsr-entry/,
    "a heading with nothing under it says words were lost",
  );
});

test("feedback the server refused is not echoed as though it had landed", async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 500 });
  t.after(() => {
    globalThis.fetch = real;
  });
  const { root, panel } = mount(t);
  panel.queue(queued);

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.doesNotMatch(shown(root), /lsr-entry/);
  assert.match(shown(root), /lsr-pill/, "the pills are still there to try again with");
});

function heldFetch(t: TestContext): { sent: SentFeedback[]; settle: (ok: boolean) => void } {
  const sent: SentFeedback[] = [];
  const waiting: ((ok: boolean) => void)[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Omit<SentFeedback, "path">;
    sent.push({ path: String(input), ...body });
    return new Promise<Response>((resolve) => {
      waiting.push((ok) => resolve(new Response(null, { status: ok ? 204 : 500 })));
    });
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return {
    sent,
    settle: (ok) => {
      for (const answer of waiting.splice(0)) answer(ok);
    },
  };
}

/** Long enough for the send's own promise chain to have run to the end. */
const settled = (): Promise<void> => tick(5);

function controls(root: FakeNode): { send: boolean; end: boolean; box: boolean; label: string } {
  return {
    send: root.querySelector("#lsr-send")?.disabled ?? false,
    end: root.querySelector("#lsr-send-end")?.disabled ?? false,
    box: root.querySelector("#lsr-general-comment")?.disabled ?? false,
    label: root.querySelector("#lsr-send")?.textContent ?? "",
  };
}

test("the send controls are locked while the request is in flight, and say so", async (t) => {
  const flight = heldFetch(t);
  const { root, box } = mount(t);
  const typing = box();
  typing!.value = "ship it";

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.deepEqual(controls(root), { send: true, end: true, box: true, label: "Sending…" });
  assert.equal(box(), typing, "the compose row was patched, not redrawn");

  flight.settle(true);
  await settled();

  assert.deepEqual(controls(root), { send: false, end: false, box: false, label: "Send to Agent" });
  assert.equal(box(), typing, "and patched back, still the element it was");
});

test("a second press while the first send is in flight sends nothing", async (t) => {
  const flight = heldFetch(t);
  const { root, panel } = mount(t);
  panel.queue(queued);

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);
  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  root.dispatch("click", { target: root.querySelector("#lsr-send-end") });
  await tick(0);

  assert.equal(flight.sent.length, 1, "the queue is only handed over once");
});

test("Enter while a send is in flight sends nothing either", async (t) => {
  const flight = heldFetch(t);
  const { root, box } = mount(t);
  box()!.value = "ship it";

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);
  box()!.value = "and another thing";
  root.dispatch("keydown", keydown(box()));
  await tick(0);

  assert.equal(flight.sent.length, 1);
});

test("a refused send gives the controls back and clears nothing", async (t) => {
  const flight = heldFetch(t);
  const { root, panel, box } = mount(t);
  panel.queue(queued);
  box()!.value = "and one more thing";

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);
  flight.settle(false);
  await settled();

  // The two pills are still waiting, and the button still counts them.
  assert.deepEqual(controls(root), {
    send: false,
    end: false,
    box: false,
    label: "Send 2 to Agent",
  });
  assert.equal(box()?.value, "and one more thing", "nothing the reviewer wrote was taken away");
  assert.match(shown(root), /lsr-pill/);
});

test("the reviewer can press again once a refused send has been given back", async (t) => {
  const flight = heldFetch(t);
  const { root, panel } = mount(t);
  panel.queue(queued);

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);
  flight.settle(false);
  await settled();
  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.equal(flight.sent.length, 2);
});

test("a status arriving mid-flight redraws the row without handing the buttons back", async (t) => {
  const flight = heldFetch(t);
  const { root, panel, box } = mount(t);
  box()!.value = "ship it";

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);
  // The server's account of this send coming back: status `feedback`, the one thing that
  // replaces the compose row.
  panel.update(session({ status: "feedback" }));

  assert.deepEqual(controls(root), { send: true, end: true, box: true, label: "Sending…" });

  flight.settle(true);
  await settled();

  assert.deepEqual(controls(root), { send: false, end: false, box: false, label: "Send to Agent" });
});

test("a Send & End that lands leaves the controls locked for good", async (t) => {
  const flight = heldFetch(t);
  const { root } = mount(t);

  root.dispatch("click", { target: root.querySelector("#lsr-send-end") });
  await tick(0);
  flight.settle(true);
  await settled();

  assert.deepEqual(controls(root), { send: true, end: true, box: true, label: "Send to Agent" });
  assert.match(root.querySelector(".lsr-compose")?.innerHTML ?? "", /This review has ended/);
});

test("pressing a comment's file name asks the page to jump to its lines", (t) => {
  const jumps: { file: string; anchor: { side: "old" | "new"; line: number } | undefined }[] = [];
  const { root, panel } = mount(t, session(), new FakeStorage(), (file, anchor) =>
    jumps.push({ file, anchor }),
  );

  panel.queue([
    {
      type: "annotation",
      file: "src/api/users.ts",
      group: "API",
      selected_text: "+x",
      comment: "naming",
      side: "new",
      line_start: 12,
      line_end: 14,
    },
  ]);
  const press = root.querySelector(".lsr-prompt-file");
  assert.ok(press, "the pill names its file as a press");
  root.dispatch("click", { target: press });

  assert.deepEqual(jumps, [{ file: "src/api/users.ts", anchor: { side: "new", line: 12 } }]);
});

test("a press on a comment without an anchor still names the file", (t) => {
  const jumps: { file: string; anchor: unknown }[] = [];
  const { root, panel } = mount(t, session(), new FakeStorage(), (file, anchor) =>
    jumps.push({ file, anchor }),
  );

  panel.queue([
    { type: "annotation", file: "src/api.ts", group: "API", selected_text: "+x", comment: "n" },
  ]);
  root.dispatch("click", { target: root.querySelector(".lsr-prompt-file") });

  assert.deepEqual(jumps, [{ file: "src/api.ts", anchor: undefined }]);
});

const opened: ConversationEntry = {
  role: "reviewer",
  at: "2025-01-01T00:01:00.000Z",
  roundIndex: 0,
  prompts: [{ type: "message", id: "t1", comment: "per-request or per-batch?" }],
};

/** The agent had the last word in t1: its card now offers Reply and Resolve. */
const answered: ConversationEntry = {
  role: "agent",
  at: "2025-01-01T00:03:00.000Z",
  roundIndex: 0,
  prompts: [{ type: "reply", thread: "t1", comment: "per-request, for now" }],
};

function replyBoxOf(root: FakeNode, thread = "t1"): FakeNode | undefined {
  return root
    .querySelectorAll(".lsr-thread-reply-box")
    .find((box) => box.dataset.thread === thread);
}

function pressIn(root: FakeNode, selector: string, thread = "t1"): void {
  const target = root.querySelectorAll(selector).find((node) => node.dataset.thread === thread);
  assert.ok(target, `no ${selector} for ${thread}`);
  root.dispatch("click", { target });
}

test("a reply in a thread is one more pill, and goes out with the rest on Send", async (t) => {
  const { root, panel } = mount(t, session({ conversation: [opened, answered] }));
  const sent = stubFetch(t);
  panel.queue([annotation]);
  replyBoxOf(root)!.value = "  per-batch  ";

  pressIn(root, ".lsr-thread-reply-add");

  assert.equal(replyBoxOf(root)?.value, "", "the box empties for the next reply");
  assert.equal(replyBoxOf(root)?.focused, true, "and keeps the reviewer in it");
  assert.equal(
    root.querySelector("#lsr-queue-status")?.textContent,
    "Queued — 2 waiting for your next Send",
  );
  assert.equal(sent.length, 0, "replying is not sending");

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  assert.deepEqual(sent[0]?.prompts, [
    annotation,
    { type: "reply", thread: "t1", comment: "per-batch" },
  ]);
});

test("Enter in a reply box adds the reply, as its button does; an empty one adds nothing", (t) => {
  const { root } = mount(t, session({ conversation: [opened, answered] }));
  const field = replyBoxOf(root)!;
  field.value = "   ";
  root.dispatch("keydown", keydown(field, { key: "Enter" }));
  assert.equal(queuedIn(root), 0);

  replyBoxOf(root)!.value = "per-batch";
  const event = keydown(replyBoxOf(root), { key: "Enter" });
  root.dispatch("keydown", event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(queuedIn(root), 1);
  assert.match(shown(root), /lsr-draft[\s\S]*per-batch/, "drawn in its card, not sent yet");
});

test("a key in anything but a reply box is not a reply", (t) => {
  const { root } = mount(t, session({ conversation: [opened, answered] }));
  replyBoxOf(root)!.value = "per-batch";

  root.dispatch("keydown", keydown(root.querySelector(".lsr-thread-reply-add"), { key: "Enter" }));
  root.dispatch("keydown", keydown(new FakeNode("textarea"), { key: "Enter" }));

  assert.equal(queuedIn(root), 0);
});

/** Every redraw replaces the scroll, and a pill queued mid-reply is the ordinary way that happens. */
test("a pill queued mid-reply does not cost the reviewer their sentence", (t) => {
  const { root, panel } = mount(t, session({ conversation: [opened, answered] }));
  replyBoxOf(root)!.value = "per-batch, becau";

  panel.queue([annotation]);

  assert.equal(replyBoxOf(root)?.value, "per-batch, becau");
});

test("resolve folds the thread at once and travels as a pill; pressed again it is taken back", async (t) => {
  const { root } = mount(t, session({ conversation: [opened, answered] }));
  const sent = stubFetch(t);

  pressIn(root, ".lsr-thread-resolve");

  assert.match(shown(root), /data-resolved="true"/);
  assert.match(shown(root), /resolves on your next Send/);
  assert.equal(sent.length, 0, "resolving sends nothing by itself");
  assert.equal(queuedIn(root), 1);
  assert.match(shown(root), /data-shut="true"/, "folded at the press");

  root.dispatch("click", { target: root.querySelector(".lsr-thread-fold") });
  pressIn(root, ".lsr-thread-resolve");
  assert.match(shown(root), /data-resolved="false"/);
  assert.equal(queuedIn(root), 0, "no second, opposite pill");

  pressIn(root, ".lsr-thread-resolve");
  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);
  assert.deepEqual(sent[0]?.prompts, [{ type: "resolve", thread: "t1", resolved: true }]);
});

test("a resolved thread's toggle queues the reopen", (t) => {
  const resolved: ConversationEntry = {
    role: "reviewer",
    at: "2025-01-01T00:02:00.000Z",
    roundIndex: 0,
    prompts: [{ type: "resolve", thread: "t1", resolved: true }],
  };
  const { root } = mount(t, session({ conversation: [opened, resolved] }));
  root.dispatch("click", { target: root.querySelector(".lsr-group-toggle") });
  root.dispatch("click", { target: root.querySelector(".lsr-thread-fold") });

  pressIn(root, ".lsr-thread-resolve");

  assert.match(shown(root), /reopens on your next Send/);
  assert.equal(queuedIn(root), 1);
});

/**
 * The lock matrix. Digesting: nothing that writes is live — compose, thread
 * replies, resolve, taking a pill back — and every redraw re-applies it.
 * Working: all of it queues. End is never locked by the turn.
 */
test("while the agent digests everything that writes is locked, redraw after redraw", (t) => {
  const { root, panel } = mount(t, session({ conversation: [opened, answered] }));
  panel.queue([annotation]);
  panel.setTurn(READING, 1);

  const locked = (): boolean[] =>
    ["#lsr-send", "#lsr-general-comment", ".lsr-pill-remove"].map(
      (selector) => root.querySelector(selector)?.disabled ?? false,
    );
  // Not drawn at all rather than drawn disabled: the foot only offers what can be pressed.
  const footer = () => root.querySelectorAll(".lsr-thread-foot").length;
  assert.deepEqual(locked(), [true, true, true]);
  assert.equal(footer(), 0);
  assert.equal(root.querySelector("#lsr-send-end")?.disabled, false);
  assert.match(
    root.querySelector(".lsr-complete")?.textContent ?? "",
    /Locked while the agent reads/,
  );

  panel.update(session({ conversation: [opened, answered] }));
  assert.deepEqual(locked(), [true, true, true]);
  assert.equal(footer(), 0);

  panel.setTurn(WORKING);
  assert.deepEqual(locked(), [false, false, false]);
  assert.deepEqual(
    [".lsr-thread-reply-box", ".lsr-thread-reply-add", ".lsr-thread-resolve"].map(
      (selector) => root.querySelector(selector)?.disabled,
    ),
    [false, false, false],
  );
  assert.equal(
    root.querySelector(".lsr-complete")?.textContent,
    "Queued items go into the next round.",
  );
});

test("a stale press while the agent digests writes nothing", (t) => {
  const { root, panel, box } = mount(t, session({ conversation: [opened, answered] }));
  const sent = stubFetch(t);
  panel.queue([annotation]);
  // Held from before the turn moved, as a listener that raced the redraw would.
  const staleAdd = root.querySelector(".lsr-thread-reply-add");
  const staleResolve = root.querySelector(".lsr-thread-resolve");
  replyBoxOf(root)!.value = "per-batch";
  panel.setTurn(READING);
  box()!.value = "one more";

  root.dispatch("click", { target: staleAdd });
  root.dispatch("click", { target: staleResolve });
  root.dispatch("click", { target: root.querySelector(".lsr-pill-remove") });
  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  panel.queue([annotation]);

  assert.deepEqual(sent, []);
  assert.equal(queuedIn(root), 1);
  assert.equal(panel.writesLocked(), true);
  panel.setTurn(WORKING);
  assert.equal(panel.writesLocked(), false);
});

test("while the agent works a thread reply and a resolve queue like everything else", (t) => {
  const { root, panel } = mount(t, session({ conversation: [opened, answered] }));
  const sent = stubFetch(t);
  panel.setTurn(WORKING);
  replyBoxOf(root)!.value = "per-batch";

  pressIn(root, ".lsr-thread-reply-add");
  pressIn(root, ".lsr-thread-resolve");

  assert.deepEqual(sent, []);
  assert.equal(queuedIn(root), 2);
});

/** Replying twice in a row is the reviewer's call; the waiting line is for the agent's turn only. */
test("a thread the reviewer spoke in last keeps its footer, and says it waits only while the agent holds the turn", (t) => {
  const { root, panel } = mount(t, session({ conversation: [opened] }));

  assert.equal(root.querySelectorAll(".lsr-thread-foot").length, 1);
  assert.equal(root.querySelector(".lsr-thread-waiting"), null);

  panel.setTurn(WORKING);
  assert.equal(root.querySelectorAll(".lsr-thread-foot").length, 1);
  assert.equal(root.querySelector(".lsr-thread-waiting")?.textContent, "Waiting for the agent…");

  panel.setTurn(READING);
  assert.equal(root.querySelectorAll(".lsr-thread-foot").length, 0);
  assert.equal(root.querySelector(".lsr-thread-waiting")?.textContent, "Waiting for the agent…");

  panel.update(session({ conversation: [opened, answered] }));
  assert.equal(root.querySelector(".lsr-thread-waiting"), null);
});

test("the reviewer can reply twice in a row in a thread they spoke in last", (t) => {
  const { root } = mount(t, session({ conversation: [opened] }));
  const sent = stubFetch(t);

  replyBoxOf(root)!.value = "per-batch";
  pressIn(root, ".lsr-thread-reply-add");
  replyBoxOf(root)!.value = "and per-request later";
  pressIn(root, ".lsr-thread-reply-add");

  assert.deepEqual(sent, []);
  assert.equal(queuedIn(root), 2);
});

/** Only the compose row was redrawn on the status change, so the scroll kept its footers. */
test("a review that ends takes the thread footers with it", (t) => {
  const { root, panel } = mount(t, session({ conversation: [opened, answered] }));
  assert.equal(root.querySelectorAll(".lsr-thread-foot").length, 1);

  panel.update(session({ conversation: [opened, answered], status: "ended" }));

  assert.equal(root.querySelectorAll(".lsr-thread-foot").length, 0);
  assert.equal(root.querySelector(".lsr-thread-waiting"), null);
});

/** The fake parses markup but keeps it only where it was assigned: the mount's, until the first redraw. */
function drawn(root: FakeNode): string {
  return shown(root) || root.innerHTML;
}

const settledT1: ConversationEntry = {
  role: "reviewer",
  at: "2025-01-01T00:04:00.000Z",
  roundIndex: 0,
  prompts: [{ type: "resolve", thread: "t1", resolved: true }],
};

test("a press anywhere on a card's head folds it, and the fold outlives a reload", (t) => {
  const storage = new FakeStorage();
  const conversation = [opened, answered];
  const { root } = mount(t, session({ conversation }), storage);

  root.dispatch("click", { target: root.querySelector(".lsr-thread-where") });

  assert.match(drawn(root), /data-shut="true"/);
  assert.deepEqual(readMemory(storage, "key").folds, { t1: { shut: true, resolved: false } });
  const again = mount(t, session({ conversation }), storage);
  assert.match(drawn(again.root), /data-shut="true"/);

  again.root.dispatch("click", { target: again.root.querySelector(".lsr-thread-gist") });
  assert.match(drawn(again.root), /data-shut="false"/);
});

test("the file press in a card's head jumps to the lines without folding the card", (t) => {
  const jumps: string[] = [];
  const line: ConversationEntry = {
    ...opened,
    prompts: [{ ...annotation, id: "t1", side: "new", line_start: 4, line_end: 4 }],
  };
  const { root } = mount(t, session({ conversation: [line] }), new FakeStorage(), (file) =>
    jumps.push(file),
  );

  root.dispatch("click", { target: root.querySelector(".lsr-prompt-file") });

  assert.deepEqual(jumps, ["src/api/users.ts"]);
  assert.match(drawn(root), /data-shut="false"/);
});

test("folding is reading, so it stays live while the agent digests", (t) => {
  const { root, panel } = mount(t, session({ conversation: [opened, answered] }));
  panel.setTurn(READING, 1);

  root.dispatch("click", { target: root.querySelector(".lsr-thread-fold") });

  assert.match(drawn(root), /data-shut="true"/);
});

test("a press outside any card's head folds nothing", (t) => {
  const { root } = mount(t, session({ conversation: [opened, answered] }));

  root.dispatch("click", { target: root.querySelector(".lsr-prompt-comment") });
  root.dispatch("click", { target: root.querySelector(".lsr-thread-group") });

  assert.match(drawn(root), /data-shut="false"/);
});

test("a fold press naming a card no longer drawn does nothing", (t) => {
  const storage = new FakeStorage();
  const { root, panel } = mount(t, session({ conversation: [opened, answered] }), storage);
  const stale = root.querySelector(".lsr-thread-fold");
  panel.update(session({ conversation: [] }));

  root.dispatch("click", { target: stale });

  assert.deepEqual(readMemory(storage, "key").folds, {});
});

test("the resolved group unfolds on its heading's press, and stays unfolded after a reload", (t) => {
  const storage = new FakeStorage();
  const conversation = [opened, settledT1];
  const { root } = mount(t, session({ conversation }), storage);
  assert.doesNotMatch(drawn(root), /data-key="t1"/);

  root.dispatch("click", { target: root.querySelector(".lsr-group-toggle") });

  assert.match(drawn(root), /data-key="t1"/);
  assert.equal(readMemory(storage, "key").resolvedShown, true);
  const again = mount(t, session({ conversation }), storage);
  assert.match(drawn(again.root), /data-key="t1"/);
  again.root.dispatch("click", { target: again.root.querySelector(".lsr-group-toggle") });
  assert.doesNotMatch(drawn(again.root), /data-key="t1"/);
});

test("a card's fold chosen while resolved does not hold once the agent reopens it by answering", (t) => {
  const storage = new FakeStorage();
  updateMemory(storage, "key", {
    resolvedShown: true,
    folds: { t1: { shut: false, resolved: true } },
  });
  const { root, panel } = mount(t, session({ conversation: [opened, settledT1] }), storage);
  assert.match(drawn(root), /data-shut="false"/, "unfolded, as chosen, while resolved");
  root.dispatch("click", { target: root.querySelector(".lsr-thread-fold") });
  assert.deepEqual(readMemory(storage, "key").folds.t1, { shut: true, resolved: true });

  const reopened: ConversationEntry = { ...answered, at: "2025-01-01T00:05:00.000Z" };
  panel.update(session({ conversation: [opened, settledT1, reopened] }));

  assert.match(drawn(root), /data-shut="false"/, "open again: the fold was made while resolved");
});

test("the page is told the queue by kind, so the round offer can count replies as replies", (t) => {
  installFakeElements((undo) => t.after(undo));
  const tallies: unknown[] = [];
  const root = new FakeNode();
  const panel = mountPanel({
    root: asPanelRoot(root),
    key: "key",
    session: session({ conversation: [opened, answered] }),
    storage: new FakeStorage(),
    onEnd: () => {},
    onPending: (queued) => tallies.push(queued),
    onJump: () => {},
  });

  panel.queue([annotation]);
  replyBoxOf(root)!.value = "per-batch";
  pressIn(root, ".lsr-thread-reply-add");

  assert.deepEqual(tallies.at(-1), { comments: 1, replies: 1, resolves: 0 });
});

test("words the server holds read as unheard until the agent picks them up", (t) => {
  const asked: ConversationEntry = { ...opened, at: "2025-01-01T00:10:00.000Z" };
  const held = session({
    conversation: [asked],
    pending: asked.prompts,
    batch: { id: "b0", prompts: [], at: "2025-01-01T00:00:30.000Z" },
  });
  const { root, panel } = mount(t, held);
  assert.match(drawn(root), /data-delivery="unheard">sent · agent not listening/);

  panel.setTurn({ holder: "agent", mode: "digesting", at: "2025-01-01T00:11:00.000Z" }, 1);

  assert.match(drawn(root), /data-delivery="seen">✓ seen by agent/);
  panel.update(held);
  assert.match(drawn(root), /data-delivery="seen"/, "a stale refetch does not undo the pickup");
});
