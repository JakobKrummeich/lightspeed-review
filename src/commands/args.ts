/**
 * The one flag scanner behind every command that takes flags. Commands keep their
 * own vocabulary and error text; this walks tokens left to right in one pass,
 * throwing the caller's error at the exact token — which mistake is reported first
 * stays per-command. No command may ignore a flag it does not know: silently
 * collecting one as a positional is how `start` came to open a browser that
 * `--no-opne` had asked it not to.
 */
export interface ScanSpec {
  /** Flags that consume the next token as their value. */
  value?: readonly string[];
  /** Flags that stand alone. */
  boolean?: readonly string[];
  /** The error an unknown flag-like token raises, thrown where the token was met. */
  onUnknown: (flag: string) => Error;
  /** What a value flag with nothing to eat does. Absent, the hit is recorded
   * valueless and the caller decides (`start` drops it, `poll` raises errors that
   * depend on earlier flags); a factory throws at the flag itself (`feedback`). */
  onMissingValue?: (flag: string) => Error;
  /** Whether a flag-like token can be a value. `"any"` (default) eats whatever comes
   * next — a poll note may be "-1 on that"; `"bare"` refuses, so `--since --format`
   * is a missing value, not a value. */
  values?: "any" | "bare";
  /** What marks an unknown token as flag-like: `poll` only `--x` (a branch named
   * `-x` stays positional), `feedback` any `-x`. */
  flagPrefix?: "-" | "--";
}

export interface FlagHit {
  flag: string;
  /** Absent when the flag had nothing it was allowed to eat. */
  value: string | undefined;
}

export interface ScannedArgs {
  positional: string[];
  /** Every flag occurrence in command-line order; a repeated flag appears once per use. */
  flags: FlagHit[];
}

export function scanArgs(args: string[], spec: ScanSpec): ScannedArgs {
  const scanned: ScannedArgs = { positional: [], flags: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (isKnown(spec.value, token)) index += readValueFlag(scanned, spec, token, args[index + 1]);
    else if (isKnown(spec.boolean, token)) scanned.flags.push({ flag: token, value: undefined });
    else scanned.positional.push(unknownChecked(spec, token));
  }
  return scanned;
}

function isKnown(flags: readonly string[] | undefined, token: string): boolean {
  return flags !== undefined && flags.includes(token);
}

/** A token nobody declared is positional unless it looks like a flag. */
function unknownChecked(spec: ScanSpec, token: string): string {
  if (token.startsWith(spec.flagPrefix ?? "--")) throw spec.onUnknown(token);
  return token;
}

/** Returns how many tokens the value ate: 1, or 0 when the flag had none to eat. */
function readValueFlag(
  scanned: ScannedArgs,
  spec: ScanSpec,
  flag: string,
  next: string | undefined,
): number {
  const value = edible(spec, next) ? next : undefined;
  if (value === undefined && spec.onMissingValue !== undefined) throw spec.onMissingValue(flag);
  scanned.flags.push({ flag, value });
  return value === undefined ? 0 : 1;
}

/** Whether the next token is one this flag may take as its value at all. */
function edible(spec: ScanSpec, next: string | undefined): next is string {
  if (next === undefined) return false;
  return spec.values !== "bare" || !next.startsWith("-");
}

/** Every value the flag was given, in order, so a repeatable flag keeps them all. */
export function allValues(scanned: ScannedArgs, flag: string): string[] {
  return scanned.flags
    .filter((hit) => hit.flag === flag && hit.value !== undefined)
    .map((hit) => hit.value!);
}

/** Repeating a single-valued flag means the last one wins. */
export function lastValue(scanned: ScannedArgs, flag: string): string | undefined {
  return allValues(scanned, flag).at(-1);
}

export function hasFlag(scanned: ScannedArgs, flag: string): boolean {
  return scanned.flags.some((hit) => hit.flag === flag);
}
