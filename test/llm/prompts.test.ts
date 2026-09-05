import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile } from "../../src/diff-extract.ts";
import {
  GROUPING_SYSTEM_PROMPT,
  MAX_PREVIOUS_CHARS,
  MAX_PROMPT_CHARS,
  buildGroupingPrompt,
  buildRepairPrompt,
  type GroupingPromptInput,
} from "../../src/llm/prompts.ts";

function diffFile(path: string, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    status: "modified",
    diff: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new`,
    insertions: 1,
    deletions: 1,
    oversized: false,
    ...overrides,
  };
}

function prompt(files: DiffFile[], overrides: Partial<GroupingPromptInput> = {}): string {
  return buildGroupingPrompt({ files, intents: [], ...overrides });
}

/** A patch of `hunks` hunks × `lines` added lines. Built, not sliced from a real diff: the tests must know where the hunks are. */
function patch(path: string, hunks: number, lines: number): string {
  const bodies = Array.from({ length: hunks }, (_, index) =>
    [
      `@@ -${index * 200 + 1},${lines} +${index * 200 + 1},${lines} @@ function f${index}()`,
      ...Array.from({ length: lines }, (_, line) => `+  line ${index}-${line} of f${index}`),
    ].join("\n"),
  );
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    ...bodies,
  ].join("\n");
}

/** A patch of a file git scored 100% identical: a header, and no hunk to cut at. */
function renamePatch(from: string, to: string): string {
  return [
    `diff --git a/${from} b/${to}`,
    "similarity index 100%",
    `rename from ${from}`,
    `rename to ${to}`,
  ].join("\n");
}

/** Seeded 32-bit LCG: an unreplayable fuzz failure is a flake, not a test. */
function randoms(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The `--- path ---` block for one file, without the label or the blank line after it. */
function sectionOf(text: string, path: string): string {
  const label = `--- ${path} ---\n`;
  const start = text.indexOf(label);
  assert.notEqual(start, -1, `no section for ${path}`);
  const rest = text.slice(start + label.length);
  const end = rest.indexOf("\n\n--- ");
  return end === -1 ? rest.replace(/\n$/, "") : rest.slice(0, end);
}

/** Prompt with wrapping flattened: asserting against wrapped text fails on a reflow that changed nothing. */
const RULES = GROUPING_SYSTEM_PROMPT.replace(/\s+/g, " ");

/** Bullets under `A good grouping:`, unwrapped — the closed set of what the model orders on. */
function goodGroupingRules(): string[] {
  const lines = GROUPING_SYSTEM_PROMPT.split("\n");
  const start = lines.indexOf("A good grouping:") + 1;
  const end = lines.indexOf("", start);
  return lines
    .slice(start, end)
    .join("\n")
    .split(/\n(?=- )/)
    .map((rule) => rule.replace(/\s+/g, " ").replace(/^- /, ""));
}

test("the system prompt defines what a good grouping is, since no validator can", () => {
  for (const rule of [/cause before consequence/i, /contract before its uses/i, /tests trail/i]) {
    assert.match(GROUPING_SYSTEM_PROMPT, rule);
  }
  assert.match(GROUPING_SYSTEM_PROMPT, /mechanical change[\s\S]*last/i);
  // Pins the opening rule itself; the words `stated intent` also appear in the priority bullet.
  assert.match(GROUPING_SYSTEM_PROMPT, /Opens with the group that carries the stated intent/i);
});

test("the system prompt says where tests go, because leaving it open changed the answer", () => {
  // Measured: with only "tests trail", the model paired each source with its own test — half
  // the disagreement on the worst-scoring fixture.
  assert.match(GROUPING_SYSTEM_PROMPT, /tests for a change go in one[\s\S]*group after the code/i);
});

test("the system prompt refuses to cap the number of groups", () => {
  assert.match(GROUPING_SYSTEM_PROMPT, /no target number/i);
  // A 200-file change squeezed into seven groups is seven groups nobody can hold.
  assert.doesNotMatch(GROUPING_SYSTEM_PROMPT, /\b2-6 groups\b/);
});

test("`rationale` is asked for as what the change does, not as a check-question", () => {
  // The complaint: the rationale was the heading again with a question mark. Loose on the
  // sentence, exact on the invariant: phrasing is the prompt author's business, the demand is not.
  assert.match(RULES, /`rationale`.{0,120}what the.{0,40}does/i);
  assert.match(RULES, /never a.{0,20}question/i);
  assert.match(RULES, /never the name again in longer words/i);
  assert.match(RULES, /Does the session lifecycle handling in frontend look right\?/i);
});

/** 19 of 112 recorded rationales came back as orders ("Add the focus field…"); the original complaint was "instead of telling me what to do". */
test("`rationale` is pinned to the third person, not to an instruction", () => {
  assert.match(RULES, /in the third person/i);
  assert.match(RULES, /never an instruction to the reviewer/i);
});

/** `watch` follows the rationale's rules plus one: it must name this group's risk — a caution fitting every group is the review restated. */
test("`watch` is asked for as the group's own risk, stated rather than ordered", () => {
  assert.match(RULES, /`watch` as one short sentence/i);
  assert.match(RULES, /same rules as `rationale`/i);
  assert.match(RULES, /Check the expiry logic carefully/);
  assert.match(RULES, /would fit any group fits none/i);
});

/** Measured on first baselines: imperatives came back mid-sentence ("…; verify all six…") and doc groups as reassurance — the prompt names both escapes. */
test("`watch` bans the buried imperative and the reassuring grade, docs included", () => {
  assert.match(RULES, /an order is still an order mid-sentence/i);
  assert.match(RULES, /`verify`, `ensure`, `confirm` or any other verb aimed at the reader/);
  assert.match(RULES, /state the danger it points at/i);
  assert.match(RULES, /Nor is it reassurance/i);
  assert.match(RULES, /the comment explains the purpose clearly/i);
  assert.match(RULES, /claim most likely to be false against the code/i);
});

/** B2: the prompt states the applicable test — each group readable from the groups above — not just "causal". */
test("the order is causal: every group readable from the groups above it alone", () => {
  assert.match(RULES, /seen only the groups above/i);
  assert.match(RULES, /mechanism before its uses/i);
});

/** A lockfile is generated output and a dependency change at once: the two bullets would otherwise contradict. */
test("a lockfile is ranked with its manifest, not quarantined as generated bulk", () => {
  assert.match(RULES, /lockfile is not that bulk/i);
  assert.match(RULES, /with the manifest that pins it/i);
});

test("dependencies, security and git hooks are ranked high, and above the tests", () => {
  assert.match(RULES, /Ranks a new dependency, a security-critical change and a git hook high/i);
  assert.match(RULES, /pre-commit or other hook/i);
  assert.match(GROUPING_SYSTEM_PROMPT, /above the tests in every case/i);
  // Deliberately not a hoist: where they sit against the intent is the model's.
  assert.match(GROUPING_SYSTEM_PROMPT, /stated intent is yours to judge/i);
});

test("the prompt says what each reading tier is for, and where the doubt goes", () => {
  assert.match(RULES, /`sweep` is for a chapter whose every file is bulk/i);
  assert.match(RULES, /`study` is everything a human has to judge/i);
  // The asymmetry the code enforces afterwards, stated where the answer is written.
  assert.match(RULES, /wrongly swept is the change nobody looked at/i);
});

test("the two chapters that are never swept are named as exceptions, not as preferences", () => {
  assert.match(RULES, /holding a file the inventory marks `guardrail` is never `sweep`/i);
  assert.match(RULES, /a test chapter is never `sweep`/i);
  // Said as the reason it is, so the rule survives a model that argues with it.
  assert.match(RULES, /check on the code just read/i);
});

/** Rules the schema and `validateGroupingReply` already enforce are deleted on purpose. */
test("the system prompt does not restate what the validator already enforces", () => {
  assert.doesNotMatch(GROUPING_SYSTEM_PROMPT, /^.*there is no order field.*$/im);
  assert.doesNotMatch(GROUPING_SYSTEM_PROMPT, /never invent/i);
  // The schema JSON itself carries `additionalProperties`; no *rule* repeats it.
  const rules = GROUPING_SYSTEM_PROMPT.split("matching this schema:")[0]!;
  assert.doesNotMatch(rules, /additionalProperties/i);
});

test("the schema travels in the system prompt, so the cacheable prefix carries it", () => {
  assert.match(GROUPING_SYSTEM_PROMPT, /"groups"/);
  assert.doesNotMatch(prompt([diffFile("src/a.ts")]), /"groups"/);
});

test("the user message is data only: no schema, no instructions", () => {
  const text = prompt([diffFile("src/a.ts")], { intents: ["sign the tokens"] });

  assert.doesNotMatch(text, /Reply with/i);
  assert.doesNotMatch(text, /schema/i);
});

test("the stated intent leads the user message, in the order it was given", () => {
  const text = prompt([diffFile("src/a.ts")], { intents: ["sign the tokens", "drop /login"] });

  assert.match(text, /1\. sign the tokens\n2\. drop \/login/);
  assert.ok(text.indexOf("sign the tokens") < text.indexOf("src/a.ts"));
});

test("a round with no stated intent says nothing rather than an empty heading", () => {
  assert.doesNotMatch(prompt([diffFile("src/a.ts")]), /intent/i);
});

test("the user prompt lists every changed file with its status", () => {
  const text = prompt([
    diffFile("src/a.ts"),
    diffFile("assets/logo.png", { status: "binary", diff: "" }),
  ]);

  assert.match(text, /src\/a\.ts/);
  assert.match(text, /assets\/logo\.png/);
  assert.match(text, /binary/);
});

/** The common case, and the one a budget rule must not touch. */
test("a patch that fits is sent whole, with nothing added to it", () => {
  const diff = patch("src/a.ts", 1, 3);

  const text = prompt([diffFile("src/a.ts", { diff })]);

  assert.ok(text.endsWith(`--- src/a.ts ---\n${diff}\n`));
  assert.doesNotMatch(text, /not shown/);
});

/** The old flat 4,000-char cap cut both to a third while 80,000 budget chars went unused. */
test("the per-file allowance comes from the budget the header left, not a flat cap", () => {
  const files = ["src/a.ts", "src/b.ts"].map((path) =>
    diffFile(path, { diff: patch(path, 40, 12) }),
  );

  const text = prompt(files);

  for (const file of files) assert.equal(sectionOf(text, file.path), file.diff);
  assert.ok(text.length > 20_000, `prompt was only ${text.length} chars`);
});

test("a patch too big for its share is cut at a hunk boundary, never mid-line", () => {
  const diff = patch("src/big.ts", 400, 40);

  const shown = sectionOf(prompt([diffFile("src/big.ts", { diff })]), "src/big.ts");

  const kept = shown.split("\n... (")[0]!;
  assert.ok(diff.startsWith(`${kept}\n`), "what was shown is not a prefix of the patch");
  assert.ok(kept.split("\n").at(-1)!.startsWith("+  line "), "the cut fell mid-hunk");
  // The cut landed between two hunks: the next line of the patch opens one.
  assert.ok(diff.slice(kept.length + 1).startsWith("@@ "), "the cut fell inside a hunk");
});

/** A model that knows what it is missing can still place the file. */
test("a cut patch says how many hunks and changed lines were left out", () => {
  const diff = patch("src/big.ts", 400, 40);

  const shown = sectionOf(prompt([diffFile("src/big.ts", { diff })]), "src/big.ts");

  const marker = /\.\.\. \((\d+) of 400 hunks shown, (\d+) further changed lines not shown\)/.exec(
    shown,
  );
  assert.ok(marker, `no elision marker in:\n${shown.slice(-200)}`);
  const kept = Number(marker[1]);
  assert.equal(shown.split("\n").filter((line) => line.startsWith("@@ ")).length, kept);
  assert.equal(Number(marker[2]), (400 - kept) * 40);
});

test("the share a small file leaves unused goes to the file that needs it", () => {
  const small = Array.from({ length: 9 }, (_, index) =>
    diffFile(`src/small-${index}.ts`, { diff: patch(`src/small-${index}.ts`, 1, 2) }),
  );
  const big = diffFile("src/big.ts", { diff: patch("src/big.ts", 4_000, 40) });

  const text = prompt([...small, big]);

  for (const file of small) assert.equal(sectionOf(text, file.path), file.diff);
  // An equal tenth would be 12,000 chars; the nine under it hand the surplus to the one over.
  assert.ok(
    sectionOf(text, "src/big.ts").length > 100_000,
    `the big file got only ${sectionOf(text, "src/big.ts").length} chars`,
  );
});

/** The old fallback dropped every diff in the prompt when any one file was too big. */
test("one oversized file no longer blinds the model to the rest of the diff", () => {
  const huge = diffFile("src/huge.ts", { diff: patch("src/huge.ts", 20_000, 40) });
  const small = diffFile("src/small.ts", { diff: patch("src/small.ts", 2, 3) });

  const text = prompt([huge, small]);

  assert.equal(sectionOf(text, "src/small.ts"), small.diff);
  assert.doesNotMatch(text, /diffs omitted/);
  assert.match(sectionOf(text, "src/huge.ts"), /@@ [\s\S]*hunks shown, \d+ further changed lines/);
});

test("no prompt exceeds the whole-prompt budget, however large the diff is", () => {
  const files = Array.from({ length: 200 }, (_, index) =>
    diffFile(`src/file-${index}.ts`, { diff: patch(`src/file-${index}.ts`, 500, 40) }),
  );

  const text = prompt(files);

  assert.ok(
    text.length <= MAX_PROMPT_CHARS,
    `prompt was ${text.length} chars, limit ${MAX_PROMPT_CHARS}`,
  );
  assert.match(text, /src\/file-199\.ts/);
});

/** A share stopping short of the first hunk spends nothing; an added file is one hunk however large. Before the second pass 11,112 chars went unspent on this shape. */
test("a share too small to buy a hunk goes back to the files that can spend it", () => {
  const added = diffFile("src/added.ts", {
    status: "added",
    diff: patch("src/added.ts", 1, 2_000),
  });
  const rest = Array.from({ length: 10 }, (_, index) =>
    diffFile(`src/file-${index}.ts`, { diff: patch(`src/file-${index}.ts`, 20, 60) }),
  );

  const text = prompt([added, ...rest]);

  // The added file's one hunk exceeds any share, so it stays out — but its share must be spent elsewhere.
  assert.ok(
    text.length > MAX_PROMPT_CHARS * 0.98,
    `${MAX_PROMPT_CHARS - text.length} characters went unspent`,
  );
});

test("a diff of many large files spends the budget instead of announcing defeat", () => {
  const files = Array.from({ length: 50 }, (_, index) =>
    diffFile(`src/file-${index}.ts`, { diff: patch(`src/file-${index}.ts`, 50, 200) }),
  );

  const text = prompt(files);

  assert.doesNotMatch(text, /diffs omitted/);
  assert.ok(text.length > MAX_PROMPT_CHARS * 0.9, `only ${text.length} of the budget was spent`);
  // Where no fair share buys a hunk, the leftover goes to the front of the diff.
  assert.match(sectionOf(text, "src/file-0.ts"), /@@ /);
});

/** Four budget mutations survived a one-shape suite landing 40,000 chars short of the cap: only shapes near the cap pin it. */
test("no shape of diff pushes a prompt past the budget", () => {
  const next = randoms(20_240_617);

  for (let shape = 0; shape < 200; shape += 1) {
    const files = Array.from({ length: 1 + Math.floor(next() * 30) }, (_, index) => {
      const path = `src/${"nested/".repeat(Math.floor(next() * 4))}file-${index}.ts`;
      const hunks = Math.floor(next() * 25);
      const lines = 1 + Math.floor(next() * 80);
      return diffFile(path, {
        diff: hunks === 0 ? renamePatch(`old/${path}`, path) : patch(path, hunks, lines),
      });
    });

    const text = prompt(files, { intents: ["shape ".repeat(Math.floor(next() * 40))] });

    assert.ok(
      text.length <= MAX_PROMPT_CHARS,
      `shape ${shape} of ${files.length} file(s) built a prompt of ${text.length} chars`,
    );
  }
});

/**
 * Three off-by-ones (blank line under header, joining newline, elision cost) are invisible unless
 * a prompt rests exactly on the limit: grow the header one char at a time across every alignment.
 */
test("the budget is exact at every alignment of header and hunks", () => {
  const diff = patch("src/a.ts", 6, 1_000);

  for (let pad = 0; pad < 900; pad += 1) {
    const text = prompt([diffFile("src/a.ts", { diff })], { intents: ["x".repeat(pad)] });

    assert.ok(
      text.length <= MAX_PROMPT_CHARS,
      `an intent of ${pad} chars built a prompt of ${text.length} chars`,
    );
  }
});

/** The intent is the one freely-written part; uncapped, a pasted design doc pushed the prompt to 200,171 chars. */
test("a stated intent longer than its cap is cut, and says it was", () => {
  const text = prompt([diffFile("src/a.ts")], {
    intents: ["why this branch exists ".repeat(9_000)],
  });

  assert.ok(text.length <= MAX_PROMPT_CHARS, `prompt was ${text.length} chars`);
  assert.match(text, /intent truncated/);
  assert.match(text, /1\. why this branch exists/);
});

/**
 * The inventory is irreducible (an untold file cannot be grouped) so it may overrun;
 * the promise is diff bodies never push past budget — here none are sent at all.
 */
test("an inventory too large for the budget carries no diff bodies", () => {
  const files = Array.from({ length: 4_000 }, (_, index) =>
    diffFile(`src/very/deeply/nested/directory/file-${index}.ts`, {
      diff: patch(`src/very/deeply/nested/directory/file-${index}.ts`, 3, 40),
    }),
  );

  const text = prompt(files);

  assert.doesNotMatch(text, /^--- /m);
  assert.match(text, /diffs omitted/);
  assert.ok(text.length > MAX_PROMPT_CHARS, "the inventory was expected to overrun on its own");
  assert.ok(text.length < MAX_PROMPT_CHARS * 2.5, `prompt was ${text.length} chars`);
});

/** Last resort: every file is one hunk bigger than the whole budget, so no allocation could place anything. */
test("when no share can carry a hunk, the file list survives on its own", () => {
  const files = Array.from({ length: 20 }, (_, index) =>
    diffFile(`src/file-${index}.ts`, { diff: patch(`src/file-${index}.ts`, 1, 8_000) }),
  );

  const text = prompt(files);

  assert.match(text, /diffs omitted/);
  assert.match(text, /file-19\.ts/);
  assert.doesNotMatch(text, /^--- /m);
});

test("the repair prompt states the problem and asks for the whole reply again", () => {
  const text = buildRepairPrompt("these files are missing: src/b.ts");

  assert.match(text, /these files are missing: src\/b\.ts/);
  assert.match(text, /JSON/);
});

test("a diff of only binary files lists them without claiming the prompt was too large", () => {
  const text = prompt([
    diffFile("assets/logo.png", { status: "binary", diff: "" }),
    diffFile("assets/icon.png", { status: "binary", diff: "" }),
  ]);

  assert.match(text, /assets\/icon\.png/);
  assert.ok(!text.includes("too large"));
});

/**
 * Used to end with `, already approved`, which the rules sank to the review's end; asserted as
 * the whole line so a mark put back on it fails here.
 */
test("an inventory line ends at what git measured, saying nothing of approval", () => {
  const text = prompt([diffFile("src/a.ts"), diffFile("src/b.ts")]);

  assert.match(text, /^- src\/a\.ts \(modified, \+1\/-1\)$/m);
  assert.match(text, /^- src\/b\.ts \(modified, \+1\/-1\)$/m);
});

/**
 * Ordering on approval moved the review under the reviewer between rounds. Asserted closed so
 * the rule stays gone however reworded; adding a rule means editing here too — a decision, not an edit.
 */
test("the rules the model orders on are these and no others", () => {
  assert.deepEqual(
    goodGroupingRules().map((rule) => rule.split(/[.:,]/)[0]),
    [
      "Opens with the group that carries the stated intent",
      "Puts cause before consequence",
      "Puts a contract before its uses",
      "Lets production code lead and tests trail",
      "Ranks a new dependency",
      "Quarantines mechanical change — renames",
      "Uses as many groups as the change has concerns",
      "Holds the previous round's reading order wherever it is still true",
    ],
  );
  // Nothing anywhere else in the prompt speaks of approval either.
  assert.doesNotMatch(RULES, /approv/i);
});

/**
 * Complaint: every round re-grouped from scratch and the reviewer re-learned the map.
 * In the system prompt on purpose: it is the cacheable prefix.
 */
test("the system prompt asks for last round's reading order to be held steady", () => {
  assert.match(RULES, /Holds the previous round's reading order wherever it is still true/i);
  assert.match(RULES, /already learned/i);
  assert.match(RULES, /keep its group names, its order and its membership/i);
  assert.match(RULES, /new file in the group it belongs to rather than opening one for it/i);
  assert.match(RULES, /drop a group whose files are gone/i);
  assert.match(RULES, /add or rename a group only where the change has made the old one false/i);
  assert.match(RULES, /round three should recognise the review they left/i);
});

/** Asserted as whole lines: what the section must carry is order and membership, not a mention. */
test("the previous round's grouping is given back in the order the reviewer read it", () => {
  const text = prompt([diffFile("src/token.ts"), diffFile("test/token.test.ts")], {
    previous: [
      { name: "Token signing", files: ["src/token.ts", "src/keys.ts"] },
      { name: "Tests", files: ["test/token.test.ts"] },
    ],
  });

  assert.match(text, new RegExp(`^${PREVIOUS_HEADING}$`, "m"));
  assert.match(text, /^1\. Token signing — src\/token\.ts, src\/keys\.ts$/m);
  assert.match(text, /^2\. Tests — test\/token\.test\.ts$/m);
  // It is header, so it comes before the inventory the budget is measured against.
  assert.ok(text.indexOf("Token signing") < text.indexOf("Diff with 2 changed file(s):"));
});

/** A first round's prompt must be byte-for-byte what it always was, so the provider's cache is not split. */
test("a first round says nothing about a previous grouping", () => {
  const files = [diffFile("src/a.ts"), diffFile("src/b.ts")];

  const text = prompt(files);

  assert.doesNotMatch(text, /last round/i);
  assert.doesNotMatch(text, /^Grouping you returned/m);
  assert.equal(prompt(files, { previous: [] }), text);
});

/**
 * The memory gives way to the patches. Cut at a group boundary and said aloud: a group listing
 * three of its eight files would read as a group that shed five.
 */
test("an oversized previous grouping is cut at a group boundary, and says so", () => {
  const previous = Array.from({ length: 400 }, (_, index) => ({
    name: `Concern number ${index}`,
    files: Array.from({ length: 5 }, (_, file) => `src/area-${index}/file-${file}.ts`),
  }));
  const files = Array.from({ length: 20 }, (_, index) =>
    diffFile(`src/file-${index}.ts`, { diff: patch(`src/file-${index}.ts`, 30, 40) }),
  );

  const text = prompt(files, { previous });

  const section = previousListing(text);
  assert.ok(section.length <= MAX_PREVIOUS_CHARS, `the section was ${section.length} chars`);
  const marker = /\.\.\. \((\d+) of 400 groups shown, (\d+) further files not shown\)/.exec(
    section,
  );
  assert.ok(marker, `no dropped-groups note in:\n${section.slice(-200)}`);
  const kept = Number(marker[1]);
  assert.ok(kept > 0 && kept < 400, `${kept} groups survived the cap`);
  assert.equal(Number(marker[2]), (400 - kept) * 5);
  // Whole groups only: the last kept carries all five files, the first dropped carries none.
  assert.match(section, new RegExp(`^${kept}\\. Concern number ${kept - 1} — .*file-4\\.ts$`, "m"));
  assert.doesNotMatch(section, new RegExp(`Concern number ${kept}\\b`));
  // And the diff still won: the budget the header left over still bought patches.
  assert.ok(text.length <= MAX_PROMPT_CHARS, `prompt was ${text.length} chars`);
  assert.match(text, /^--- src\/file-0\.ts ---$/m);
  assert.match(text, /^@@ /m);
});

const PREVIOUS_HEADING = "Grouping you returned last round, in the order the reviewer read it:";

/** The listing under the heading, without the heading or the blank line after it. */
function previousListing(text: string): string {
  const start = text.indexOf(`${PREVIOUS_HEADING}\n`);
  assert.notEqual(start, -1, "no previous-grouping section");
  return text.slice(start + PREVIOUS_HEADING.length + 1).split("\n\n")[0]!;
}

/**
 * Inventory alone leaves under `MIN_PATCH_CHARS` spare. Regression: the memory charged to the
 * header took this shape 7,968 chars past budget and dropped every hunk.
 */
function longInventory(count: number): DiffFile[] {
  return Array.from({ length: count }, (_, index) => {
    const path = `src/very/deeply/nested/directory/module-${index}/file.ts`;
    return diffFile(path, { diff: patch(path, 20, 40) });
  });
}

function memoryOf(count: number): { name: string; files: string[] }[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Concern number ${index}`,
    files: [`src/very/deeply/nested/directory/module-${index}/file.ts`],
  }));
}

