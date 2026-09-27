import { crossesRect, type SkyRect } from "./sky-keep-out.ts";

interface Point {
  x: number;
  y: number;
}

/**
 * Prim's minimum spanning tree over `points`, never across the button's box
 * (`sky-keep-out.ts`); edges as indexes into `points`. When the box parts the
 * stars, each side is a tree of its own.
 */
export function spanningTree(points: Point[], keep: SkyRect): [number, number][] {
  const edges: [number, number][] = [];
  const inTree = [0];
  while (inTree.length < points.length) {
    const best = shortestReach(points, inTree, keep);
    if (best === undefined) {
      inTree.push(points.findIndex((_point, index) => !inTree.includes(index)));
      continue;
    }
    edges.push(best);
    inTree.push(best[1]);
  }
  return edges;
}

/** The shortest edge from the tree to a star outside it that keeps off the box, if any. */
function shortestReach(
  points: Point[],
  inTree: number[],
  keep: SkyRect,
): [number, number] | undefined {
  let best: [number, number] | undefined;
  let shortest = Infinity;
  for (const from of inTree) {
    const origin = points[from];
    if (origin === undefined) continue;
    for (const [to, point] of points.entries()) {
      if (inTree.includes(to)) continue;
      const length = Math.hypot(origin.x - point.x, origin.y - point.y);
      if (length >= shortest || crossesRect(keep, origin, point)) continue;
      shortest = length;
      best = [from, to];
    }
  }
  return best;
}
