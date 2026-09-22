import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile } from "../src/diff-extract.ts";
import { isUnchangedRelocation, relocationOf, renamedFrom } from "../src/file-relocation.ts";

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

test("a file that left its directory is moved, whatever happened to its name", () => {
  const kept = file("src/new/thing.ts", { status: "renamed", previousPath: "src/old/thing.ts" });
  const changed = file("src/hooks/useGroupPages.ts", {
    status: "renamed",
    previousPath: "src/screens/usePresenterGroupWorkScreen.ts",
  });

  assert.equal(relocationOf(kept), "moved");
  assert.equal(relocationOf(changed), "moved");
});

test("a file that stayed in its directory under another name is renamed", () => {
  const renamed = file("src/auth/session.ts", {
    status: "renamed",
    previousPath: "src/auth/token.ts",
  });
  const atRoot = file("README.md", { status: "renamed", previousPath: "readme.md" });

  assert.equal(relocationOf(renamed), "renamed");
  assert.equal(relocationOf(atRoot), "renamed");
});

test("a copy is copied, into its own directory or another", () => {
  const beside = file("src/auth/admin.ts", { status: "copied", previousPath: "src/auth/user.ts" });
  const elsewhere = file("src/admin/user.ts", {
    status: "copied",
    previousPath: "src/auth/user.ts",
  });

  assert.equal(relocationOf(beside), "copied");
  assert.equal(relocationOf(elsewhere), "copied");
});

test("a file with no earlier name is not relocated", () => {
  assert.equal(relocationOf(file("src/a.ts")), undefined);
  assert.equal(relocationOf(file("src/a.ts", { status: "added" })), undefined);
});

test("a relocation git scored 100% with nothing changed on top is unchanged", () => {
  const moved = file("src/new/a.ts", {
    status: "renamed",
    previousPath: "src/old/a.ts",
    similarity: 100,
  });

  assert.equal(isUnchangedRelocation(moved), true);
  assert.equal(isUnchangedRelocation({ ...moved, similarity: 96, insertions: 2 }), false);
  assert.equal(isUnchangedRelocation({ ...moved, insertions: 1 }), false);
  assert.equal(isUnchangedRelocation(file("src/a.ts", { similarity: 100 })), false);
});

test("renamedFrom is the old name of a rename and nothing for a copy", () => {
  assert.equal(
    renamedFrom(file("src/b.ts", { status: "renamed", previousPath: "src/a.ts" })),
    "src/a.ts",
  );
  assert.equal(
    renamedFrom(file("src/b.ts", { status: "copied", previousPath: "src/a.ts" })),
    undefined,
  );
  assert.equal(renamedFrom(file("src/b.ts")), undefined);
});
