import { renderOpening } from "../opening-view.ts";

export interface OpeningHost {
  root: HTMLElement;
  intents: readonly string[];
  /**
   * Recorded on open, not close: a reload halfway through must land on the
   * review, not restart the ceremony.
   */
  onOpen(): void;
  onClose(): void;
}

const FLARE_MS = 160;
const FLOOD_MS = 260;

function flare(field: HTMLElement | null): void {
  if (field === null) return;
  field.dataset.flare = "true";
  setTimeout(() => {
    field.dataset.flare = "false";
  }, FLARE_MS);
}

/**
 * Floods first so the review is under the light when it fades — an arrival,
 * not a screen taken away.
 */
function flood(field: HTMLElement | null, done: () => void): void {
  if (field !== null) field.dataset.bloom = "true";
  setTimeout(done, FLOOD_MS);
}

/**
 * All sheets pre-rendered: a press is one attribute write per sheet, nothing
 * redrawn — which lets the leaving sheet animate against the arriving one.
 * Both exits share one `close`, so the last sheet and Esc land in the same
 * place. Dialog focus: top sheet's button takes the caret on open and every
 * peel; close restores the previous holder.
 */
export function mountOpening(host: OpeningHost): void {
  const stack = renderOpening(host.intents);
  // Nothing to open, nothing shown: the gate already refuses reasonless
  // rounds, and an empty dialog holding focus would be the worse failure.
  if (stack === "") return;

  const before = document.activeElement;
  host.root.innerHTML = stack;
  const field = host.root.querySelector<HTMLElement>(".lsr-opening-overlay");
  const sheets = [...host.root.querySelectorAll<HTMLElement>(".lsr-opening-sheet")];
  const dots = [...host.root.querySelectorAll<HTMLElement>(".lsr-opening-dot")];
  let step = 0;
  let open = true;
  let leaving = false;

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    host.root.innerHTML = "";
    document.removeEventListener("keydown", onKey);
    if (before instanceof HTMLElement) before.focus();
    host.onClose();
  };

  const paint = (): void => {
    for (const [index, sheet] of sheets.entries()) {
      sheet.dataset.at = index < step ? "gone" : index === step ? "top" : "under";
    }
    for (const [index, dot] of dots.entries()) dot.dataset.on = String(index <= step);
    sheets[step]?.querySelector<HTMLElement>(".lsr-opening-press")?.focus();
  };

  const peel = (): void => {
    // On the way out, answers nothing: a second press must not light the room again.
    if (leaving || !open) return;
    flare(field);
    step += 1;
    if (step >= sheets.length) {
      leaving = true;
      flood(field, close);
    } else paint();
  };

  document.addEventListener("keydown", onKey);
  for (const button of host.root.querySelectorAll<HTMLElement>(".lsr-opening-press")) {
    button.addEventListener("click", peel);
  }
  paint();
  host.onOpen();
}
