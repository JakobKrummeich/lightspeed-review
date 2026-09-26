import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { NOTHING_QUEUED } from "../../../src/browser/queued-pill.ts";
import { wireSessionEvents, type Wired } from "../../../src/browser/dom/session-events.ts";
import { REOPEN_MAX_MS, REOPEN_MS } from "../../../src/browser/dom/session-sync.ts";
import { FOLD_MS } from "../../../src/browser/dom/round-popup.ts";
import type { SessionData } from "../../../src/browser/dom/session-api.ts";
import type { ReviewerPlace } from "../../../src/browser/round-offer.ts";
import type { ConversationEntry } from "../../../src/session-store.ts";
import { asPanelRoot, FakeNode, installFakeElements } from "./fake-panel-dom.ts";

/** Only what the page does with its stream: listen, be told, and ask whether it is dead. */
class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  emit(type: string, data = ""): void {
    for (const handler of this.listeners.get(type) ?? []) handler({ data });
  }
}

const reply: ConversationEntry = {
  role: "agent",
  at: "2025-01-02T00:00:00.000Z",
  prompts: [{ type: "message", comment: "renamed it" }],
};

const said: ConversationEntry = {
  role: "reviewer",
  at: "2025-01-02T00:00:00.000Z",
  prompts: [{ type: "message", comment: "rename this" }],
};

