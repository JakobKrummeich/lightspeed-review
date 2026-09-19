import { createRequire } from "node:module";

/**
 * What this build of lightspeed calls itself. Single-sourced from package.json
 * and resolved the same from `src/` and from the bundled `dist/cli.mjs`, so the
 * CLI and the server it spawns can never disagree about who is newer.
 *
 * The server states it on `/health`; every command that would talk to a server
 * compares it against this. A `serve` left over from an older install answers
 * happily and speaks a protocol the current CLI no longer reads — that is the
 * failure this constant exists to make visible.
 */
const require = createRequire(import.meta.url);

const manifest = require("../package.json") as { version: string; description: string };

export const CLI_VERSION = manifest.version;

export const CLI_DESCRIPTION = manifest.description;
