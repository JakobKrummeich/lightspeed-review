import { renderOpening } from "../opening-view.ts";
import type { SkyChapter } from "../starfield.ts";
import { mountOpeningSky } from "./opening-sky.ts";
import type { Stillness } from "./stillness.ts";

export interface OpeningHost {
  root: HTMLElement;
  intents: readonly string[];
  /** One star per file; empty leaves the sky sheet out. */
  chapters: readonly SkyChapter[];
  /** Asked once, when the room goes up. */
  stillness(): Stillness;
  /**
   * Recorded on open, not close: a reload halfway through must land on the
   * review, not restart the ceremony.
   */
  onOpen(): void;
  onClose(): void;
}

const FLARE_MS = 160;

function flare(field: HTMLElement | null): void {
  if (field === null) return;
  field.dataset.flare = "true";
  setTimeout(() => {
    field.dataset.flare = "false";
  }, FLARE_MS);
}

/**
 * All sheets pre-rendered: a press is one attribute write per sheet, nothing
 * redrawn — which lets the leaving sheet animate against the arriving one.
 * Both exits share one `close`, so the jump's landing and Esc land in the same
 * place. Dialog focus: top sheet's button takes the caret on open and every
 * peel (the sky sheet itself while its button is held back); close restores
 * the previous holder.
 */
export function mountOpening(host: OpeningHost): void {
  const stack = renderOpening(host.intents, host.chapters);
  // Nothing to open, nothing shown: the gate already refuses reasonless
  // rounds, and an empty dialog holding focus would be the worse failure.
  if (stack === "") return;

  const before = document.activeElement;
  host.root.innerHTML = stack;
  const field = host.root.querySelector<HTMLElement>(".lsr-opening-overlay");
  const sheets = [...host.root.querySelectorAll<HTMLElement>(".lsr-opening-sheet")];
  const dots = [...host.root.querySelectorAll<HTMLElement>(".lsr-opening-dot")];
  const sky = field && mountOpeningSky(field, host.chapters, host.stillness());
  let step = 0;
  let open = true;
  let leaving = false;

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    sky?.stop();
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
    caretTo(sheets[step]);
  };

  const leave = (): void => {
    leaving = true;
    if (sky) sky.leave(close);
    else close();
  };

  const peel = (from: number): void => {
    // Only the sheet on top answers: a gone sheet's button can still hold the
    // caret. On the way out nothing does — a second press must not light the
    // room again.
    if (leaving || !open || from !== step) return;
    flare(field);
    step += 1;
    const next = sheets[step];
    if (next === undefined) return leave();
    paint();
    if (next.dataset.sky === "true") sky?.arrive(() => reveal(next));
  };

  document.addEventListener("keydown", onKey);
  for (const [index, sheet] of sheets.entries()) {
    sheet
      .querySelector<HTMLElement>(".lsr-opening-press")
      ?.addEventListener("click", () => peel(index));
  }
  paint();
  host.onOpen();
}

/** A held button cannot take the caret, so the sheet holds it until the button is shown. */
function caretTo(sheet: HTMLElement | undefined): void {
  const button = sheet?.querySelector<HTMLElement>(".lsr-opening-press");
  if (button?.dataset.held === "true") sheet?.focus();
  else button?.focus();
}

function reveal(sheet: HTMLElement): void {
  const button = sheet.querySelector<HTMLElement>(".lsr-opening-press");
  if (!button) return;
  button.dataset.held = "false";
  button.focus();
}
