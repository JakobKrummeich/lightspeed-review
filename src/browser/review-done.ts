/**
 * The sidebar's note ("Every file is approved — Send & End when you are
 * ready") proved too quiet for the moment — it sits in a column the eye left
 * an hour ago — so the news is said once, over the review, with the press it
 * calls for on it. Two ways out and nothing else: approved is not the same as
 * done and the reviewer decides which this is. Numbers only in the queued
 * line, so nothing needs escaping.
 */
export function renderReviewDone(queued: number): string {
  return `<div class="lsr-done-overlay">
  <div class="lsr-done-card" role="dialog" aria-modal="true" aria-label="Every file is approved">
    <div class="lsr-done-head">
      <h2 class="lsr-done-title">Every file is approved</h2>
      <span class="lsr-done-badge">
        <span class="lsr-done-nova" aria-hidden="true"><i class="lsr-done-point"></i><i class="lsr-done-ring"></i><i class="lsr-done-ring"></i><i class="lsr-done-flare"></i></span>
        <span class="lsr-done-mark" aria-hidden="true">✓</span>
      </span>
    </div>
    <p class="lsr-done-note">End the review to hand it back to the agent, or keep looking.${queuedLine(queued)}</p>
    <div class="lsr-done-actions">
      <button type="button" class="lsr-primary lsr-done-end">End review</button>
      <button type="button" class="lsr-secondary lsr-done-stay">Keep looking</button>
    </div>
  </div>
</div>`;
}

/**
 * "End review" is the sidebar's Send & End, and the reviewer should not learn
 * that from the conversation afterwards. The card only opens on the
 * reviewer's turn (`dom/finish.ts`), so the queue always goes with it.
 */
function queuedLine(queued: number): string {
  if (queued <= 0) return "";
  return ` ${queued === 1 ? "Your one queued note goes" : `Your ${queued} queued notes go`} with it.`;
}
