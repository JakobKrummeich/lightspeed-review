import type { EnterKeydown } from "../../../src/browser/dom/enter-key.ts";

/** A keydown as the mounts read one: the modifiers, the target, and the veto. */
export interface FakeKeydown extends EnterKeydown {
  target: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
}

/** Defaults to the bare Enter that submits, so a test names only its variation. */
export function keydown(target: unknown, over: Partial<EnterKeydown> = {}): FakeKeydown {
  const event: FakeKeydown = {
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    target,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    ...over,
  };
  return event;
}
