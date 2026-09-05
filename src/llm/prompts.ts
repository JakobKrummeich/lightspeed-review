import { classifyFile, type ClassifyConfig } from "../classify.ts";
import { splitHunks, type DiffFile } from "../diff-extract.ts";
import { GROUPING_SCHEMA_JSON } from "./schema.ts";

/**
 * Whole-prompt budget, and the only one there is: what the header leaves of it
 * is shared out between the files by `fairShares`, so a two-file diff sends
 * both patches whole where a two-hundred-file diff sends a few hunks each.
 */
export const MAX_PROMPT_CHARS = 120_000;

/**
 * Cap on the stated intent — the one free-written part of the prompt. A pasted
 * design document used to be unanswerable: 200,000 chars of intent made a
 * 200,171-char prompt, budget or no budget. No honest intent meets this cap.
 */
export const MAX_INTENT_CHARS = 8_000;

/**
 * The room the patches never give up; the previous grouping is offered only
 * what is left over. 20,000 chars is under this repo's median commit (25,263
 * over the last forty), so an ordinary round's whole diff is never traded for
 * a memory of last round's layout.
 */
export const MIN_PATCH_CHARS = 20_000;

/**
 * Ceiling on the previous-grouping section, heading included — a maximum, never
 * an entitlement: charged to what the inventory left spare, not to the patches
 * (see `previousRoom`). At ~30 chars a path it carries some 300 memberships
 * whole for 8% of the whole-prompt budget.
 */
export const MAX_PREVIOUS_CHARS = 10_000;

/**
 * Everything identical on every call, schema included, so a provider's prompt
 * cache can reuse the prefix. Deliberately unsaid: rules the validator already
 * enforces (`order` = array position, no extra keys, paths from the diff) —
 * prompt space goes to the one thing no validator can check, what makes a
 * grouping good. Tests-last is stated although `trailTests` enforces it:
 * "ranks high" with nothing to rank above is an adjective, not an order.
 */
