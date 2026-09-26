/**
 * A round does not swap the diff instantly — that threw the reviewer to the
 * top of a re-cut review — but waits behind a header offer until taken. The
 * deciding lives here, pure: answerable without a browser.
 */
import { NOTHING_QUEUED, queuedTotal, type QueueTally } from "./queued-pill.ts";

export interface ReviewerPlace {
  /** Pixels. */
  scrolled: number;
  queued: QueueTally;
  focus: number | undefined;
}

/** Showing none of the three signs, the reviewer has nothing to lose and the offer is not worth the press. */
export function holdsRound(place: ReviewerPlace): boolean {
  return place.scrolled > 0 || queuedTotal(place.queued) > 0 || place.focus !== undefined;
}

/**
 * Named (not just "a new round") and sized, since size decides take-now vs
 * finish-the-group. `round` is zero-based; reviewers count from one. A queue
 * is named too — the reviewer's own words are the thing they would most expect
 * a new round to cost them.
 */
export function roundOfferLabel(
  round: number,
  files: number,
  queued: QueueTally = NOTHING_QUEUED,
): string {
  const kept = queuedTotal(queued) === 0 ? "" : ` · ${queuedCount(queued)} kept`;
  return `Round ${round + 1} is ready · ${fileCount(files)}${kept}`;
}

function fileCount(files: number): string {
  return files === 1 ? "1 file" : `${files} files`;
}

/** Kinds with none left out: "0 replies" is noise in a reassurance. */
function queuedCount(queued: QueueTally): string {
  const parts = [
    counted(queued.comments, "comment", "comments"),
    counted(queued.replies, "reply", "replies"),
    counted(queued.resolves, "resolve", "resolves"),
  ].filter((part) => part !== "");
  const last = parts.pop() ?? "";
  return parts.length === 0 ? last : `${parts.join(", ")} and ${last}`;
}

function counted(count: number, one: string, many: string): string {
  if (count === 0) return "";
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Nothing in the page has ever dropped a pill, but a reviewer holding six
 * unsent comments cannot know that, and the cost of guessing wrong is pressing
 * "keep reading" on a round they wanted.
 */
function queueLine(queued: QueueTally): string {
  const total = queuedTotal(queued);
  if (total === 0) return "";
  const rest = total === 1 ? "stays queued — it goes" : "stay queued — they go";
  return `\n    <p class="lsr-round-queue">Your ${queuedCount(queued)} ${rest} out on your next Send.</p>`;
}

/** Dismissing is not declining — the round waits in the header. Numbers only, so nothing needs escaping. */
export function renderRoundPopup(
  round: number,
  files: number,
  queued: QueueTally = NOTHING_QUEUED,
): string {
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
