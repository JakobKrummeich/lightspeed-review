import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile, DiffGroup } from "../../../src/diff-extract.ts";
import { mountDiffView, type MountedDiff } from "../../../src/browser/dom/diff-mount.ts";
import type { SessionData } from "../../../src/browser/dom/session-api.ts";
import type { ApprovedFormData } from "../../../src/rounds/approved-form.ts";
import type { Approval } from "../../../src/rounds/history.ts";
import type { OpenFolds } from "../../../src/browser/collapse-plan.ts";
import { asElement, FakeElement, FakeInput, installFakeDom } from "./fake-diff-dom.ts";

/** Binary on purpose: a placeholder keeps diff2html and the highlighter (which wants the network) out of tests about ticks. */
function file(path: string): DiffFile {
  return {
    path,
    status: "binary",
    diff: "",
    insertions: 0,
    deletions: 0,
    oversized: false,
  };
}

function group(name: string, paths: string[]): DiffGroup {
  return { name, rationale: `why ${name}`, files: paths.map(file) };
}

/** For tests needing a real diff. Extension gates highlighting: `.txt` has no grammar, `.ts` does. */
function textFile(path: string): DiffFile {
  return {
    path,
    status: "modified",
    diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-const old = 1;\n+const branch = 2;\n`,
    insertions: 1,
    deletions: 1,
    oversized: false,
  };
}

/** Prior rounds' conversation, for the last-round-feedback tests; default is an unspoken review. */
type History = Pick<SessionData, "conversation" | "rounds">;

const FIRST_ROUND: History = {
  conversation: [],
  rounds: [{ index: 0, at: "2025-01-01T00:00:00.000Z" }],
};

/** A second round, opened after the reviewer annotated these files in the first. */
function answered(paths: string[]): History {
  return {
    conversation: [
      {
        role: "reviewer",
        at: "2025-01-01T01:00:00.000Z",
        roundIndex: 0,
        prompts: paths.map((path) => ({
          type: "annotation",
          file: path,
          group: "API",
          selected_text: "old",
          comment: `about ${path}`,
        })),
      },
    ],
    rounds: [
      { index: 0, at: "2025-01-01T00:00:00.000Z" },
      { index: 1, at: "2025-01-02T00:00:00.000Z" },
    ],
  };
}

function session(
  groups: DiffGroup[],
  approved: string[],
  approval: Record<string, Approval> = {},
  history: History = FIRST_ROUND,
): SessionData {
  return {
    intents: [],
    commits: [],
    groups,
    approved,
    approval,
    ...history,
    pending: [],
    status: "open",
  };
}

/** What the fake server answers when a file's approved form is asked for. */
interface FormAnswer {
  data?: ApprovedFormData;
  /** Set when the server has no such answer, which is a 404 on the wire. */
  missing?: boolean;
}

interface MountOptions {
  approval?: Record<string, Approval>;
  form?: FormAnswer;
  /** What the server hands over for the file's whole new side; absent is a 404. */
  contents?: string;
  history?: History;
  /** What the reviewer had open when they were last on this round. */
  open?: OpenFolds;
  /** The chapter focus mode was on when they were last on this round. */
  focus?: number;
}

interface Mounted {
  root: FakeElement;
  /** The element the review scrolls in, which is what an anchored fold is paid out of. */
  scroller: FakeElement;
  progress: FakeElement;
  view: MountedDiff;
  /** Every path this page posted as approved, oldest call first. */
  posted: string[][];
  /** Every fetched-form URL this page asked for — either endpoint — oldest first. */
  asked: string[];
  /** Every report of whether the whole review is approved, oldest first. */
  reported: boolean[];
  /** Every report of what stands open, oldest first. */
  opened: OpenFolds[];
  /** Every report of the focused chapter, oldest first. */
  focused: (number | undefined)[];
  /** Every whole-file read the highlighting pass made, which is how it is counted. */
  read: string[];
  /** The press on a chapter's gate: the control that stands for the whole chapter's fold. */
  gatePress(index: number): FakeElement;
  groupContent(index: number): FakeElement;
  groupTick(index: number): FakeInput;
  fileHeader(path: string): FakeElement;
  /** The row the file's tick sits in, which is what a tick holds still. */
  fileFoot(path: string): FakeElement;
  fileTick(path: string): FakeInput;
  /** The reviewer pressing "Read the diff", which is what opens a chapter. */
  open(index: number): void;
  /** The same for one file, whose header is its own toggle. */
  openFile(path: string): void;
  /** The reviewer ticking a box, which is a change event with a new state. */
  tick(box: FakeInput, checked: boolean): void;
  /** The reviewer pressing one side of a file's own diff switch. */
  pickForm(path: string, form: string): void;
  fileBlock(path: string): FakeElement;
  /** Lets the toggle's fetch and its handler run before anything is asserted. */
  settle(): Promise<void>;
  /** Polls for the highlighting pass: grammars are dynamic imports, several awaits deep, so ticks can't count it. */
  until(ready: () => boolean, what: string): Promise<void>;
}

function mount(
  t: TestContext,
  groups: DiffGroup[],
  approved: string[] = [],
  options: MountOptions = {},
): Mounted {
  const root = new FakeElement();
  const progress = new FakeElement();
  // A collapse is measured against the scrolling element, not the diff root.
  const scroller = new FakeElement("main", `class="lsr-review"`);
  scroller.append(root);
  installFakeDom(scroller);
  const posted: string[][] = [];
  const asked: string[] = [];
  const read: string[] = [];
  const reported: boolean[] = [];
  const opened: OpenFolds[] = [];
  const focused: (number | undefined)[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/approved-form") || url.includes("/last-round-form")) {
      asked.push(url);
      const answer = options.form ?? { missing: true };
      if (answer.missing || !answer.data) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(answer.data), { status: 200 });
    }
    // Whole-file reads refused unless a test hands contents over: counted to see
    // which blocks were painted; a block with no file highlights its own lines.
    if (url.includes("/file?")) {
      read.push(url);
      const query = new URL(url, "http://x").searchParams;
      if (options.contents !== undefined && query.get("side") === "new") {
        return new Response(
          JSON.stringify({ path: query.get("path"), side: "new", contents: options.contents }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    }
    posted.push((JSON.parse(String(init?.body)) as { approved: string[] }).approved);
    assert.equal(url, "/api/session/key/approved");
    return new Response(null, { status: 204 });
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  const view = mountDiffView({
    root: asElement(root),
    progress: asElement(progress),
    key: "key",
    session: session(groups, approved, options.approval, options.history),
    format: "line-by-line",
    open: options.open,
    focus: options.focus,
    onFocus: (focus) => focused.push(focus),
    onOpen: (open) => opened.push(open),
    onApproved: (all) => reported.push(all),
  });
  const find = (selector: string): FakeElement => {
    const found = root.querySelector(selector);
    assert.ok(found, `the page rendered ${selector}`);
    return found;
  };
  const section = (index: number): FakeElement => find(`.lsr-group[data-group-index="${index}"]`);
  const tickIn = (scope: FakeElement, selector: string): FakeInput => {
    const box = scope.querySelector(selector);
    assert.ok(box instanceof FakeInput, `${selector} is a checkbox`);
    return box;
  };
  return {
    root,
    scroller,
    progress,
    view,
    posted,
    asked,
    read,
    reported,
    opened,
    focused,
    fileBlock: (path) => find(`.lsr-file[data-file="${path}"]`),
    pickForm(path, form) {
      const block = find(`.lsr-file[data-file="${path}"]`);
      root.dispatch("click", {
        target: tickTarget(block, `.lsr-form-option[data-form="${form}"]`),
      });
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
    async until(ready, what) {
      const deadline = Date.now() + 2000;
      while (!ready()) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    gatePress: (index) => tickTarget(section(index), ".lsr-gate-press"),
    groupContent: (index) => tickTarget(section(index), ".lsr-group-content"),
    groupTick: (index) => tickIn(section(index), ".lsr-tick-all"),
    fileHeader: (path) => tickTarget(find(`.lsr-file[data-file="${path}"]`), ".lsr-file-header"),
    fileFoot: (path) => tickTarget(find(`.lsr-file[data-file="${path}"]`), ".lsr-file-foot"),
    fileTick: (path) => tickIn(root, `.lsr-approved[data-file="${path}"]`),
    open(index) {
      root.dispatch("click", { target: tickTarget(section(index), ".lsr-gate-press") });
    },
    openFile(path) {
      root.dispatch("click", {
        target: tickTarget(find(`.lsr-file[data-file="${path}"]`), ".lsr-file-header"),
      });
    },
    tick(box, checked) {
      box.checked = checked;
      root.dispatch("change", { target: box });
    },
  };
}

function tickTarget(scope: FakeElement, selector: string): FakeElement {
  const found = scope.querySelector(selector);
  assert.ok(found, `the group rendered ${selector}`);
  return found;
}

const isOpen = (header: FakeElement): boolean => header.getAttribute("aria-expanded") === "true";

test("ticking a group's last file shuts the group and marks it approved", async (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])], [], { focus: 0 });
  page.open(0);
  assert.equal(isOpen(page.gatePress(0)), true, "the gate was passed, so the diff is up");

  page.tick(page.fileTick("a.png"), true);
  assert.equal(isOpen(page.gatePress(0)), true, "one file short, so it stays open");

  page.tick(page.fileTick("b.png"), true);

  // Nothing left in it to read: the chapter shuts back onto the card it opened behind.
  assert.equal(isOpen(page.gatePress(0)), false);
  assert.equal(page.groupContent(0).hidden, true);
  assert.equal(page.groupTick(0).checked, true);
  assert.equal(page.root.querySelector(".lsr-gate-counter")?.textContent, "2/2 approved");
});

test("unticking a file in an approved group opens it again", async (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])], ["a.png"], { focus: 0 });
  page.open(0);
  // Read to the end, which is what shuts a chapter and marks it.
  page.tick(page.fileTick("b.png"), true);
  assert.equal(isOpen(page.gatePress(0)), false);

  page.tick(page.fileTick("a.png"), false);

  // Untick is asking to look again; a shut group would hide the very diff asked for.
  assert.equal(isOpen(page.gatePress(0)), true);
  assert.equal(page.groupContent(0).hidden, false);
  assert.equal(page.groupTick(0).checked, false);
});

test("the group's own tick approves every file in it and shuts it in one go", async (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])], [], { focus: 0 });
  page.open(0);

  page.tick(page.groupTick(0), true);

  assert.equal(page.fileTick("a.png").checked, true);
  assert.equal(page.fileTick("b.png").checked, true);
  assert.equal(isOpen(page.gatePress(0)), false);
  assert.deepEqual(page.posted.at(-1), ["a.png", "b.png"], "the server hears about every file");
});

test("unticking a group's own tick opens it and clears every file in it", async (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])], ["a.png"], { focus: 0 });
  page.open(0);
  page.tick(page.groupTick(0), true);
  assert.equal(isOpen(page.gatePress(0)), false, "ticked to the end, so it shut");

  page.tick(page.groupTick(0), false);

  assert.equal(page.fileTick("a.png").checked, false);
  assert.equal(isOpen(page.gatePress(0)), true, "asking to look again reopens the diff");
  assert.deepEqual(page.posted.at(-1), [], "the server hears the withdrawal too");
});

test("ticking a file shuts it, and unticking it opens it again", async (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])], [], { focus: 0 });

  page.tick(page.fileTick("a.png"), true);
  assert.equal(isOpen(page.fileHeader("a.png")), false, "a ticked file has been read");

  page.tick(page.fileTick("a.png"), false);
  assert.equal(isOpen(page.fileHeader("a.png")), true, "unticking it is asking to read it again");
});

test("a file the reviewer re-opened after approving it survives a tick elsewhere", async (t) => {
  // Same rule as groups, one level down: a tick moves what it changed and nothing else.
  const page = mount(t, [group("API", ["a.png", "b.png"])], ["a.png"], { focus: 0 });
  page.open(0);
  page.openFile("a.png");

  page.tick(page.fileTick("b.png"), true);

  assert.equal(isOpen(page.fileHeader("a.png")), true, "nobody asked for it to be shut");
  assert.equal(isOpen(page.gatePress(0)), false, "the group did flip, so it shuts");
});

test("a tick that flips a chapter the page is not showing folds nothing", async (t) => {
  // Same file in two groups, one off-screen: the fold plan names a section this draw lacks;
  // nothing to fold there, and nothing to throw over either.
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["a.png"])], [], { focus: 0 });
  page.open(0);

  page.tick(page.fileTick("a.png"), true);

  assert.equal(isOpen(page.gatePress(0)), false, "the chapter on screen flipped and shut");
  assert.equal(page.root.querySelector(`.lsr-group[data-group-index="1"]`), null);
  assert.equal(page.reported.at(-1), true, "and the review is done either way");
});

/** Three chapters to read in order; `approved` decides which are already done. */
const threeChapters = (): DiffGroup[] => [
  group("API", ["a.png"]),
  group("Docs", ["b.png"]),
  group("Tests", ["c.png"]),
];

const shownChapters = (page: Mounted): (string | null)[] =>
  page.root
    .querySelectorAll(".lsr-group")
    .map((section) => section.getAttribute("data-group-index"));

test("finishing a chapter puts the next one still to read on screen, shut on its card", (t) => {
  const page = mount(t, threeChapters(), ["b.png"], { focus: 0 });
  page.open(0);

  page.tick(page.fileTick("a.png"), true);

  // Docs is done already, so the reviewer lands on Tests — and on its card, as every way into
  // a chapter does: the tick asked for the next thing to read, not for its lines.
  assert.deepEqual(shownChapters(page), ["2"]);
  assert.equal(isOpen(page.gatePress(2)), false);
  assert.deepEqual(page.focused, [2], "reported, so a reload comes back to the same place");
  assert.deepEqual(
    page.posted.at(-1),
    ["b.png", "a.png"],
    "the tick reached the server all the same",
  );
  assert.equal(page.reported.at(-1), false, "two of three, so the review is not done");
  assert.equal(
    page.scroller.scrolledInto || page.root.scrolledInto,
    true,
    "top of the new chapter",
  );
});

test("the chapter's own tick moves on the same way a last file tick does", (t) => {
  const page = mount(t, threeChapters(), [], { focus: 1 });
  page.open(1);

  page.tick(page.groupTick(1), true);

  assert.deepEqual(shownChapters(page), ["2"], "the next in order, not the first");
  assert.deepEqual(page.focused, [2]);
});

test("the last chapter finished wraps round to the first still to read", (t) => {
  const page = mount(t, threeChapters(), ["b.png"], { focus: 2 });
  page.open(2);

  page.tick(page.fileTick("c.png"), true);

  assert.deepEqual(shownChapters(page), ["0"]);
});

test("a tick that leaves the chapter unfinished moves nowhere", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"]), group("Docs", ["c.png"])], [], {
    focus: 0,
  });
  page.open(0);

  page.tick(page.fileTick("a.png"), true);

  assert.deepEqual(shownChapters(page), ["0"], "half read is not finished");
  assert.deepEqual(page.focused, [], "no focus move to report");
  assert.equal(isOpen(page.gatePress(0)), true, "and the diff stays up");
});

test("unticking inside a finished chapter reopens it where it is, moving nowhere", (t) => {
  const page = mount(t, threeChapters(), ["a.png"], { focus: 0 });

  page.tick(page.groupTick(0), false);

  assert.deepEqual(shownChapters(page), ["0"]);
  assert.equal(isOpen(page.gatePress(0)), true, "asking to look again opens the diff");
  assert.deepEqual(page.focused, []);
});

test("a finished chapter never lands on a sweep chapter", (t) => {
  const groups = threeChapters();
  groups[1] = { ...groups[1]!, tier: "sweep" };
  const page = mount(t, groups, ["c.png"], { focus: 0 });
  page.open(0);

  page.tick(page.fileTick("a.png"), true);

  // Docs is bulk the survey approves in one press; Tests is done. Nothing is left to read, so
  // the finished card stays rather than asking for a reading the tier said was not worth having.
  assert.deepEqual(shownChapters(page), ["0"]);
  assert.equal(isOpen(page.gatePress(0)), false, "shut onto its card, mark and all");
  assert.deepEqual(page.focused, []);
});

test("pressing anywhere on the card passes the gate, not only the button", (t) => {
  const page = mount(t, [group("API", ["a.png"])], [], { focus: 0 });

  press(page, ".lsr-gate-rationale");

  assert.equal(isOpen(page.gatePress(0)), true);
  assert.equal(page.groupContent(0).hidden, false);
});

test("the chapter's own tick on a finished card is a tick, not a press through the gate", (t) => {
  const page = mount(t, [group("API", ["a.png"])], ["a.png"], { focus: 0 });

  const foot = page.root.querySelector(".lsr-group-foot");
  assert.ok(foot, "the finished card carries its own tick");
  page.root.dispatch("click", { target: tickTarget(foot, ".lsr-tick") });

  assert.equal(isOpen(page.gatePress(0)), false, "the card stays, the box is the browser's");
});

test("a press inside an open chapter's body is a press on its lines, not on its card", (t) => {
  const page = mount(t, [group("API", ["a.png"])], [], { focus: 0 });
  page.open(0);
  page.root.scrolledInto = false;

  press(page, ".lsr-group-content");

  assert.equal(isOpen(page.gatePress(0)), true, "nothing to open");
  assert.equal(page.root.scrolledInto, false, "and nothing scrolled: the reviewer is reading");
});

/** A needs-reapproval file, which is the only kind that carries the switch. */
function reapproval(path: string): Record<string, Approval> {
  return { [path]: "needs-reapproval" };
}

function formData(path = "notes.txt"): ApprovedFormData {
  return {
    path,
    paths: [path],
    from: "1111111111111111",
    to: "2222222222222222",
    state: "diff",
    diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-const approved = 1;\n+const since = 3;\n`,
  };
}

