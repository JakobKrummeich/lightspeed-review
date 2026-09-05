/**
 * Turns the diff's per-draw/per-tick reports into the one event worth acting
 * on: the moment the last file is ticked. The first report is deliberately
 * never a crossing — it is the state the page opened in (a re-group can open
 * with every file already ticked), and the consumer auto-opens the panel:
 * doing that on load would override a choice for a state the reviewer knew.
 */
export function crossings(onCross: () => void): (complete: boolean) => void {
  /** Undefined until the first report, which is where the review started. */
  let before: boolean | undefined;
  return (complete: boolean): void => {
    const crossed = before === false && complete;
    before = complete;
    if (crossed) onCross();
  };
}
