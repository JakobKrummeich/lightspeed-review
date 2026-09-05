import type { ReviewMemoryStorage } from "../../src/browser/review-memory.ts";

/** A `localStorage` that keeps what it is given, and can be looked into. */
export class FakeStorage implements ReviewMemoryStorage {
  readonly entries: Map<string, string>;
  /**
   * Character cap for the whole store. A real quota counts what is already in
   * there — a refused write can land after shedding. Zero refuses every write.
   */
  budget = Number.POSITIVE_INFINITY;

  constructor(seed: Record<string, string> = {}) {
    this.entries = new Map(Object.entries(seed));
  }

  get length(): number {
    return this.entries.size;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.used(key) + key.length + value.length > this.budget) {
      throw new Error("QuotaExceededError");
    }
    this.entries.set(key, value);
  }

  /** What everything but the key being written is taking up. */
  private used(writing: string): number {
    let total = 0;
    for (const [key, value] of this.entries) {
      if (key !== writing) total += key.length + value.length;
    }
    return total;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }
}
