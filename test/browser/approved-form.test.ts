import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FORM_UNAVAILABLE,
  FULL_OPTION,
  LAST_ROUND_FORM_OPTIONS,
  parseFileForm,
  renderFetchedForm,
} from "../../src/browser/approved-form.ts";
import type { ApprovedFormData } from "../../src/rounds/approved-form.ts";
import type { DiffRenderer } from "../../src/browser/diff-renderer.ts";

const renderer: DiffRenderer = { renderFile: (diff) => `<pre>${diff}</pre>` };

function data(over: Partial<ApprovedFormData> = {}): ApprovedFormData {
  return {
    path: "src/a.ts",
    paths: ["src/a.ts"],
    from: "1111111aaaaaaa",
    to: "2222222bbbbbbb",
    state: "diff",
    diff: "@@ -1 +1 @@\n-old\n+new",
    ...over,
  };
}

function render(over: Partial<ApprovedFormData> = {}): string {
  return renderFetchedForm("approved", { data: data(over), renderer });
}

function renderLastRound(over: Partial<ApprovedFormData> = {}): string {
  return renderFetchedForm("last-round", { data: data(over), renderer });
}

test("the view is the note and the diff, and nothing the reviewer did not ask for", () => {
  const html = render();

  assert.match(html, /<pre>@@ -1 \+1 @@\n-old\n\+new<\/pre>/, "the diff goes through the renderer");
  assert.doesNotMatch(html, /What changed after you approved/, "the heading is gone");
  assert.doesNotMatch(html, /lsr-approved-sha/, "and with it the commit range");
  assert.doesNotMatch(html, /Round 2/, "the rounds are the conversation panel's job");
});

test("the view says feedback is off in it, where the reviewer would try to give it", () => {
  const html = render();

  assert.match(html, /Feedback is off in this view/);
  // Nothing on screen names the two commits any more, so the note may not point
  // at them; it names the press that gets the reviewer a view they can comment on.
  assert.doesNotMatch(html, /these two commits/);
  assert.match(
    html,
    /press Branch diff to leave one/,
    "the option is named as the switch names it",
  );
});

test("a view with no diff in it does not talk about line numbers it is not showing", () => {
  // Each state is one sentence about why there is nothing to read; nothing to select either,
  // so the note would answer a question the reviewer cannot ask.
  for (const state of ["identical", "binary", "unreachable", "unrecorded", "oversize"] as const) {
    assert.doesNotMatch(render({ state, diff: undefined }), /Feedback is off/, state);
  }
});

test("a commit git no longer has says so, and shows no diff at all", () => {
  const html = render({ state: "unreachable", diff: undefined });

  assert.match(html, /cannot be reconstructed/);
  assert.match(html, /rebase or a force-push/);
  assert.doesNotMatch(html, /<pre>/, "nothing is guessed in place of the diff");
});

test("a round that recorded no commit is not blamed on a rebase that never happened", () => {
  // A pre-commit-storage session: saying "force-push" would send the reviewer hunting through
  // a history nobody rewrote.
  const html = render({ from: null, state: "unrecorded", diff: undefined });

  assert.match(html, /recorded no commit for one of the two rounds/);
  assert.match(html, /Nothing was rewritten\./);
  assert.doesNotMatch(html, /rebase or a force-push/);
});

test("a file changed and changed back says so instead of showing an empty diff", () => {
  const html = render({ state: "identical", diff: undefined });

  assert.match(html, /byte for byte the form you approved/);
  assert.doesNotMatch(html, /<pre>/);
});

test("a file with no lines to show says which of the two versions is binary", () => {
  // Decided from the patch, server-side: a file that was text when it was
  // approved and is binary now is exactly what the reviewer is here to see.
  const html = render({ state: "binary", diff: undefined });

  assert.match(html, /one of the two versions is binary/);
  assert.match(html, /If the file was text when you approved it, that is itself the change\./);
  assert.doesNotMatch(html, /<pre>/);
});

