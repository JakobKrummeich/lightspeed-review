/**
 * The box in the middle of the sky kept clear for the constellation sheet's
 * button — the place the jump launches from. `layoutSky` keeps every star,
 * figure line and name out of it: clusters move out of its way, a straggler
 * that still lands in it is sent back out, a figure edge that would cross it
 * is not drawn, and a name that would cover it goes above its stars instead.
 * Pure geometry, like the layout it serves.
 */

interface Size {
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

/** `x`/`y` its top left corner. */
export interface SkyRect extends Size, Point {}

/**
 * The button is about 200 × 44 px and its pulse rings 22 px out round it; a
 * star's glow reaches some 13 px past its centre. Rounded up from there.
 */
export const KEEP_OUT = { width: 320, height: 140 } as const;

/** Centred on the sky, as the sheet centres its button in the window. */
export function keepOut(box: Size): SkyRect {
  const width = Math.min(KEEP_OUT.width, box.width);
  const height = Math.min(KEEP_OUT.height, box.height);
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

function middleOf(rect: SkyRect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * A cluster's centre moved straight away from the sky's middle until its
 * stars — `reach` across, 0.8 of it down, as `cluster` spreads them — clear
 * the box. A centre on the middle itself stays: its stars ring the button.
 */
export function clearCentre(
  centre: [number, number],
  reach: number,
  rect: SkyRect,
): [number, number] {
  const middle = middleOf(rect);
  const [dx, dy] = [centre[0] - middle.x, centre[1] - middle.y];
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return centre;
  const across = dx === 0 ? Infinity : (rect.width / 2 + reach) / Math.abs(dx / distance);
  const down = dy === 0 ? Infinity : (rect.height / 2 + reach * 0.8) / Math.abs(dy / distance);
  const need = Math.min(across, down);
  if (distance >= need) return centre;
  return [middle.x + (dx / distance) * need, middle.y + (dy / distance) * need];
}

function within(rect: SkyRect, { x, y }: Point): boolean {
  return x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height;
}

/**
 * A star in the box goes out the way it lies from the middle, as far past the
 * edge as it stood inside it, so a crowd keeps its spread; one on the middle
 * itself goes up.
 */
export function outOf(rect: SkyRect, point: Point): Point {
  if (!within(rect, point)) return point;
  const middle = middleOf(rect);
  const [dx, dy] =
    point.x === middle.x && point.y === middle.y
      ? [0, -1]
      : [point.x - middle.x, point.y - middle.y];
  const toEdge = Math.min(
    dx === 0 ? Infinity : rect.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : rect.height / 2 / Math.abs(dy),
  );
  const edge = { x: middle.x + dx * toEdge, y: middle.y + dy * toEdge };
  const beyond = Math.hypot(edge.x - point.x, edge.y - point.y) + 2;
  const length = Math.hypot(dx, dy);
  return { x: edge.x + (dx / length) * beyond, y: edge.y + (dy / length) * beyond };
}

/** Whether the segment `a`–`b` passes through the box's inside (Liang–Barsky). */
export function crossesRect(rect: SkyRect, a: Point, b: Point): boolean {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const sides: [number, number][] = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.width - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.height - a.y],
  ];
  let [enter, leave] = [0, 1];
  for (const [toward, room] of sides) {
    if (toward === 0) {
      if (room <= 0) return false;
      continue;
    }
    const at = room / toward;
    if (toward < 0) enter = Math.max(enter, at);
    else leave = Math.min(leave, at);
  }
  return enter < leave;
}

/** A name's box, `x` its centre and `y` its top, shares any of the box's inside. */
export function coversRect(rect: SkyRect, label: Size & Point): boolean {
  return (
    label.x + label.width / 2 > rect.x &&
    label.x - label.width / 2 < rect.x + rect.width &&
    label.y + label.height > rect.y &&
    label.y < rect.y + rect.height
  );
}
