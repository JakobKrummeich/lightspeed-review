import type { EnterKeydown } from "../../../src/browser/dom/enter-key.ts";

export interface FakeKeydown extends EnterKeydown {
  target: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
}

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
