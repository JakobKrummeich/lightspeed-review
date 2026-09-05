import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile, DiffGroup } from "../../src/diff-extract.ts";
import type { DiffRenderer } from "../../src/browser/diff-renderer.ts";
import {
  counterLabel,
  fileApprovalFlips,
  groupApprovalFlips,
  groupApproved,
  overallCounterLabel,
  renderGroups,
  reviewApproved,
  toggleFileApproved,
  toggleGroupApproved,
  type ReviewRender,
} from "../../src/browser/diff-view.ts";

const stubRenderer: DiffRenderer = { renderFile: (diff) => `<pre class="stub">${diff}</pre>` };

/** A round nobody left a comment in before, which is what most of these are about. */
const noComments = new Set<string>();

/** A round whose files all stood still since the last one, ditto. */
const noChanges = new Set<string>();

/** A draw with everything not under test at its quietest; each test names only what it asserts on. */
function render(review: Partial<ReviewRender> & Pick<ReviewRender, "groups">): string {
  return renderGroups({
    approved: [],
    renderer: stubRenderer,
    approval: {},
    commented: noComments,
    sinceLastRound: noChanges,
    ...review,
  });
}

/** A draw of one chapter — the only view a diff is drawn in; the overview has no headers or rows. */
function chapter(review: Partial<ReviewRender> & Pick<ReviewRender, "groups">, focus = 0): string {
  return render({ ...review, focus });
}

function file(path: string, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    status: "modified",
    diff: `@@ -1 +1 @@\n-old\n+new ${path}`,
    insertions: 1,
    deletions: 1,
    oversized: false,
    ...overrides,
  };
}

function group(name: string, paths: string[], watch?: string): DiffGroup {
  return {
    name,
    rationale: `why ${name}`,
    ...(watch === undefined ? {} : { watch }),
    files: paths.map((path) => file(path)),
  };
}

test("a chapter renders behind the gate that states it, name and rationale", () => {
  const groups = [group("Schema", ["prisma/schema.prisma"]), group("API", ["src/api/users.ts"])];

  assert.match(chapter({ groups }), /class="lsr-gate-rationale">why Schema</);
  assert.match(chapter({ groups }, 1), /class="lsr-gate-rationale">why API</);
});

test("the overview is the index alone, and not one diff", () => {
  // Reading happens inside a chapter: rendered diffs on the overview were a wall to scroll past.
  const groups = [group("Schema", ["src/a.ts"]), group("API", ["src/b.ts"])];
  const failingRenderer: DiffRenderer = {
    renderFile: () => assert.fail("the overview draws no diff"),
  };

  const html = render({ groups, renderer: failingRenderer });

  assert.match(html, /class="lsr-index"/);
  assert.doesNotMatch(html, /class="lsr-group"/);
  assert.doesNotMatch(html, /class="lsr-file"/);
});

test("the index lists the groups in model order", () => {
  const groups = [group("Schema", ["a.ts"]), group("API", ["b.ts"])];

  const html = render({ groups });

  assert.deepEqual(
    [...html.matchAll(/class="lsr-index-name">([^<]+)</g)].map((match) => match[1]),
    ["Schema", "API"],
  );
});

test("renders each file's diff through the renderer", () => {
  const html = chapter({ groups: [group("API", ["src/api/users.ts"])] });

  assert.match(html, /<pre class="stub">@@ -1 \+1 @@/);
  assert.match(html, /new src\/api\/users.ts/);
});

test("counts approved files per group in the header", () => {
  const groups = [group("API", ["a.ts", "b.ts", "c.ts"])];

  const html = chapter({ groups, approved: ["a.ts", "c.ts"] });

  assert.match(html, /2\/3 approved/);
});

test("an approved file is checked and collapsed", () => {
  const html = chapter({ groups: [group("API", ["a.ts", "b.ts"])], approved: ["a.ts"] });

  const headers = html.match(/<button type="button" class="lsr-file-header"[^>]*>/g)!;
  assert.match(headers[0]!, /aria-expanded="false"/);
  assert.match(headers[1]!, /aria-expanded="true"/);
  assert.match(html, /<div class="lsr-file" data-file="a.ts"/);
  assert.match(html, /<input type="checkbox" class="lsr-approved" data-file="a.ts" checked/);
});

