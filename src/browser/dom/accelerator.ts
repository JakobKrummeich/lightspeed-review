/**
 * 05 Accelerator: the light that answers a tick (`css/light-approval.css`). A
 * particle runs along the bar to the grown fill's new edge and a spark marks
 * where it stopped; a finished chapter flashes and a glint crosses it; the
 * last one sends a glint down every segment. The tick's own box glows.
 */
import type { DiffGroup } from "../../diff-extract.ts";
import { progressChange, progressSegments, type ProgressChange } from "../progress-bar.ts";
import { play, spark, stop } from "./light-play.ts";

/** Long enough for the slowest run, the last glint and its fade. */
const MOMENT_MS = 2400;
const TICK_MS = 600;
/** The whole bar is crossed in this, however many segments it has. */
const SWEEP_MS = 540;
/** Everything a run lays into a segment, taken out again by an untick. */
const RUN_LIGHTS = ["lsr-light-photon", "lsr-light-edge", "lsr-light-flash", "lsr-light-glint"];

interface Run {
  /** Where the particle sets off and lands, from the segment's own left edge. */
  from: number;
  to: number;
  ms: number;
}

/** Aimed once, then fired on whichever bar the tick left on the page. */
export interface Accelerator {
  /**
   * The bar is patched in place: `grow` writes its new widths, and is called
   * once the run is lit, so the fill grows behind the particle.
   */
  fire(tick: Element, grow: () => void): void;
  /**
   * The bar has been redrawn at its new widths (a tick that moved focus on, a
   * sweep), on elements that never showed the old ones: the grown fill is set
   * back to where the tick found it and grown from there. The tick's box glows
   * if the redraw drew it again.
   */
  redrawn(root: ParentNode, tick?: HTMLInputElement): void;
}

/** `before` and `after` are the approved lists either side of the tick. */
export function aimTick(
  progress: HTMLElement,
  groups: DiffGroup[],
  before: string[],
  after: string[],
): Accelerator {
  const was = progressSegments(groups, before);
  const now = progressSegments(groups, after);
  const shrunk = now.flatMap((segment, at) =>
    segment.approvedWeight < (was[at]?.approvedWeight ?? 0) ? [at] : [],
  );
  return aimAccelerator(progress, progressChange(was, now), shrunk);
}

/**
 * Measures the bar now, before the tick writes anything to the page: every
 * patch and redraw after it would make this read lay the page out again.
 * `shrunk` are the segments an untick narrowed.
 */
export function aimAccelerator(
  progress: HTMLElement,
  change: ProgressChange | undefined,
  shrunk: number[],
): Accelerator {
  const segment = change && segmentAt(progress, change.index);
  const run = segment && change && runTo(segment, change.share);
  const was = segment?.querySelector(".lsr-progress-fill")?.getAttribute("style") ?? "";
  const light = (grow: () => void): void => {
    if (change && run) launch(progress, change, run, grow);
    else settle(progress, shrunk, grow);
  };
  return {
    fire(tick, grow) {
      play(tick, "tick", TICK_MS);
      light(grow);
    },
    redrawn(root, tick) {
      const live = tick && liveTick(root, tick);
      if (live) play(live, "tick", TICK_MS);
      const fill = change && segmentAt(progress, change.index)?.querySelector(".lsr-progress-fill");
      if (!fill) return;
      const grown = fill.getAttribute("style") ?? "";
      // Back to the old width with nothing to animate the way back, read so
      // the browser holds it as where the growth starts.
      fill.setAttribute("style", `${was}; transition: none`);
      void (fill as HTMLElement).offsetWidth;
      light(() => fill.setAttribute("style", grown));
    },
  };
}

function segmentAt(progress: HTMLElement, index: number): HTMLElement | undefined {
  return segmentsOf(progress).find((one) => one.dataset.groupIndex === String(index));
}

function segmentsOf(progress: HTMLElement): HTMLElement[] {
  return [...progress.querySelectorAll<HTMLElement>(".lsr-progress-segment")];
}

/**
 * From the start of the bar, not of the segment: the light comes from where
 * the reviewer's progress began. A farther edge is a longer run, capped so a
 * wide bar does not keep the moment going. No box: the bar is not drawn at
 * this width, and there is nowhere to run.
 */
function runTo(segment: HTMLElement, share: number): Run | undefined {
  const box = segment.getBoundingClientRect();
  const bar = segment.parentElement?.getBoundingClientRect();
  if (!bar || box.width === 0) return undefined;
  const from = bar.left - box.left;
  const to = box.width * share;
  return { from, to, ms: Math.round(Math.min(600, 220 + (to - from) / 2)) };
}

/**
 * The segment holds the run only until the particle lands: its fill's growth
 * waits on the particle that long, and a width set after that — an untick —
 * applies at once. The sparks carry their own copy of the run's length, so
 * the segment's can go without cutting them short.
 */
function launch(progress: HTMLElement, change: ProgressChange, run: Run, grow: () => void): void {
  const segment = segmentAt(progress, change.index);
  if (!segment) {
    grow();
    return;
  }
  const length = { "--lsr-photon-ms": `${run.ms}ms` };
  play(segment, "run", run.ms, length);
  grow();
  spark(segment, "lsr-light-photon", MOMENT_MS, {
    ...length,
    "--lsr-photon-from": `${run.from}px`,
    "--lsr-photon-to": `${run.to}px`,
  });
  spark(segment, "lsr-light-edge", MOMENT_MS, {
    ...length,
    "--lsr-edge-at": `${change.share * 100}%`,
  });
  if (change.kind !== "partial") finishChapter(segment, run.ms);
  if (change.kind === "all") sweep(segmentsOf(progress), run.ms);
}

/**
 * An untick: nothing celebrates it, and a run still going on the segments it
 * narrowed would hold their width back behind a particle bound for an edge
 * that is gone. Every other segment's light plays on.
 */
function settle(progress: HTMLElement, shrunk: number[], grow: () => void): void {
  for (const index of shrunk) {
    const segment = segmentAt(progress, index);
    if (segment) putOut(segment);
  }
  grow();
}

function putOut(segment: HTMLElement): void {
  if (segment.getAttribute("data-light") === "run") stop(segment);
  for (const name of RUN_LIGHTS) {
    for (const light of segment.querySelectorAll(`.${name}`)) light.remove();
  }
}

function finishChapter(segment: HTMLElement, ms: number): void {
  spark(segment, "lsr-light-flash", MOMENT_MS, { "--lsr-photon-ms": `${ms}ms` });
  glint(segment, ms + 120);
}

function sweep(segments: HTMLElement[], ms: number): void {
  const step = Math.min(90, SWEEP_MS / segments.length);
  segments.forEach((segment, at) => glint(segment, ms + 420 + Math.round(at * step)));
}

/** Inside the fill, which clips it: only what is approved is crossed. */
function glint(segment: HTMLElement, at: number): void {
  const fill = segment.querySelector(".lsr-progress-fill");
  if (fill) spark(fill, "lsr-light-glint", MOMENT_MS, { "--lsr-glint-at": `${at}ms` });
}

/**
 * The box the redraw drew in the ticked one's place, matched by what it
 * ticks: a tick that moved focus on to another chapter has none on screen.
 */
function liveTick(root: ParentNode, tick: HTMLInputElement): HTMLInputElement | undefined {
  if (tick.isConnected) return tick;
  return [...root.querySelectorAll<HTMLInputElement>("input")].find(
    (input) =>
      input.className === tick.className &&
      input.dataset.file === tick.dataset.file &&
      input.dataset.groupIndex === tick.dataset.groupIndex,
  );
}
