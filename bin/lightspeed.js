#!/usr/bin/env node
import process from "node:process";
// The bundle is built by `prepare`, so it is absent only on a clone that skipped
// the install; the bare module-not-found Node prints for that names the file and
// not the command that would fix it.
try {
  await import("../dist/cli.mjs");
} catch (error) {
  const missingBundle =
    error?.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes("dist/cli.mjs");
  if (!missingBundle) throw error;
  process.stderr.write(
    "error: dist/cli.mjs is missing — run `pnpm install && pnpm run build` in the clone\n",
  );
  process.exit(2);
}