/**
 * The file is inside a chapter, because that is the only place a diff is drawn,
 * and past its gate, because these tests are about the diff itself.
 */
function reapprovalPage(t: TestContext, form: FormAnswer): Mounted {
  const page = mount(
    t,
    [{ name: "API", rationale: "why API", files: [textFile("notes.txt")] }],
    [],
    {
      approval: reapproval("notes.txt"),
      form,
      focus: 0,
    },
  );
  page.open(0);
  return page;
}

const pressed = (page: Mounted, form: string): string | null =>
  page
    .fileBlock("notes.txt")
    .querySelector(`.lsr-form-option[data-form="${form}"]`)
    ?.getAttribute("aria-pressed") ?? null;

const diffText = (page: Mounted): string =>
  page.fileBlock("notes.txt").querySelector(".lsr-file-diff")?.innerHTML ?? "";

test("pressing Since approval swaps the file's diff for what changed after it", async (t) => {
  const page = reapprovalPage(t, { data: formData() });

  page.pickForm("notes.txt", "approved");
  await page.settle();

  assert.equal(page.asked.length, 1, "the page asked git once");
  assert.match(page.asked[0]!, /\/api\/session\/key\/approved-form\?path=notes\.txt$/);
  assert.equal(page.fileBlock("notes.txt").getAttribute("data-form"), "approved");
  assert.equal(pressed(page, "approved"), "true");
  assert.equal(pressed(page, "branch"), "false");
  assert.match(diffText(page), /const approved = 1;/, "the line the approval was given on");
  assert.match(diffText(page), /Feedback is off in this view/);
});

