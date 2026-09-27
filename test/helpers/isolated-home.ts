import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Points HOME, which `os.homedir()` reads on every call, at a fresh temporary
 * directory for the rest of this test process, and returns it.
 *
 * For a test file that resolves the default state dir in-process
 * (`loadConfig` and its siblings, `defaultStateDir`, `authStateDir`): each
 * resolution runs `adoptFormerStateDir`, which renames `~/.lightspeed-review`
 * into a state dir that does not exist yet. Under the real HOME, a run on a
 * machine that still has the old directory would move the developer's reviews
 * into `~/custom-state` or a temp dir. Call it before any test runs.
 */
export function isolateHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lsr-home-"));
  process.env.HOME = home;
  return home;
}
