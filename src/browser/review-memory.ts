import { ANCHOR_FIELDS, parsePrompt } from "../feedback-prompt.ts";
import type { QueuedPill } from "./queued-pill.ts";
import type { FeedbackPrompt } from "../session-store.ts";

/**
 * The `localStorage` slice this needs, fakeable in tests. Wider than
 * `view-format.ts`'s: this one must find other sessions' records to drop them.
 */
export interface ReviewMemoryStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Two lifetimes: `pending`/`draft` are unsent words that nothing the agent
 * does makes stale; `groups`/`files`/`scroll` point into one round's diff, so
 * they are round-stamped and only handed back to that round.
 */
export interface ReviewMemory {
  pending: QueuedPill[];
  draft: string;
  round: number | undefined;
  /**
   * Last round whose replay auto-showed, so a reload never re-triggers it.
   * Not part of the place: a re-group leaves it; the reopen control ignores it.
   */
  replayed: number | undefined;
  /** Once per review, not per round: a re-group leaves it standing, and nothing ever sets it back. */
  unwrapped: boolean;
  groups: number[];
  files: string[];
  /** Pixels. */
  scroll: number;
  focus: number | undefined;
  /**
   * The reviewer's own fold per thread card, by card key. Not round-stamped:
   * threads outlive rounds.
   */
  folds: Record<string, ThreadFold>;
  /** The resolved group starts folded; unfolding it is a choice kept per review. */
  resolvedShown: boolean;
}

/**
 * `resolved`: whether the card was settled when the choice was made — the
 * choice holds only while that is still so, so a thread the agent reopened by
 * answering is not left folded by a fold made while it was resolved.
 */
export interface ThreadFold {
  shut: boolean;
  resolved: boolean;
}

export type ReviewPlace = Pick<ReviewMemory, "groups" | "files" | "scroll" | "focus">;

/**
 * Fresh arrays each call: a shared constant would hand the same arrays to
 * every reader, and one push would leak into every later read.
 */
function emptyPlace(): ReviewPlace {
  return { groups: [], files: [], scroll: 0, focus: undefined };
}

/**
 * Bumped when a stored record would be read wrong. Other versions dropped,
 * never migrated: guessing an older shape risks restoring a pill the reviewer
 * never wrote.
 */
const VERSION = 1;

const KEY_PREFIX = "lsr:memory:";

/**
 * Uncapped this grows for the browser profile's life. Eight ≈ several days:
 * yesterday's branch still finds its queue, and the store stays a rounding
 * error against the origin's quota.
 */
export const MEMORY_SESSION_LIMIT = 8;

export function readMemory(storage: ReviewMemoryStorage, sessionKey: string): ReviewMemory {
  const stored = attempt(() => storage.getItem(storageKey(sessionKey)));
  return parseMemory(stored ?? undefined) ?? emptyMemory();
}

/** Nothing for a replaced round: its indices, paths and offset describe a different diff. */
export function reviewPlace(memory: ReviewMemory, round: number): ReviewPlace | undefined {
  if (memory.round !== round) return undefined;
  return {
    groups: memory.groups,
    files: memory.files,
    scroll: memory.scroll,
    focus: memory.focus,
  };
}

/**
 * Panel and diff each remember their half without reading the other's. A
 * patch naming a new round resets the place half — the old paths and offsets
 * must not survive into a different diff.
 */
export function updateMemory(
  storage: ReviewMemoryStorage,
  sessionKey: string,
  patch: Partial<ReviewMemory>,
): void {
  const next = { ...rebased(readMemory(storage, sessionKey), patch.round), ...patch };
  if (isEmpty(next)) {
    attempt(() => storage.removeItem(storageKey(sessionKey)));
    return;
  }
  write(storage, sessionKey, next);
}

function rebased(memory: ReviewMemory, round: number | undefined): ReviewMemory {
  if (round === undefined || round === memory.round) return memory;
  return { ...memory, ...emptyPlace(), round };
}

/** Four parts: four different kinds of nothing, unreadable as one run of `&&`. */
function isEmpty(memory: ReviewMemory): boolean {
  return (
    nothingUnsent(memory) && nothingShownYet(memory) && noPlaceKept(memory) && noFoldKept(memory)
  );
}

function noFoldKept(memory: ReviewMemory): boolean {
  return Object.keys(memory.folds).length === 0 && !memory.resolvedShown;
}

function nothingUnsent(memory: ReviewMemory): boolean {
  return memory.pending.length === 0 && memory.draft === "";
}

/**
 * Dropping the record while either overlay's flag stands would give it a
 * second turn on next load — the one thing both must never do.
 */
function nothingShownYet(memory: ReviewMemory): boolean {
  return memory.replayed === undefined && !memory.unwrapped;
}

function noPlaceKept(memory: ReviewMemory): boolean {
  return (
    memory.groups.length === 0 &&
    memory.files.length === 0 &&
    memory.scroll === 0 &&
    memory.focus === undefined
  );
}

/**
 * Gives ground on quota: first other reviews, then this review's place. Queue
 * and draft go last — the only things not recoverable by scrolling.
 */