test("pressing Branch diff puts the ordinary diff back", async (t) => {
  const page = reapprovalPage(t, { data: formData() });
  page.pickForm("notes.txt", "approved");
  await page.settle();

  page.pickForm("notes.txt", "branch");

  assert.equal(page.fileBlock("notes.txt").getAttribute("data-form"), "branch");
  assert.equal(pressed(page, "branch"), "true");
  assert.doesNotMatch(diffText(page), /Feedback is off in this view/);
});

test("flipping back to the approved form asks git once, not once a press", async (t) => {
  const page = reapprovalPage(t, { data: formData() });
  page.pickForm("notes.txt", "approved");
  await page.settle();

  page.pickForm("notes.txt", "branch");
  page.pickForm("notes.txt", "approved");
  await page.settle();

  assert.equal(page.asked.length, 1, "the second look is served from what was fetched");
  assert.match(diffText(page), /Feedback is off in this view/);
});

test("the toggle leaves the file where it is, open and unticked", async (t) => {
  const page = reapprovalPage(t, { data: formData() });

  page.pickForm("notes.txt", "approved");
  await page.settle();

  assert.equal(
    isOpen(page.fileHeader("notes.txt")),
    true,
    "a question about a file is not a verdict",
  );
  assert.equal(page.fileTick("notes.txt").checked, false);
  assert.equal(isOpen(page.gatePress(0)), true, "and the chapter is still the one being read");
});

test("a file whose approved form the server cannot produce says so", async (t) => {
  const page = reapprovalPage(t, { missing: true });

  page.pickForm("notes.txt", "approved");
  await page.settle();

  assert.match(diffText(page), /could not be read/);
  assert.equal(pressed(page, "approved"), "true", "the press still landed");
});

test("a new round takes the approved form back down", async (t) => {
  const page = reapprovalPage(t, { data: formData() });
  page.pickForm("notes.txt", "approved");
  await page.settle();

  // Head moved: the on-screen diff describes a tree no longer under review.
  page.view.update(
    session([{ name: "API", rationale: "why API", files: [textFile("notes.txt")] }], [], {}),
    "regrouped",
  );
  // A re-group lands on the survey, so the file is read again from there.
  press(page, `.lsr-index-entry[data-group-index="0"]`);

  // Fresh markup opens on the branch diff; the whole-file option keeps a switch here.
  assert.equal(page.fileBlock("notes.txt").getAttribute("data-form"), "branch");
  assert.ok(!page.fileBlock("notes.txt").querySelector(`.lsr-form-option[data-form="approved"]`));
  assert.doesNotMatch(diffText(page), /Feedback is off in this view/);
});

test("a new round asks git again rather than serving the last round's diff", async (t) => {
  // After a new round the same path names a different pair of commits: a cached answer would
  // show the wrong two trees with nothing on screen saying so.
  const page = reapprovalPage(t, { data: formData() });
  page.pickForm("notes.txt", "approved");
  await page.settle();

  page.view.update(
    session([{ name: "API", rationale: "why API", files: [textFile("notes.txt")] }], [], {
      "notes.txt": "needs-reapproval",
    }),
    "regrouped",
  );
  press(page, `.lsr-index-entry[data-group-index="0"]`);
  page.pickForm("notes.txt", "approved");
  await page.settle();

  assert.equal(page.asked.length, 2, "the new round's diff is a new question");
});

test("a second press while git is still answering does not ask twice", async (t) => {
  const page = reapprovalPage(t, { data: formData() });

  page.pickForm("notes.txt", "approved");
  page.pickForm("notes.txt", "approved");
  await page.settle();

  assert.equal(page.asked.length, 1);
  assert.match(diffText(page), /Feedback is off in this view/);
});

