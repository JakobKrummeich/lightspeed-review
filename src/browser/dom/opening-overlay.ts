import { renderOpening } from "../opening-view.ts";
import type { SkyChapter } from "../starfield.ts";
import { mountOpeningSky, type OpeningSky } from "./opening-sky.ts";
import { holdPageBehind } from "./page-hold.ts";
import { claimRoom, evictRoom, leaveRoom } from "./room-claim.ts";
import type { paintSky } from "./starfield-canvas.ts";
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
  /** The sky's canvas painter; a test hands in its own. */
  paint?: typeof paintSky;
}

const FLARE_MS = 160;

/** Returns the strike's timer, so a room that closes mid-strike takes it along. */
function flare(field: HTMLElement | null): ReturnType<typeof setTimeout> | undefined {
  if (field === null) return undefined;
  field.dataset.flare = "true";
  return setTimeout(() => {
    field.dataset.flare = "false";
  }, FLARE_MS);
}

/**
 * All sheets pre-rendered: a press is one attribute write per sheet, nothing
 * redrawn — which lets the leaving sheet animate against the arriving one.
 * Both exits share one `close`, so the jump's landing and Esc land in the same
 * place. Dialog focus: top sheet's button takes the caret on open and every
 * peel (the sky sheet itself while its button is held back); close restores
 * the previous holder. The page behind is inert until then, so Tab stays in
 * the room.
 */
export function mountOpening(host: OpeningHost): void {
  const stack = renderOpening(host.intents, host.chapters);
  // Nothing to open, nothing shown: the gate already refuses reasonless
  // rounds, and an empty dialog holding focus would be the worse failure.
  if (stack === "") return;

  // The root is shared with the round jump: whichever room comes second
  // closes the first by its own way out (`room-claim.ts`), which hands the
  // page and the caret back before this room takes them.
  evictRoom(host.root);
  const before = document.activeElement;
  host.root.innerHTML = stack;
  const release = holdPageBehind(host.root);
  let sky: OpeningSky | undefined = undefined;
  let step = 0;
  let open = true;
  let leaving = false;
  let strike: ReturnType<typeof setTimeout> | undefined;

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };

  // Declared before anything that can throw: the next room's claim, Esc and
  // a sky that failed to mount all leave by it.
  const close = (): void => {
    if (!open) return;
    open = false;
    sky?.stop();
    clearTimeout(strike);
    leaveRoom(host.root, close);
    host.root.innerHTML = "";
    document.removeEventListener("keydown", onKey);
    release();
    if (before instanceof HTMLElement) before.focus();
    host.onClose();
  };

  claimRoom(host.root, close);
  document.addEventListener("keydown", onKey);
  const field = host.root.querySelector<HTMLElement>(".lsr-opening-overlay");
  const mountedSky = skyOf(field, host);
  // The ceremony is decoration over the review: without its sky, no ceremony.
  if (mountedSky === null) return close();
  sky = mountedSky;
  const sheets = [...host.root.querySelectorAll<HTMLElement>(".lsr-opening-sheet")];
  const dots = [...host.root.querySelectorAll<HTMLElement>(".lsr-opening-dot")];

  const paint = (): void => {
    lay(sheets, dots, step);
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
    clearTimeout(strike);
    strike = flare(field);
    step += 1;
    const next = sheets[step];
    if (next === undefined) return leave();
    paint();
    if (next.dataset.sky === "true") sky?.arrive(() => reveal(next));
  };

  onPress(sheets, peel);
  paint();
  host.onOpen();
}

/** The room's sky; `null` when mounting it threw (said here), `undefined` with no field. */
function skyOf(field: HTMLElement | null, host: OpeningHost): OpeningSky | null | undefined {
  if (!field) return undefined;
  try {
    return mountOpeningSky(field, host.chapters, host.stillness(), host.paint);
  } catch (error) {
    console.error("lightspeed: the opening could not start", error);
    return null;
  }
}

/** Each sheet's button answers for its own sheet. */
function onPress(sheets: HTMLElement[], peel: (index: number) => void): void {
  for (const [index, sheet] of sheets.entries()) {
    sheet
      .querySelector<HTMLElement>(".lsr-opening-press")
      ?.addEventListener("click", () => peel(index));
  }
}

/** Moves every sheet and dot to `step`: one attribute write each, the stylesheet animates. */
function lay(sheets: HTMLElement[], dots: HTMLElement[], step: number): void {
  for (const [index, sheet] of sheets.entries()) {
    sheet.dataset.at = index < step ? "gone" : index === step ? "top" : "under";
    // Faded is not gone: Tab still finds an invisible button.
    sheet.inert = index !== step;
  }
  for (const [index, dot] of dots.entries()) dot.dataset.on = String(index <= step);
}

/**
 * A held button cannot take the caret, so the sheet holds it until the button
 * is shown. Plain `focus()`: the room clips and cannot scroll, but the sheet
 * scrolls, and must, to bring its button into view under a tall reason.
 */
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
