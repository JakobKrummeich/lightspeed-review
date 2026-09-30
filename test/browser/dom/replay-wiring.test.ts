import { test } from "node:test";
import assert from "node:assert/strict";
import type { Arrivals } from "../../../src/browser/dom/jump-overlay.ts";
import type { ReplayOpening } from "../../../src/browser/dom/replay-overlay.ts";
import { wireReplay, type ReplayHosts } from "../../../src/browser/dom/replay-wiring.ts";
import type { SessionData } from "../../../src/browser/dom/session-api.ts";
import { currentRound } from "../../../src/browser/conversation-rounds.ts";
import { createDiff2HtmlRenderer } from "../../../src/browser/diff2html-adapter.ts";
import { agentMessages } from "../../../src/browser/message-news.ts";
import { readMemory } from "../../../src/browser/review-memory.ts";
import { renderReplayOverlay } from "../../../src/browser/round-replay.ts";
import { trackSeenReplies } from "../../../src/browser/seen-replies.ts";
import type { ReplayComment, ReplayData } from "../../../src/rounds/replay.ts";
import type { ConversationEntry, RoundMark } from "../../../src/session-store.ts";
import { FakeStorage } from "../fake-storage.ts";
import { asPanelRoot, FakeNode } from "./fake-panel-dom.ts";

const KEY = "review-key";

/** Round `last` arriving, with the round before it commented on: its replay opens on its own. */
function roundOf(last: number, commentedOn = true): SessionData {
  const rounds: RoundMark[] = Array.from({ length: last + 1 }, (_, index) => ({
    index,
    at: `2025-01-0${index + 1}T00:00:00.000Z`,
  }));
  const said: ConversationEntry = {
    role: "reviewer",
    at: `2025-01-0${last}T01:00:00.000Z`,
    roundIndex: last - 1,
    prompts: commentedOn
      ? [{ type: "annotation", file: "a.ts", group: "A", selected_text: "x", comment: "why?" }]
      : [{ type: "message", comment: "looks fine" }],
  };
  return { rounds, conversation: [said], status: "open" } as unknown as SessionData;
}

function cardsOf(id: string): ReplayData {
  const comment: ReplayComment = {
    id,
    file: "a.ts",
    group: "A",
    anchor: { side: "new", line_start: 1, line_end: 1 },
    selected_text: "x",
    comment: "why?",
    status: "addressed",
    state: "ok",
    answers: [],
    note: "because",
  };
  return { comments: [comment] };
}

/** Arrivals the test flies by hand: `land()` is the jump in flight landing. */
function fakeArrivals() {
  const flights = { jumps: 0 };
  let flying = false;
  let next: (() => void) | undefined;
  const arrival: Arrivals = {
    jump: () => {
      flights.jumps += 1;
      flying = true;
    },
    onLanding: (then) => {
      if (flying) next = then;
      else then();
    },
    forget: () => {
      next = undefined;
    },
    jumping: () => flying,
  };
  const land = (): void => {
    flying = false;
    const then = next;
    next = undefined;
    then?.();
  };
  return { arrival, flights, land };
}

