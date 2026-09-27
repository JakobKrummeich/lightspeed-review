import { test } from "node:test";
import assert from "node:assert/strict";
import type { Arrivals } from "../../../src/browser/dom/jump-overlay.ts";
import type { ReplayOpening } from "../../../src/browser/dom/replay-overlay.ts";
import { wireReplay, type ReplayHosts } from "../../../src/browser/dom/replay-wiring.ts";
import type { SessionData } from "../../../src/browser/dom/session-api.ts";
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
  const calls: string[] = [];
  let flying = false;
  let next: (() => void) | undefined;
  const arrival: Arrivals = {
    jump: () => {
      calls.push("jump");
      flying = true;
    },
    onLanding: (then) => {
      if (flying) next = then;
      else then();
    },
    forget: () => {
      calls.push("forget");
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
  return { arrival, calls, land };
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * One tab's page: its own arrivals and overlay, and the storage every tab
 * shares. The server answers each round with cards when the round before it
 * was commented on, as `rounds/replay.ts` does; `answer` stands in for it.
 */
function tab(storage = new FakeStorage(), answer?: () => Promise<ReplayData>) {
  const flight = fakeArrivals();
  const opened: string[] = [];
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
  const wired = wireReplay(page, live, {
    arrivals: () => flight.arrival,
    fetch: answer ?? (async () => served),
    storage,
    overlay: () => ({
      open: (opening: ReplayOpening) => opened.push(opening.data.comments[0]?.id ?? "?"),
    }),
  });
  /** The page's own order for a new round: arriving, the draw, then the replay asked for. */
  const arrive = (fresh: SessionData, commentedOn = true): void => {
    served = commentedOn ? cardsOf(`r${fresh.rounds.length - 1}`) : { comments: [] };
    wired.arriving(fresh);
    live.round = fresh.rounds.length - 1;
    wired.refreshReplay(fresh);
  };
  return { ...flight, opened, reopen, storage, arrive };
}

test("a round whose replay opens arrives by the jump, and the replay opens as it lands", async () => {
  const page = tab();

  page.arrive(roundOf(1));
  await settled();

  assert.deepEqual(page.calls, ["forget", "jump"]);
  assert.deepEqual(page.opened, [], "the replay waits for the landing");
  page.land();
  assert.deepEqual(page.opened, ["r1"]);
  assert.equal(page.reopen.hidden, false, "and stays offered for a reopen by hand");
});

test("a round with nothing to replay neither jumps nor opens, but still forgets the last", async () => {
  const page = tab();

  page.arrive(roundOf(1, false), false);
  await settled();

  assert.deepEqual(
    page.calls,
    ["forget"],
    "an older round's queued replay is dropped all the same",
  );
  assert.deepEqual(page.opened, []);
});

test("every newer round forgets what the last one queued for the landing", async () => {
  const page = tab();

  page.arrive(roundOf(1));
  await settled();
  page.arrive(roundOf(2, false), false);
  await settled();
  page.land();

  assert.deepEqual(page.calls, ["forget", "jump", "forget"]);
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
