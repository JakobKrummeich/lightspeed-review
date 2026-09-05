import { mergeStreams, nodeStream } from "diff2html/lib/ui/js/highlight.js-helpers.js";
import type { HLJSApi } from "highlight.js";
import { highlightFile, htmlForRow, type DiffRow } from "../syntax-file.ts";
import { loadHighlighter } from "../syntax-grammars.ts";
import { languageForPath } from "../syntax-languages.ts";
import { highlightSide } from "../syntax-lines.ts";
import { lineNumbers, sideColumns } from "./line-numbers.ts";
import { fetchFileSide } from "./session-api.ts";

type Side = "old" | "new";

const SIDES: Side[] = ["old", "new"];

/** Both versions of one file, as far as the server could produce them. */
type FileText = Partial<Record<Side, string>>;

/**
 * Which versions of a file are worth asking for. A file that was added has no
 * old version, a deleted one has no new version, and a binary file has no lines
 * at all; asking anyway would only log a 404 in the reviewer's console.
 */
const SIDES_BY_STATUS: Record<string, Side[]> = {
  added: ["new"],
  deleted: ["old"],
  binary: [],
};

/**
 * Colours an already-rendered diff, one grammar per file. Runs after the diff
 * is on screen: momentary monochrome beats nothing until highlight.js loads.
 * Files are read whole out of git — a hunk is not a program, and meaning
 * depends on the surrounding lines a diff leaves out.
 */
export async function highlightDiff(root: HTMLElement, sessionKey?: string): Promise<void> {
  await highlightBlocks(
    [...root.querySelectorAll<HTMLElement>(".lsr-file[data-file]")],
    sessionKey,
  );
}

/**
 * Same for a named set of blocks (a form toggle replaces one block's lines);
 * repainting the whole review would merge a second set of spans into
 * already-coloured lines.
 */
export async function highlightBlocks(blocks: HTMLElement[], sessionKey?: string): Promise<void> {
  const files = blocks
    // A whole-file view arrives pre-highlighted from its own fetch; a second
    // pass would merge its spans into themselves.
    .filter((element) => element.dataset.form !== "full")
    .map((element) => ({ element, language: languageForPath(element.dataset.file ?? "") }))
    .filter((file): file is { element: HTMLElement; language: string } => !!file.language);
  // Started before grammars are awaited: the two round trips overlap.
  const texts = files.map((file) => readFile(sessionKey, file.element.dataset));
  const hljs = await loadHighlighter(files.map((file) => file.language));
  if (!hljs) return;
  for (const [index, { element, language }] of files.entries()) {
    const text = await texts[index]!;
    // A re-group or format switch mid-flight detaches these nodes; skip them.
    if (!element.isConnected) continue;
    paint(element, hljs, language, text);
  }
}

/**
 * Never fatal: an unserved file is read from the diff. Versions fetched are
 * the branch's; an approved-form block diffs two other commits, so
 * `htmlForRow` rejects its lines and it falls back to hunk-only highlighting
 * — deliberate, since serving the approving round's tree would mean a second
 * endpoint for a rarely opened view.
 */
async function readFile(sessionKey: string | undefined, file: DOMStringMap): Promise<FileText> {
  const path = file.file ?? "";
  if (!sessionKey || path === "") return {};
  const text: FileText = {};
  await Promise.all(
    (SIDES_BY_STATUS[file.status ?? ""] ?? SIDES).map(async (side) => {
      text[side] = await fetchFileSide(sessionKey, path, side).catch(() => undefined);
    }),
  );
  return text;
}

/**
 * Each line written once (a double paint would merge the first paint's spans
 * into the second as diff marks). Whole-file wins; the rest falls back to the
 * diff's own text.
 */
function paint(file: HTMLElement, hljs: HLJSApi, language: string, text: FileText): void {
  const fromFile = paintFromFile(file, hljs, language, text);
  const sides = sidesOf(file);
  const complete = sides.every((side) => side.every((line) => fromFile.has(line)));
  const fromDiff = complete ? new Map<Element, string>() : paintFromDiff(sides, hljs, language);
  for (const [line, html] of new Map([...fromDiff, ...fromFile])) apply(line, html);
}

/**
 * Highlights each version as its own document, handing every diff row its
 * line. Rows the file cannot account for are left for the diff-only pass.
 */
function paintFromFile(
  file: HTMLElement,
  hljs: HLJSApi,
  language: string,
  text: FileText,
): Map<Element, string> {
  const painted = new Map<Element, string>();
  // Old first, so context lines end up coloured by the newer version — the
  // one under review.
  for (const side of SIDES) {
    const contents = text[side];
    const highlighted =
      contents === undefined ? undefined : highlightFile(hljs, language, contents);
    if (!highlighted) continue;
    for (const { line, row } of rowsOf(file, side)) {
      const html = htmlForRow(highlighted, row);
      if (html !== undefined) painted.set(line, html);
    }
  }
  return painted;
}

/**
 * Fallback: highlight what is on screen. Multi-line constructs cut by the
 * hunk read wrongly — the price of having no file.
 */
function paintFromDiff(sides: Element[][], hljs: HLJSApi, language: string): Map<Element, string> {
  const painted = new Map<Element, string>();
  for (const side of sides) {
    const highlighted = highlightSide(
      hljs,
      language,
      side.map((line) => line.textContent ?? ""),
    );
    if (!highlighted) continue;
    for (const [index, line] of side.entries()) painted.set(line, highlighted[index] ?? "");
  }
  return painted;
}

/** Rendered rows of one version, each with diff2html's printed line number. */
function rowsOf(file: HTMLElement, side: Side): { line: Element; row: DiffRow }[] {
  const columns = sideColumns(file);
  const scope = columns.length > 0 ? columns[side === "old" ? 0 : 1] : file;
  if (!scope) return [];
  return lineElements(scope).map((line) => ({
    line,
    row: { number: lineNumbers(line, columns)[side], text: line.textContent ?? "" },
  }));
}

/**
 * Line elements grouped into the texts they came from: only each version on
 * its own is a document highlight.js can read. Side-by-side: a column each;
 * unified: removed+context, then added+context. Context lines belong to both
 * and are painted by the newer one.
 */
function sidesOf(file: HTMLElement): Element[][] {
  const columns = [...file.querySelectorAll(".d2h-file-side-diff")];
  if (columns.length > 0) return columns.map((column) => [...lineElements(column)]);
  const before: Element[] = [];
  const after: Element[] = [];
  for (const line of lineElements(file)) {
    const cell = line.closest("td");
    if (!cell?.classList.contains("d2h-ins")) before.push(line);
    if (!cell?.classList.contains("d2h-del")) after.push(line);
  }
  return [before, after];
}

function lineElements(scope: Element): Element[] {
  return [...scope.querySelectorAll(".d2h-code-line-ctn")].filter(
    // Hunk headers (`@@ -1,4 +1,4 @@`) are not part of either version's text.
    (line) => !line.closest("td")?.classList.contains("d2h-info"),
  );
}

/**
 * diff2html marks intra-line edits with `<ins>`/`<del>`; the highlighted line
 * is plain markup over the same text, so the two are merged by diff2html's
 * own helpers rather than one thrown away.
 */
function apply(line: Element, html: string): void {
  const text = line.textContent;
  if (text === null || text === "") return;
  const marks = nodeStream(line);
  // Safe as HTML: highlight.js escapes its input, and the marks come from the
  // line already on the page.
  line.innerHTML =
    marks.length > 0 ? mergeStreams(marks, nodeStream(asFragment(html)), text) : html;
  line.classList.add("hljs");
}

function asFragment(html: string): Element {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return holder;
}
