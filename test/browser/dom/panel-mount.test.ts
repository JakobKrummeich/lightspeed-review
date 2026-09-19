import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as tick } from "node:timers/promises";
import { mountPanel } from "../../../src/browser/dom/panel-mount.ts";
import type { SessionData } from "../../../src/browser/dom/session-api.ts";
import type {
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
const READING: Turn = { holder: "agent", mode: "reading", at: "2025-01-01T00:06:00.000Z" };

const working = (note: string): Turn => ({
  holder: "agent",
  mode: "working",
  at: "2025-01-01T00:07:00.000Z",
  note,
});

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
  prompts: [{ type: "message", comment: "wrapped it in a transaction" }],
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
  /** The page the panel is on, which a reviewer can leave. */
  page: FakeWindow;
  /** Whether the panel has told the page the reviewer is done. */
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

/** The reviewer typing into the compose box, keystrokes and all. */
function type(root: FakeNode, box: FakeNode, text: string): void {
  box.value = text;
  root.dispatch("input", { target: box });
}

/** Long enough for a put-off write to have run. */
const stored = (): Promise<void> => tick(SAVE_DELAY_MS + 20);

/** What the panel posted, so a keystroke can be checked against the wire. */
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

test("a per-comment answer arriving with an update lands under its comment", (t) => {
  // `say --for` publishes a session change; the redraw must show the declaration live,
  // not only on the next visit's mount.
  const { root, panel } = mount(t);
  const asked: ConversationEntry = {
    role: "reviewer",
    at: "2025-01-01T00:00:00.000Z",
    roundIndex: 0,
    prompts: [
      {
        type: "annotation",
        id: "evt_7",
        file: "src/api/users.ts",
        group: "API",
        selected_text: "+const user = 1;",
        comment: "wrap in a transaction",
      },
    ],
  };

  panel.update(
    session({
      conversation: [asked],
      declarations: {
        evt_7: { note: "held as designed", files: [], at: "2025-01-01T01:00:00.000Z" },
      },
    }),
  );

  const scroll = root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "";
  assert.match(scroll, /lsr-prompt-answer/);
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

  panel.setTurn(READING);

  assert.match(
    root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "",
    /the agent has your feedback/,
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

  // `reading` and `working` gate identically; the difference is only ever this
  // sentence, which is the reason `work` takes a plan at all.
  assert.match(
    root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "",
    /implementing: splitting the transaction helper out/,
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

test("the agent's turn takes Send away and leaves everything else pressable", (t) => {
  const { root, panel } = mount(t);

  panel.setTurn(READING);

  assert.equal(root.querySelector("#lsr-send")?.disabled, true);
  // Send is the only control a turn can take: ending is never gated, and
  // queueing and typing are how a reviewer keeps working through the silence.
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
  assert.equal(box(), typing, "the very element they were typing into");
  assert.equal(typing!.value, "half a thought");
});

test("a session that opens on the agent's turn is locked before any SSE frame", (t) => {
  const { root } = mount(t, session({ turn: READING }));

  // A reload is not an escape: the turn is server truth, and the page draws it
  // from the session it was handed rather than waiting to be told.
  assert.equal(root.querySelector("#lsr-send")?.disabled, true);
});

test("a press on a locked Send sends nothing at all", (t) => {
  const { root, panel } = mount(t, session({ pending: [] }));
  const sent = stubFetch(t);
  panel.queue([annotation]);
  panel.setTurn(READING);

  root.dispatch("click", { target: root.querySelector("#lsr-send") });

  // Browsers fire nothing off a disabled button, but the handler is the lock:
  // a stale listener must not put words on somebody else's turn.
  assert.deepEqual(sent, []);
});

test("Enter is the same Send, so the same turn takes it away", (t) => {
  const { root, panel, box } = mount(t);
  const sent = stubFetch(t);
  box()!.value = "one more thing";
  panel.setTurn(READING);

  root.dispatch("keydown", keydown(box(), { key: "Enter" }));

  assert.deepEqual(sent, []);
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
  assert.equal(root.querySelectorAll(".lsr-pill").length, 1, "the queue is still queued");
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

test("a new round rules its line into the history without touching the draft", (t) => {
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
  assert.match(scroll, /lsr-round-mark/, "the round that just opened is marked");
  assert.match(scroll, /Round 2/);
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

/** The live region above the compose box, which is where the note lands. */
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
  // The finish card's press: queue and comment go with it, the page locks, the controls too.
  const sent = stubFetch(t);
  const { root, panel, ended, box } = mount(t);
  type(root, box()!, "one last thing");

  panel.end();
  await tick(0);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.ended, true);
  assert.deepEqual(
    sent[0]?.prompts.map((prompt) => prompt.comment),
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

/** Everything the scroll half is showing: the history and the queue under it. */
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
      conversation: [{ role: "reviewer", at: "2025-01-01T00:01:00.000Z", prompts: [queued[0]!] }],
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
      conversation: [{ role: "reviewer", at: "2025-01-01T00:01:00.000Z", prompts: [queued[0]!] }],
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

test("the echoed turn is stamped with the round the reviewer is looking at", async (t) => {
  stubFetch(t);
  const { root, box } = mount(
    t,
    session({
      conversation: [reply],
      rounds: [
        { index: 0, at: "2025-01-01T00:00:00.000Z" },
        { index: 1, at: "2025-01-02T00:00:00.000Z" },
      ],
    }),
  );
  type(root, box()!, "still not right");

  root.dispatch("click", { target: root.querySelector("#lsr-send") });
  await tick(0);

  const history = shown(root);
  assert.ok(
    history.indexOf("Round 2") < history.indexOf("still not right"),
    "the new turn belongs under the line for the round on screen, not the one before it",
  );
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

/** A POST that hangs until the test says how it ended, like a slow network. */
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

/** The three controls the reviewer sends with, as they stand right now. */
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

  assert.deepEqual(controls(root), { send: false, end: false, box: false, label: "Send to Agent" });
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

/** The conversation `ask` leaves behind: a question, and nothing said after it. */
const asked: ConversationEntry = {
  role: "agent",
  at: "2025-01-01T00:05:00.000Z",
  roundIndex: 0,
  prompts: [{ type: "message", comment: "per-request or per-batch?", kind: "question" }],
};

/** The open question's own box, which lives in the scroll and not the compose row. */
function answerOf(root: FakeNode): FakeNode | null {
  return root.querySelector(".lsr-answer-box");
}

test("answering the question sends that text and nothing else", async (t) => {
  const { root, panel } = mount(t, session({ conversation: [asked] }));
  const sent = stubFetch(t);
  // A queue and a half-typed general comment, both of which must survive: the
  // reviewer was answering a question, not finishing their review.
  panel.queue([annotation]);
  root.querySelector("#lsr-general-comment")!.value = "still writing this one";
  answerOf(root)!.value = "per-batch";

  root.dispatch("click", { target: root.querySelector(".lsr-answer-send") });
  await tick(0);

  assert.deepEqual(sent, [
    {
      path: "/api/session/key/feedback",
      prompts: [{ type: "message", comment: "per-batch" }],
      ended: false,
    },
  ]);
  assert.equal(root.querySelectorAll(".lsr-pill").length, 1, "the queue is still queued");
  assert.equal(root.querySelector("#lsr-general-comment")?.value, "still writing this one");
});

test("Enter in the answer box is the same one press", async (t) => {
  const { root } = mount(t, session({ conversation: [asked] }));
  const sent = stubFetch(t);
  const field = answerOf(root)!;
  field.value = "per-batch";

  root.dispatch("keydown", keydown(field, { key: "Enter" }));
  await tick(0);

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.prompts, [{ type: "message", comment: "per-batch" }]);
});

test("an empty answer box sends nothing, as an empty compose box does", async (t) => {
  const { root } = mount(t, session({ conversation: [asked] }));
  const sent = stubFetch(t);
  answerOf(root)!.value = "   ";

  root.dispatch("click", { target: root.querySelector(".lsr-answer-send") });
  await tick(0);

  assert.deepEqual(sent, []);
});

/** The answer is the last word, so the question above it is answered — and the
 * box goes without waiting for the server's own copy to come back over SSE. */
test("the box goes once the answer is on the wire", async (t) => {
  const { root } = mount(t, session({ conversation: [asked] }));
  stubFetch(t);
  answerOf(root)!.value = "per-batch";

  root.dispatch("click", { target: root.querySelector(".lsr-answer-send") });
  await tick(0);

  assert.equal(answerOf(root), null);
  assert.match(root.querySelector(".lsr-panel-scroll")?.innerHTML ?? "", /per-batch/);
});

/** Every redraw replaces the scroll, and queueing a pill mid-answer is the
 * ordinary way that happens. The half-written answer must outlive it. */
test("a pill queued mid-answer does not cost the reviewer their sentence", (t) => {
  const { root, panel } = mount(t, session({ conversation: [asked] }));
  answerOf(root)!.value = "per-batch, becau";

  panel.queue([annotation]);

  assert.equal(answerOf(root)?.value, "per-batch, becau");
});

/**
 * Every redraw replaces the scroll, and the Answer button with it, so a button
 * rendered fresh is a live one. The lock has to be re-applied by the draw
 * itself; left to the call sites, the first one that forgot put a live Answer
 * in front of the reviewer on the agent's turn.
 */
test("a redraw on the agent's turn hands back an Answer that is still disabled", (t) => {
  const { root, panel } = mount(t, session({ conversation: [asked] }));
  panel.setTurn(READING);
  assert.equal(root.querySelector(".lsr-answer-send")?.disabled, true);

  // A pill queued from the diff: the ordinary way the scroll is redrawn.
  panel.queue([annotation]);

  assert.equal(root.querySelector(".lsr-answer-send")?.disabled, true);
});

/** One gate over everything that sends. The turn cannot move under an open
 * question in practice, but the press must read the same answer Send does. */
test("the answer press obeys the one rule the rest of the panel obeys", async (t) => {
  const { root, panel } = mount(t, session({ conversation: [asked] }));
  const sent = stubFetch(t);
  answerOf(root)!.value = "per-batch";
  panel.setTurn(READING);

  root.dispatch("click", { target: root.querySelector(".lsr-answer-send") });
  await tick(0);

  assert.deepEqual(sent, []);
  assert.equal(root.querySelector(".lsr-answer-send")?.disabled, true);
});
