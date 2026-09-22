import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile } from "../../src/diff-extract.ts";
import { pathLabel } from "../../src/browser/path-label.ts";

function file(path: string, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    status: "modified",
    diff: "",
    insertions: 0,
    deletions: 0,
    oversized: false,
    ...overrides,
  };
}

test("a relocated file is named by both of its paths, old to new", () => {
  const moved = file("src/new/thing.ts", { status: "renamed", previousPath: "src/old/thing.ts" });
  const copied = file("src/auth/admin.ts", { status: "copied", previousPath: "src/auth/user.ts" });

  assert.equal(pathLabel(moved), "src/old/thing.ts → src/new/thing.ts");
  assert.equal(pathLabel(copied), "src/auth/user.ts → src/auth/admin.ts");
});

test("any other file is named by its path alone", () => {
  assert.equal(pathLabel(file("src/a.ts")), "src/a.ts");
  assert.equal(pathLabel(file("src/a.ts", { status: "added" })), "src/a.ts");
});

test("an earlier name git did not pair the file with is not shown", () => {
  // A session written before copies were told apart stored one as `modified`
  // with a `previousPath`; the label follows `relocationOf`, not the field.
  const stale = file("src/auth/admin.ts", { status: "modified", previousPath: "src/auth/user.ts" });

  assert.equal(pathLabel(stale), "src/auth/admin.ts");
});

test("both paths are escaped: they come from the patch", () => {
  const moved = file("src/<b>new</b>.ts", { status: "renamed", previousPath: "src/<i>x</i>.ts" });

  assert.equal(pathLabel(moved), "src/&lt;i&gt;x&lt;/i&gt;.ts → src/&lt;b&gt;new&lt;/b&gt;.ts");
});