/**
 * The memory is the one honest thing to drop, so it goes before any hunk — heading included:
 * a heading over a bare elision says only that a grouping once existed.
 */
test("a previous grouping never takes the patches' place in the budget", () => {
  const files = longInventory(1_580);

  const without = prompt(files);
  const withMemory = prompt(files, { previous: memoryOf(400) });

  assert.match(without, /^@@ /m);
  assert.ok(without.length <= MAX_PROMPT_CHARS, `prompt was ${without.length} chars`);
  assert.ok(withMemory.length <= MAX_PROMPT_CHARS, `prompt was ${withMemory.length} chars`);
  assert.doesNotMatch(withMemory, /Grouping you returned last round/);
  assert.doesNotMatch(withMemory, /groups shown/);
  assert.doesNotMatch(withMemory, /diffs omitted/);
  // Not merely "still has hunks": the diff the model reads is the same diff.
  assert.equal(withMemory, without);
});

/**
 * The ceiling is what the section may cost; what the inventory left spare is what it does cost.
 * A self-measuring cap let this header buy 10,000 chars it did not have.
 */
test("the memory is cut to what the inventory left spare, not to its own ceiling", () => {
  const files = longInventory(1_320);

  const text = prompt(files, { previous: memoryOf(400) });

  const listing = previousListing(text);
  assert.ok(listing.length > 0, "the section was dropped altogether");
  assert.ok(
    listing.length < MAX_PREVIOUS_CHARS / 2,
    `the listing took ${listing.length} of a ${MAX_PREVIOUS_CHARS} ceiling the header could not pay`,
  );
  assert.match(listing, /groups shown, \d+ further files not shown/);
  assert.ok(text.length <= MAX_PROMPT_CHARS, `prompt was ${text.length} chars`);
  assert.match(text, /^@@ /m);
  assert.doesNotMatch(text, /diffs omitted/);
});