function session(round: number, conversation: ConversationEntry[] = []): SessionData {
  return {
    intents: [],
    commits: [],
    groups: [
      {
        name: "API",
        rationale: "",
        files: [
          {
            path: "src/a.ts",
            status: "modified",
            diff: "@@ -1 +1 @@\n-old\n+new",
            insertions: 1,
            deletions: 1,
            oversized: false,
          },
        ],
      },
    ],
    approved: [],
    approval: {},
    conversation,
    rounds: Array.from({ length: round + 1 }, (_unused, index) => ({
      index,
      at: `2025-01-0${index + 1}T00:00:00.000Z`,
    })),
    pending: [],
    status: "feedback",
    turn: { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" },
  };
}

const idle: ReviewerPlace = { scrolled: 0, queued: NOTHING_QUEUED, focus: undefined };

/** One page's server: answers `/data` with whatever `serving` holds when asked. */
interface FakeServer {
  serving: SessionData;
  fetched: number;
  /** When set, answers wait here until released, so a test decides the order they land in. */
  held: (() => void)[] | undefined;
  failing: boolean;
}

/**
 * Every global stubbed once per test and put back once, whatever the number of pages: two
 * snapshots restored first-in-first-out would put the first page's stubs back for good.
 */
function world(t: TestContext) {
  installFakeElements((undo) => t.after(undo));
  const globals = globalThis as Record<string, unknown>;
  const before = {
    EventSource: globals.EventSource,
    fetch: globals.fetch,
    document: globals.document,
  };
  t.after(() => Object.assign(globals, before));
  const streams = new Map<string, FakeEventSource[]>();
  const servers = new Map<string, FakeServer>();
  globals.EventSource = class extends FakeEventSource {
    constructor(url: string) {
      super();
      streams.set(url, [...(streams.get(url) ?? []), this]);
    }
  };
  globals.fetch = (url: string) => {
    const server = servers.get(url);
    assert.ok(server, `no page asked for ${url}`);
    server.fetched += 1;
    const body = server.serving;
    const answer = { ok: !server.failing, json: () => Promise.resolve(body) };
    const { held } = server;
    if (held === undefined) return Promise.resolve(answer);
    return new Promise((resolve) => held.push(() => resolve(answer)));
  };
  // The popup listens for Escape on the document while a card is up.
  globals.document = { addEventListener: () => {}, removeEventListener: () => {} };
  let pages = 0;
  return {
    /** A page loaded on round 0 with nothing said, wired as `main.ts` wires it. */
    page: (place: ReviewerPlace = idle) => {
      const key = `k${pages++}`;
      const server: FakeServer = {
        serving: session(0),
        fetched: 0,
        held: undefined,
        failing: false,
      };
      servers.set(`/api/session/${key}/data`, server);
      const opened = (): FakeEventSource[] => streams.get(`/api/session/${key}/events`) ?? [];
      return { server, opened, ...wirePage(key, place, () => opened().at(-1)) };
    },
  };
}

/** Every mount stubbed to write what it was told into one log. */
function wirePage(key: string, place: ReviewerPlace, latest: () => FakeEventSource | undefined) {
  const log: string[] = [];
  /** What the header was told of the stream, apart from `log`: every open says it. */
  const connections: boolean[] = [];
  const roots = {
    review: new FakeNode("div"),
    intent: new FakeNode("div"),
    reopen: new FakeNode("button"),
    offer: new FakeNode("button", 'id="lsr-round-offer" hidden'),
    popup: new FakeNode("div", 'id="lsr-round-popup" hidden'),
    connection: new FakeNode("p", 'id="lsr-connection" hidden'),
  };
  roots.review.scrollTop = 500;
  roots.intent.innerHTML = "as the reviewer left it";
  const loaded = session(0);
  const live = { round: 0, drawn: loaded };
  const wired: Wired = {
    page: {
      key,
      reviewRoot: asPanelRoot(roots.review),
      intentRoot: asPanelRoot(roots.intent),
      replayReopen: asPanelRoot(roots.reopen),
      roundOffer: asPanelRoot(roots.offer),
      roundPopup: asPanelRoot(roots.popup),
      connection: asPanelRoot(roots.connection),
    },
    live,
    diff: {
      update: (_fresh, change) => log.push(`diff ${change}`),
      setFormat: () => {},
      reveal: () => {},
    },
    panel: {
      queue: () => {},
      update: (fresh) => log.push(`panel ${fresh.conversation.length} said`),
      setAllApproved: () => {},
      setTurn: (turn) => log.push(`panel turn ${turn.holder}`),
      writesLocked: () => false,
      end: () => {},
    },
    banner: {
      setPresence: () => {},
      setSession: () => log.push("banner"),
      setEndedByReviewer: () => {},
      setConnected: (connected) => void connections.push(connected),
    },
    railControl: { setQueued: () => {}, expand: () => log.push("rail expand") },
    finish: { setTurn: () => {} },
    refreshReplay: () => log.push("replay"),
    place: () => place,
  };
  wireSessionEvents(wired);
  const stream = (): FakeEventSource => {
    const open = latest();
    assert.ok(open, "the page opened its stream");
    return open;
  };
  return { stream, log, live, roots, connections };
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("an open onto nothing new asks, and touches nothing on the page", async (t) => {
  // Regression: an SSH tunnel drops idle streams, and each reopen redrew the round — the intent
  // block shut, the selection and the answer box's caret gone, with nothing to show for it.
  const { stream, server, log, live, roots } = world(t).page();

  stream().emit("open");
  stream().emit("open");
  stream().emit("open");
  await settled();

  assert.equal(server.fetched, 3, "every open asks, the first included");
  assert.deepEqual(log, []);
  assert.equal(live.round, 0);
  assert.equal(roots.intent.innerHTML, "as the reviewer left it");
  assert.equal(roots.review.scrollTop, 500);
});

test("the first open catches a round that landed between the page's load and its subscribe", async (t) => {
  const { stream, server, log, live } = world(t).page();
  server.serving = session(1);

  stream().emit("open");
  await settled();

  assert.ok(log.includes("diff regrouped"));
  assert.equal(live.round, 1);
});

test("a reconnect onto a new round draws it exactly as a session event would", async (t) => {
  // Regression: `stop` then `start` published the new round before the tab had reconnected, and
  // the server keeps no backlog — the tab sat on the old round for good.
  const pages = world(t);
  const byEvent = pages.page();
  byEvent.server.serving = session(1);
  byEvent.stream().emit("session");
  await settled();

  const byReconnect = pages.page();
  byReconnect.server.serving = session(1);
  byReconnect.stream().emit("open");
  await settled();

  assert.deepEqual(byReconnect.log, byEvent.log);
  assert.ok(byReconnect.log.includes("diff regrouped"), "the new round is on screen");
  assert.equal(byReconnect.live.round, 1);
  assert.equal(byReconnect.roots.review.scrollTop, 0);
});

test("a reconnect onto a new round waits behind the offer while the reviewer is reading", async (t) => {
  const { stream, server, log, live, roots } = world(t).page({
    scrolled: 500,
    queued: { ...NOTHING_QUEUED, comments: 1 },
    focus: 0,
  });
  server.serving = session(1);

  stream().emit("open");
  await settled();

  assert.deepEqual(log, [], "the diff and the place are left alone");
  assert.equal(live.round, 0, "not taken until the reviewer takes it");
  assert.equal(roots.offer.hidden, false);
  assert.match(roots.offer.textContent, /Round 2 is ready/);
});

test("a reconnect onto the same round with missed talk draws it in place", async (t) => {
  const { stream, server, log, live, roots } = world(t).page();
  server.serving = session(0, [reply]);

  stream().emit("open");
  // The server's order on subscribe: the presence frame is written as the stream opens.
  stream().emit(
    "presence",
    JSON.stringify({ waiting: false, turn: { holder: "reviewer", at: "" } }),
  );
  await settled();

  assert.deepEqual(log, [
    "panel turn reviewer",
    "diff same-round",
    "panel 1 said",
    "banner",
    "rail expand",
  ]);
  // The refetch speaks for the round, never for the turn: nothing after it overrules presence.
  assert.equal(live.round, 0);
  assert.deepEqual(live.drawn.conversation, [reply]);
  assert.equal(roots.review.scrollTop, 500, "no one is moved inside a round");
  assert.equal(roots.offer.hidden, true);
  assert.equal(roots.popup.hidden, true);
});

test("once drawn, the same talk is not drawn again on the next reconnect", async (t) => {
  const { stream, server, log } = world(t).page();
  server.serving = session(0, [reply]);
  stream().emit("open");
  await settled();
  log.length = 0;

  stream().emit("open");
  await settled();

  assert.deepEqual(log, []);
});

test("the reviewer's own feedback, once in the panel, is not news to a reconnect", async (t) => {
  const { stream, server, log } = world(t).page();
  server.serving = session(0, [said]);
  stream().emit("feedback");
  await settled();
  assert.deepEqual(log, ["panel 1 said", "banner"]);

  stream().emit("open");
  await settled();

  assert.deepEqual(log, ["panel 1 said", "banner"]);
});

test("an announced session is drawn even when nothing the page compares has moved", async (t) => {
  // The server said something moved; the comparison is a reduction, and news it leaves out
  // (approvals) must still land.
  const { stream, log } = world(t).page();

  stream().emit("session");
  await settled();

  assert.deepEqual(log, ["diff same-round", "panel 0 said", "banner"]);
});

test("an older answer landing last does not put the old round back", async (t) => {
  const { stream, server, log, live } = world(t).page();
  server.held = [];
  stream().emit("open");
  server.serving = session(1);
  stream().emit("session");
  const [older, newer] = server.held;
  assert.ok(older && newer, "both asks are in flight");

  newer();
  await settled();
  older();
  await settled();

  assert.equal(live.round, 1);
  assert.deepEqual(log, ["diff regrouped", "replay", "panel 0 said", "banner"]);
});

test("a session that cannot be fetched is logged, not thrown", async (t) => {
  const { stream, server, log } = world(t).page();
  const logged = t.mock.method(console, "error", () => {});
  server.failing = true;

  stream().emit("open");
  stream().emit("feedback");
  await settled();

  assert.deepEqual(log, []);
  assert.deepEqual(
    logged.mock.calls.map((call) => call.arguments[0]),
    [
      "lightspeed: the session could not be refreshed",
      "lightspeed: the conversation could not be refreshed",
    ],
  );
});

test("a stream the browser gave up on is opened again, and a dropped one is left to retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream, opened, server } = world(t).page();

  // Dropped: the browser is already retrying, a second stream would double every event.
  stream().emit("error");
  t.mock.timers.tick(REOPEN_MAX_MS);
  assert.equal(opened().length, 1);

  // Refused (a non-200 answer): closed for good unless the page opens another.
  stream().readyState = FakeEventSource.CLOSED;
  stream().emit("error");
  t.mock.timers.tick(REOPEN_MS - 1);
  assert.equal(opened().length, 1, "not before the wait is up");
  t.mock.timers.tick(1);
  assert.equal(opened().length, 2);

  // The new stream is wired like the first: its open asks for the session.
  stream().emit("open");
  await settled();
  assert.equal(server.fetched, 1);
});

test("a dropped stream shows the connection chip until it opens again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream, roots, connections } = world(t).page();
  stream().emit("open");
  assert.equal(roots.connection.hidden, true);

  // Dropped and retrying by itself: said all the same — by the header too.
  stream().emit("error");
  assert.equal(roots.connection.hidden, false);
  assert.equal(connections.at(-1), false);
  stream().emit("open");
  assert.equal(roots.connection.hidden, true);
  assert.equal(connections.at(-1), true);

  // Refused and reopened by the page: said until the new stream opens.
  stream().readyState = FakeEventSource.CLOSED;
  stream().emit("error");
  assert.equal(roots.connection.hidden, false);
  t.mock.timers.tick(REOPEN_MS);
  stream().emit("open");
  assert.equal(roots.connection.hidden, true);
});