test("a redraw while git is still answering says so, rather than saying it failed", async (t) => {
  const page = reapprovalPage(t, { data: formData() });
  page.pickForm("notes.txt", "approved");

  page.view.setFormat("side-by-side");

  assert.match(diffText(page), /Reading what changed since you approved this/);
  await page.settle();
  assert.match(diffText(page), /Feedback is off in this view/);
});

test("a refused answer is asked for again the next time the reviewer presses", async (t) => {
  const page = reapprovalPage(t, { missing: true });
  page.pickForm("notes.txt", "approved");
  await page.settle();

  page.pickForm("notes.txt", "branch");
  page.pickForm("notes.txt", "approved");
  await page.settle();

  assert.equal(page.asked.length, 2, "a failure is not an answer to cache");
});

test("the swapped-in diff is painted, and only in the file that was toggled", async (t) => {
  // Repainting the whole review would merge a second set of spans into every already-coloured
  // line: the pass must be the swapped block's alone.
  const page = mount(
    t,
    [{ name: "API", rationale: "why API", files: [textFile("a.ts"), textFile("b.ts")] }],
    [],
    { approval: { "a.ts": "needs-reapproval" }, form: { data: formData("a.ts") }, focus: 0 },
  );
  await page.until(() => page.read.length > 0, "the first draw to paint the review");
  const drawn = page.read.length;

  page.pickForm("a.ts", "approved");
  await page.settle();
  await page.until(
    () => page.fileBlock("a.ts").querySelectorAll(".hljs").length > 0,
    "the approved form's own lines to be painted",
  );

  const repainted = page.read.slice(drawn);
  assert.ok(repainted.length > 0, "the fresh lines were painted");
  assert.deepEqual(
    [...new Set(repainted.map((url) => new URL(url, "http://x").searchParams.get("path")))],
    ["a.ts"],
    "and no other file was touched",
  );
  assert.ok(
    page.fileBlock("a.ts").querySelectorAll(".hljs").length > 0,
    "the approved form's own lines carry the highlighting pass",
  );
});

test("switching layout keeps the approved form without asking git again", async (t) => {
  const page = reapprovalPage(t, { data: formData() });
  page.pickForm("notes.txt", "approved");
  await page.settle();

  page.view.setFormat("side-by-side");

  assert.equal(page.asked.length, 1, "a layout switch is not a new question");
  assert.equal(page.fileBlock("notes.txt").getAttribute("data-form"), "approved");
  assert.match(diffText(page), /Feedback is off in this view/);
});

/** Two rounds whose recorded blobs prove notes.txt moved between them, unapproved. */
const CHANGED_ROUNDS: History = {
  conversation: [],
  rounds: [
    {
      index: 0,
      at: "2025-01-01T00:00:00.000Z",
      files: [{ path: "notes.txt", status: "modified", blob: "aaa1111" }],
    },
    {
      index: 1,
      at: "2025-01-02T00:00:00.000Z",
      files: [{ path: "notes.txt", status: "modified", blob: "bbb2222" }],
    },
  ],
};

/** A file the agent edited between rounds without ever holding an approval. */
function changedRoundsPage(t: TestContext, form: FormAnswer): Mounted {
  return mount(t, [{ name: "API", rationale: "why API", files: [textFile("notes.txt")] }], [], {
    form,
    history: CHANGED_ROUNDS,
    focus: 0,
  });
}

test("pressing Since last round swaps the diff for what moved between the rounds", async (t) => {
  const page = changedRoundsPage(t, { data: formData() });
  assert.equal(page.fileBlock("notes.txt").getAttribute("data-form"), "branch");

  page.pickForm("notes.txt", "last-round");
  assert.match(diffText(page), /Reading what changed since the last round/);
  await page.settle();

  assert.equal(page.asked.length, 1, "the page asked git once");
  assert.match(page.asked[0]!, /\/api\/session\/key\/last-round-form\?path=notes\.txt$/);
  assert.equal(page.fileBlock("notes.txt").getAttribute("data-form"), "last-round");
  assert.equal(pressed(page, "last-round"), "true");
  assert.equal(pressed(page, "branch"), "false");
  assert.match(diffText(page), /const approved = 1;/, "the fetched diff is on screen");
  assert.match(diffText(page), /Feedback is off in this view/);
});

test("pressing Branch diff puts the ordinary diff back on a last-round file", async (t) => {
  const page = changedRoundsPage(t, { data: formData() });
  page.pickForm("notes.txt", "last-round");
  await page.settle();

  page.pickForm("notes.txt", "branch");

  assert.equal(page.fileBlock("notes.txt").getAttribute("data-form"), "branch");
  assert.equal(pressed(page, "branch"), "true");
  assert.doesNotMatch(diffText(page), /Feedback is off in this view/);
});

test("switching layout keeps the last-round view without asking git again", async (t) => {
  const page = changedRoundsPage(t, { data: formData() });
  page.pickForm("notes.txt", "last-round");
  await page.settle();

  page.view.setFormat("side-by-side");

  assert.equal(page.asked.length, 1, "a layout switch is not a new question");
  assert.equal(page.fileBlock("notes.txt").getAttribute("data-form"), "last-round");
  assert.match(diffText(page), /Feedback is off in this view/);
});

test("a last-round answer the server refused says so in the round's own words", async (t) => {
  const page = changedRoundsPage(t, { missing: true });

  page.pickForm("notes.txt", "last-round");
  await page.settle();

  assert.match(diffText(page), /What changed since the last round could not be read/);
  assert.equal(pressed(page, "last-round"), "true", "the press still landed");
});

test("a new round asks for the last-round diff again, like every fetched form", async (t) => {
  // A new round is a new pair of heads: the cached answer describes the wrong trees.
  const page = changedRoundsPage(t, { data: formData() });
  page.pickForm("notes.txt", "last-round");
  await page.settle();

  page.view.update(
    session(
      [{ name: "API", rationale: "why API", files: [textFile("notes.txt")] }],
      [],
      {},
      CHANGED_ROUNDS,
    ),
    "regrouped",
  );
  press(page, `.lsr-index-entry[data-group-index="0"]`);

  assert.equal(page.fileBlock("notes.txt").getAttribute("data-form"), "branch");

  page.pickForm("notes.txt", "last-round");
  await page.settle();

  assert.equal(page.asked.length, 2, "the new round's diff is a new question");
});

/** A file with the plainest of switches: modified, no approval history, no grammar. */
function wholeFilePage(t: TestContext, contents?: string): Mounted {
  return mount(t, [{ name: "API", rationale: "why API", files: [textFile("notes.txt")] }], [], {
    focus: 0,
    ...(contents === undefined ? {} : { contents }),
  });
}

