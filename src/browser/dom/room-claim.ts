/**
 * `#lsr-opening` is one root shared by two rooms: the opening (a first round)
 * and the round jump (every later one). They can meet — a round can arrive
 * while a reviewer in another tab still sits in the opening — so a room never
 * writes over the root. It claims it with its own way out, and whoever takes
 * the root next runs that way out first: timers, frames, listeners, the inert
 * page and the caret all go the way they would on Esc.
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