function write(storage: ReviewMemoryStorage, sessionKey: string, memory: ReviewMemory): void {
  const key = storageKey(sessionKey);
  evictOldest(storage, key);
  if (put(storage, key, memory)) return;
  evictOthers(storage, key);
  if (put(storage, key, memory)) return;
  // Still no room: keep going without the place. A thrown error would lose
  // the page; a reload loses the queue either way.
  put(storage, key, { ...memory, ...emptyPlace(), round: undefined });
}

/**
 * Two reviews often write within one millisecond, and equal stamps make
 * eviction guess (wrongly for the later write) — so each stamp is at least one
 * past the last; the clock still orders across page loads.
 */
let lastStamp = 0;

function stamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/** False: the store is full or shut. */
function put(storage: ReviewMemoryStorage, key: string, memory: ReviewMemory): boolean {
  const record = { v: VERSION, at: stamp(), ...memory };
  try {
    storage.setItem(key, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

function evictOldest(storage: ReviewMemoryStorage, keep: string): void {
  for (const stale of otherReviews(storage, keep).slice(MEMORY_SESSION_LIMIT - 1)) {
    attempt(() => storage.removeItem(stale.key));
  }
}

function evictOthers(storage: ReviewMemoryStorage, keep: string): void {
  for (const other of otherReviews(storage, keep)) {
    attempt(() => storage.removeItem(other.key));
  }
}

function otherReviews(storage: ReviewMemoryStorage, keep: string): { key: string; at: number }[] {
  return records(storage).filter((record) => record.key !== keep);
}

/** Newest write first. */
function records(storage: ReviewMemoryStorage): { key: string; at: number }[] {
  const found = attempt(() => {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(KEY_PREFIX)) keys.push(key);
    }
    return keys;
  });
  return (found ?? [])
    .map((key) => ({ key, at: savedAt(storage, key) }))
    .sort((one, other) => other.at - one.at);
}

/** A record that will not say dates from the beginning of time. */
function savedAt(storage: ReviewMemoryStorage, key: string): number {
  const value = parseJson(attempt(() => storage.getItem(key)) ?? undefined);
  return isRecord(value) ? (asNumber(value.at) ?? 0) : 0;
}

/**
 * Every field checked, not trusted: the store is origin-wide, and a page that
 * throws on load beats losing to an empty queue.
 */
function parseMemory(text: string | undefined): ReviewMemory | undefined {
  const value = parseJson(text);
  if (!isRecord(value) || value.v !== VERSION) return undefined;
  return {
    pending: asArray(value.pending).map(restoredPill).filter(present),
    draft: typeof value.draft === "string" ? value.draft : "",
    round: asInteger(value.round),
    replayed: asInteger(value.replayed),
    // Anything but this code's own flag reads as "not opened". Wrong costs one
    // repeat showing — cheaper than withholding the wrapper for good.
    unwrapped: value.unwrapped === true,
    groups: asArray(value.groups).map(asInteger).filter(present),
    files: asArray(value.files).filter((entry) => typeof entry === "string"),
    scroll: Math.max(asNumber(value.scroll) ?? 0, 0),
    focus: asInteger(value.focus),
    folds: restoredFolds(value.folds),
    resolvedShown: value.resolvedShown === true,
  };
}

/** Entry by entry: one corrupt fold costs that thread its fold, not every thread theirs. */
function restoredFolds(value: unknown): Record<string, ThreadFold> {
  if (!isRecord(value)) return {};
  const folds: Record<string, ThreadFold> = {};
  for (const [key, fold] of Object.entries(value)) {
    if (isFold(fold)) folds[key] = { shut: fold.shut, resolved: fold.resolved };
  }
  return folds;
}

function isFold(value: unknown): value is ThreadFold {
  return isRecord(value) && typeof value.shut === "boolean" && typeof value.resolved === "boolean";
}

/**
 * Judged by the server's own rules, so nothing restores into a queue the send
 * would bounce (one refused prompt fails the whole payload). Only the anchor
 * is loosened: a broken line range drops the anchor, not the words — an
 * unanchored annotation is an ordinary thing to send.
 */
function restoredPrompt(value: unknown): FeedbackPrompt | undefined {
  const sendable = parsePrompt(value);
  if (sendable) return sendable;
  // Both readings judge every other field alike, so a record the second
  // accepts was refused over its anchor alone.
  return parsePrompt(withoutAnchor(value));
}

/**
 * The stamp rides outside the server's parser (which strips unknown fields);
 * a corrupt stamp drops alone — no stamp honestly claims no round.
 */
function restoredPill(value: unknown): QueuedPill | undefined {
  const prompt = restoredPrompt(value);
  if (prompt === undefined) return undefined;
  const round = isRecord(value) ? asInteger(value.round) : undefined;
  return round === undefined ? prompt : { ...prompt, round };
}

function withoutAnchor(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([field]) => !ANCHOR_FIELDS.includes(field)),
  );
}

function emptyMemory(): ReviewMemory {
  return {
    pending: [],
    draft: "",
    round: undefined,
    replayed: undefined,
    unwrapped: false,
    ...emptyPlace(),
    folds: {},
    resolvedShown: false,
  };
}

function storageKey(sessionKey: string): string {
  return `${KEY_PREFIX}${sessionKey}`;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  // Every stored integer counts from 0 or 1; a negative is corruption.
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** Storage access throws when the browser blocks it, or when it is full. */
function attempt<T>(act: () => T): T | undefined {
  try {
    return act();
  } catch {
    return undefined;
  }
}
