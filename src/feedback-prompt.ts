import type { AnnotationPrompt, FeedbackPrompt, LineAnchor } from "./session-store.ts";

/**
 * One prompt shape, shared by both sides: the server checks the browser's
 * payload, the browser checks what it restores from `localStorage` — a restored
 * prompt the server rejects would loop forever with nothing saying why.
 * Imported into the browser bundle, so no filesystem or session store here.
 */
export function parsePrompt(value: unknown): FeedbackPrompt | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const prompt = value as Record<string, unknown>;
  const comment = prompt.comment;
  if (typeof comment !== "string") return undefined;
  if (prompt.type === "message") return { type: "message", comment };
  if (prompt.type !== "annotation") return undefined;
  return parseAnnotation(prompt, comment);
}

/** An annotation without a file, a group and the text it was taken from anchors nothing. */
function parseAnnotation(
  prompt: Record<string, unknown>,
  comment: string,
): AnnotationPrompt | undefined {
  const { file, group, selected_text } = prompt;
  if (typeof file !== "string" || typeof group !== "string" || typeof selected_text !== "string") {
    return undefined;
  }
  const anchor = parseAnchor(prompt);
  if (anchor === "invalid") return undefined;
  const parsed = { type: "annotation", file, group, selected_text, comment } as const;
  return anchor === undefined ? parsed : { ...parsed, ...anchor };
}

/**
 * All three fields or none: half an anchor locates nothing, and a client sending
 * one is broken in a way worth reporting. Numbers are checked for plausibility
 * only; existence in the file is decided where the file is read.
 */
function parseAnchor(prompt: Record<string, unknown>): LineAnchor | undefined | "invalid" {
  const { line_start, line_end, side } = prompt;
  if (!anchorAttempted(prompt)) return undefined;
  const range = lineRange(line_start, line_end);
  if (range === undefined) return "invalid";
  if (side !== "old" && side !== "new") return "invalid";
  const columns = parseColumns(prompt, range);
  if (columns === "invalid") return "invalid";
  return { side, ...range, ...columns };
}

/**
 * One list, two users: detects an attempted anchor here, and the browser strips
 * these off a broken record — half a list would leave half an anchor behind.
 */
export const ANCHOR_FIELDS = ["line_start", "line_end", "side", "col_start", "col_end"];

/** No anchor field at all means the reviewer selected without one, not badly. */
function anchorAttempted(prompt: Record<string, unknown>): boolean {
  return ANCHOR_FIELDS.some((field) => prompt[field] !== undefined);
}

/**
 * Partial-line selection range. Either end may be missing on its own (start
 * mid-line, run to end). Single-line ranges must run forwards; across lines the
 * columns sit on different lines, so their order says nothing.
 */
function parseColumns(
  prompt: Record<string, unknown>,
  range: { line_start: number; line_end: number },
): { col_start?: number; col_end?: number } | "invalid" {
  const { col_start, col_end } = prompt;
  if (!isColumn(col_start) || !isColumn(col_end)) return "invalid";
  if (backwards(range, col_start, col_end)) return "invalid";
  return {
    ...(col_start === undefined ? {} : { col_start }),
    ...(col_end === undefined ? {} : { col_end }),
  };
}

function backwards(
  range: { line_start: number; line_end: number },
  start: number | undefined,
  end: number | undefined,
): boolean {
  if (range.line_start !== range.line_end) return false;
  return start !== undefined && end !== undefined && start > end;
}

function lineRange(
  start: unknown,
  end: unknown,
): { line_start: number; line_end: number } | undefined {
  if (!isPosition(start) || !isPosition(end) || start > end) return undefined;
  return { line_start: start, line_end: end };
}

/** An absent column is not a broken one: that end of the selection is unclipped. */
function isColumn(value: unknown): value is number | undefined {
  return value === undefined || isPosition(value);
}

/** A 1-based line or column number, which is the only numbering the wire format has. */
function isPosition(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
