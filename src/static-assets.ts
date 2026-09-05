import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewError } from "./errors.ts";

/**
 * Resolved relative to this module, so it points at `dist/browser/` whether the
 * code runs from `src/` under Node type stripping or from the bundled CLI.
 */
export const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../dist/browser/", import.meta.url));

export interface StaticAsset {
  contentType: string;
  contents: Buffer;
}

/** The built browser bundle as one server's worth of bytes, keyed by file name. */
export type AssetSnapshot = ReadonlyMap<string, StaticAsset>;

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** Without these the page mounts nothing, so their absence is not a 404 — it is a dead server. */
const REQUIRED_ASSETS = ["app.js", "app.css"];

/**
 * Whole bundle into memory at server start and again on each round open
 * (`handleCreateSession`), swapped whole. Per-request disk reads let a build
 * under a running daemon pair an old shell with new CSS/JS — a page neither
 * build produced, broken with no error. A snapshot pins both halves to one
 * build; a restart or the next round picks up the new one. ~1.3 MB resident.
 */
export function loadAssets(directory: string): AssetSnapshot {
  const assets = new Map<string, StaticAsset>();
  for (const entry of readBundleDir(directory)) {
    const contentType = CONTENT_TYPES[extname(entry)];
    if (contentType === undefined) continue;
    // An unreadable listed file is a broken build; fail at start, where someone
    // is watching, not as an invisible mid-review 404.
    try {
      assets.set(entry, { contentType, contents: readFileSync(join(directory, entry)) });
    } catch {
      throw bundleMissing(directory, `${entry} is listed in the directory but cannot be read`);
    }
  }
  const missing = REQUIRED_ASSETS.filter((asset) => !assets.has(asset));
  if (missing.length > 0) throw bundleMissing(directory, missing.join(", "));
  return assets;
}

function readBundleDir(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    throw bundleMissing(directory, "the directory does not exist or cannot be read");
  }
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

function bundleMissing(directory: string, detail: string): ReviewError {
  return new ReviewError({
    code: "browser_bundle_missing",
    message: `the browser bundle is missing from ${directory} — run \`pnpm run build\``,
    detail,
    suggestions: [
      "Run `pnpm run build` to build the browser bundle, then start the server again",
      "Reinstall lightspeed if this is an installed copy rather than a checkout",
    ],
  });
}

/**
 * Presence check without reading, so the command spawning a detached server can
 * fail with the real reason: the spawned process has no stdio anyone reads, and
 * its own check would surface as a startup timeout.
 */
export function assertBundlePresent(directory: string): void {
  for (const asset of REQUIRED_ASSETS) {
    try {
      if (statSync(join(directory, asset)).isFile()) continue;
    } catch {
      // Falls through to the same failure as a file that is not there at all.
    }
    throw bundleMissing(directory, asset);
  }
}