test("pressing Whole file swaps the diff for the file's entire new version", async (t) => {
  const page = wholeFilePage(t, "alpha\nbeta\n");

  page.pickForm("notes.txt", "full");
  assert.match(diffText(page), /Reading the whole file/);
  await page.settle();

  const reads = page.read.filter((url) => url.includes("side=new"));
  assert.equal(reads.length, 1, "the page read the file once");
  assert.match(reads[0]!, /\/api\/session\/key\/file\?path=notes\.txt&side=new$/);
  assert.equal(page.fileBlock("notes.txt").getAttribute("data-form"), "full");
  assert.equal(pressed(page, "full"), "true");
  assert.equal(pressed(page, "branch"), "false");
  assert.match(diffText(page), /alpha/);
  assert.match(diffText(page), /beta/);
  assert.match(diffText(page), /line-num2">2</, "every line carries its own number");
  assert.match(diffText(page), /Read-only view/);
});

test("pressing Branch diff puts the ordinary diff back after the whole file", async (t) => {
  const page = wholeFilePage(t, "alpha\n");
  page.pickForm("notes.txt", "full");
  await page.settle();

  page.pickForm("notes.txt", "branch");

  assert.equal(page.fileBlock("notes.txt").getAttribute("data-form"), "branch");
  assert.equal(pressed(page, "branch"), "true");
  assert.doesNotMatch(diffText(page), /Read-only view/);
  assert.match(diffText(page), /const branch = 2;/, "the branch diff is back");
});

test("flipping back to the whole file reads it once, not once a press", async (t) => {
  const page = wholeFilePage(t, "alpha\n");
  page.pickForm("notes.txt", "full");
  await page.settle();

  page.pickForm("notes.txt", "branch");
  page.pickForm("notes.txt", "full");
  await page.settle();

  assert.equal(
    page.read.filter((url) => url.includes("side=new")).length,
    1,
    "the second look is served from what was read",
  );
  assert.match(diffText(page), /Read-only view/);
});

test("a whole file the server cannot hand over is explained in one sentence", async (t) => {
  const page = wholeFilePage(t);

  page.pickForm("notes.txt", "full");
  await page.settle();

  assert.match(diffText(page), /The whole file could not be read/);
  assert.match(diffText(page), /Press Branch diff for the ordinary one\./);
  assert.equal(pressed(page, "full"), "true", "the press still landed");
});

test("the whole file is painted once and the repaint pass leaves it alone", async (t) => {
  // `.ts` so both passes would want it: the view arrives highlighted from its own
  // fetch, and a second pass would merge its spans into themselves.
  const page = mount(t, [{ name: "API", rationale: "why API", files: [textFile("code.ts")] }], [], {
    focus: 0,
    contents: "const a = 1;\nconst b = 2;\n",
  });
  await page.until(() => page.read.length >= 2, "the first draw to paint the review");

  page.pickForm("code.ts", "full");
  await page.until(
    () =>
      (page.fileBlock("code.ts").querySelector(".lsr-file-diff")?.innerHTML ?? "").includes(
        "d2h-code-line-ctn hljs",
      ),
    "the whole file to arrive highlighted",
  );

  const body = page.fileBlock("code.ts").querySelector(".lsr-file-diff")?.innerHTML ?? "";
  assert.match(body, /class="d2h-code-line-ctn hljs"/);
  await page.settle();
  await page.settle();
  assert.equal(
    page.read.length,
    3,
    "two sides for the first draw, one whole read for the view, and no repaint",
  );
});

test("switching layout keeps the whole file without reading it again", async (t) => {
  const page = mount(t, [{ name: "API", rationale: "why API", files: [textFile("code.ts")] }], [], {
    focus: 0,
    contents: "const a = 1;\n",
  });
  page.pickForm("code.ts", "full");
  await page.until(
    () =>
      (page.fileBlock("code.ts").querySelector(".lsr-file-diff")?.innerHTML ?? "").includes(
        "d2h-code-line-ctn hljs",
      ),
    "the whole file to arrive highlighted",
  );
  const reads = page.read.length;

  page.view.setFormat("side-by-side");
  await page.settle();
  await page.settle();

  assert.equal(page.fileBlock("code.ts").getAttribute("data-form"), "full");
  const body = page.fileBlock("code.ts").querySelector(".lsr-file-diff")?.innerHTML ?? "";
  assert.match(body, /Read-only view/);
  assert.match(body, /class="d2h-code-line-ctn hljs"/, "the cached body keeps its colours");
  assert.equal(page.read.length, reads, "a layout switch is not a new question");
});

test("approving a file repaints the chapter's counter, and the index on the way out", async (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])], [], { focus: 0 });

  page.tick(page.fileTick("a.png"), true);

  // The tick finished API, so the card on screen is now Docs's, with Docs's counter.
  assert.deepEqual(shownChapters(page), ["1"]);
  assert.equal(page.root.querySelector(".lsr-gate-counter")?.textContent, "0/1 approved");
  assert.equal(
    page.progress.querySelector(".lsr-progress-count")?.textContent,
    "1/2 files approved",
  );

  // The index is not on screen to patch; it is redrawn on exit from the approvals as they stand.
  press(page, ".lsr-focus-exit");

  assert.deepEqual(
    page.root.querySelectorAll(".lsr-index-counter").map((span) => span.textContent),
    ["1/1 approved", "0/1 approved"],
  );
});

test("a press on a header segment lands in that chapter", (t) => {
  // The bar lives in the header, outside the diff root's listeners, so it carries its own;
  // a press is the same focus move an index entry makes.
  const page = mount(t, [group("API", ["a.png", "b.png"]), group("Docs", ["c.png"])]);
  const segment = page.progress.querySelector('.lsr-progress-segment[data-group-index="1"]');
  assert.ok(segment, "the header drew the second chapter's segment");

  page.progress.dispatch("click", { target: segment });

  assert.deepEqual(page.focused, [1], "the press is reported as a focus move");
  assert.match(page.root.innerHTML, /lsr-focus-bar/, "the chapter stands open");
});

test("the header's bar is drawn one segment per group, and each keeps its element", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"]), group("Docs", ["c.png"])], [], {
    focus: 0,
  });
  const before = page.progress.querySelectorAll(".lsr-progress-segment");

  page.tick(page.fileTick("a.png"), true);

  const after = page.progress.querySelectorAll(".lsr-progress-segment");
  assert.equal(after.length, 2);
  // Same elements, not lookalikes: a redrawn bar would jump the fill to its width instead of animating it.
  assert.strictEqual(after[0], before[0], "a tick repaints the bar rather than replacing it");
  assert.strictEqual(after[1], before[1]);
});

test("a tick fills its group's segment, and untick empties it again", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"]), group("Docs", ["c.png"])], [], {
    focus: 0,
  });
  const segment = (index: number): FakeElement => {
    const found = page.progress.querySelector(`.lsr-progress-segment[data-group-index="${index}"]`);
    assert.ok(found, `the header drew a segment for group ${index}`);
    return found;
  };
  const fill = (index: number): string | null =>
    segment(index).querySelector(".lsr-progress-fill")?.getAttribute("style") ?? null;

  page.tick(page.fileTick("a.png"), true);

  assert.equal(fill(0), "width: 50%");
  assert.equal(segment(0).getAttribute("data-state"), "partial");
  assert.equal(segment(0).getAttribute("title"), "API: 1/2 approved");
  // Tooltip and aria-label are read by different people; patching only one tells two stories.
  assert.equal(segment(0).getAttribute("aria-label"), "API: 1/2 approved");
  assert.equal(fill(1), "width: 0%", "the other group is untouched");

  page.tick(page.fileTick("b.png"), true);

  // Finishing API moved the reviewer on to Docs; the bar came with the draw and says so.
  assert.deepEqual(shownChapters(page), ["1"]);
  assert.equal(fill(0), "width: 100%");
  assert.equal(segment(0).getAttribute("data-state"), "approved");
  assert.equal(segment(0).getAttribute("aria-label"), "API: 2/2 approved");

  press(page, ".lsr-focus-prev");
  page.tick(page.fileTick("a.png"), false);

  assert.equal(fill(0), "width: 50%");
  assert.equal(segment(0).getAttribute("data-state"), "partial");
  assert.equal(
    page.progress.querySelector(".lsr-progress-count")?.textContent,
    "1/3 files approved",
  );
});

test("a re-group draws the bar again, for the groups the new round has", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])]);

  page.view.update(
    session([group("API", ["a.png"]), group("Docs", ["b.png"])], ["a.png"]),
    "regrouped",
  );

  assert.equal(page.progress.querySelectorAll(".lsr-progress-segment").length, 2);
  assert.equal(
    page.progress.querySelector(".lsr-progress-count")?.textContent,
    "1/2 files approved",
  );
});

