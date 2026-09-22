import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile } from "../src/diff-extract.ts";
import { relocationOf, renamedFrom, unchangedRelocationOf } from "../src/file-relocation.ts";

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

test("a file with no earlier name is not relocated", () => {
  assert.equal(relocationOf(file("src/a.ts")), undefined);
  assert.equal(relocationOf(file("src/a.ts", { status: "added" })), undefined);
});

test("an earlier name on a file git did not call renamed is not a relocation", () => {
  // Sessions written while `src/diff-extract.ts` still asked git for copies
  // stored one as `modified` with a `previousPath`; read back, such a file is
  // not moved anywhere.
  const stale = file("src/auth/admin.ts", { status: "modified", previousPath: "src/auth/user.ts" });

  assert.equal(relocationOf(stale), undefined);
});

test("a relocation git scored 100% with nothing changed on top is unchanged, in its own word", () => {
  const moved = file("src/new/a.ts", {
    status: "renamed",
    previousPath: "src/old/a.ts",
    similarity: 100,
  });

  assert.equal(unchangedRelocationOf(moved), "moved");
  assert.equal(unchangedRelocationOf({ ...moved, path: "src/old/b.ts" }), "renamed");
  assert.equal(unchangedRelocationOf({ ...moved, similarity: 96, insertions: 2 }), undefined);
  assert.equal(unchangedRelocationOf({ ...moved, insertions: 1 }), undefined);
  assert.equal(unchangedRelocationOf(file("src/a.ts", { similarity: 100 })), undefined);
});

test("a mode flip on a 100% relocation is a change, hunks or no hunks", () => {
  // `git mv` + `chmod +x`: git says `similarity index 100%` and counts no lines,
  // and the one thing that changed is in the header.
  const madeExecutable = file("bin/run.sh", {
    status: "renamed",
    previousPath: "scripts/run.sh",
    similarity: 100,
    diff: [
      "diff --git a/scripts/run.sh b/bin/run.sh",
      "old mode 100644",
      "new mode 100755",
      "similarity index 100%",
      "rename from scripts/run.sh",
      "rename to bin/run.sh",
    ].join("\n"),
  });

  assert.equal(unchangedRelocationOf(madeExecutable), undefined);
});

test("renamedFrom is the old name of a rename, and nothing for an earlier name under any other status", () => {
  assert.equal(
    renamedFrom(file("src/b.ts", { status: "renamed", previousPath: "src/a.ts" })),
    "src/a.ts",
  );
  // How a round recorded a copy while `src/diff-extract.ts` still asked git
  // for copies: `src/a.ts` is still there, so it is not `src/b.ts`'s past.
  assert.equal(
    renamedFrom(file("src/b.ts", { status: "modified", previousPath: "src/a.ts" })),
    undefined,
  );
  assert.equal(renamedFrom(file("src/b.ts")), undefined);
});