export const GROUPING_SYSTEM_PROMPT = [
  "You decide the order in which a human reads a code review.",
  "",
  "They will read the diff in the groups you return, in the order you return them.",
  "Grouping is not classification: it is a reading order that makes the change",
  "explain itself, one group at a time.",
  "",
  "A good grouping:",
  "- Opens with the group that carries the stated intent. That is the change the",
  "  reviewer came to judge; everything else in the diff exists to serve it.",
  "- Puts cause before consequence: the change that forced the others comes first,",
  "  so each later group reads as a result rather than a surprise. The test is",
  "  that every group makes sense to a reader who has seen only the groups above",
  "  it: the mechanism before its uses, the foundation before what stands on it.",
  "- Puts a contract before its uses: the type, the schema, the signature, then the",
  "  call sites that had to follow it.",
  "- Lets production code lead and tests trail: the tests for a change go in one",
  "  group after the code they cover, not paired file by file with it. A test read",
  "  before the code it covers is a puzzle; read after it, it is a check on what",
  "  was just read.",
  "- Ranks a new dependency, a security-critical change and a git hook high: a",
  "  package added to the manifest, a change to authentication, permissions,",
  "  secrets or the handling of untrusted input, a pre-commit or other hook that",
  "  runs on every commit. Those are the lines a reviewer least wants to meet at",
  "  the bottom of a review, and they come above the tests in every case. Where",
  "  they sit against the group carrying the stated intent is yours to judge.",
  "- Quarantines mechanical change — renames, moves, generated output, formatting —",
  "  in its own group, last. It is bulk with nothing to decide, and mixed into real",
  "  work it hides that work. A dependency lockfile is not that bulk, however it",
  "  was generated: it goes high, with the manifest that pins it.",
  "- Uses as many groups as the change has concerns. Too few and a group is a",
  "  second diff for the reviewer to sort out; too many and the order is just the",
  "  file list again. There is no target number.",
  "- Holds the previous round's reading order wherever it is still true. A",
  "  grouping given as last round's is one the reviewer has already learned: keep",
  "  its group names, its order and its membership wherever the diff still",
  "  supports them. Put a new file in the group it belongs to rather than opening",
  "  one for it; drop a group whose files are gone; add or rename a group only",
  "  where the change has made the old one false, and then only that group. A",
  "  reviewer coming back for round three should recognise the review they left.",
  "",
  "An inventory line may end in `mechanical` or `guardrail`: `mechanical` says the",
  "change is bulk with nothing to decide, `guardrail` says the file is a script, a",
  "hook, a dependency or a piece of infrastructure whose change is never that bulk",
  "however small it looks. Both are facts about the file, read off the diff and the",
  "repository's own configuration, and not instructions about the group they land",
  "in; a file carrying neither mark is one no rule could settle, which says nothing",
  "about how much it matters.",
  "",
  "Name each group after the concern it represents — `Token signing`, not",
  "`Changes in src`. Write `rationale` as one short sentence saying what the",
  "change in that group does — a primer under the name, carrying what the name",
  "had no room for. Say what the change does, in the third person: never a",
  "question, never an instruction to the reviewer, and never the name again in",
  "longer words. Under `Session lifecycle handling in frontend`, `Does the",
  "session lifecycle handling in frontend look right?` tells the reviewer",
  "nothing they did not read one line above, and `Check the teardown path`",
  "orders them to do the job they opened the review to do, while `Ends the",
  "session when the last socket closes and drops the timers the panel was",
  "holding` tells them what they are about to read. An order is still an order",
  "mid-sentence: never `verify`, `ensure`, `confirm` or any other verb aimed at",
  "the reader — where one is tempting, say what the code does instead.",
  "",
  "Set `tier` to how the chapter has to be read. `sweep` is for a chapter whose",
  "every file is bulk — renames, moves, generated output, formatting,",
  "documentation, styling, translation catalogues — where reading line by line",
  "buys the reviewer nothing and the whole chapter is one tick. `study` is",
  "everything a human has to judge, and it is the answer wherever there is a",
  "doubt: a chapter wrongly swept is the change nobody looked at, while a",
  "chapter wrongly studied costs a few minutes. Two rules admit no exception. A",
  "chapter holding a file the inventory marks `guardrail` is never `sweep`,",
  "however small its diff: a script, a hook, a dependency or a piece of",
  "infrastructure is what a reviewer is there for. And a test chapter is never",
  "`sweep`: a test is the check on the code just read, which is exactly a thing",
  "to read.",
  "",
  "Every file in the diff belongs to exactly one group — a gap costs a whole",
  "extra round trip.",
  "",
  "Reply with JSON only, no prose and no markdown fences — a single object",
  "whose only top-level key is `groups`, never an echo of the schema's own",
  "keywords (`type`, `properties`, `$schema`) — matching this schema:",
  GROUPING_SCHEMA_JSON,
].join("\n");

/** One group of the grouping the reviewer read last round, by file path. */
export interface PreviousGroup {
  name: string;
  files: string[];
}

export interface GroupingPromptInput {
  files: DiffFile[];
  /** Why the branch exists, as the agent that opened the review stated it. */
  intents: string[];
  /** The grouping the reviewer read last round, in the order they read it. */
  previous?: PreviousGroup[];
  /** The repository's own classify globs; absent leaves the classifier's defaults alone. */
  classify?: ClassifyConfig;
}

/**
 * The first user message: data only — every instruction lives in the system
 * prompt. Degrades one file at a time: the header (intent + inventory) is
 * written first, since a file missing from the inventory cannot be grouped,
 * and what it did not spend is shared between the patches. The inventory is
 * irreducible, so `MAX_PROMPT_CHARS` bounds the diff bodies, not the prompt:
 * an inventory alone overrunning the budget overruns it, budget clamped to
 * zero. The previous grouping is the one honest-to-drop header part, so it is
 * sized against the spare above `MIN_PATCH_CHARS` and shrinks to nothing —
 * charged to the header instead, a 1,600-file diff went 7,968 chars past
 * budget and left the model reading `(diffs omitted: too large for one request)`.
 */
