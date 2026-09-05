import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewError } from "../src/errors.ts";
import { assertBundlePresent, loadAssets } from "../src/static-assets.ts";

function bundleDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "lsr-assets-"));
  writeFileSync(join(directory, "app.js"), "console.log('hi');");
  writeFileSync(join(directory, "app.css"), ".lsr-file{}");
  return directory;
}

test("a loaded bundle answers with the bytes and the content type of each asset", () => {
  const directory = bundleDir();
  writeFileSync(join(directory, "app.js.map"), '{"version":3}');

  const assets = loadAssets(directory);

  assert.equal(assets.get("app.js")?.contents.toString(), "console.log('hi');");
  assert.match(assets.get("app.js")?.contentType ?? "", /javascript/);
  assert.match(assets.get("app.css")?.contentType ?? "", /text\/css/);
  assert.match(assets.get("app.js.map")?.contentType ?? "", /json/);
});

test("the snapshot holds the bytes that were on disk when it was taken", () => {
  const directory = bundleDir();
  const assets = loadAssets(directory);

  writeFileSync(join(directory, "app.css"), ".lsr-wrecked{}");

  assert.equal(assets.get("app.css")?.contents.toString(), ".lsr-file{}");
});

test("a bundle read survives its directory being wiped by the next build", () => {
  const directory = bundleDir();
  const assets = loadAssets(directory);

  rmSync(directory, { recursive: true, force: true });

  assert.equal(assets.get("app.js")?.contents.toString(), "console.log('hi');");
});

test("files the browser is never served are left out of the snapshot", () => {
  const directory = bundleDir();
  writeFileSync(join(directory, "notes.txt"), "not an asset");
  mkdirSync(join(directory, "nested.js"));

  const assets = loadAssets(directory);

  assert.equal(assets.get("notes.txt"), undefined);
  assert.equal(assets.get("nested.js"), undefined);
});

test("a name is a key and not a path, so it cannot reach outside the bundle", () => {
  const assets = loadAssets(bundleDir());

  assert.equal(assets.get("../../etc/passwd"), undefined);
  assert.equal(assets.get("/etc/passwd"), undefined);
});

test("a directory with no bundle in it says to build the bundle", () => {
  const directory = mkdtempSync(join(tmpdir(), "lsr-assets-"));

  assert.throws(
    () => loadAssets(directory),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "browser_bundle_missing" &&
      /pnpm run build/.test(error.message),
  );
});

test("a bundle directory that does not exist says to build the bundle", () => {
  assert.throws(
    () => loadAssets(join(tmpdir(), "lsr-assets-absent-directory")),
    (error: unknown) => error instanceof ReviewError && error.code === "browser_bundle_missing",
  );
});

test("a bundle missing only its stylesheet is as fatal as one missing everything", () => {
  const directory = mkdtempSync(join(tmpdir(), "lsr-assets-"));
  writeFileSync(join(directory, "app.js"), "console.log('hi');");

  assert.throws(
    () => loadAssets(directory),
    (error: unknown) =>
      error instanceof ReviewError && /app\.css/.test(error.detail ?? "") === true,
  );
});

/** Root reads everything, so there is no unreadable file to build there. */
test(
  "a chunk that cannot be read fails the load instead of 404ing mid-review",
  { skip: process.getuid?.() === 0 ? "runs as root" : false },
  () => {
    const directory = bundleDir();
    const chunk = join(directory, "grammar.js");
    writeFileSync(chunk, "export const x = 1;");
    chmodSync(chunk, 0o000);

    assert.throws(
      () => loadAssets(directory),
      (error: unknown) =>
        error instanceof ReviewError &&
        error.code === "browser_bundle_missing" &&
        /grammar\.js/.test(error.detail ?? ""),
    );
  },
);

test("a present bundle passes the pre-spawn check without reading it", () => {
  assert.doesNotThrow(() => assertBundlePresent(bundleDir()));
});

test("the pre-spawn check names the same failure the server would raise", () => {
  const directory = mkdtempSync(join(tmpdir(), "lsr-assets-"));
  writeFileSync(join(directory, "app.js"), "console.log('hi');");

  assert.throws(
    () => assertBundlePresent(directory),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "browser_bundle_missing" &&
      /pnpm run build/.test(error.message) &&
      error.detail === "app.css",
  );
});

test("the pre-spawn check refuses a directory where an asset should be", () => {
  const directory = mkdtempSync(join(tmpdir(), "lsr-assets-"));
  mkdirSync(join(directory, "app.js"));
  writeFileSync(join(directory, "app.css"), ".lsr-file{}");

  assert.throws(
    () => assertBundlePresent(directory),
    (error: unknown) => error instanceof ReviewError && error.code === "browser_bundle_missing",
  );
});
