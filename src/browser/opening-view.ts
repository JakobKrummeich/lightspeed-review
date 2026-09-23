import { escapeHtml } from "../escape-html.ts";

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
}

/**
 * Complete from the start because peeling is an attribute write, not a redraw
 * — the stylesheet animates the leaving sheet against the arriving one.
 * `data-flare`/`data-bloom` start off for the same reason. No intents renders
 * "": the mount reads that as nothing to open.
 */
export function renderOpening(intents: readonly string[]): string {
  if (intents.length === 0) return "";
  const sheets: Sheet[] = [cover(), ...intents.map(reasonSheet(intents.length))];
  return `<div class="lsr-opening-overlay" role="dialog" aria-modal="true" aria-label="What this round is for" data-flare="false" data-bloom="false">
${motes()}
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
function reasonSheet(total: number): (intent: string, index: number) => Sheet {
  return (intent, index) => ({
    label: `reason ${index + 1} of ${total}`,
    body: escapeHtml(intent),
    act: index === total - 1 ? "Open the review" : "Next reason",
  });
}

/** Every sheet names its z-layer (cover must paint on top); `data-at` is what the peel moves and the stylesheet animates. */
function laid(sheet: Sheet, index: number, total: number): string {
  const parts = [
    sheet.lead === undefined ? "" : `<p class="lsr-opening-lead">${sheet.lead}</p>`,
    sheet.headline === undefined ? "" : `<p class="lsr-opening-headline">${sheet.headline}</p>`,
    sheet.body === undefined ? "" : `<p class="lsr-opening-body">${sheet.body}</p>`,
    `<button type="button" class="lsr-opening-press">${sheet.act}</button>`,
  ].filter((part) => part !== "");
  const label = sheet.label === undefined ? "" : ` aria-label="${sheet.label}"`;
  return `<section class="lsr-opening-sheet" data-index="${index}" data-at="${index === 0 ? "top" : "under"}"${label} style="z-index:${total - index}">
${parts.join("\n")}
</section>`;
}

/**
 * No `Math.random` in a pure render — two calls must agree or no test can
 * assert either. Irrational-fraction stepping scatters indexes evenly without
 * repeats; four steps give four non-aligned spreads. Negative delays: the
 * field is already drifting on the first frame.
 */
function motes(): string {
  const dust = Array.from({ length: 14 }, (_unused, index) => {
    const walk = (step: number): number => ((index + 1) * step) % 1;
    const left = 8 + walk(0.618034) * 84;
    const life = 7 + walk(0.754878) * 7;
    const delay = -walk(0.414214) * life;
    const drift = Math.round(walk(0.302776) * 60 - 30);
    const style = `left:${left.toFixed(1)}%;--life:${life.toFixed(1)}s;--delay:${delay.toFixed(1)}s;--drift:${drift}px`;
    return `<i class="lsr-opening-mote" style="${style}"></i>`;
  }).join("");
  return `<span class="lsr-opening-motes" aria-hidden="true">${dust}</span>`;
}

/** Eye-only decoration: each section already carries the same fact as an aria-label. */
function dots(total: number): string {
  const row = Array.from(
    { length: total },
    (_unused, index) => `<i class="lsr-opening-dot" data-on="${index === 0}"></i>`,
  ).join("");
  return `<span class="lsr-opening-dots" aria-hidden="true">${row}</span>`;
}
