/**
 * 05 Accelerator: the light that answers a tick (`css/light-approval.css`). A
 * particle runs along the bar to the grown fill's new edge and a spark marks
 * where it stopped; a finished chapter flashes and a glint crosses it; the
 * last one sends a glint down every segment. The tick's own box glows.
 */
import type { ProgressChange } from "../progress-bar.ts";
import { play, spark } from "./light-play.ts";

/** Long enough for the slowest run, the last glint and its fade. */
const MOMENT_MS = 2400;
const TICK_MS = 600;
/** The whole bar is crossed in this, however many segments it has. */
const SWEEP_MS = 540;

interface Run {
  /** Where the particle sets off and lands, from the segment's own left edge. */
  from: number;
  to: number;
  ms: number;
}

/**
 * Called before the fill's width is patched: measuring flushes styles, and
 * the moment's state has to be on the segment when the width changes, so the
 * fill grows behind the particle rather than ahead of it.
 */
export function accelerate(
  progress: HTMLElement,
  change: ProgressChange | undefined,
  tick: Element,
): void {
  play(tick, "tick", TICK_MS);
  if (change === undefined) return;
  const segments = [...progress.querySelectorAll<HTMLElement>(".lsr-progress-segment")];
  const segment = segments.find((one) => one.dataset.groupIndex === String(change.index));
  const run = segment && runTo(segment, change.share);
  // No box: the bar is not drawn at this width, and there is nowhere to run.
  if (!segment || !run) return;
  launch(segment, run, change.share);
  if (change.kind !== "partial") finishChapter(segment, run.ms);
  if (change.kind === "all") sweep(segments, run.ms);
}

/**
 * From the start of the bar, not of the segment: the light comes from where
 * the reviewer's progress began. A farther edge is a longer run, capped so a
 * wide bar does not keep the moment going.
 */
function runTo(segment: HTMLElement, share: number): Run | undefined {
  const box = segment.getBoundingClientRect();
  const bar = segment.parentElement?.getBoundingClientRect();
  if (!bar || box.width === 0) return undefined;
  const from = bar.left - box.left;
  const to = box.width * share;
  return { from, to, ms: Math.round(Math.min(600, 220 + (to - from) / 2)) };
}

function launch(segment: HTMLElement, run: Run, share: number): void {
  segment.style.setProperty("--lsr-photon-ms", `${run.ms}ms`);
  play(segment, "run", MOMENT_MS);
  spark(segment, "lsr-light-photon", MOMENT_MS, {
    "--lsr-photon-from": `${run.from}px`,
    "--lsr-photon-to": `${run.to}px`,
  });
  spark(segment, "lsr-light-edge", MOMENT_MS, { "--lsr-edge-at": `${share * 100}%` });
}

function finishChapter(segment: HTMLElement, ms: number): void {
  spark(segment, "lsr-light-flash", MOMENT_MS);
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
