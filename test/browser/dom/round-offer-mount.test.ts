import { test } from "node:test";
import assert from "node:assert/strict";
import { mountRoundOffer } from "../../../src/browser/dom/round-offer-mount.ts";
import type { SessionData } from "../../../src/browser/dom/session-api.ts";
import type { DiffFile } from "../../../src/diff-extract.ts";
import { asPanelRoot, FakeNode } from "./fake-panel-dom.ts";

function file(path: string): DiffFile {
  return {
    path,
    status: "modified",
    diff: `@@ -1 +1 @@\n-old\n+new ${path}`,
    insertions: 1,
    deletions: 1,
    oversized: false,
  };
}

/** A round of `paths`, cut into one group per name given. */
function session(round: number, groups: Record<string, string[]>): SessionData {
  return {
    intents: [],
    commits: [],
    groups: Object.entries(groups).map(([name, paths]) => ({
      name,
      rationale: "",
      files: paths.map(file),
    })),
    approved: [],
    approval: {},
    conversation: [],
    rounds: Array.from({ length: round + 1 }, (_unused, index) => ({
      index,
      at: `2025-01-0${index + 1}T00:00:00.000Z`,
    })),
    pending: [],
    status: "feedback",
  };
}

/** The button as the shell renders it: in the header, empty and hidden. */
function mount(): { root: FakeNode; taken: SessionData[] } {
  const root = new FakeNode("button", 'id="lsr-round-offer" hidden');
  const taken: SessionData[] = [];
  const offer = mountRoundOffer({ root: asPanelRoot(root), onTake: (fresh) => taken.push(fresh) });
  Object.assign(root, { offer });
  return { root, taken };
}

function control(root: FakeNode): ReturnType<typeof mountRoundOffer> {
  return (root as unknown as { offer: ReturnType<typeof mountRoundOffer> }).offer;
}

test("an offered round names itself and says how big it is", () => {
  const { root } = mount();

  control(root).offer(session(1, { API: ["src/a.ts", "src/b.ts"] }));

  assert.equal(root.hidden, false);
  assert.equal(root.textContent, "Round 2 is ready · 2 files");
});

test("a file in two groups is one file to read", () => {
  const { root } = mount();

  control(root).offer(session(1, { API: ["src/a.ts"], Tests: ["src/a.ts", "test/a.test.ts"] }));

  assert.equal(root.textContent, "Round 2 is ready · 2 files");
});

test("pressing it hands over the round that was offered", () => {
  const { root, taken } = mount();
  const fresh = session(1, { API: ["src/a.ts"] });

  control(root).offer(fresh);
  root.dispatch("click", {});

  assert.deepEqual(taken, [fresh]);
  assert.equal(root.hidden, true, "there is nothing left to take");
});

test("a second round replaces the first rather than queueing behind it", () => {
  const { root, taken } = mount();
  const older = session(1, { API: ["src/a.ts"] });
  const newer = session(2, { API: ["src/a.ts", "src/b.ts"] });

  control(root).offer(older);
  control(root).offer(newer);
  root.dispatch("click", {});

  // Taking the older one would open a diff the repository has moved past, and
  // a reviewer who read through two rounds is not owed two presses.
  assert.deepEqual(taken, [newer]);
  assert.equal(root.textContent, "Round 3 is ready · 2 files");
});

test("a press with nothing offered does nothing at all", () => {
  const { root, taken } = mount();

  root.dispatch("click", {});

  assert.deepEqual(taken, []);
});

test("a round that went on screen by itself leaves no offer standing", () => {
  const { root, taken } = mount();

  control(root).offer(session(1, { API: ["src/a.ts"] }));
  control(root).clear();
  root.dispatch("click", {});

  assert.equal(root.hidden, true);
  assert.deepEqual(taken, [], "the press is on a control that no longer stands for anything");
});

test("a dismissed popup leaves the offer beckoning until it is pressed", () => {
  const { root, taken } = mount();

  control(root).offer(session(1, { API: ["src/a.ts"] }));
  control(root).beckon();

  assert.equal(root.dataset.beckon, "true", "the button calls out for the press it is owed");

  root.dispatch("click", {});

  assert.equal(root.dataset.beckon, undefined, "a pressed button has nothing to call for");
  assert.equal(taken.length, 1);
});

test("a beckon with nothing offered is a call about nothing, and is not made", () => {
  const { root } = mount();

  control(root).beckon();

  assert.equal(root.dataset.beckon, undefined);
});

test("a round that went on screen by itself takes the beckon with it", () => {
  const { root } = mount();

  control(root).offer(session(1, { API: ["src/a.ts"] }));
  control(root).beckon();
  control(root).clear();

  assert.equal(root.dataset.beckon, undefined);
});
