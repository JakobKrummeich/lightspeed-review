import type { DiffOutputFormat } from "../diff2html-adapter.ts";
import {
  effectiveFormat,
  parseViewFormat,
  readViewFormat,
  writeViewFormat,
  type ViewFormatStorage,
} from "../view-format.ts";

export interface MountedViewToggle {
  /** Asks again whether two columns fit — the answer changes with the panel. */
  refresh(): void;
}

export interface ViewToggleOptions {
  /** The segmented control; its `button[data-format]` children are the options. */
  root: HTMLElement;
  sessionKey: string;
  storage: ViewFormatStorage;
  /** Whether two code columns fit right now, panel included if it is open. */
  hasRoom(): boolean;
  /** Called only when the rendered view changes, never for the initial one. */
  onFormat(format: DiffOutputFormat): void;
}

/**
 * Wires the header view switch. The caller renders the first view itself (same
 * stored preference, same breakpoint) so the diff is drawn once at mount.
 */
export function mountViewToggle(options: ViewToggleOptions): MountedViewToggle {
  const buttons = [...options.root.querySelectorAll<HTMLButtonElement>("button[data-format]")];
  let preferred = readViewFormat(options.storage, options.sessionKey);
  let current = effectiveFormat(preferred, options.hasRoom());
  mark(buttons, current);

  // A resize or panel toggle changes the view without the choice changing:
  // the preference is kept and honoured again once there is room.
  const refresh = (): void => {
    const next = effectiveFormat(preferred, options.hasRoom());
    if (next === current) return;
    current = next;
    mark(buttons, current);
    options.onFormat(current);
  };

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const picked = parseViewFormat(button.dataset.format);
      if (!picked) return;
      preferred = picked;
      writeViewFormat(options.storage, options.sessionKey, preferred);
      refresh();
    });
  }
  return { refresh };
}

/** The pressed option is the view on screen, so the control reads as state. */
function mark(buttons: HTMLButtonElement[], format: DiffOutputFormat): void {
  for (const button of buttons) {
    button.setAttribute("aria-pressed", String(button.dataset.format === format));
  }
}
