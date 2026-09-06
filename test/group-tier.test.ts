import { test } from "node:test";
import assert from "node:assert/strict";
import { isSweep, trailSweeps, type GroupTier } from "../src/group-tier.ts";

/**
 * A chapter as the ordering reads it: a name to check the result by, and a
 * tier. Nothing else, because nothing else decides where a chapter goes.
 */
interface Chapter {
  name: string;
  tier?: GroupTier;
}

function chapter(name: string, tier?: GroupTier): Chapter {
  return tier === undefined ? { name } : { name, tier };
}

function namesOf(groups: Chapter[]): string[] {
  return groups.map((group) => group.name);
}

test("the chapters to study keep their order, and the swept ones follow in theirs", () => {
  const ordered = trailSweeps([
    chapter("Renames", "sweep"),
    chapter("Auth", "study"),
    chapter("Docs", "sweep"),
    chapter("Billing", "study"),
  ]);

  assert.deepEqual(namesOf(ordered), ["Auth", "Billing", "Renames", "Docs"]);
});

test("a review with nothing swept comes back in the order it arrived", () => {
  const groups = [chapter("Auth", "study"), chapter("Billing", "study")];

  assert.deepEqual(namesOf(trailSweeps(groups)), ["Auth", "Billing"]);
});

test("a review that is nothing but bulk comes back in the order it arrived", () => {
  // Nothing to sink it below, and the lane's own order is the grouping's.
  const groups = [chapter("Renames", "sweep"), chapter("Docs", "sweep")];

  assert.deepEqual(namesOf(trailSweeps(groups)), ["Renames", "Docs"]);
});

test("a chapter that never named a tier is studied, so it stays ahead of the bulk", () => {
  // The same reading `isSweep` gives it: a session written before tiers existed
  // is read chapter by chapter, and none of its chapters belongs in the lane.
  const groups = [chapter("Renames", "sweep"), chapter("Old"), chapter("Auth", "study")];

  assert.deepEqual(namesOf(trailSweeps(groups)), ["Old", "Auth", "Renames"]);
  assert.equal(isSweep(chapter("Old")), false);
});

test("the chapters themselves are handed back untouched: only their places move", () => {
  const bulk = chapter("Renames", "sweep");
  const auth = chapter("Auth", "study");

  const ordered = trailSweeps([bulk, auth]);

  assert.equal(ordered[0], auth);
  assert.equal(ordered[1], bulk);
});

test("no group is lost or duplicated, however the tiers fall", () => {
  const groups = [
    chapter("Renames", "sweep"),
    chapter("Auth"),
    chapter("Docs", "sweep"),
    chapter("Billing", "study"),
  ];

  const ordered = trailSweeps(groups);

  assert.equal(ordered.length, groups.length);
  assert.deepEqual([...namesOf(ordered)].sort(), [...namesOf(groups)].sort());
});

test("ordering twice changes nothing the first pass did not", () => {
  // Every boundary that takes groups from somewhere else runs this, so the
  // second run of it on the same review has to be the identity.
  const groups = [chapter("Renames", "sweep"), chapter("Auth", "study")];
  const once = trailSweeps(groups);

  assert.deepEqual(namesOf(trailSweeps(once)), namesOf(once));
});