test("the tick that finishes the last file is reported, and the one that undoes it too", (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])], [], { focus: 0 });

  assert.deepEqual(page.reported, [false], "an unread review is reported as it opens");

  page.tick(page.fileTick("a.png"), true);
  assert.deepEqual(page.reported.at(-1), false, "half a review is not a review");

  // Via the survey into the other chapter: the only way to a file the open chapter lacks.
  press(page, ".lsr-focus-exit");
  press(page, `.lsr-index-entry[data-group-index="1"]`);

  page.tick(page.fileTick("b.png"), true);
  assert.deepEqual(page.reported.at(-1), true, "that was the last file");

  page.tick(page.fileTick("b.png"), false);
  assert.deepEqual(page.reported.at(-1), false, "the reviewer wants another look");
});

test("a group tick that finishes the review is reported like any other", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])], [], { focus: 0 });

  page.tick(page.groupTick(0), true);

  assert.equal(page.reported.at(-1), true);
});

test("a round that opens already approved is reported on its first draw", (t) => {
  // A re-group carries approvals over (`carriedApproval`): a round can open with nothing left to read.
  const page = mount(t, [group("API", ["a.png"])], ["a.png"]);

  assert.deepEqual(page.reported, [true]);
});

test("a re-group reports where the new round stands, not where the last one did", (t) => {
  const page = mount(t, [group("API", ["a.png"])], ["a.png"]);

  page.view.update(session([group("API", ["a.png", "c.png"])], ["a.png"]), "regrouped");

  assert.equal(page.reported.at(-1), false, "the new file is unread");
});

/** Crude heights — rows 40px, diffs 1000px. The point is a collapse removes ~1000px, not the numbers. */
function giveHeights(page: Mounted): void {
  for (const row of page.root.querySelectorAll(".lsr-row")) row.ownHeight = 40;
  for (const diff of page.root.querySelectorAll(".lsr-file-diff")) diff.ownHeight = 1000;
}

const headerTop = (element: FakeElement): number => element.getBoundingClientRect().top;

test("ticking a file read to the end holds the row the tick is in, and travels nowhere", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png", "c.png"])], [], { focus: 0 });
  page.open(0);
  giveHeights(page);
  // Scrolled to the second file's foot: the tick row near screen top, its header 1000px above.
  page.scroller.scrollTop = 2060;
  assert.equal(headerTop(page.fileFoot("b.png")), 60, "the row they are pressing");
  assert.equal(headerTop(page.fileHeader("b.png")), -980, "its header is off the screen");

  page.tick(page.fileTick("b.png"), true);

  // The fold is paid out of scrollTop so the pressed row stays put to the pixel; the next file
  // lands at eye level, not a screenful of already-read diff.
  assert.equal(headerTop(page.fileFoot("b.png")), 60);
  assert.equal(page.scroller.scrollTop, 1060, "the review paid the fold, and nothing else");
  assert.equal(headerTop(page.fileHeader("b.png")), 20, "the file they finished is two rows now");
  assert.equal(headerTop(page.fileHeader("c.png")), 100, "and the next file is directly under it");
});

test("the tick that finishes the last chapter left to read holds the reviewer on its card", (t) => {
  // One chapter in the review, so there is nowhere to move on to: the finished card stays.
  const page = mount(t, [group("API", ["a.png", "b.png"])], ["a.png"], { focus: 0 });
  page.open(0);
  giveHeights(page);
  page.scroller.scrollTop = 1500;
  const section = page.root.querySelector(`.lsr-group[data-group-index="0"]`)!;
  assert.equal(headerTop(section), -1500);

  page.tick(page.fileTick("b.png"), true);

  // Everything inside the chapter folded away and its gate card came back up in their place, so
  // the section itself — the one thing that survives the gesture — is what the reviewer holds.
  assert.equal(page.groupContent(0).hidden, true);
  assert.equal(headerTop(section), 0);
  assert.equal(page.scroller.scrollTop, 0);
});

test("shutting a file from its header holds the header, which is what was pressed", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png", "c.png"])], [], { focus: 0 });
  page.open(0);
  giveHeights(page);
  // Header on-screen under the cursor: the only place it can be pressed from.
  page.scroller.scrollTop = 960;
  const before = headerTop(page.fileHeader("b.png"));
  assert.equal(before, 120);

  page.openFile("b.png");

  // Everything folds below the header, so no scroll correction is needed.
  assert.equal(headerTop(page.fileHeader("b.png")), before);
  assert.equal(page.scroller.scrollTop, 960);
  assert.equal(headerTop(page.fileHeader("c.png")), 200, "the next file came up under it");
});

test("swapping one file's diff for its other form leaves that file's header alone", async (t) => {
  const page = reapprovalPage(t, { missing: true });
  giveHeights(page);
  page.scroller.scrollTop = 900;
  const before = headerTop(page.fileHeader("notes.txt"));

  page.pickForm("notes.txt", "approved");
  await page.settle();

  // The swap is the one non-fold height change; it anchors on the file's header for the same reason folds do.
  assert.equal(page.fileBlock("notes.txt").getAttribute("data-form"), "approved");
  assert.equal(headerTop(page.fileHeader("notes.txt")), before);
  assert.equal(page.scroller.scrollTop, 900);
});

test("a tick that folds nothing leaves the offset exactly where it was", (t) => {
  // The ticked file was never open: nothing changes height, so nothing may move.
  const page = mount(t, [group("API", ["a.png", "b.png"])], ["b.png"], { focus: 0 });
  giveHeights(page);
  page.scroller.scrollTop = 900;

  page.tick(page.fileTick("b.png"), true);

  assert.equal(page.scroller.scrollTop, 900);
});

test("the files last round's feedback was about are marked on the first draw", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])], [], {
    history: answered(["a.png"]),
    focus: 0,
  });

  assert.ok(page.fileHeader("a.png").outerHTML.includes("commented last round"));
  assert.ok(!page.fileHeader("b.png").outerHTML.includes("commented last round"));
});

test("a re-group marks what the round it drew was asked about, not what the last one was", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])], [], {
    history: answered(["a.png"]),
    focus: 0,
  });

  page.view.update(
    session([group("API", ["a.png", "b.png"])], [], {}, answered(["b.png"])),
    "regrouped",
  );
  press(page, `.lsr-index-entry[data-group-index="0"]`);

  assert.ok(!page.fileHeader("a.png").outerHTML.includes("commented last round"));
  assert.ok(page.fileHeader("b.png").outerHTML.includes("commented last round"));
});

test("a chapter nobody has read yet opens behind its gate, files and all", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])], [], { focus: 0 });

  assert.equal(isOpen(page.gatePress(0)), false, "the card is what a chapter opens on");
  assert.equal(page.groupContent(0).hidden, true, "and the diff is shut behind it");
  // Unticked files render open inside it; the report must match the markup's state.
  assert.deepEqual(page.opened.at(-1), { groups: [], files: ["a.png", "b.png"] });

  page.open(0);

  assert.equal(page.groupContent(0).hidden, false, "one press is the whole gate");
  assert.deepEqual(page.opened.at(-1), { groups: [0], files: ["a.png", "b.png"] });
});

test("the survey has nothing to fold, so it reports nothing standing open", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])]);

  assert.equal(page.root.querySelector(".lsr-group"), null, "no chapter is drawn here");
  assert.deepEqual(page.opened.at(-1), { groups: [], files: [] });
});

test("what the reviewer had open is open again on the next draw", (t) => {
  // A gate already passed is part of what was open: a reload puts the reviewer back where they
  // were reading, not in front of a card they have read.
  const page = mount(t, [group("API", ["a.png"]), group("UI", ["b.png", "c.png"])], [], {
    focus: 1,
    open: { groups: [1], files: ["c.png"] },
  });

  assert.equal(isOpen(page.gatePress(1)), true);
  assert.equal(page.groupContent(1).hidden, false);
  assert.equal(isOpen(page.fileHeader("c.png")), true);
  assert.equal(isOpen(page.fileHeader("b.png")), false, "a file left shut stays shut");
});