/** A grouping sized to rest on the cap: names padded so one character decides whether the last group fits. */
function memoryOnTheCap(count: number, pad: number): { name: string; files: string[] }[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `${"C".repeat(pad)}${index}`,
    files: Array.from({ length: 5 }, (_, file) => `src/a${index}/f${file}.ts`),
  }));
}

/**
 * A cut grouping with no note looks complete and the model holds it: the group is dropped for
 * good. One group short is the boundary the 400-group fixture never lands on.
 */
test("a cut of exactly one group still says a group was cut", () => {
  const text = prompt([diffFile("src/a.ts"), diffFile("src/b.ts")], {
    previous: memoryOnTheCap(62, 79),
  });

  const listing = previousListing(text).split("\n");
  assert.equal(listing.length, 62, `${listing.length} lines, expected 61 groups and the note`);
  assert.match(listing[60]!, /^61\. C+60 — src\/a60\/f0\.ts, /);
  assert.equal(listing[61], "... (61 of 62 groups shown, 5 further files not shown)");
});

/**
 * `keepWhileFits` prices each item with the note it would leave (notes grow when counts roll a
 * digit); without look-ahead this stops at 61 under a false `61 of 62`. Fuzz never lands here.
 */
test("a grouping that fits to the last group is not cut by the note it does not need", () => {
  const text = prompt([diffFile("src/a.ts"), diffFile("src/b.ts")], {
    previous: memoryOnTheCap(62, 78),
  });

  const listing = previousListing(text).split("\n");
  assert.equal(listing.length, 62, `${listing.length} lines, expected all 62 groups and no note`);
  assert.match(listing[61]!, /^62\. C+61 — src\/a61\/f0\.ts, /);
  assert.doesNotMatch(previousListing(text), /groups shown/);
});

