import { test } from "node:test";
import assert from "node:assert/strict";
import { mountPanelRail, type MountedRail } from "../../../src/browser/dom/panel-rail.ts";

/** The four things the rail touches: attributes, one click listener, the badge, `dataset`. */
class FakeRail {
  readonly attributes: Record<string, string> = {};
  readonly badge = { textContent: "", hidden: true };
  private readonly withBadge: boolean;
  private click: (() => void) | undefined;

  constructor(withBadge: boolean) {
    this.withBadge = withBadge;
  }

  querySelector(selector: string): unknown {
    return selector === ".lsr-rail-badge" && this.withBadge ? this.badge : null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "click") this.click = listener;
  }

  press(): void {
    this.click?.();
  }
}

function mounted(withBadge = true): {
  rail: FakeRail;
  page: { dataset: Record<string, string> };
  toggles: () => number;
  control: MountedRail;
} {
  const rail = new FakeRail(withBadge);
  const page = { dataset: {} as Record<string, string> };
  let toggles = 0;
  const control = mountPanelRail({
    rail: rail as unknown as HTMLElement,
    page: page as unknown as HTMLElement,
    onToggle: () => void (toggles += 1),
  });
  return { rail, page, toggles: () => toggles, control };
}

test("every session starts with the conversation open, and says so", () => {
  const { rail, page, toggles, control } = mounted();

  assert.equal(page.dataset.panel, "open");
  assert.equal(rail.attributes["aria-expanded"], "true");
  assert.equal(rail.attributes["aria-label"], "Hide the conversation");
  assert.equal(rail.badge.hidden, true);
  assert.equal(control.isOpen(), true);
  assert.equal(toggles(), 0, "the first draw is not a toggle");
});

test("a press shuts the panel and the next one opens it, each a toggle", () => {
  const { rail, page, toggles, control } = mounted();

  rail.press();
  assert.equal(page.dataset.panel, "collapsed");
  assert.equal(rail.attributes["aria-expanded"], "false");
  assert.equal(rail.attributes["aria-label"], "Show the conversation");
  assert.equal(control.isOpen(), false);
  assert.equal(toggles(), 1);

  rail.press();
  assert.equal(page.dataset.panel, "open");
  assert.equal(control.isOpen(), true);
  assert.equal(toggles(), 2);
});

test("queued notes are counted on the shut rail only, and never toggle it", () => {
  const { rail, toggles, control } = mounted();

  // onToggle re-asks the view breakpoint and files the panel's replies as
  // seen: a queue count calling it would mark words read behind a shut panel.
  control.setQueued(2);
  assert.equal(rail.badge.hidden, true, "open, the pills are the count");
  rail.press();
  assert.equal(rail.badge.textContent, "2");
  assert.equal(rail.badge.hidden, false);
  assert.equal(rail.attributes["aria-label"], "Show the conversation — 2 queued");
  control.setQueued(0);
  assert.equal(rail.badge.hidden, true);
  assert.equal(toggles(), 1, "only the press toggled");
});

test("expand says whether it opened anything, and toggles only when it did", () => {
  const { rail, toggles, control } = mounted();

  // session-events takes the panel to its foot only on true: an open panel
  // the reviewer has scrolled up in must not be yanked down by an answer.
  assert.equal(control.expand(), false);
  assert.equal(toggles(), 0);

  rail.press();
  assert.equal(control.expand(), true);
  assert.equal(control.isOpen(), true);
  assert.equal(toggles(), 2);
});

test("a rail without its badge still opens and shuts", () => {
  const { rail, page, control } = mounted(false);

  control.setQueued(3);
  rail.press();
  assert.equal(page.dataset.panel, "collapsed");
  assert.equal(rail.attributes["aria-label"], "Show the conversation — 3 queued");
});