test("a server that keeps refusing is asked ever more slowly, and an open resets the wait", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream, opened } = world(t).page();
  const refuse = (): void => {
    stream().readyState = FakeEventSource.CLOSED;
    stream().emit("error");
  };
  /** How long the next reopen took, found by ticking a second at a time. */
  const waited = (): number => {
    const before = opened().length;
    let ms = 0;
    while (opened().length === before) {
      t.mock.timers.tick(1000);
      ms += 1000;
    }
    return ms;
  };

  const waits = [1, 2, 3, 4, 5, 6].map(() => {
    refuse();
    return waited();
  });
  assert.deepEqual(waits, [5000, 10_000, 20_000, 40_000, 60_000, 60_000]);

  stream().emit("open");
  refuse();
  assert.equal(waited(), REOPEN_MS);
});

test("a reopened stream's events are heard once, by the new stream alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream, opened, server } = world(t).page();
  const dead = stream();
  dead.readyState = FakeEventSource.CLOSED;
  dead.emit("error");
  t.mock.timers.tick(REOPEN_MAX_MS * 2);
  assert.equal(opened().length, 2, "one new stream, however long the page waits");
  assert.notEqual(stream(), dead);

  stream().emit("open");
  stream().emit("session");
  stream().emit("feedback");
  await settled();

  assert.equal(server.fetched, 3, "one ask per event, not one per stream ever opened");
});