export function buildGroupingPrompt(input: GroupingPromptInput): string {
  const { files, intents } = input;
  const intent = intentSection(intents);
  const inventory = [
    `Diff with ${files.length} changed file(s):`,
    "",
    files.map((file) => inventoryLine(file, input.classify)).join("\n"),
  ];
  const irreducible = [...intent, ...inventory].join("\n").length;
  const header = [
    ...intent,
    ...previousSection(input.previous ?? [], previousRoom(irreducible)),
    ...inventory,
  ].join("\n");
  const patched = files.filter((file) => file.diff !== "");
  if (patched.length === 0) return header;

  // Less the blank line between the header and the first section.
  const budget = Math.max(0, MAX_PROMPT_CHARS - header.length - 1);
  const sections = shareOut(patched, budget).filter((section) => section !== "");

  if (sections.length === 0) {
    return [header, "", "(diffs omitted: too large for one request)"].join("\n");
  }
  return [header, "", ...sections].join("\n");
}

/** Follow-up user message that keeps the failed attempt in the conversation. */
export function buildRepairPrompt(problem: string): string {
  return [
    `That reply was rejected: ${problem}`,
    "",
    "Reply again with the complete grouping as JSON only, matching the schema exactly.",
  ].join("\n");
}

/**
 * The strongest signal this call gets, so it comes first and in the order the
 * agent gave it. A round from before intents were required simply has none.
 */
function intentSection(intents: string[]): string[] {
  if (intents.length === 0) return [];
  return [
    "Stated intent of this branch, written by the agent that changed it:",
    clip(intents.map((intent, index) => `${index + 1}. ${intent}`).join("\n"), MAX_INTENT_CHARS),
    "",
  ];
}

/**
 * Last round's reading order, verbatim and data-only (the hold-steady rule
 * lives in the cacheable system prompt). Deliberately not filtered against this
 * round's diff: the model reads gone-groups and new files off the two lists
 * together — filtering would silently retire a group the reviewer remembers.
 */
function previousSection(previous: PreviousGroup[], room: number): string[] {
  // Heading and blank line spent out of `room`: the section's cost before it says anything.
  const lines = previousLines(previous, room - PREVIOUS_HEADING.length - 2);
  if (lines.length === 0) return [];
  return [PREVIOUS_HEADING, ...lines, ""];
}

const PREVIOUS_HEADING = "Grouping you returned last round, in the order the reviewer read it:";

/**
 * What is left for the memory once the diff has its floor: only the spare, so
 * an inventory threatening `MIN_PATCH_CHARS` silences the section rather than
 * spending the patches' room.
 */
function previousRoom(irreducible: number): number {
  const spare = MAX_PROMPT_CHARS - irreducible - MIN_PATCH_CHARS;
  return Math.max(0, Math.min(MAX_PREVIOUS_CHARS, spare));
}

/**
 * As many whole groups as `limit` pays for, plus a note on what was cut. Whole
 * groups only: a group listing three of its eight files reads as a group that
 * shed five — the one thing this section must not say by accident.
 */
function previousLines(previous: PreviousGroup[], limit: number): string[] {
  const entries = previous.map((group, index) => ({
    line: `${index + 1}. ${group.name} — ${group.files.join(", ")}`,
    files: group.files.length,
  }));
  const { kept, note } = keepWhileFits({
    items: entries,
    cost: (entry) => entry.line.length + 1,
    left: (entry) => entry.files,
    note: (shown, files) => dropped(entries.length, shown, files),
    // Less the newline the note needs if the cut turns out to need one.
    limit: limit - 1,
  });
  // Nothing kept is nothing to hold steady: an elision standing alone under the
  // heading says only that there was a grouping, which is not a reading order.
  if (kept === 0) return [];
  return [...entries.slice(0, kept).map((entry) => entry.line), ...(note === "" ? [] : [note])];
}

