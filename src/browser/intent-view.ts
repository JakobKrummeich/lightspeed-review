import { escapeHtml } from "../escape-html.ts";

export interface IntentView {
  intents: string[];
  /** Not rendered: the chapter index says what the branch did in the reviewer's terms. */
  commits: string[];
}

/**
 * Pure; rendered by both server (no flash) and browser (a new round may state
 * a new reason). Several intents stay several lines: they are separate reasons.
 *
 * Drawn shut, every time: the reasons are read once, at the top of the review,
 * and after that they are a band above the chapter list that every return to
 * the survey scrolls past. A heading holding a button rather than a bare
 * button, because the document outline is where a screen reader finds the top
 * of this block.
 */
export function renderIntent(view: IntentView): string {
  if (view.intents.length === 0 && view.commits.length === 0) return "";
  return [
    `<h2 class="lsr-intent-title"><button type="button" class="lsr-intent-press" aria-expanded="false" aria-controls="lsr-intent-body">What this change is for<span class="lsr-intent-hint">press to expand</span></button></h2>`,
    `<div class="lsr-intent-body" id="lsr-intent-body" hidden>${renderIntents(view.intents)}</div>`,
  ].join("\n");
}

/**
 * The block stands with the overview and goes away with the chapter: beside a
 * survey it is the point, beside one diff it is dead space. Takes anything
 * with an element's `hidden` flag so the rule tests without a page; the
 * attribute is enough — `.lsr-intent` sets no `display` for it to lose to.
 */
export function showIntentFor(block: Pick<HTMLElement, "hidden">, focus: number | undefined): void {
  block.hidden = focus !== undefined;
}

/** `open` and `publish` require `--intent`, so this is a round from before it did — silence is not the same as no reason. */
function renderIntents(intents: string[]): string {
  if (intents.length === 0) {
    return `<p class="lsr-intent-none">This round was opened without a stated intent.</p>`;
  }
  const items = intents
    .map((intent) => `<li class="lsr-intent-item">${escapeHtml(intent)}</li>`)
    .join("\n      ");
  return `<ul class="lsr-intent-list">\n      ${items}\n    </ul>`;
}
