import { updateMemory, type ReviewMemoryStorage } from "../review-memory.ts";
import { generalCommentBox } from "./panel-wire.ts";
import { saveLater } from "./save-later.ts";

/**
 * The general comment box's half-typed words survive a reload: written back
 * into the box once at mount, and stored again whenever typing pauses or the
 * page goes away. Clearing it after a send or a queue is the panel's, which
 * writes the empty draft at once rather than waiting on the delay here.
 */
export function keepDraft(
  root: HTMLElement,
  storage: ReviewMemoryStorage,
  key: string,
  draft: string,
): void {
  // Draft stored on a delay: typing is a burst, and every keystroke would
  // restringify every queued pill.
  const rememberDraft = saveLater(() =>
    updateMemory(storage, key, { draft: generalCommentBox(root)?.value ?? "" }),
  );
  // Pagehide mid-sentence is exactly what the delay would lose; cut it short.
  window.addEventListener("pagehide", () => rememberDraft.now());
  // Written back, not rendered into markup: a draft ending in whitespace or
  // looking like a tag would not survive textarea markup.
  const composeBox = generalCommentBox(root);
  if (composeBox) composeBox.value = draft;
  root.addEventListener("input", (event) => {
    if (event.target === generalCommentBox(root)) rememberDraft.soon();
  });
}