/**
 * What the cap left out, in the section's own terms: "6 of 40 groups shown"
 * tells the model the order continues past what it sees, and the unseen files
 * are not new to the reviewer.
 */
function dropped(count: number, kept: number, files: number): string {
  if (kept === count) return "";
  return `... (${kept} of ${count} groups shown, ${files} further files not shown)`;
}

interface FitInput<T> {
  /** In the order they will be read; the prefix that fits is what survives. */
  items: T[];
  /** What one item adds to the running total, in characters. */
  cost: (item: T) => number;
  /** What showing one item takes off the count the note reports. */
  left: (item: T) => number;
  /** The line saying what was cut, empty when nothing was. */
  note: (kept: number, left: number) => string;
  limit: number;
}

/**
 * Longest prefix of `items` fitting `limit`, plus the note under it. Both cut
 * sites (patch → hunks, grouping → groups) want the same properties: cut between
 * items, truthful note, note paid for before the item needing it. That last is
 * why this is not a `reduce`: a note grows when its count rolls over a digit, so
 * each step prices the item together with the note it would leave. `left` is
 * decremented, not re-summed per pass — re-reducing made a 100,000-hunk file
 * cost 2.4 seconds to lay out.
 */
function keepWhileFits<T>({ items, cost, left, note, limit }: FitInput<T>): {
  kept: number;
  note: string;
} {
  let used = 0;
  let kept = 0;
  let remaining = items.reduce((total, item) => total + left(item), 0);
  for (const item of items) {
    const after = remaining - left(item);
    if (used + cost(item) + note(kept + 1, after).length > limit) break;
    used += cost(item);
    remaining = after;
    kept += 1;
  }
  return { kept, note: note(kept, remaining) };
}

/**
 * Prose has no hunk seam, so the cut falls at the last break/space before the
 * limit and says it happened — a sentence that ends early, not one never written.
 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const seam = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  return `${cut.slice(0, seam === -1 ? limit : seam)}\n... (intent truncated)`;
}

/**
 * Approval is deliberately not on this line. The model was once told, with a
 * sink-approved-groups rule; both are gone — approval moving the review between
 * rounds is what loses the reviewer their place, and telling without the rule
 * is the same sinking minus the determinism.
 */
function inventoryLine(file: DiffFile, classify?: ClassifyConfig): string {
  const measured = `${file.status}${renameMark(file)}, +${file.insertions}/-${file.deletions}`;
  return `- ${file.path} (${measured}${classificationMark(file, classify)})`;
}

/**
 * What `src/classify.ts` settled about this file, in one word after the numbers.
 * The system prompt already asks for mechanical change to be quarantined last
 * and for scripts, hooks and dependencies to rank high; the mark hands the model
 * the fact instead of asking it to infer one from a path. Guardrail is printed
 * where both could be — it never is, since the classifier suppresses mechanical
 * on a guardrail file, and printing the stronger mark keeps that true of the
 * line as well. A file no rule claims says nothing rather than `ordinary`: an
 * absent mark is an absent fact, not a verdict that the file is unimportant.
 */
function classificationMark(file: DiffFile, classify?: ClassifyConfig): string {
  const { mechanical, guardrail } = classifyFile(file, classify);
  if (guardrail) return ", guardrail";
  return mechanical ? ", mechanical" : "";
}

/**
 * A rename git measured is mechanical by arithmetic, not by judgement: with the
 * similarity on the line, the quarantine group is a fact the model can read.
 */
function renameMark(file: DiffFile): string {
  if (file.previousPath === undefined) return "";
  const identical = file.similarity === undefined ? "" : `, ${file.similarity}% identical`;
  return ` from ${file.previousPath}${identical}`;
}

