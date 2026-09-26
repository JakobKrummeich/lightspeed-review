import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mountTabBeacon, type BeaconPage } from "../../../src/browser/dom/tab-beacon-mount.ts";
import { FAVICON, FAVICON_LIT } from "../../../src/browser/tab-beacon.ts";
import type { Turn } from "../../../src/session-store.ts";

const YOURS: Turn = { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" };
const AGENTS: Turn = { holder: "agent", mode: "working", at: "2025-01-01T00:01:00.000Z" };
const TITLE = "feat ← main · lightspeed";

/** The document as the beacon sees it: a title, a favicon link, and whether anybody is looking. */
class FakePage {
  title = TITLE;
  hidden = false;
  readonly icon = { href: FAVICON };
  private readonly listeners: (() => void)[] = [];

  querySelector(selector: string): { href: string } | null {
    return selector === 'link[rel="icon"]' ? this.icon : null;
  }

  addEventListener(type: string, handler: () => void): void {
    if (type === "visibilitychange") this.listeners.push(handler);
  }

  /** The reviewer switching tabs, as the browser reports it. */
  show(hidden: boolean): void {
    this.hidden = hidden;
    for (const handler of this.listeners) handler();
  }
}

function mounted(t: TestContext, opening: Turn = AGENTS, still = false, ended = false) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const page = new FakePage();
  const status = ended ? "ended" : "feedback";
  const beacon = mountTabBeacon(
    page as unknown as BeaconPage,
    { status, turn: opening },
    () => still,
  );
  return { page, beacon };
}

test("the turn coming back to a hidden tab lights its title and favicon", (t) => {
  const { page, beacon } = mounted(t);
  page.show(true);

  beacon.setTurn(YOURS);

  assert.equal(page.title, `● Your turn · ${TITLE}`);
  assert.equal(page.icon.href, FAVICON_LIT[0]);
});

test("a lit favicon twinkles between its two frames once a second", (t) => {
  const { page, beacon } = mounted(t);
  page.show(true);
  beacon.setTurn(YOURS);

  t.mock.timers.tick(1000);
  assert.equal(page.icon.href, FAVICON_LIT[1]);
  t.mock.timers.tick(1000);
  assert.equal(page.icon.href, FAVICON_LIT[0]);
});

test("looking at the tab puts everything back and stops the twinkle", (t) => {
  const { page, beacon } = mounted(t);
  page.show(true);
  beacon.setTurn(YOURS);

  page.show(false);
  t.mock.timers.tick(5000);

  assert.equal(page.title, TITLE);
  assert.equal(page.icon.href, FAVICON);
});

test("for a reviewer who asked for less movement the favicon lights on one frame", (t) => {
  const { page, beacon } = mounted(t, AGENTS, true);
  page.show(true);
  beacon.setTurn(YOURS);

  t.mock.timers.tick(3000);

  assert.equal(page.icon.href, FAVICON_LIT[0]);
  assert.equal(page.title, `● Your turn · ${TITLE}`);
});

test("a tab being looked at when the turn comes back stays dark", (t) => {
  const { page, beacon } = mounted(t);

  beacon.setTurn(YOURS);

  assert.equal(page.title, TITLE);
  assert.equal(page.icon.href, FAVICON);
});

test("only a flip is news: a tab hidden on the reviewer's own turn stays dark", (t) => {
  // The presence frames restate the turn on every reconnect; the reviewer who
  // left on their own turn already knew it was theirs.
  const { page, beacon } = mounted(t, YOURS);
  page.show(true);

  beacon.setTurn(YOURS);

  assert.equal(page.title, TITLE);
});

test("the turn going back to the agent before anybody looked takes the beacon down", (t) => {
  const { page, beacon } = mounted(t);
  page.show(true);
  beacon.setTurn(YOURS);

  beacon.setTurn(AGENTS);
  t.mock.timers.tick(2000);

  assert.equal(page.title, TITLE);
  assert.equal(page.icon.href, FAVICON);
});

test("a page with no favicon still says it in the title", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const page = new FakePage();
  page.querySelector = () => null;
  const beacon = mountTabBeacon(
    page as unknown as BeaconPage,
    { status: "feedback", turn: AGENTS },
    () => false,
  );
  page.show(true);

  beacon.setTurn(YOURS);

  assert.equal(page.title, `● Your turn · ${TITLE}`);
  assert.equal(page.icon.href, FAVICON);
});

test("an ended review keeps the tab dark, though its end hands the turn back", (t) => {
  // Regression: `lightspeed end` writes a reviewer turn, which lit a hidden tab's title.
  const { page, beacon } = mounted(t);
  page.show(true);

  beacon.setEnded(true);
  beacon.setTurn(YOURS);

  assert.equal(page.title, TITLE);
  assert.equal(page.icon.href, FAVICON);
});

test("a page opened on an ended review keeps the tab dark from its first frame", (t) => {
  const { page, beacon } = mounted(t, AGENTS, false, true);
  page.show(true);

  beacon.setTurn(YOURS);

  assert.equal(page.title, TITLE);
  assert.equal(page.icon.href, FAVICON);
});

test("a reopened review lights the tab again when the agent hands the turn back", (t) => {
  // Regression: the end put the beacon out for good, and `open --reopen` left that page dark.
  const { page, beacon } = mounted(t);
  beacon.setTurn(YOURS);
  beacon.setEnded(true);

  beacon.setEnded(false);
  page.show(true);
  assert.equal(page.title, TITLE, "the reopen itself is no flip");
  beacon.setTurn(AGENTS);
  beacon.setTurn(YOURS);

  assert.equal(page.title, `● Your turn · ${TITLE}`);
  assert.equal(page.icon.href, FAVICON_LIT[0]);
});

test("the turns an ended review goes through are followed, so the reopen is not a flip", (t) => {
  // The end hands the turn to the reviewer while ended; reopened, that reviewer turn restated
  // is the one the page already knew, not news.
  const { page, beacon } = mounted(t);
  page.show(true);
  beacon.setEnded(true);
  beacon.setTurn(YOURS);

  beacon.setEnded(false);
  beacon.setTurn(YOURS);

  assert.equal(page.title, TITLE);
});

test("the end puts out a beacon that was already lit, and its twinkle with it", (t) => {
  const { page, beacon } = mounted(t);
  page.show(true);
  beacon.setTurn(YOURS);

  beacon.setEnded(true);
  t.mock.timers.tick(3000);

  assert.equal(page.title, TITLE);
  assert.equal(page.icon.href, FAVICON);
});
