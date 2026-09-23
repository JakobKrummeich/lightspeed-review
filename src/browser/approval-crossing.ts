/**
 * The first report is deliberately never a crossing — it is the state the page
 * opened in (a re-group can open with every file already ticked), and the
 * consumer auto-opens the panel: doing that on load would override a choice
 * for a state the reviewer knew.
 */
export function crossings(onCross: () => void): (complete: boolean) => void {
  let before: boolean | undefined;
  return (complete: boolean): void => {
    const crossed = before === false && complete;
    before = complete;
    if (crossed) onCross();
  };
}