/**
 * Neither section filters against the other: a vanished group is still shown (the model cannot
 * be told to drop what it never saw), a new file appears in the inventory alone.
 */
test("a vanished group is still shown, and a file the last grouping never saw is not", () => {
  const text = prompt([diffFile("src/token.ts"), diffFile("src/refresh.ts")], {
    previous: [
      { name: "Token signing", files: ["src/token.ts"] },
      { name: "Legacy cookies", files: ["src/cookies.ts", "src/session.ts"] },
    ],
  });

  const section = previousListing(text);
  assert.match(section, /^2\. Legacy cookies — src\/cookies\.ts, src\/session\.ts$/m);
  assert.doesNotMatch(section, /src\/refresh\.ts/);
  assert.match(text, /^- src\/refresh\.ts \(modified, \+1\/-1\)$/m);
  // A path only the memory knows is never mistaken for a changed file.
  assert.doesNotMatch(text, /^- src\/cookies\.ts /m);
});

test("a renamed file says where it came from and how much survived", () => {
  const renamed = diffFile("src/auth/token.ts", {
    status: "renamed",
    previousPath: "src/token.ts",
    similarity: 96,
  });

  const text = buildGroupingPrompt({ files: [renamed], intents: [] });

  assert.match(text, /- src\/auth\/token\.ts \(renamed from src\/token\.ts, 96% identical, /);
});

/**
 * The marks are the classifier's answer restated where the model reads the diff. Asserted as
 * whole lines: the mark belongs at the end of the line git's own numbers close, not anywhere.
 */
test("an inventory line states the classification when the rules settled one", () => {
  const text = prompt([
    diffFile("docs/setup.md", { insertions: 12, deletions: 4 }),
    diffFile("install.sh", { insertions: 31, deletions: 0 }),
    diffFile("src/server.ts"),
  ]);

  assert.match(text, /^- docs\/setup\.md \(modified, \+12\/-4, mechanical\)$/m);
  assert.match(text, /^- install\.sh \(modified, \+31\/-0, guardrail\)$/m);
  assert.match(text, /^- src\/server\.ts \(modified, \+1\/-1\)$/m);
});

test("the repository's own classify globs reach the inventory", () => {
  const text = prompt([diffFile("app/payments/charge.rb"), diffFile("docs/api/orders.json")], {
    classify: { mechanical: ["docs/api/**"], guardrail: ["app/payments/**"] },
  });

  assert.match(text, /^- app\/payments\/charge\.rb \(modified, \+1\/-1, guardrail\)$/m);
  assert.match(text, /^- docs\/api\/orders\.json \(modified, \+1\/-1, mechanical\)$/m);
});

/** Guardrail wins in the classifier, and the line the model reads must not say otherwise. */
test("a guardrail file is never reported as mechanical, whatever else it is", () => {
  const text = prompt([diffFile("docs/deploy.md")], {
    classify: { mechanical: [], guardrail: ["docs/deploy.md"] },
  });

  assert.match(text, /^- docs\/deploy\.md \(modified, \+1\/-1, guardrail\)$/m);
});

test("a renamed file carries its mark after the numbers, not instead of them", () => {
  const renamed = diffFile("app/models/orders/order.rb", {
    status: "renamed",
    previousPath: "app/models/order.rb",
    similarity: 100,
    insertions: 0,
    deletions: 0,
    diff: "",
  });

  const text = buildGroupingPrompt({ files: [renamed], intents: [] });

  assert.match(
    text,
    /^- app\/models\/orders\/order\.rb \(renamed from app\/models\/order\.rb, 100% identical, \+0\/-0, mechanical\)$/m,
  );
});

/**
 * The prompt already asks for a quarantine and for scripts and dependencies to rank high; the
 * marks hand the model the facts instead of asking it to infer them, which is why they are
 * described as facts and not as a verdict on the group they land in.
 */
test("the system prompt says what the marks on an inventory line mean", () => {
  assert.match(RULES, /`mechanical`/);
  assert.match(RULES, /`guardrail`/);
  assert.match(RULES, /facts about the file[^.]*not instructions about the group/i);
});
