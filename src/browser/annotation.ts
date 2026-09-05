import { escapeHtml } from "../escape-html.ts";
import type { AnnotationPrompt, AnnotationSide, LineAnchor } from "../session-store.ts";

export type { LineAnchor };

/**
 * 1-based inclusive column range inside one line, in UTF-16 code units of the
 * line's own code: the diff's `+`/`-` marker is not a column, an astral char is two.
 */
export interface SelectedColumns {
  start: number;
  end: number;
}

/** The numbers the diff printed for one selected line, either side missing. */
export interface SelectedLine {
  old?: number;
  new?: number;
  /** Where the selection clipped this line; absent when it took the whole line. */
  columns?: SelectedColumns;
}

/** One contiguous piece of a text selection, already attributed to a file block. */
export interface SelectionFragment {
  file: string;
  group: string;
  text: string;
  anchor?: LineAnchor;
}

/**
 * The range selected lines span. New side preferred (the code under review);
 * removed-only selections anchor on the old side. Unnumbered lines skipped; no
 * numbers at all means no anchor — a guessed line would misdirect the agent.
 * Only the first and last line can be clipped, so columns come from those two.
 */
export function anchorFor(lines: SelectedLine[]): LineAnchor | undefined {
  const side: AnnotationSide = lines.some((line) => line.new !== undefined) ? "new" : "old";
  const numbered = lines.filter((line) => line[side] !== undefined);
  const first = numbered[0];
  const last = numbered.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const numbers = numbered.map((line) => line[side]).filter((number) => number !== undefined);
  return {
    side,
    line_start: Math.min(...numbers),
    line_end: Math.max(...numbers),
    ...columnFields(first.columns?.start, last.columns?.end),
  };
}

/**
 * Unclipped boundaries are omitted, not spelled as "column 1": absent means
 * the line was taken whole, which the agent needs to tell the cases apart.
 */
function columnFields(
  start: number | undefined,
  end: number | undefined,
): { col_start?: number; col_end?: number } {
  return {
    ...(start === undefined ? {} : { col_start: start }),
    ...(end === undefined ? {} : { col_end: end }),
  };
}

/**
 * Builds annotations from a queued selection: one per file block (agent needs
 * an unambiguous `file`), `+`/`-` prefixes kept so old/new stay distinguishable.
 * Only empty fragments drop; whitespace-only is a real selection (trailing
 * spaces, indentation) and must not queue as nothing.
 */
export function annotationsFrom(
  fragments: SelectionFragment[],
  comment: string,
): AnnotationPrompt[] {
  const trimmed = comment.trim();
  if (trimmed === "") return [];
  const byFile = new Map<string, SelectionFragment[]>();
  for (const fragment of fragments) {
    if (fragment.text === "") continue;
    const ofFile = byFile.get(fragment.file);
    if (ofFile) ofFile.push(fragment);
    else byFile.set(fragment.file, [fragment]);
  }
  return [...byFile.values()].map((ofFile) => promptFor(ofFile, trimmed));
}

function promptFor(fragments: SelectionFragment[], comment: string): AnnotationPrompt {
  const first = fragments[0]!;
  const prompt = {
    type: "annotation",
    file: first.file,
    group: first.group,
    selected_text: fragments.map((fragment) => fragment.text).join("\n"),
    comment,
  } as const;
  const anchor = mergedAnchor(fragments);
  // Spread, not assigned: serialised straight to JSON, where an anchorless
  // annotation must carry no anchor fields at all.
  return anchor === undefined ? prompt : { ...prompt, ...anchor };
}

/**
 * Anchor of a whole file's fragments. Same-side ranges widen to their span;
 * opposite sides cannot be one anchor, so the annotation goes out unanchored
 * rather than pointing at code the reviewer never selected.
 */
function mergedAnchor(fragments: SelectionFragment[]): LineAnchor | undefined {
  const anchors = fragments
    .map((fragment) => fragment.anchor)
    .filter((anchor): anchor is LineAnchor => anchor !== undefined);
  const side = anchors[0]?.side;
  if (side === undefined) return undefined;
  if (anchors.some((anchor) => anchor.side !== side)) return undefined;
  const line_start = Math.min(...anchors.map((anchor) => anchor.line_start));
  const line_end = Math.max(...anchors.map((anchor) => anchor.line_end));
  return {
    side,
    line_start,
    line_end,
    ...columnFields(startColumn(anchors, line_start), endColumn(anchors, line_end)),
  };
}

/**
 * Leftmost column any fragment marked on the first line; one fragment taking
 * the line whole drops the column altogether.
 */
function startColumn(anchors: LineAnchor[], line: number): number | undefined {
  const columns = anchors
    .filter((anchor) => anchor.line_start === line)
    .map((anchor) => anchor.col_start);
  if (columns.some((column) => column === undefined)) return undefined;
  return Math.min(...columns.filter((column) => column !== undefined));
}

/** Where it ends, by the same rule read from the other end. */
function endColumn(anchors: LineAnchor[], line: number): number | undefined {
  const columns = anchors
    .filter((anchor) => anchor.line_end === line)
    .map((anchor) => anchor.col_end);
  if (columns.some((column) => column === undefined)) return undefined;
  return Math.max(...columns.filter((column) => column !== undefined));
}

/** Shortens selected text for the popup preview. */
export function selectionPreview(text: string, maxChars = 200): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/** The selection popup: what was selected, where from, and the comment box. */
export function renderAnnotationPopup(fragments: SelectionFragment[]): string {
  const files = [...new Set(fragments.map((fragment) => fragment.file))];
  const preview = selectionPreview(fragments.map((fragment) => fragment.text).join("\n"));
  return `<p class="lsr-popup-files">${files.map((file) => escapeHtml(file)).join("<br />")}</p>
<pre class="lsr-popup-preview">${escapeHtml(preview)}</pre>
<textarea id="lsr-annotation-comment" placeholder="Type feedback, then press Enter"></textarea>
<button type="button" id="lsr-queue-feedback">Queue Feedback</button>`;
}
