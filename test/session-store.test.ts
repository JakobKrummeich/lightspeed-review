import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type SessionRecord } from "../src/session-store.ts";
import { ReviewError } from "../src/errors.ts";

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "lsr-store-"));
}

/** One chapter of one file, for the orders and defaults the store answers for. */
function chapter(name: string, path: string): SessionRecord["groups"][number] {
  return {
    name,
    rationale: "request handling",
    tier: "study",
    files: [
      {
        path,
        status: "modified",
        diff: "@@ -1 +1 @@\n-old\n+new",
        insertions: 1,
        deletions: 1,
        oversized: false,
      },
    ],
  };
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key: "a3f8c21b9e4d5f60",
    repoRoot: "/repo",
    branch: "feature-auth",
    base: "main",
    status: "open",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    groups: [chapter("API Handlers", "src/api/users.ts")],
    conversation: [],
    pending: [],
    approved: [],
    rounds: [],
    ...overrides,
  };
}

test("get returns undefined for an unknown key", () => {
  const store = new SessionStore(stateDir());

  assert.equal(store.get("deadbeefdeadbeef"), undefined);
});

test("list is empty for a fresh state dir", () => {
  const store = new SessionStore(stateDir());

  assert.deepEqual(store.list(), []);
});

test("a saved session is readable by a second store instance", () => {
  const dir = stateDir();
  new SessionStore(dir).save(sessionRecord());

  const reloaded = new SessionStore(dir).get("a3f8c21b9e4d5f60");

  assert.deepEqual(reloaded, sessionRecord());
});

test("groups, conversation, pending feedback and approved flags all survive a round trip", () => {
  const dir = stateDir();
  const record = sessionRecord({
    conversation: [
      {
        role: "reviewer",
        at: "2025-01-01T00:05:00.000Z",
        prompts: [
          {
            type: "annotation",
            file: "src/api/users.ts",
            group: "API Handlers",
            selected_text: "+new",
            comment: "wrap in a transaction",
          },
        ],
      },
      {
        role: "agent",
        at: "2025-01-01T00:06:00.000Z",
        prompts: [{ type: "message", comment: "done" }],
      },
    ],
    pending: [{ type: "message", comment: "looks good overall" }],
    approved: ["src/api/users.ts"],
  });
  new SessionStore(dir).save(record);

  assert.deepEqual(new SessionStore(dir).get(record.key), record);
});

test("saving the same key twice overwrites rather than duplicating", () => {
  const dir = stateDir();
  const store = new SessionStore(dir);
  store.save(sessionRecord());
  store.save(sessionRecord({ status: "feedback" }));

  assert.equal(store.list().length, 1);
  assert.equal(store.get("a3f8c21b9e4d5f60")?.status, "feedback");
});

test("list returns every stored session", () => {
  const store = new SessionStore(stateDir());
  store.save(sessionRecord());
  store.save(sessionRecord({ key: "b1c2d3e4f5061728", branch: "fix-billing" }));

  assert.deepEqual(
    store
      .list()
      .map((session) => session.branch)
      .sort(),
    ["feature-auth", "fix-billing"],
  );
});

test("remove deletes the session", () => {
  const store = new SessionStore(stateDir());
  store.save(sessionRecord());

  store.remove("a3f8c21b9e4d5f60");

  assert.equal(store.get("a3f8c21b9e4d5f60"), undefined);
  assert.deepEqual(store.list(), []);
});

test("remove is a no-op for an unknown key", () => {
  const store = new SessionStore(stateDir());

  assert.doesNotThrow(() => store.remove("deadbeefdeadbeef"));
});

test("a round written before approvals were recorded reads as closing on nothing", () => {
  const dir = stateDir();
  const store = new SessionStore(dir);
  store.save(sessionRecord());
  // `rounds` shipped before `approvedAtEnd` did, so sessions from that window
  // are on disk without it and every reader would trip over the gap.
  writeFileSync(
    join(dir, "sessions", "a3f8c21b9e4d5f60.json"),
    JSON.stringify({
      ...sessionRecord(),
      rounds: [
        {
          index: 0,
          at: "2025-01-01T00:00:00.000Z",
          files: [{ path: "src/api/users.ts", status: "modified", blob: "4c9f88d" }],
        },
      ],
    }),
  );

  assert.deepEqual(store.get("a3f8c21b9e4d5f60")?.rounds[0]?.approvedAtEnd, []);
});