test("a new round held behind a waved-away card is not announced again by a reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream, server, roots, live } = world(t).page({
    scrolled: 500,
    queued: NOTHING_QUEUED,
    focus: 0,
  });
  server.serving = session(1);
  stream().emit("session");
  await settled();
  const stay = roots.popup.querySelector(".lsr-round-stay");
  assert.ok(stay, "the card is up");
  roots.popup.dispatch("click", { target: stay });
  t.mock.timers.tick(FOLD_MS);
  assert.equal(roots.popup.hidden, true);

  stream().emit("open");
  await settled();

  assert.equal(server.fetched, 2);
  assert.equal(roots.popup.hidden, true, "they already answered this question");
  assert.equal(roots.offer.hidden, false, "the round still waits in the header");
  assert.equal(live.round, 0);
});

test("a round the feedback answer carried is still drawn by the reopen it overtook", async (t) => {
  // Regression: a round published while the stream was down; the reopen asked, another tab's Send
  // fired `feedback`, and its answer — carrying the new round — landed first. Counting that
  // answer as drawn made the reopen's own answer look like old news, and the round never came.
  const { stream, server, log, live } = world(t).page();
  server.serving = session(1, [said]);
  server.held = [];
  stream().emit("open");
  stream().emit("feedback");
  const [reopen, feedback] = server.held;
  assert.ok(reopen && feedback, "both asks are in flight");

  feedback();
  await settled();
  reopen();
  await settled();

  assert.equal(live.round, 1);
  assert.deepEqual(log, [
    "panel 1 said",
    "banner",
    "diff regrouped",
    "replay",
    "panel 1 said",
    "banner",
  ]);
});

test("a session started over from nothing is not taken for the first round it replaced", async (t) => {
  // `session_corrupt` recovery deletes the session and starts it again: round 0 again, new diff.
  const { stream, server, log } = world(t).page();
  const again = session(0);
  again.rounds = [{ index: 0, at: "2025-02-01T00:00:00.000Z" }];
  server.serving = again;

  stream().emit("open");
  await settled();

  assert.ok(log.includes("banner"), "drawn, not skipped as unchanged");
});

test("an older answer landing first is drawn: a newer ask only overtakes it once it lands", async (t) => {
  const { stream, server, live } = world(t).page();
  server.held = [];
  server.serving = session(1);
  stream().emit("open");
  server.serving = session(2);
  stream().emit("session");
  const [older, newer] = server.held;
  assert.ok(older && newer, "both asks are in flight");

  older();
  await settled();
  assert.equal(
    live.round,
    1,
    "the newer ask might yet fail; the older answer is the best there is",
  );
  newer();
  await settled();
  assert.equal(live.round, 2);
});

test("an announcement overtaken by a reopen's answer is still drawn", async (t) => {
  // The reopen's answer stands for the announcement too: were it judged as a reopen alone, news
  // outside the comparison (approvals) would be skipped and the announcement's answer dropped.
  const { stream, server, log } = world(t).page();
  server.held = [];
  stream().emit("session");
  stream().emit("open");
  const [announced, reopened] = server.held;
  assert.ok(announced && reopened, "both asks are in flight");

  reopened();
  await settled();
  announced();
  await settled();

  assert.deepEqual(log, ["diff same-round", "panel 0 said", "banner"]);
});