test("escapes group names and file paths so session data cannot inject markup", () => {
  const groups = [group('<img src=x onerror="alert(1)">', ['<script>"evil".ts'])];
  // The renderer escapes diff bodies itself; this is about the view's own markup.
  const emptyRenderer: DiffRenderer = { renderFile: () => "" };

  const html = chapter({ groups, renderer: emptyRenderer });

  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("a binary file shows a placeholder instead of calling the renderer", () => {
  const binary = { ...file("logo.png", { status: "binary", diff: "" }) };
  const failingRenderer: DiffRenderer = {
    renderFile: () => assert.fail("binary files must not reach the renderer"),
  };

  const html = chapter({
    groups: [{ name: "Assets", rationale: "images", files: [binary] }],
    renderer: failingRenderer,
  });

  assert.match(html, /binary file/i);
});

test("an empty grouping states so instead of rendering a blank page", () => {
  assert.match(render({ groups: [] }), /no changes/i);
});

test("counterLabel reports approved over total for one group", () => {
  assert.equal(counterLabel(group("API", ["a.ts", "b.ts"]), ["b.ts", "other.ts"]), "1/2 approved");
});

test("toggling a file on adds it once and toggling it off removes it", () => {
  assert.deepEqual(toggleFileApproved(["a.ts"], "b.ts", true), ["a.ts", "b.ts"]);
  assert.deepEqual(toggleFileApproved(["a.ts", "b.ts"], "b.ts", true), ["a.ts", "b.ts"]);
  assert.deepEqual(toggleFileApproved(["a.ts", "b.ts"], "a.ts", false), ["b.ts"]);
});

test("ticking a whole group adds its files and leaves other groups untouched", () => {
  const api = group("API", ["a.ts", "b.ts"]);

  assert.deepEqual(toggleGroupApproved(["z.ts"], api, true), ["z.ts", "a.ts", "b.ts"]);
  assert.deepEqual(toggleGroupApproved(["z.ts", "a.ts", "b.ts"], api, false), ["z.ts"]);
});

test("a group is approved exactly when every file in it is", () => {
  const api = group("API", ["a.ts", "b.ts"]);

  assert.equal(groupApproved(api, ["a.ts"]), false);
  assert.equal(groupApproved(api, ["a.ts", "b.ts"]), true);
  assert.equal(groupApproved(api, ["a.ts", "b.ts", "elsewhere.ts"]), true);
});

test("a group with no files in it is not approved, and says so", () => {
  // Vacuous truth would tick the box and dim the card for work nobody did.
  const empty = group("Empty", []);

  assert.equal(groupApproved(empty, []), false);
  assert.equal(counterLabel(empty, []), "0/0 approved");
  assert.doesNotMatch(chapter({ groups: [empty] }), /lsr-tick-all[^>]*checked/);
});

test("a file flips when its own tick changes, and only then", () => {
  const groups = [group("API", ["a.ts", "b.ts"])];

  assert.deepEqual(fileApprovalFlips(groups, [], ["a.ts"]), [{ path: "a.ts", approved: true }]);
  assert.deepEqual(fileApprovalFlips(groups, ["a.ts", "b.ts"], ["b.ts"]), [
    { path: "a.ts", approved: false },
  ]);
  assert.deepEqual(fileApprovalFlips(groups, ["a.ts"], ["a.ts", "elsewhere.ts"]), []);
});

test("ticking the last file of a group flips that group, and only that group", () => {
  const groups = [group("API", ["a.ts", "b.ts"]), group("Docs", ["c.ts"])];

  const flips = groupApprovalFlips(groups, ["a.ts"], ["a.ts", "b.ts"]);

  assert.deepEqual(flips, [{ index: 0, approved: true }]);
});

test("unticking a file in a fully approved group flips it back to unapproved", () => {
  const groups = [group("API", ["a.ts", "b.ts"])];

  const flips = groupApprovalFlips(groups, ["a.ts", "b.ts"], ["a.ts"]);

  assert.deepEqual(flips, [{ index: 0, approved: false }]);
});

test("a tick that leaves a group part-done flips nothing", () => {
  // A re-opened approved group must not slam shut on a tick elsewhere: only real flips are reported.
  const groups = [group("API", ["a.ts", "b.ts", "c.ts"]), group("Docs", ["d.ts"])];

  assert.deepEqual(groupApprovalFlips(groups, [], ["a.ts"]), []);
  assert.deepEqual(groupApprovalFlips(groups, ["d.ts"], ["d.ts", "a.ts"]), []);
});

test("ticking a group's own box flips the group in one go", () => {
  const api = group("API", ["a.ts", "b.ts"]);

  const ticked = toggleGroupApproved([], api, true);

  assert.deepEqual(groupApprovalFlips([api], [], ticked), [{ index: 0, approved: true }]);
  assert.deepEqual(groupApprovalFlips([api], ticked, toggleGroupApproved(ticked, api, false)), [
    { index: 0, approved: false },
  ]);
});

test("a group whose files are all approved loads marked", () => {
  const groups = [group("Settled", ["a.ts", "b.ts"]), group("Fresh", ["c.ts"])];
  const tick = (html: string): string =>
    html.match(/<input type="checkbox" class="lsr-tick-all"[^>]*>/)![0];

  // The tick is the whole mark: the card recedes off `:has(.lsr-tick-all:checked)`, nothing else
  // stored. Shut-ness not asserted — a chapter on screen always stands open.
  assert.match(tick(chapter({ groups, approved: ["a.ts", "b.ts"] })), / checked/);
  assert.doesNotMatch(tick(chapter({ groups, approved: ["a.ts", "b.ts"] }, 1)), / checked/);
});

test("the chapter's tick names itself, and stands apart from the file above it", () => {
  const html = chapter({ groups: [group("API", ["a.ts"])] });
  // Directly under a file's own "approve", so the word is what stops the two being read as one;
  // the spoken name says which files it is a verdict on.
  assert.match(html, /class="lsr-tick-label">approve chapter<\/span/);
  assert.match(html, /aria-label="Approve chapter: mark every file in it approved"/);
  assert.match(html, /aria-label="Mark a\.ts approved"/);
  // Its own row at the chapter's foot, so its padding ticks the box and toggles nothing.
  assert.match(html, /<div class="lsr-row lsr-group-foot"\s*><label class="lsr-tick"/);
});

test("the file tick sits after its diff, where reading the file ends", () => {
  const html = chapter({ groups: [group("API", ["a.ts"])] });
  // Reading ends at the bottom of the diff: a tick at the top means scrolling back up to use it.
  assert.ok(
    html.indexOf(`class="lsr-file-diff"`) < html.indexOf(`class="lsr-approved"`),
    "the file tick follows the diff it marks",
  );
  // Away from the file row, the box has no path beside it, so it labels itself.
  assert.match(html, /class="lsr-tick-label">approve<\/span/);
});

test("the chapter's reasons head it once, on the gate, and never over the diff", () => {
  // They used to head the first file's diff, where the eye went to the code and the sentences
  // were never read. Now the gate says them, and the diff below carries no copy of them.
  const html = chapter({ groups: [group("API", ["a.ts"], "The retry loop exit is new.")] });
  const content = html.slice(html.indexOf(`class="lsr-group-content"`));

  assert.equal(html.match(/why API/g)?.length, 1, "the rationale is said once");
  assert.equal(html.match(/The retry loop exit is new\./g)?.length, 1);
  assert.doesNotMatch(content, /why API|retry loop/, "nothing of it is repeated over the lines");
  assert.doesNotMatch(html, /lsr-group-header|lsr-group-name|lsr-group-rationale/);
});

test("overallCounterLabel counts approved files across every group", () => {
  const groups = [group("API", ["a.ts", "b.ts"]), group("Docs", ["c.ts"])];
  assert.equal(overallCounterLabel(groups, ["b.ts"]), "1/3 files approved");
  assert.equal(overallCounterLabel(groups, ["a.ts", "b.ts", "c.ts"]), "3/3 files approved");
  assert.equal(overallCounterLabel([], []), "nothing to review");
});

test("the review is approved only once every file in it is", () => {
  const groups = [group("API", ["a.ts", "b.ts"]), group("Docs", ["c.ts"])];

  assert.equal(reviewApproved(groups, []), false);
  assert.equal(reviewApproved(groups, ["a.ts", "c.ts"]), false, "one file short is not done");
  assert.equal(reviewApproved(groups, ["a.ts", "b.ts", "c.ts"]), true);
});

test("a file counts once however many groups list it, and a stranger counts for nothing", () => {
  const groups = [group("API", ["a.ts"]), group("Docs", ["a.ts", "c.ts"])];

  assert.equal(reviewApproved(groups, ["a.ts", "gone.ts"]), false, "c.ts is still unread");
  assert.equal(reviewApproved(groups, ["a.ts", "c.ts"]), true);
});

test("one file is a whole review, and no files are no achievement", () => {
  assert.equal(reviewApproved([group("API", ["a.ts"])], ["a.ts"]), true);
  // Same refusal `groupApproved` makes: there is nothing here to have approved.
  assert.equal(reviewApproved([], []), false);
  assert.equal(reviewApproved([], ["a.ts"]), false);
  assert.equal(reviewApproved([group("API", [])], []), false);
});

test("a binary or oversized file is a file the review is not done without", () => {
  const groups = [
    { name: "Assets", rationale: "why", files: [file("logo.png", { status: "binary", diff: "" })] },
    { name: "Data", rationale: "why", files: [file("dump.sql", { oversized: true })] },
  ];

  assert.equal(reviewApproved(groups, ["logo.png"]), false);
  assert.equal(reviewApproved(groups, ["logo.png", "dump.sql"]), true);
});

test("each tick box sits outside the section it marks, so collapsing keeps it", () => {
  const html = chapter({ groups: [group("API", ["a.ts"])] });
  // A tick nested in the section it marks would vanish exactly when needed; collapsing hides the
  // content element only, so both ticks stay on screen.
  assert.ok(
    html.indexOf(`class="lsr-group-content"`) < html.indexOf(`class="lsr-tick-all"`),
    "the chapter tick sits below the collapsible content, outside it",
  );
  assert.ok(
    html.indexOf(`class="lsr-file-diff"`) < html.indexOf(`class="lsr-approved"`),
    "the file tick sits below the collapsible diff, outside it",
  );
});

test("a file approved in an earlier round is dimmed and closed, and says nothing", () => {
  const groups = [group("API", ["a.ts", "b.ts"])];

  const html = chapter({
    groups,
    approved: ["a.ts"],
    approval: {
      "a.ts": "approved",
      "b.ts": "unapproved",
    },
  });

  assert.match(html, /<div class="lsr-file" data-file="a.ts" data-approval="approved"/);
  assert.match(html, /<div class="lsr-file" data-file="b.ts" data-approval="unapproved"/);
  // The tick and the dimming already say "approved"; a badge would repeat them.
  assert.ok(!html.includes("lsr-file-approval"));
  // Closed, diff hidden, and left where the group put it: being read is not a reason to move.
  const blocks = html.split('<div class="lsr-file"');
  assert.match(blocks[1]!, /data-file="a.ts"/);
  assert.match(blocks[1]!, /aria-expanded="false"/);
  assert.match(blocks[1]!, /<div class="lsr-file-diff" id="[^"]+" hidden>/);
});

test("a file the round says nothing about cannot have been approved in it", () => {
  const html = chapter({ groups: [group("API", ["a.ts"])] });

  assert.match(html, /data-approval="unapproved"/);
});

test("a file edited after it was approved says so, since nothing else shows it", () => {
  const html = chapter({
    groups: [group("API", ["a.ts"])],
    approval: {
      "a.ts": "needs-reapproval",
    },
  });

  assert.match(html, /data-approval="needs-reapproval"/);
  assert.match(html, /<span class="lsr-file-approval">changed after approval<\/span>/);
});

test("a file edited after approval offers the second diff, with the branch one pressed", () => {
  const html = chapter({
    groups: [group("API", ["a.ts"])],
    approval: {
      "a.ts": "needs-reapproval",
    },
  });

  assert.match(html, /data-form="branch"[^>]*data-status/, "the block starts on the branch diff");
  assert.match(
    html,
    /class="lsr-switch-option lsr-form-option" data-form="branch" aria-pressed="true">Branch diff</,
  );
  assert.match(
    html,
    /class="lsr-switch-option lsr-form-option" data-form="approved" aria-pressed="false">Since approval</,
  );
  assert.match(html, /aria-label="Which diff to show for a.ts"/);
  // The whole-file view joins the pair rather than displacing it, and comes last.
  assert.match(
    html,
    /Since approval<\/button>[^]*data-form="full" aria-pressed="false">Whole file</,
  );
});

test("a file that moved between rounds unapproved offers the round comparison", () => {
  const html = chapter({
    groups: [group("API", ["a.ts"])],
    sinceLastRound: new Set(["a.ts"]),
  });

  assert.match(html, /data-form="branch"[^>]*data-status/, "the block starts on the branch diff");
  assert.match(
    html,
    /class="lsr-switch-option lsr-form-option" data-form="branch" aria-pressed="true">Branch diff</,
  );
  assert.match(
    html,
    /class="lsr-switch-option lsr-form-option" data-form="last-round" aria-pressed="false">Since last round</,
  );
  assert.ok(!html.includes("Since approval"), "the approval never happened, so nothing claims it");
  assert.match(html, /aria-label="Which diff to show for a.ts"/);
});

test("a needs-reapproval file keeps the approval switch whatever the rounds say", () => {
  // Blobs moved between rounds too, but the approved form covers everything since the tick:
  // one comparison per file, and the approval names a verdict.
  const html = chapter({
    groups: [group("API", ["a.ts"])],
    approval: { "a.ts": "needs-reapproval" },
    sinceLastRound: new Set(["a.ts"]),
  });

  assert.match(html, /data-form="approved"[^>]*aria-pressed="false">Since approval</);
  assert.ok(!html.includes("Since last round"));
});

test("an ordinary file still offers the whole-file view, and only that", () => {
  const html = chapter({
    groups: [group("API", ["a.ts", "b.ts"])],
    approved: ["a.ts"],
    approval: {
      "a.ts": "approved",
      "b.ts": "unapproved",
    },
  });

  assert.match(html, /data-form="branch"[^>]*data-status/, "the block starts on the branch diff");
  assert.match(
    html,
    /class="lsr-switch-option lsr-form-option" data-form="branch" aria-pressed="true">Branch diff</,
  );
  assert.match(
    html,
    /class="lsr-switch-option lsr-form-option" data-form="full" aria-pressed="false">Whole file</,
  );
  assert.ok(!html.includes("Since approval"), "no approval was withdrawn, so nothing claims one");
  assert.ok(!html.includes("Since last round"));
});

test("added and renamed files offer the whole-file view too", () => {
  const html = chapter({
    groups: [
      {
        name: "API",
        rationale: "why API",
        files: [file("a.ts", { status: "added" }), file("b.ts", { status: "renamed" })],
      },
    ],
  });

  assert.equal(html.match(/>Whole file</g)?.length, 2);
});

test("a deleted or binary file offers no whole-file view: there is no new side to show", () => {
  const html = chapter({
    groups: [
      {
        name: "API",
        rationale: "why API",
        files: [file("gone.ts", { status: "deleted" }), file("logo.png", { status: "binary" })],
      },
    ],
  });

  assert.ok(!html.includes("lsr-form-switch"), "nothing else to show either, so no switch at all");
  assert.ok(!html.includes("data-form"));
});

test("a deleted file needing reapproval keeps its pair, without the whole-file option", () => {
  const html = chapter({
    groups: [
      { name: "API", rationale: "why API", files: [file("gone.ts", { status: "deleted" })] },
    ],
    approval: { "gone.ts": "needs-reapproval" },
  });

  assert.match(html, /data-form="approved"[^>]*aria-pressed="false">Since approval</);
  assert.ok(!html.includes("Whole file"));
});

test("an unapproved file the review has seen before is left to speak for itself", () => {
  const html = chapter({ groups: [group("API", ["a.ts"])], approval: { "a.ts": "unapproved" } });

  assert.match(html, /data-approval="unapproved"/);
  assert.ok(!html.includes("lsr-file-approval"));
});

/** A tick must not move the page under the reviewer: approval buys no position at all. */
test("a group's files keep the model's order whatever the reviewer approved", () => {
  const groups = [group("API", ["approved.ts", "unapproved.ts", "reapprove.ts"])];

  const html = chapter({
    groups,
    approved: ["approved.ts"],
    approval: {
      "approved.ts": "approved",
      "unapproved.ts": "unapproved",
      "reapprove.ts": "needs-reapproval",
    },
  });

  assert.deepEqual(
    [...html.matchAll(/class="lsr-file-path">([^<]+)</g)].map((match) => match[1]),
    ["approved.ts", "unapproved.ts", "reapprove.ts"],
  );
});

/** The same reading from the other side: approving a file moves nothing. */
test("the order a group renders in is the same before and after a file is approved", () => {
  const groups = [group("API", ["z.ts", "a.ts", "m.ts"])];
  const paths = (html: string): (string | undefined)[] =>
    [...html.matchAll(/class="lsr-file-path">([^<]+)</g)].map((match) => match[1]);

  const before = chapter({ groups });
  const after = chapter({ groups, approved: ["z.ts"], approval: { "z.ts": "approved" } });

  assert.deepEqual(paths(before), ["z.ts", "a.ts", "m.ts"]);
  assert.deepEqual(paths(after), paths(before));
});

test("the group with unapproved work is neither marked nor singled out", () => {
  const groups = [group("Settled", ["a.ts"]), group("Fresh", ["b.ts"])];
  const review = {
    groups,
    approved: ["a.ts"],
    approval: { "a.ts": "approved", "b.ts": "unapproved" } as const,
  };

  assert.doesNotMatch(chapter(review, 1), /lsr-tick-all[^>]*checked/);
  // Which chapter to read first is the reviewer's call: the survey names no favourite.
  assert.doesNotMatch(render(review), /start here/);
});

test("the heaviest file in a group wears the logic badge on its row", () => {
  const branchy = file("src/pay.ts", { diff: "@@ -1 +1,2 @@\n+  if (user.debt) refuse();" });
  const flat = file("src/const.ts", { diff: "@@ -1 +1 @@\n+const RETRIES = 5;" });

  const html = chapter({
    groups: [{ name: "Billing", rationale: "money", files: [flat, branchy] }],
  });

  const rows = [...html.matchAll(/class="lsr-file" data-file="([^"]+)"[\s\S]*?<\/button/g)];
  const badged = rows.filter(([body]) => body.includes("lsr-file-logic")).map(([, path]) => path);
  assert.deepEqual(badged, ["src/pay.ts"]);
});

test("a renamed file's row says so, with git's own similarity", () => {
  const renamed = {
    ...file("src/auth/token.ts"),
    status: "renamed" as const,
    previousPath: "src/token.ts",
    similarity: 96,
  };

  const html = chapter({ groups: [{ name: "Moves", rationale: "mechanical", files: [renamed] }] });

  assert.match(html, /renamed from src\/token\.ts, 96% identical/);
});

test("a file the reviewer commented on last round is marked, and its neighbours are not", () => {
  const groups = [group("API", ["src/api.ts", "src/db.ts"])];

  const html = chapter({ groups, commented: new Set(["src/api.ts"]) });

  const rows = [...html.matchAll(/class="lsr-file" data-file="([^"]+)"[\s\S]*?<\/button/g)];
  const badged = rows
    .filter(([body]) => body.includes("lsr-file-commented"))
    .map(([, path]) => path);
  assert.deepEqual(badged, ["src/api.ts"]);
  assert.match(html, /<span class="lsr-file-commented">commented last round<\/span>/);
});

test("a file renamed this round wears the badge left on the name it had last round", () => {
  const renamed = {
    ...file("src/http/api.ts"),
    status: "renamed" as const,
    previousPath: "src/api.ts",
  };

  const html = chapter({
    groups: [{ name: "Moves", rationale: "mechanical", files: [renamed] }],
    commented: new Set(["src/api.ts"]),
  });

  assert.match(html, /lsr-file-commented/);
});

test("a file both commented on and edited after approval says both things", () => {
  const html = chapter({
    groups: [group("API", ["src/api.ts"])],
    approval: { "src/api.ts": "needs-reapproval" },
    commented: new Set(["src/api.ts"]),
  });

  // The comment came first and the edit answers it: the row reads in that order.
  assert.match(
    html,
    /<span class="lsr-file-commented">commented last round<\/span><span class="lsr-file-approval">changed after approval<\/span>/,
  );
});

test("a round nobody has commented in yet marks nothing", () => {
  const html = chapter({ groups: [group("API", ["src/api.ts"])] });

  assert.ok(!html.includes("lsr-file-commented"));
});

test("a focused review is one chapter and its bar: no index, no other groups", () => {
  const groups = [group("Schema", ["a.ts"]), group("API", ["b.ts"]), group("Docs", ["c.ts"])];

  const html = render({ groups, focus: 1 });

  assert.match(html, /class="lsr-focus-bar"/);
  assert.doesNotMatch(html, /class="lsr-index"/);
  const sections = html.match(/<section class="lsr-group"[^>]*>/g);
  assert.equal(sections?.length, 1);
  // The real index, so ticks, counters and annotations still name the chapter.
  assert.match(sections![0]!, /data-group-index="1"/);
  assert.doesNotMatch(html, /new a\.ts/);
  assert.match(html, /new b\.ts/);
  assert.doesNotMatch(html, /new c\.ts/);
});

test("a chapter's section carries its tier only when there is one to act on", () => {
  // The card's chrome reads it: a sweep chapter's card offers its tick, a study chapter's
  // holds it back until the diff is up. Absent on study, as it is on the progress bar.
  const sweep = render({ groups: [{ ...group("Docs", ["c.md"]), tier: "sweep" }], focus: 0 });
  assert.match(sweep, /<section class="lsr-group" data-group-index="0" data-tier="sweep">/);

  const study = render({ groups: [{ ...group("API", ["b.ts"]), tier: "study" }], focus: 0 });
  assert.match(study, /<section class="lsr-group" data-group-index="0">/);
  assert.doesNotMatch(study, /data-tier/);
});

test("a focused chapter opens behind its gate, whichever way it was entered", () => {
  // Every draw renders the chapter shut: entering, re-entering and stepping sideways all come
  // through here, and each of them is a chapter being entered, so each of them is gated.
  const html = render({ groups: [group("API", ["b.ts"])], focus: 0 });

  assert.match(html, /class="lsr-gate-press" aria-expanded="false" aria-controls="([^"]+)"/);
  const contentId = /aria-controls="([^"]+)"/.exec(html)![1];
  assert.match(html, new RegExp(`<div class="lsr-group-content" id="${contentId}" hidden>`));
});

test("the gate is drawn with the chapter, so the diff is one press away and not one draw", () => {
  // Hidden, not absent: the press is then the fold that is already there, and a tick that
  // finishes the chapter can shut it back onto the card it opened behind.
  const html = render({ groups: [group("API", ["b.ts"])], focus: 0 });

  assert.match(html, /<pre class="stub">/, "the diff is rendered");
  assert.match(html, /class="lsr-file" data-file="b\.ts"/);
});

test("a focus the review does not have falls back to the overview", () => {
  const groups = [group("Schema", ["a.ts"]), group("API", ["b.ts"])];

  const html = render({ groups, focus: 7 });

  assert.match(html, /class="lsr-index"/);
  assert.doesNotMatch(html, /class="lsr-focus-bar"/);
  assert.doesNotMatch(html, /class="lsr-group"/);
});

test("no focus renders the overview, exactly as an absent one does", () => {
  const groups = [group("Schema", ["a.ts"])];

  assert.equal(render({ groups }), render({ groups, focus: undefined }));
});