test("passing a chapter's gate is reported, so the page can write it down", (t) => {
  // News arriving mid-read redraws the chapter, and the draw renders it shut: without this
  // report the reviewer would be sent back to the card they already read past.
  const page = mount(t, [group("API", ["a.png"]), group("UI", ["b.png"])], [], { focus: 1 });
  assert.deepEqual(page.opened.at(-1), { groups: [], files: ["b.png"] });

  page.open(1);

  assert.deepEqual(page.opened.at(-1), { groups: [1], files: ["b.png"] });
});

test("shutting a file the reviewer had open is reported too", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])], [], {
    focus: 0,
    open: { groups: [0], files: ["a.png", "b.png"] },
  });

  page.openFile("a.png");

  assert.deepEqual(page.opened.at(-1), { groups: [0], files: ["b.png"] });
});

test("a tick that shuts what it finished is reported as shut", (t) => {
  const page = mount(t, [group("API", ["a.png"])], [], {
    focus: 0,
    open: { groups: [0], files: ["a.png"] },
  });

  page.tick(page.fileTick("a.png"), true);

  assert.deepEqual(page.opened.at(-1), { groups: [], files: [] });
});

test("switching layout keeps the review open where the reviewer opened it", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])], [], { focus: 0 });
  page.open(0);
  page.openFile("b.png");

  page.view.setFormat("side-by-side");

  assert.equal(isOpen(page.gatePress(0)), true);
  assert.equal(isOpen(page.fileHeader("b.png")), false);
  assert.equal(isOpen(page.fileHeader("a.png")), true);
});

test("a new round opens as it is rendered, not as the round before it was left", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])], [], {
    focus: 0,
    open: { groups: [0], files: ["a.png"] },
  });

  page.view.update(session([group("API", ["a.png", "c.png"])], []), "regrouped");

  assert.equal(page.root.querySelector(".lsr-group"), null, "the new round is a survey again");
  press(page, `.lsr-index-entry[data-group-index="0"]`);

  // b.png was left shut last round; the new round opens as rendered, not as left — and the
  // chapter behind its gate again, because entering one is entering one.
  assert.equal(isOpen(page.fileHeader("a.png")), true);
  assert.deepEqual(page.opened.at(-1), { groups: [], files: ["a.png", "c.png"] });
});

test("news inside the round leaves the review folded as the reviewer folded it", (t) => {
  // An agent reply is a session event arriving mid-read: the lines did not move, so neither may the folds.
  const page = mount(t, [group("API", ["a.png", "b.png"])], [], { focus: 0 });
  page.open(0);
  page.openFile("b.png");

  page.view.update(session([group("API", ["a.png", "b.png"])], []), "same-round");

  assert.equal(isOpen(page.gatePress(0)), true, "the gate they passed is not put back up");
  assert.equal(isOpen(page.fileHeader("b.png")), false, "and the file they shut is still shut");
  assert.deepEqual(page.opened.at(-1), { groups: [0], files: ["a.png"] });
});

test("a file a new round no longer has is not reported as open", (t) => {
  const page = mount(t, [group("API", ["a.png"])], [], {
    focus: 0,
    open: { groups: [0], files: ["a.png"] },
  });

  page.view.update(session([group("API", ["b.png"])], []), "regrouped");
  press(page, `.lsr-index-entry[data-group-index="0"]`);

  assert.deepEqual(page.opened.at(-1), { groups: [], files: ["b.png"] });
});

/** The reviewer pressing something in the focus bar, or an index entry. */
function press(page: Mounted, selector: string): void {
  const target = page.root.querySelector(selector);
  assert.ok(target, `the page rendered ${selector}`);
  page.root.dispatch("click", { target });
}

test("pressing an index entry focuses that chapter and nothing else is rendered", (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])]);

  press(page, `.lsr-index-entry[data-group-index="1"]`);

  assert.ok(page.root.querySelector(".lsr-focus-bar"), "the bar heads the chapter");
  assert.equal(page.root.querySelector(".lsr-index"), null, "the index is gone, not hidden");
  assert.deepEqual(
    page.root
      .querySelectorAll(".lsr-group")
      .map((section) => section.getAttribute("data-group-index")),
    ["1"],
  );
  assert.equal(isOpen(page.gatePress(1)), false, "the chapter opens on its gate");
  assert.deepEqual(page.focused, [1], "so a reload can come back to it");

  page.open(1);
  assert.equal(page.groupContent(1).hidden, false, "and the press behind it is the diff");
});

/** A survey with one chapter to read and one of bulk, as the grouping tiered them. */
function sweptPage(t: TestContext): Mounted {
  return mount(t, [
    group("API", ["a.png"]),
    { ...group("Docs", ["b.png", "c.png"]), tier: "sweep" as const },
  ]);
}

test("the lane's one press ticks every file of every swept chapter", (t) => {
  const page = sweptPage(t);

  press(page, ".lsr-sweep-approve");

  // The same POST one tick makes, carrying the whole lane.
  assert.deepEqual(page.posted, [["b.png", "c.png"]]);
  // The survey is redrawn, so the rows say where the review now stands.
  assert.match(page.root.querySelector(".lsr-sweep")?.textContent ?? "", /2\/2 approved/);
  assert.equal(page.progress.querySelectorAll(".lsr-progress-segment").length, 2);
});

test("the lane leaves the chapters worth reading alone, and completion with them", (t) => {
  const page = sweptPage(t);

  press(page, ".lsr-sweep-approve");

  assert.deepEqual(page.reported.at(-1), false, "a swept lane is not a reviewed diff");
  press(page, `.lsr-index-entry[data-group-index="0"]`);
  page.tick(page.fileTick("a.png"), true);
  assert.deepEqual(page.reported.at(-1), true);
});

test("a second press on the lane posts nothing, because it changes nothing", (t) => {
  // The press is a union, not a toggle: pressing it again must not untick the
  // lane, and must not spend a request saying so.
  const page = sweptPage(t);

  press(page, ".lsr-sweep-approve");
  press(page, ".lsr-sweep-approve");

  assert.equal(page.posted.length, 1);
});

test("leaving a chapter renders the survey again, and only the survey", (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])]);
  press(page, `.lsr-index-entry[data-group-index="0"]`);

  press(page, ".lsr-focus-exit");

  assert.ok(page.root.querySelector(".lsr-index"), "the index is back");
  assert.equal(page.root.querySelectorAll(".lsr-group").length, 0, "with no diff under it");
  assert.deepEqual(page.focused, [0, undefined]);
});

test("every way into a chapter lands on its gate, the one just read included", (t) => {
  // Entering a chapter is entering a chapter: stepping sideways into the next one, and coming
  // back to the one whose diff was already open, both start on the card again.
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])]);
  press(page, `.lsr-index-entry[data-group-index="0"]`);
  page.open(0);

  press(page, ".lsr-focus-next");
  assert.equal(isOpen(page.gatePress(1)), false, "the next chapter states itself first");

  press(page, ".lsr-focus-prev");
  assert.equal(isOpen(page.gatePress(0)), false, "and so does the one just read");

  page.open(0);
  press(page, ".lsr-focus-exit");
  press(page, `.lsr-index-entry[data-group-index="0"]`);
  assert.equal(isOpen(page.gatePress(0)), false, "re-entry is entry");
});

test("next and previous move one chapter at a time", (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])]);
  press(page, `.lsr-index-entry[data-group-index="0"]`);

  press(page, ".lsr-focus-next");
  assert.deepEqual(
    page.root
      .querySelectorAll(".lsr-group")
      .map((section) => section.getAttribute("data-group-index")),
    ["1"],
  );

  press(page, ".lsr-focus-prev");
  assert.deepEqual(
    page.root
      .querySelectorAll(".lsr-group")
      .map((section) => section.getAttribute("data-group-index")),
    ["0"],
  );
  assert.deepEqual(page.focused, [0, 1, 0]);
});