/**
 * Sections in file order, spending as much of `budget` as whole hunks can.
 * Two passes: a fair share measured in characters is not a share of what the
 * prompt can carry — under the fair pass alone, 50 files of 50 hunks came back
 * with 98% of budget unspent under a false "too large for one request". The
 * second pass offers each file, in reading order, everything still unspent;
 * one sweep settles it, so "too large" prints only when true. Reading order,
 * not need, is deliberate: leftover goes to the front of the diff rather than
 * slices that buy nothing — the cost is breadth, the alternative an allocator
 * counting hunks in one pass and characters in another.
 */
function shareOut(files: DiffFile[], budget: number): string[] {
  const fair = fairShares(files, sectionCost, budget).map(({ item, share }) => ({
    file: item,
    section: hunkSection(item, share),
  }));
  let unspent = budget - fair.reduce((total, { section }) => total + spend(section), 0);
  return fair.map(({ file, section }) => {
    const grown = hunkSection(file, spend(section) + unspent);
    unspent -= spend(grown) - spend(section);
    return grown;
  });
}

/** What a rendered section costs: itself, and the newline joining it to the next. */
function spend(section: string): number {
  return section === "" ? 0 : section.length + 1;
}

/**
 * Water-filling: equal shares, under-needers hand back the rest; smallest need
 * first is that repetition done once. Only files no allocation could keep whole
 * are ever cut, so a diff that fits at all is sent entire. The alternative — a
 * flat per-file cap — cut eight files of a real 91,000-char diff to 38% of
 * themselves while 80,000 chars of budget went unspent.
 */
function fairShares<T>(
  items: T[],
  need: (item: T) => number,
  budget: number,
): { item: T; share: number }[] {
  const shares = items.map((item) => ({ item, need: need(item), share: 0 }));
  let left = budget;
  for (const [taken, entry] of [...shares].sort((a, b) => a.need - b.need).entries()) {
    entry.share = Math.min(entry.need, Math.floor(left / (shares.length - taken)));
    left -= entry.share;
  }
  return shares;
}

/** What a file's whole patch costs: the label, the patch, its own newline and the joining one. */
function sectionCost(file: DiffFile): number {
  return sectionLabel(file).length + file.diff.length + 2;
}

function sectionLabel(file: DiffFile): string {
  return `--- ${file.path} ---\n`;
}

/**
 * As much of a file's patch as `share` pays for, cut only at hunk boundaries:
 * half a hunk reads as a corrupt patch and costs the same. A file that cannot
 * afford its first hunk contributes nothing — its inventory line already says
 * it changed. Monotone in `share`, which `shareOut` relies on for its second,
 * larger offer.
 */
function hunkSection(file: DiffFile, share: number): string {
  if (sectionCost(file) <= share) return `${sectionLabel(file)}${file.diff}\n`;

  const { header, hunks } = splitHunks(file.diff);
  // Nothing to cut at, not nothing affordable: a 100%-identical rename and a
  // combined diff are all header — no share would change that.
  if (hunks.length === 0) return "";

  const { kept, note } = keepWhileFits({
    items: hunks,
    cost: (hunk) => hunk.header.length + hunk.body.length,
    left: (hunk) => hunk.insertions + hunk.deletions,
    note: (shown, lines) => elision(hunks.length, shown, lines),
    limit: share - sectionLabel(file).length - 2 - header.length,
  });
  if (kept === 0) return "";
  const shown = hunks.slice(0, kept).map((hunk) => hunk.header + hunk.body);
  return `${sectionLabel(file)}${header}${shown.join("")}${note}\n`;
}

/**
 * What the cut left out, in the model's own terms: "4 of 11 hunks shown, 380
 * further changed lines" is a thing to weigh; a bare "truncated" is a thing to
 * guess about.
 */
function elision(count: number, kept: number, lines: number): string {
  if (kept === count) return "";
  return `... (${kept} of ${count} hunks shown, ${lines} further changed lines not shown)`;
}