test("a session written before reading tiers existed opens, and opens as study", () => {
  const dir = stateDir();
  const store = new SessionStore(dir);
  store.save(sessionRecord());
  // Every session on disk when tiers shipped is this shape. The default is the
  // safe direction: a chapter nobody tiered is one the reviewer reads, never
  // one the survey sweeps into a lane and offers to tick in a single press.
  const untiered = sessionRecord();
  delete untiered.groups[0]!.tier;
  writeFileSync(join(dir, "sessions", "a3f8c21b9e4d5f60.json"), JSON.stringify(untiered));

  const loaded = store.get("a3f8c21b9e4d5f60");

  assert.equal(loaded?.groups[0]?.name, "API Handlers");
  assert.equal(loaded?.groups[0]?.tier, "study");
  assert.equal(loaded?.groups[0]?.files.length, 1);
});

test("a stored session opens with its bulk last, wherever the file kept it", () => {
  const store = new SessionStore(stateDir());
  // A session written before chapters were ordered by tier, or posted by a
  // client that never ordered them: the reading order is the store's answer to
  // give, not something every reader works out again for itself.
  store.save(
    sessionRecord({
      groups: [
        { ...chapter("Renames", "src/moved.ts"), tier: "sweep" },
        chapter("API Handlers", "src/api/users.ts"),
        { ...chapter("Docs", "README.md"), tier: "sweep" },
        chapter("Billing", "src/billing.ts"),
      ],
    }),
  );

  const loaded = store.get("a3f8c21b9e4d5f60");

  assert.deepEqual(
    loaded?.groups.map((group) => group.name),
    ["API Handlers", "Billing", "Renames", "Docs"],
  );
});

test("a session written before journeys were retired still reads as a review", () => {
  const dir = stateDir();
  const store = new SessionStore(dir);
  store.save(sessionRecord());
  // Journeys shipped and were withdrawn, so sessions in the wild carry them.
  // A field the store no longer names must be inert, not a corrupt session.
  writeFileSync(
    join(dir, "sessions", "a3f8c21b9e4d5f60.json"),
    JSON.stringify({
      ...sessionRecord({ approved: ["src/api/users.ts"] }),
      journeys: [
        {
          protagonist: "a token",
          stations: [
            { name: "Parsed", tells: "the token is read", group: "API Handlers" },
            { name: "Answered", tells: "the token is sent", group: "API Handlers" },
          ],
        },
      ],
    }),
  );

  const loaded = store.get("a3f8c21b9e4d5f60");

  assert.deepEqual(loaded?.approved, ["src/api/users.ts"]);
  assert.equal(loaded?.groups[0]?.name, "API Handlers");
});

/** The thrown shape every corrupt-session test wants, with the file's own key. */
function corruptWith(fragment: RegExp): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof ReviewError &&
    error.code === "session_corrupt" &&
    error.message.includes("a3f8c21b9e4d5f60") &&
    fragment.test(error.detail ?? "") &&
    (error.suggestions ?? []).some((line) => line.includes("a3f8c21b9e4d5f60.json"));
}

/** Writes `body` over the session file the other tests in here use. */
function writeRaw(dir: string, body: unknown): void {
  writeFileSync(join(dir, "sessions", "a3f8c21b9e4d5f60.json"), JSON.stringify(body));
}

/**
 * `rounds` was the only field checked, so a half-written grouping came back as
 * a `SessionRecord` and blew up as a raw `TypeError` in the first reader.
 */
test("a session file with no grouping reports session_corrupt, not a TypeError", () => {
  const dir = stateDir();
  const store = new SessionStore(dir);
  store.save(sessionRecord());
  const withoutGroups: Partial<SessionRecord> = sessionRecord();
  delete withoutGroups.groups;
  writeRaw(dir, withoutGroups);

  assert.throws(() => store.get("a3f8c21b9e4d5f60"), corruptWith(/groups/));
});

test("a session file with a group that has no files reports session_corrupt", () => {
  const dir = stateDir();
  const store = new SessionStore(dir);
  store.save(sessionRecord());
  writeRaw(dir, {
    ...sessionRecord(),
    groups: [sessionRecord().groups[0], { name: "Auth", rationale: "tokens" }],
  });

  assert.throws(() => store.get("a3f8c21b9e4d5f60"), corruptWith(/files/));
});

test("a corrupt session file reports session_corrupt instead of vanishing", () => {
  const dir = stateDir();
  const store = new SessionStore(dir);
  store.save(sessionRecord());
  writeFileSync(join(dir, "sessions", "a3f8c21b9e4d5f60.json"), "{ truncated");

  assert.throws(
    () => store.get("a3f8c21b9e4d5f60"),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "session_corrupt" &&
      error.message.includes("a3f8c21b9e4d5f60"),
  );
});
