/**
 * `--intent` is not optional — a `start` without one exits 2 on
 * `intent_missing` — so no help line may spell one without it, whatever else
 * that line is about: a dead server, a corrupt session file, a 404.
 *
 * Its own module, below `commands/`, because the session store, the diff
 * extractor and the model client all spell it in their errors, and importing it
 * from `commands/home.ts` closed import cycles back through them.
 */
export function startCall(target: string): string {
  return `lightspeed start ${target} --intent "<why this branch exists>"`;
}
