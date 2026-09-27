/**
 * `#lsr-opening` is shared by the opening and the round jump, and a round can
 * arrive while the opening is still up. So a room claims the root with its
 * own way out, and whoever takes the root next runs that first — timers,
 * frames, listeners, the inert page and the caret go as they would on Esc.
 */
const owners = new WeakMap<HTMLElement, () => void>();

/** Closes whatever room holds `root`, as its own way out would. */
export function evictRoom(root: HTMLElement): void {
  const leave = owners.get(root);
  owners.delete(root);
  leave?.();
}

/** Takes `root` for a room that leaves by `leave`, closing the room there first. */
export function claimRoom(root: HTMLElement, leave: () => void): void {
  evictRoom(root);
  owners.set(root, leave);
}

/** The room left by itself: nothing to close when the next one comes. */
export function leaveRoom(root: HTMLElement, leave: () => void): void {
  if (owners.get(root) === leave) owners.delete(root);
}