test("a stored focus opens the round on its chapter", (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])], [], { focus: 1 });

  assert.ok(page.root.querySelector(".lsr-focus-bar"));
  assert.deepEqual(
    page.root
      .querySelectorAll(".lsr-group")
      .map((section) => section.getAttribute("data-group-index")),
    ["1"],
  );
});

test("a stored focus the review has outgrown falls back to the full view", (t) => {
  const page = mount(t, [group("API", ["a.png"])], [], { focus: 7 });

  assert.equal(page.root.querySelector(".lsr-focus-bar"), null);
  assert.ok(page.root.querySelector(".lsr-index"));
});

test("ticks still land and are counted while a chapter is focused", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"]), group("Docs", ["c.png"])]);
  press(page, `.lsr-index-entry[data-group-index="0"]`);

  page.tick(page.fileTick("a.png"), true);

  assert.deepEqual(page.posted.at(-1), ["a.png"], "the server hears the tick");
  assert.equal(page.root.querySelector(".lsr-gate-counter")?.textContent, "1/2 approved");
  assert.equal(
    page.progress.querySelector(".lsr-progress-count")?.textContent,
    "1/3 files approved",
  );
});

test("a re-group drops the focus: its chapter numbers name the old grouping", (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])]);
  press(page, `.lsr-index-entry[data-group-index="1"]`);

  page.view.update(session([group("API", ["a.png"])], []), "regrouped");

  assert.equal(page.root.querySelector(".lsr-focus-bar"), null);
  assert.ok(page.root.querySelector(".lsr-index"));
});

test("news inside the round leaves the reviewer on the chapter they focused", (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])]);
  press(page, `.lsr-index-entry[data-group-index="1"]`);

  page.view.update(session([group("API", ["a.png"]), group("Docs", ["b.png"])], []), "same-round");

  assert.ok(page.root.querySelector(".lsr-focus-bar"));
  assert.deepEqual(
    page.root
      .querySelectorAll(".lsr-group")
      .map((section) => section.getAttribute("data-group-index")),
    ["1"],
  );
});

test("switching layout keeps the focused chapter focused", (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])]);
  press(page, `.lsr-index-entry[data-group-index="0"]`);

  page.view.setFormat("side-by-side");

  assert.ok(page.root.querySelector(".lsr-focus-bar"));
  assert.equal(page.root.querySelectorAll(".lsr-group").length, 1);
});

test("a prev press at the first chapter stays put rather than exiting", (t) => {
  // disabled normally stops this press; if it fails, walking off the edge must not exit focus mode.
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])]);
  press(page, `.lsr-index-entry[data-group-index="0"]`);

  press(page, ".lsr-focus-prev");

  assert.ok(page.root.querySelector(".lsr-focus-bar"), "still in focus mode");
  assert.deepEqual(
    page.root
      .querySelectorAll(".lsr-group")
      .map((section) => section.getAttribute("data-group-index")),
    ["0"],
  );
  assert.deepEqual(page.focused, [0], "a press that moved nothing reports nothing");
});

test("a next press at the last chapter stays put rather than exiting", (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])]);
  press(page, `.lsr-index-entry[data-group-index="1"]`);

  press(page, ".lsr-focus-next");

  assert.ok(page.root.querySelector(".lsr-focus-bar"), "still in focus mode");
  assert.deepEqual(
    page.root
      .querySelectorAll(".lsr-group")
      .map((section) => section.getAttribute("data-group-index")),
    ["1"],
  );
  assert.deepEqual(page.focused, [1]);
});

test("a same-round update that outgrows the focus lets go of it for good", (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])]);
  press(page, `.lsr-index-entry[data-group-index="1"]`);

  page.view.update(session([group("API", ["a.png"])], []), "same-round");
  assert.equal(page.root.querySelector(".lsr-focus-bar"), null, "chapter 1 is gone");

  // A returning chapter count must not revive a focus the reviewer saw dissolve.
  page.view.update(session([group("API", ["a.png"]), group("Docs", ["b.png"])], []), "same-round");
  assert.equal(page.root.querySelector(".lsr-focus-bar"), null, "the full view stays");
});

test("the bar marks the chapter on screen, and the mark moves with the reviewer", (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])], [], { focus: 0 });
  const mark = (index: number): string | null =>
    page.progress
      .querySelector(`.lsr-progress-segment[data-group-index="${index}"]`)
      ?.getAttribute("data-current") ?? null;

  assert.equal(mark(0), "true", "the chapter the round opened on is marked");
  assert.equal(mark(1), null);

  // The tick finished API, so the reviewer is on Docs now, and so is the mark.
  page.tick(page.fileTick("a.png"), true);
  assert.equal(mark(0), null);
  assert.equal(mark(1), "true", "the mark moved on with the reviewer");

  press(page, ".lsr-focus-exit");
  assert.equal(mark(0), null, "the survey reads nothing, so nothing is marked");
  assert.equal(mark(1), null);

  press(page, `.lsr-index-entry[data-group-index="1"]`);
  assert.equal(mark(0), null);
  assert.equal(mark(1), "true", "the mark is where the reviewer is now");
});

test("a jump from the panel opens the chapter and lands on the very line", (t) => {
  const page = mount(t, [
    group("API", ["a.png"]),
    { name: "Docs", rationale: "", files: [textFile("docs/notes.ts")] },
  ]);

  page.view.reveal("docs/notes.ts", { side: "new", line: 1 });

  assert.deepEqual(page.focused, [1], "the chapter holding the file is entered");
  const lines = page
    .fileBlock("docs/notes.ts")
    .querySelectorAll(".d2h-code-line, .d2h-code-side-line");
  assert.ok(
    lines.some((line) => line.scrolledInto),
    "the commented line itself is brought on screen",
  );
});

test("a jump without an anchor still lands on the file", (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])]);

  page.view.reveal("b.png");

  assert.deepEqual(page.focused, [1]);
  assert.equal(page.fileBlock("b.png").scrolledInto, true);
});

test("a jump to a line the diff no longer prints falls back to the file", (t) => {
  const page = mount(t, [{ name: "Docs", rationale: "", files: [textFile("docs/notes.ts")] }], [], {
    focus: 0,
  });

  page.view.reveal("docs/notes.ts", { side: "new", line: 999 });

  assert.deepEqual(page.focused, [], "already inside the chapter: no focus press to report");
  assert.equal(page.fileBlock("docs/notes.ts").scrolledInto, true);
});

test("a jump goes through the gate: it was asked for lines, not for the card", (t) => {
  const page = mount(t, [group("API", ["a.png"]), group("Docs", ["b.png"])], [], { focus: 0 });
  assert.equal(page.groupContent(0).hidden, true, "the chapter opened on its card");

  page.view.reveal("a.png");

  assert.equal(page.groupContent(0).hidden, false, "the file asked for is on screen");
  assert.deepEqual(page.opened.at(-1), { groups: [0], files: ["a.png"] }, "and written down");
});

test("a jump unfolds a file a tick had shut", (t) => {
  const page = mount(t, [group("API", ["a.png", "b.png"])], [], { focus: 0 });
  page.tick(page.fileTick("a.png"), true);
  assert.equal(page.fileHeader("a.png").getAttribute("aria-expanded"), "false");

  page.view.reveal("a.png");

  assert.equal(page.fileHeader("a.png").getAttribute("aria-expanded"), "true");
  assert.equal(page.fileBlock("a.png").scrolledInto, true);
});

test("a jump to a file this round does not carry does nothing at all", (t) => {
  const page = mount(t, [group("API", ["a.png"])]);

  page.view.reveal("gone.ts");

  assert.deepEqual(page.focused, []);
});
