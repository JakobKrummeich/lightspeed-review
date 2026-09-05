import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const browserDir = `${repoRoot}dist/browser`;
const { dependencies } = createRequire(import.meta.url)("../package.json") as {
  dependencies: Record<string, string>;
};

// Wiped first because code splitting names chunks by content hash: without this
// every build would leave its predecessors behind in the served directory.
await rm(browserDir, { recursive: true, force: true });

// Self-contained bundle: diff2html, its CSS and every highlight.js grammar ship
// inside, so the review page needs no CDN and works offline. Splitting keeps
// grammars out of the entry point — fetched only for languages a review contains.
await build({
  entryPoints: [`${repoRoot}src/browser/dom/main.ts`],
  outdir: browserDir,
  entryNames: "app",
  bundle: true,
  splitting: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  sourcemap: true,
  minify: true,
  logLevel: "info",
});

await build({
  entryPoints: [`${repoRoot}src/cli.ts`],
  outfile: `${repoRoot}dist/cli.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Runtime dependencies stay external: npm installs them, and bundling pi-ai
  // would pull every provider SDK into the CLI entry point.
  external: Object.keys(dependencies),
  sourcemap: true,
  logLevel: "info",
});
