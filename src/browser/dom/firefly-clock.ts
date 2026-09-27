/**
 * Every firefly flies on the page's one clock. The panel and the header are
 * drawn again on presence frames, and a new firefly starting its drift from
 * the top would jump back to the middle of its box each time; started at the
 * timeline's zero, each one is where the one it replaced had got to. None to
 * set under reduced motion, where the firefly has no animations.
 */
export function keepFireflyTime(root: ParentNode): void {
  const firefly = root.querySelector(".lsr-firefly");
  if (!firefly || !("getAnimations" in firefly)) return;
  for (const animation of firefly.getAnimations({ subtree: true })) animation.startTime = 0;
}
