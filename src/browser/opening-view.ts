import { escapeHtml } from "../escape-html.ts";
import { filesLabel } from "./group-index.ts";
import type { SkyChapter, SkyLabel } from "./starfield.ts";

export interface OpeningReview {
  /** Zero-based. */
  round: number;
  intents: readonly string[];
  ended: boolean;
  unwrapped: boolean;
}

/**
 * The ceremony costs presses, so: first round only, once. Later rounds have
 * the replay, and the two overlays must never stack. An ended review is a
 * record, not a handover; a reasonless round has nothing to say one sheet at a time.
 */
export function opensFor(review: OpeningReview): boolean {
  return review.round === 0 && review.intents.length > 0 && !review.ended && !review.unwrapped;
}

interface Sheet {
  lead?: string;
  headline?: string;
  label?: string;
  body?: string;
  act: string;
  /** The constellation sheet: no words on it, and its button held back until the names are up. */
  sky?: boolean;
}

/**
 * Complete from the start because peeling is an attribute write, not a redraw
 * — the stylesheet animates the leaving sheet against the arriving one.
 * `data-flare`/`data-bloom`/`data-jump` start off for the same reason. No
 * intents renders "": the mount reads that as nothing to open. With chapters,
 * the last sheet is the sky: the files gathered into one constellation each.
 */
export function renderOpening(
  intents: readonly string[],
  chapters: readonly SkyChapter[] = [],
): string {
  if (intents.length === 0) return "";
  const sky = chapters.length > 0;
  const sheets: Sheet[] = [
    cover(),
    ...intents.map(reasonSheet(intents.length, sky)),
    ...(sky ? [skySheet(chapters)] : []),
  ];
  return `<div class="lsr-opening-overlay" role="dialog" aria-modal="true" aria-label="What this round is for" data-flare="false" data-bloom="false" data-sky="false" data-jump="false">
<canvas class="lsr-sky-canvas" aria-hidden="true"></canvas>
<span class="lsr-sky-tunnel" aria-hidden="true"></span>
<div class="lsr-sky-names" aria-hidden="true" data-on="false"></div>
<div class="lsr-opening-stack">
${sheets.map((sheet, index) => laid(sheet, index, sheets.length)).join("\n")}
</div>
${dots(sheets.length)}
<span class="lsr-opening-bloom" aria-hidden="true"></span>
</div>`;
}

/**
 * Does not count the reasons: "Four reasons, one at a time." was a line to
 * read before the reasons could be, and the dots already say how many.
 */
function cover(): Sheet {
  return {
    lead: "from your agent",
    headline: "Something was built for you",
    act: "Unwrap",
  };
}

/** "Reason n of m" is the section's aria-label, not a visible line: the dots say it to the eye. */
function reasonSheet(total: number, sky: boolean): (intent: string, index: number) => Sheet {
  const last = sky ? "Show the chapters" : "Open the review";
  return (intent, index) => ({
    label: `reason ${index + 1} of ${total}`,
    body: escapeHtml(intent),
    act: index === total - 1 ? last : "Next reason",
  });
}

/**
 * No text on the sheet: the sky is the message. The eye reads the names off
 * the stars (`renderSkyNames`); a screen reader hears them in the sheet's label.
 */
function skySheet(chapters: readonly SkyChapter[]): Sheet {
  const count = chapters.length;
  const names = chapters.map((chapter) => chapter.name).join(", ");
  return {
    label: escapeHtml(`${count} chapter${count === 1 ? "" : "s"}: ${names}`),
    act: "Open the review",
    sky: true,
  };
}

/**
 * The names under their constellations, placed by `layoutSky`. Eye-only: the
 * sky sheet's label already says every one of them.
 */
export function renderSkyNames(labels: readonly SkyLabel[]): string {
  return labels
    .map(
      (label) =>
        `<span class="lsr-sky-name" style="left:${label.x.toFixed(1)}px;top:${label.y.toFixed(1)}px;max-width:${label.width.toFixed(0)}px">${escapeHtml(label.name)}<small class="lsr-sky-count">${filesLabel(label.files)}</small></span>`,
    )
    .join("");
}

/**
 * Every sheet names its z-layer (cover must paint on top); `data-at` is what
 * the peel moves and the stylesheet animates. The sky sheet takes the caret
 * itself (`tabindex="-1"`) while its button is held back.
 */
function laid(sheet: Sheet, index: number, total: number): string {
  const label = sheet.label === undefined ? "" : ` aria-label="${sheet.label}"`;
  const sky = sheet.sky === true ? ' data-sky="true" tabindex="-1"' : "";
  return `<section class="lsr-opening-sheet" data-index="${index}" data-at="${index === 0 ? "top" : "under"}"${sky}${label} style="z-index:${total - index}">
${sheetParts(sheet).join("\n")}
</section>`;
}

function sheetParts(sheet: Sheet): string[] {
  const held = sheet.sky === true ? ' data-held="true"' : "";
  return [
    sheet.lead === undefined ? "" : `<p class="lsr-opening-lead">${sheet.lead}</p>`,
    sheet.headline === undefined ? "" : `<p class="lsr-opening-headline">${sheet.headline}</p>`,
    sheet.body === undefined ? "" : `<p class="lsr-opening-body">${sheet.body}</p>`,
    `<button type="button" class="lsr-opening-press"${held}>${sheet.act}</button>`,
  ].filter((part) => part !== "");
}

/** Eye-only decoration: each section already carries the same fact as an aria-label. */
function dots(total: number): string {
  const row = Array.from(
    { length: total },
    (_unused, index) => `<i class="lsr-opening-dot" data-on="${index === 0}"></i>`,
  ).join("");
  return `<span class="lsr-opening-dots" aria-hidden="true">${row}</span>`;
}