/** The tab's visibility, flipped by hand; `listening` counts who waits for the flip. */
function fakeVisibility(state: DocumentVisibilityState = "visible") {
  const listeners = new Set<() => void>();
  return {
    visibilityState: state,
    addEventListener: (_type: "visibilitychange", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "visibilitychange", listener: () => void) =>
      listeners.delete(listener),
    listening: () => listeners.size,
    flip(to: DocumentVisibilityState) {
      this.visibilityState = to;
      for (const listener of [...listeners]) listener();
    },
  };
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * One tab's page: its own arrivals and overlay, and the storage every tab
 * shares. The server answers each round with cards when the round before it
 * was commented on, as `rounds/replay.ts` does; `answer` stands in for it.
 */
function tab(
  storage = new FakeStorage(),
  answer?: () => Promise<ReplayData>,
  visibility = fakeVisibility(),
) {
  const flight = fakeArrivals();
  const opened: string[] = [];
  const openings: ReplayOpening[] = [];
  const reopen = new FakeNode("button", "hidden");
  const page: ReplayHosts = {
    key: KEY,
    reviewRoot: asPanelRoot(new FakeNode("main")),
    replayRoot: asPanelRoot(new FakeNode()),
    replayReopen: asPanelRoot(reopen),
    openingRoot: asPanelRoot(new FakeNode()),
  };
  const live = { round: 0, drawn: roundOf(1) };
  let served: ReplayData = { comments: [] };
  const seen = trackSeenReplies(storage, KEY);
  const wired = wireReplay(page, live, seen, {
    arrivals: () => flight.arrival,
    fetch: answer ?? (async () => served),
    storage,
    visibility,
    overlay: () => ({
      open: (opening: ReplayOpening) => {
        openings.push(opening);
        opened.push(opening.data.comments[0]?.id ?? "?");
      },
    }),
  });
  /** The conversation panel drawing `session`, as its light reports every draw. */
  const draw = (session: SessionData): void =>
    seen.drawn(agentMessages(session.conversation), currentRound(session.rounds));
  /** The page's own order for a new round: arriving, the draw, then the replay asked for. */
  const arrive = (fresh: SessionData, commentedOn = true): void => {
    served = commentedOn ? cardsOf(`r${fresh.rounds.length - 1}`) : { comments: [] };
    wired.arriving(fresh);
    live.round = fresh.rounds.length - 1;
    wired.refreshReplay(fresh);
    draw(fresh);
  };
  /** The page loading on `session`: `main.ts` draws the panel, then wires the replay. */
  const load = (session: SessionData): void => {
    live.round = currentRound(session.rounds);
    draw(session);
    wired.arriving(session);
    wired.refreshReplay(session);
  };
  /** The review ends inside the round: the page draws it, no arrival. */
  const end = (): void => {
    live.drawn = { ...live.drawn, status: "ended" };
  };
  return { ...flight, opened, openings, reopen, storage, visibility, arrive, load, draw, end };
}

test("a round whose replay opens arrives by the jump, and the replay opens as it lands", async () => {
  const page = tab();

  page.arrive(roundOf(1));
  await settled();

  assert.equal(page.flights.jumps, 1);
  assert.deepEqual(page.opened, [], "the replay waits for the landing");
  page.land();
  assert.deepEqual(page.opened, ["r1"]);
  assert.equal(page.reopen.hidden, false, "and stays offered for a reopen by hand");
});

test("a round with nothing to replay neither jumps nor opens", async () => {
  const page = tab();

  page.arrive(roundOf(1, false), false);
  await settled();

  assert.equal(page.flights.jumps, 0);
  assert.deepEqual(page.opened, []);
});

test("every newer round forgets what the last one queued for the landing", async () => {
  const page = tab();

  page.arrive(roundOf(1));
  await settled();
  page.arrive(roundOf(2, false), false);
  await settled();
  page.land();

  assert.equal(page.flights.jumps, 1, "round 2 had nothing to replay");
  assert.deepEqual(page.opened, [], "round 1's replay does not open over round 2");
});

test("a reopen by hand mid-jump is ignored; after the landing it opens at once", async () => {
  const page = tab();
  page.arrive(roundOf(1));
  await settled();

  page.reopen.dispatch("click", {});
  assert.deepEqual(page.opened, []);
  page.land();
  page.reopen.dispatch("click", {});

  assert.deepEqual(page.opened, ["r1", "r1"]);
});

test("two tabs on one review: the one that claims the round jumps and opens, the other neither", async () => {
  const shared = new FakeStorage();
  const first = tab(shared);
  const second = tab(shared);

  first.arrive(roundOf(1));
  second.arrive(roundOf(1));
  assert.equal(readMemory(shared, KEY).replayed, 1, "claimed as it arrived, not when it answered");
  await settled();
  first.land();
  second.land();

  assert.equal(first.flights.jumps, 1);
  assert.deepEqual(first.opened, ["r1"]);
  assert.equal(second.flights.jumps, 0, "no jump to nothing");
  assert.deepEqual(second.opened, []);
  assert.equal(second.reopen.hidden, false, "it is still there to open by hand");
});

test("the claim is the page's own: the claiming tab opens even when another answers first", async () => {
  const shared = new FakeStorage();
  let answer: (data: ReplayData) => void = () => undefined;
  const slow = new Promise<ReplayData>((resolve) => (answer = resolve));
  const first = tab(shared, () => slow);
  const second = tab(shared);

  first.arrive(roundOf(1));
  second.arrive(roundOf(1));
  await settled();
  answer(cardsOf("r1"));
  await settled();
  first.land();

  assert.deepEqual(first.opened, ["r1"]);
  assert.deepEqual(second.opened, []);
});

test("a failed fetch: the jump played once, and a reload neither jumps nor opens again", async () => {
  const shared = new FakeStorage();
  const failing = tab(shared, () => Promise.reject(new Error("offline")));

  failing.arrive(roundOf(1));
  await settled();
  failing.land();
  assert.deepEqual(failing.opened, [], "nothing to open");
  assert.equal(failing.reopen.hidden, false, "the reopen stays, to ask again");
  assert.equal(readMemory(shared, KEY).replayed, 1, "the round's turn is spent");

  const reloaded = tab(shared);
  reloaded.arrive(roundOf(1));
  await settled();

  assert.equal(reloaded.flights.jumps, 0);
  assert.deepEqual(reloaded.opened, []);
  assert.equal(reloaded.reopen.hidden, false, "the replay can still be opened by hand");
});

test("a claim opens once: the same round asked for again opens nothing more", async () => {
  const page = tab();
  page.arrive(roundOf(1));
  await settled();
  page.land();

  page.arrive(roundOf(1));
  await settled();

  assert.deepEqual(page.opened, ["r1"]);
});

test("a background tab takes nothing: it neither claims, jumps nor opens", async () => {
  const page = tab(new FakeStorage(), undefined, fakeVisibility("hidden"));

  page.arrive(roundOf(1));
  await settled();

  assert.equal(readMemory(page.storage, KEY).replayed, undefined, "left for a tab on screen");
  assert.equal(page.flights.jumps, 0);
  assert.deepEqual(page.opened, []);
  assert.equal(page.reopen.hidden, false, "offered as usual");
});

test("back on screen with the round still free: it claims it and opens, without a jump", async () => {
  const page = tab(new FakeStorage(), undefined, fakeVisibility("hidden"));
  page.arrive(roundOf(1));
  await settled();

  page.visibility.flip("visible");

  assert.deepEqual(page.opened, ["r1"]);
  assert.equal(page.flights.jumps, 0, "the round was drawn long ago: no swap to cover");
  assert.equal(readMemory(page.storage, KEY).replayed, 1);
  assert.equal(page.visibility.listening(), 0, "no listener left behind");
  page.visibility.flip("hidden");
  page.visibility.flip("visible");
  assert.deepEqual(page.opened, ["r1"], "once");
});

test("back on screen before the cards came back: they open when they do", async () => {
  let answer: (data: ReplayData) => void = () => undefined;
  const slow = new Promise<ReplayData>((resolve) => (answer = resolve));
  const page = tab(new FakeStorage(), () => slow, fakeVisibility("hidden"));
  page.arrive(roundOf(1));

  page.visibility.flip("visible");
  assert.deepEqual(page.opened, []);
  answer(cardsOf("r1"));
  await settled();

  assert.deepEqual(page.opened, ["r1"]);
});

test("back on screen after a tab on screen took the round: nothing opens, reopen offered", async () => {
  const shared = new FakeStorage();
  const behind = tab(shared, undefined, fakeVisibility("hidden"));
  const onScreen = tab(shared);

  behind.arrive(roundOf(1));
  onScreen.arrive(roundOf(1));
  await settled();
  onScreen.land();
  behind.visibility.flip("visible");

  assert.deepEqual(onScreen.opened, ["r1"]);
  assert.deepEqual(behind.opened, []);
  assert.equal(behind.reopen.hidden, false);
  assert.equal(behind.visibility.listening(), 0);
});

test("a flip that leaves the tab hidden is not a return", async () => {
  const page = tab(new FakeStorage(), undefined, fakeVisibility("hidden"));
  page.arrive(roundOf(1));
  await settled();

  page.visibility.flip("hidden");

  assert.deepEqual(page.opened, []);
  assert.equal(page.visibility.listening(), 1, "still waiting");
});

test("rounds arriving while hidden: only the latest counts on the return", async () => {
  const page = tab(new FakeStorage(), undefined, fakeVisibility("hidden"));
  page.arrive(roundOf(1));
  page.arrive(roundOf(2));
  await settled();

  assert.equal(page.visibility.listening(), 1, "one wait, not one per round");
  page.visibility.flip("visible");

  assert.deepEqual(page.opened, ["r2"]);
  assert.equal(readMemory(page.storage, KEY).replayed, 2);
});

test("a newer round with nothing to replay, while hidden, leaves nothing to open on the return", async () => {
  const page = tab(new FakeStorage(), undefined, fakeVisibility("hidden"));
  page.arrive(roundOf(1));
  page.arrive(roundOf(2, false), false);
  await settled();

  assert.equal(page.visibility.listening(), 0);
  page.visibility.flip("visible");

  assert.deepEqual(page.opened, []);
  assert.equal(readMemory(page.storage, KEY).replayed, undefined);
});

test("a review that ended while the tab was hidden opens no replay on the return", async () => {
  const page = tab(new FakeStorage(), undefined, fakeVisibility("hidden"));
  page.arrive(roundOf(1));
  await settled();
  page.end();

  page.visibility.flip("visible");

  assert.deepEqual(page.opened, []);
  assert.equal(readMemory(page.storage, KEY).replayed, undefined);
});

test("after a failed fetch, the reopen asks again and opens what comes back", async () => {
  let healthy = false;
  const page = tab(new FakeStorage(), async () => {
    if (!healthy) throw new Error("boom");
    return cardsOf("r1");
  });
  page.arrive(roundOf(1));
  await settled();
  page.land();

  healthy = true;
  page.reopen.dispatch("click", {});
  assert.equal(page.reopen.hidden, true, "withdrawn while it asks");
  await settled();

  assert.deepEqual(page.opened, ["r1"]);
  assert.equal(page.reopen.hidden, false);
  page.reopen.dispatch("click", {});
  assert.deepEqual(page.opened, ["r1", "r1"], "and opens from what it has after that");
});

test("a reopen that fails again stays offered", async () => {
  const page = tab(new FakeStorage(), () => Promise.reject(new Error("still down")));
  page.arrive(roundOf(1));
  await settled();
  page.land();

  page.reopen.dispatch("click", {});
  await settled();

  assert.deepEqual(page.opened, []);
  assert.equal(page.reopen.hidden, false);
});

/** Round marks up to `last`, a day apart. */
function marks(last: number): RoundMark[] {
  return Array.from({ length: last + 1 }, (_, index) => ({
    index,
    at: `2025-01-0${index + 1}T00:00:00.000Z`,
  }));
}

/** The reviewer's comment `t1`, made in round 1. */
const ASK: ConversationEntry = {
  role: "reviewer",
  at: "2025-01-02T01:00:00.000Z",
  roundIndex: 1,
  prompts: [
    { type: "annotation", id: "t1", file: "a.ts", group: "A", selected_text: "x", comment: "why?" },
  ],
};

function agentSaid(at: string, roundIndex: number, thread: string, comment: string) {
  const entry: ConversationEntry = {
    role: "agent",
    at,
    roundIndex,
    prompts: [{ type: "reply", thread, comment }],
  };
  return entry;
}

/** Said in round 1, while the reviewer had the page open: the panel drew them. */
const EARLY_NOTE = agentSaid("2025-01-02T02:00:00.000Z", 1, "t1", "looking at it");
const EARLY_MAIN = agentSaid("2025-01-02T02:30:00.000Z", 1, "main", "renaming first");
/** Said as round 2 was published: they come with the round. */
const LATE_NOTE = agentSaid("2025-01-03T00:30:00.000Z", 2, "t1", "done: renamed");
const LATE_MAIN = agentSaid("2025-01-03T00:31:00.000Z", 2, "main", "rebased too");

function session(last: number, ...conversation: ConversationEntry[]): SessionData {
  return { rounds: marks(last), conversation, status: "open" } as unknown as SessionData;
}

/** The server's card for `t1`: its note is the agent's last words in the thread. */
function answeredCard(note: ConversationEntry, answers: ReplayComment["answers"] = []): ReplayData {
  const [said] = note.prompts;
  const words = said?.type === "reply" ? said.comment : "";
  const [card] = cardsOf("t1").comments;
  return { comments: [{ ...card!, answers, note: words, note_at: note.at }] };
}

const A_CHANGE: ReplayComment["answers"] = [
  {
    file: "a.ts",
    hunks: [{ header: "@@ -1 +1 @@", body: "-x\n+y", insertions: 1, deletions: 1 }],
  },
];

/** The first card as the reviewer would read it. */
function shown(opening: ReplayOpening | undefined): string {
  assert.ok(opening, "a replay was opened");
  return renderReplayOverlay({ ...opening, current: 0 }, createDiff2HtmlRenderer());
}

test("words the panel drew before the round came are not repeated in its replay", async () => {
  const page = tab(new FakeStorage(), async () => answeredCard(EARLY_NOTE, A_CHANGE));
  page.draw(session(1, ASK, EARLY_NOTE, EARLY_MAIN));

  page.arrive(session(2, ASK, EARLY_NOTE, EARLY_MAIN, LATE_MAIN));
  await settled();
  page.land();

  const html = shown(page.openings[0]);
  assert.doesNotMatch(html, /looking at it/, "the thread's answer was read in the panel");
  assert.doesNotMatch(html, /lsr-replay-answer"/);
  assert.match(html, /lsr-replay-diff/, "what changed still shows");
  assert.equal(page.openings[0]?.roundReply, "rebased too", "only the round reply not yet read");
});

test("words that come with the round are shown, though the panel draws them before it opens", async () => {
  const page = tab(new FakeStorage(), async () => answeredCard(LATE_NOTE));
  page.draw(session(1, ASK, EARLY_NOTE, EARLY_MAIN));

  // `arrive` draws the round's conversation right after asking for the replay,
  // as `applyRound` does — the replay only opens once the jump lands after it.
  page.arrive(session(2, ASK, EARLY_NOTE, EARLY_MAIN, LATE_NOTE, LATE_MAIN));
  await settled();
  page.land();

  assert.match(shown(page.openings[0]), /lsr-replay-note">done: renamed</);
  assert.equal(page.openings[0]?.roundReply, "rebased too");
});

test("a redraw that brings the round's words ahead of the round does not count them seen", async () => {
  const page = tab(new FakeStorage(), async () => answeredCard(LATE_NOTE));
  page.draw(session(1, ASK, EARLY_NOTE));
  const next = session(2, ASK, EARLY_NOTE, LATE_NOTE, LATE_MAIN);

  // A feedback event redraws the panel from a session that already holds round 2.
  page.draw(next);
  page.arrive(next);
  await settled();
  page.land();

  assert.match(shown(page.openings[0]), /lsr-replay-note">done: renamed</);
  assert.equal(page.openings[0]?.roundReply, "rebased too");
});

test("what the panel drew survives a reload; what came with the round still shows", async () => {
  const shared = new FakeStorage();
  const before = tab(shared);
  before.draw(session(1, ASK, EARLY_NOTE, EARLY_MAIN));

  // The tab was closed; the agent answered and published; the reviewer opens the review.
  const reloaded = tab(shared, async () => answeredCard(LATE_NOTE));
  reloaded.load(session(2, ASK, EARLY_NOTE, EARLY_MAIN, LATE_NOTE, LATE_MAIN));
  await settled();
  reloaded.land();

  assert.match(shown(reloaded.openings[0]), /done: renamed/);
  assert.equal(reloaded.openings[0]?.roundReply, "rebased too", "renaming first was read");

  // Once that page drew them, they are read: a reload opened by hand leaves them out.
  const again = tab(shared, async () => answeredCard(LATE_NOTE, A_CHANGE));
  again.load(session(2, ASK, EARLY_NOTE, EARLY_MAIN, LATE_NOTE, LATE_MAIN));
  await settled();
  assert.deepEqual(again.opened, [], "the round had its showing");
  again.reopen.dispatch("click", {});
  assert.doesNotMatch(shown(again.openings[0]), /done: renamed/);
  assert.equal(again.openings[0]?.roundReply, undefined);
});

test("a round whose words were all read and that changed nothing does not open on its own", async () => {
  const page = tab(new FakeStorage(), async () => answeredCard(EARLY_NOTE));
  page.draw(session(1, ASK, EARLY_NOTE));

  page.arrive(session(2, ASK, EARLY_NOTE));
  await settled();
  page.land();

  assert.deepEqual(page.opened, []);
  assert.equal(page.reopen.hidden, false, "still there to open by hand");
  assert.equal(readMemory(page.storage, KEY).replayed, 2, "and the round's showing is spent");
});