test("a patch too large to render is measured and handed to git", () => {
  const html = render({ state: "oversize", diff: undefined, bytes: 2 * 1024 * 1024 });

  assert.match(html, /2048 kB of patch/);
  assert.match(html, /git diff --find-renames 1111111 2222222 -- src\/a\.ts/);
});

test("the command handed over names every name the file has been through", () => {
  // A `git diff` given only today's path prints nothing at all for a file that
  // was renamed since the approval, which is when the reviewer needs it most.
  const html = render({
    state: "oversize",
    diff: undefined,
    bytes: 700 * 1024,
    paths: ["src/old.ts", "src/a.ts"],
  });

  assert.match(html, /git diff --find-renames 1111111 2222222 -- src\/old\.ts src\/a\.ts/);
});

test("a patch git itself would not hand over is named without a made-up size", () => {
  const html = render({ state: "oversize", diff: undefined });

  assert.match(html, /larger than git will hand over in one piece/);
  assert.doesNotMatch(html, /0 kB/);
});

test("the last-round view is the same note and diff, under the same markup", () => {
  const html = renderLastRound();

  assert.match(html, /<pre>@@ -1 \+1 @@\n-old\n\+new<\/pre>/);
  assert.match(html, /Feedback is off in this view/);
  assert.match(html, /press Branch diff to leave one/);
});

test("the last-round view speaks of the last round, never of an approval", () => {
  // Same states, different question: these files were never approved, and a
  // sentence about "the form you approved" would claim a verdict nobody gave.
  const states = {
    identical: /byte for byte what the last round showed/,
    binary: /If the file was text last round, that is itself the change\./,
    unreachable: /The form the last round showed cannot be reconstructed/,
    unrecorded: /nothing to compare the last round against/,
  } as const;
  for (const [state, phrase] of Object.entries(states)) {
    const html = renderLastRound({ state: state as ApprovedFormData["state"], diff: undefined });
    assert.match(html, phrase, state);
    // The class names stay `lsr-approved-*` on purpose — same chrome, same CSS —
    // so only the words the reviewer reads are held to the different question.
    assert.doesNotMatch(html, /you approved|your approval/, state);
  }
});

test("an oversize last-round patch is measured against the last round, not a tick", () => {
  const html = renderLastRound({ state: "oversize", diff: undefined, bytes: 2 * 1024 * 1024 });

  assert.match(html, /The change since the last round is 2048 kB of patch/);
  assert.match(html, /git diff --find-renames 1111111 2222222 -- src\/a\.ts/);
  assert.doesNotMatch(html, /you approved|your approval/);
});

test("the last-round switch offers the branch diff and the round comparison", () => {
  assert.deepEqual(
    LAST_ROUND_FORM_OPTIONS.map(({ form, label }) => ({ form, label })),
    [
      { form: "branch", label: "Branch diff" },
      { form: "last-round", label: "Since last round" },
    ],
  );
});

test("every form of any switch parses back off the DOM, and nothing else does", () => {
  assert.equal(parseFileForm("branch"), "branch");
  assert.equal(parseFileForm("approved"), "approved");
  assert.equal(parseFileForm("last-round"), "last-round");
  assert.equal(parseFileForm("full"), "full");
  assert.equal(parseFileForm("sideways"), undefined);
  assert.equal(parseFileForm(undefined), undefined);
});

test("the whole-file option names what it shows, as the others do", () => {
  assert.deepEqual({ ...FULL_OPTION }, { form: "full", label: "Whole file" });
});

test("a whole file the server cannot hand over is explained in one sentence", () => {
  const html = FORM_UNAVAILABLE.full;

  assert.match(html, /^<p class="lsr-approved-missing">/);
  assert.match(html, /could not be read/);
  assert.match(html, /Press Branch diff for the ordinary one\./);
});
