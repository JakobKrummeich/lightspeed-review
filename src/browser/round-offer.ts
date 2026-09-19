/**
 * A round arriving mid-read. The page used to swap the diff instantly,
 * throwing the reviewer to the top of a re-cut review; now a round waits
 * behind a header offer until taken. The deciding lives here, pure: "is the
 * reviewer mid-something?" should be answerable without a browser.
 */

/** Where the reviewer stands in the round on screen. */
export interface ReviewerPlace {
  /** How far down the review they have scrolled, in pixels. */
  scrolled: number;
  /** Comments queued in this browser and not sent yet. */
  queued: number;
  /** The chapter they are reading, or nothing when they are on the survey. */
  focus: number | undefined;
}

/**
 * Must the round wait? Any of three signs suffices: scrolled off the top,
 * inside a chapter, words queued. Showing none, the reviewer has nothing to
 * lose and the offer is not worth the press.
 */
export function holdsRound(place: ReviewerPlace): boolean {
  return place.scrolled > 0 || place.queued > 0 || place.focus !== undefined;
}

/**
 * The offer's words: round named (not just "a new round") and sized, since
 * size decides take-now vs finish-the-group. `round` is zero-based; reviewers
 * count from one. A queue is named too — the reviewer's own words are the thing
 * they would most expect a new round to cost them.
 */
export function roundOfferLabel(round: number, files: number, queued = 0): string {
  const kept = queued === 0 ? "" : ` · ${queuedCount(queued)} kept`;
  return `Round ${round + 1} is ready · ${fileCount(files)}${kept}`;
}

/** The size the way the reviewer weighs it, singular spelled out. */
function fileCount(files: number): string {
  return files === 1 ? "1 file" : `${files} files`;
}

function queuedCount(queued: number): string {
  return queued === 1 ? "1 comment" : `${queued} comments`;
}

/**
 * Queue always: a round arriving does not touch what the reviewer has queued,
 * and the card says so where the doubt is. Nothing in the page has ever dropped
 * a pill, but a reviewer holding six unsent comments cannot know that, and the
 * cost of guessing wrong is pressing "keep reading" on a round they wanted.
 */
function queueLine(queued: number): string {
  if (queued === 0) return "";
  return `\n    <p class="lsr-round-queue">Your ${queuedCount(queued)} stay queued — they go out on your next send.</p>`;
}

/**
 * The card announcing a waiting round: same facts as the header offer, two
 * ways out (take, or keep reading — dismissing is not declining). Numbers
 * only, so nothing needs escaping.
 */
export function renderRoundPopup(round: number, files: number, queued = 0): string {
  const name = `Round ${round + 1}`;
  return `<div class="lsr-round-overlay">
  <div class="lsr-round-card" role="dialog" aria-modal="true" aria-label="${roundOfferLabel(round, files, queued)}">
    <h2 class="lsr-round-title">${name} is ready</h2>
    <p class="lsr-round-size">${fileCount(files)}</p>
    <p class="lsr-round-note">Take it now, or keep reading — it will wait in the header.</p>${queueLine(queued)}
    <div class="lsr-round-actions">
      <button type="button" class="lsr-primary lsr-round-take">Open round ${round + 1}</button>
      <button type="button" class="lsr-secondary lsr-round-stay">Keep reading</button>
    </div>
  </div>
</div>`;
}
