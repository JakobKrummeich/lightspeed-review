import { test } from "node:test";
import assert from "node:assert/strict";
import { withDrift } from "../src/anchor-drift.ts";
import type { SessionRecord, SessionRound } from "../src/session-types.ts";
import type { BatchItem } from "../src/threads.ts";

const R0 = "a".repeat(40);
const R1 = "b".repeat(40);
const BASE = "c".repeat(40);

function round(index: number, headCommit: string | undefined): SessionRound {
  return {
    index,
    at: `2025-01-01T00:0${index}:00.000Z`,
    baseCommit: BASE,
    ...(headCommit === undefined ? {} : { headCommit }),
    files: [],
    approvedAtEnd: [],
  };
}

function session(rounds: SessionRound[]): SessionRecord {
  return { repoRoot: "/repo", rounds } as unknown as SessionRecord;
}

const FILES: Record<string, string> = {
  [`${R0}:greet.ts`]: "a\nb\nc\nd\nexport const shout\n",
  [`${R1}:greet.ts`]: "/** doc */\na\nb\nc\nd\n\nexport const yell\n",
  [`${R0}:same.ts`]: "one\ntwo\n",
  [`${R1}:same.ts`]: "zero\none\ntwo\n",
};
const read = (_repo: string, commit: string, path: string) => FILES[`${commit}:${path}`];

function reply(file: string, line: number, extra: Partial<BatchItem> = {}): BatchItem {
  return {
    id: "t1",
    status: "reply",
    file,
    side: "new",
    line_start: line,
    line_end: line,
    selected_text: "x",
    anchoredIn: 0,
    thread: [],
    reviewer: ["and?"],
    ...extra,
  } as BatchItem;
}

test("an anchor whose line reads differently in the round on show is outdated", () => {
  const [item] = withDrift([reply("greet.ts", 5)], session([round(0, R0), round(1, R1)]), read);

  assert.equal((item as { outdated?: true }).outdated, true);
});

test("an anchor is left alone at the same commit, and a line pushed down by an insert is a changed line", () => {
  const unchanged = reply("same.ts", 1, { line_end: 1 } as Partial<BatchItem>);
  const shifted = withDrift([unchanged], session([round(0, R0), round(1, R0)]), read);
  assert.equal("outdated" in shifted[0]!, false, "same commit");

  // same.ts line 1 was "one" and is now "zero": that is a change, not the same line.
  const moved = withDrift([unchanged], session([round(0, R0), round(1, R1)]), read);
  assert.equal((moved[0] as { outdated?: true }).outdated, true);
});

test("a file gone from the round on show outdates its anchors", () => {
  const nothing = () => undefined;
  const [item] = withDrift([reply("gone.ts", 1)], session([round(0, R0), round(1, R1)]), nothing);
  assert.equal("outdated" in item!, false, "unreadable then: nothing to compare, so no claim");

  const gone = (_repo: string, commit: string) => (commit === R0 ? "x\n" : undefined);
  const [lost] = withDrift([reply("gone.ts", 1)], session([round(0, R0), round(1, R1)]), gone);
  assert.equal((lost as { outdated?: true }).outdated, true);
});

test("nothing is claimed for the round it was drawn in, a resolve, or an unknowable commit", () => {
  const rounds = session([round(0, R0), round(1, R1)]);
  const sameRound = reply("greet.ts", 5, { anchoredIn: 1 } as Partial<BatchItem>);
  const resolved: BatchItem = { id: "t2", status: "resolved", reviewer: [] };
  const general: BatchItem = { id: "t3", status: "new", reviewer: ["hi"] };
  const noHead = session([round(0, undefined), round(1, R1)]);

  assert.deepEqual(withDrift([sameRound, resolved, general], rounds, read), [
    sameRound,
    resolved,
    general,
  ]);
  assert.equal("outdated" in withDrift([reply("greet.ts", 5)], noHead, read)[0]!, false);
  assert.equal("outdated" in withDrift([reply("greet.ts", 5)], session([]), read)[0]!, false);
});

test("a base-side anchor is read against the base commits", () => {
  const seen: string[] = [];
  const spy = (_repo: string, commit: string) => {
    seen.push(commit);
    return "same\n";
  };
  const base = reply("greet.ts", 1, { side: "old" } as Partial<BatchItem>);
  const rounds = session([
    { ...round(0, R0), baseCommit: BASE },
    { ...round(1, R1), baseCommit: "d".repeat(40) },
  ]);

  const [item] = withDrift([base], rounds, spy);
  assert.deepEqual(seen, [BASE, "d".repeat(40)]);
  assert.equal("outdated" in item!, false);
});
