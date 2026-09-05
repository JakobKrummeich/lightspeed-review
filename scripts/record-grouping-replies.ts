/**
 * Records a real grouping reply per fixture, so `grade:grouping` has something to
 * score. Each fixture names a commit from this repo's history; the diff is
 * re-extracted (`<commit>^...<commit>`) rather than stored, so extraction changes
 * (rename/move detection) reach the graded prompt instead of freezing in a fixture.
 * Replies land in `test/fixtures/grouping/replies/<name>.json`, `<name>.2.json`…
 * and are committed: the baseline a prompt edit has to beat. Several per fixture
 * because run-to-run spread is about half the size of differences worth shipping —
 * one sample cannot tell an improvement from a re-roll.
 *
 * Usage: `node scripts/record-grouping-replies.ts [--samples N] [fixture-name…]`
 * Requires the configured provider to be authenticated.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { extractDiff } from "../src/diff-extract.ts";
import { groupDiff } from "../src/llm/grouping.ts";
import { REPLY_DIR, loadFixtures, type GroupingFixture } from "./grade-grouping.ts";

const REPO_ROOT = join(import.meta.dirname, "..");

async function record(fixture: GroupingFixture, model: string, sample: number): Promise<void> {
  const suffix = sample === 1 ? "" : `.${sample}`;
  const { files } = extractDiff(REPO_ROOT, fixture.commit, `${fixture.commit}^`);
  const result = await groupDiff({
    files,
    config: loadConfig(REPO_ROOT),
    intents: fixture.intents,
  });
  if (result.mode !== "llm") {
    console.log(`${fixture.name}${suffix}: ${result.mode} — ${result.reason ?? "no reason given"}`);
    return;
  }
  const reply = {
    model,
    recorded: new Date().toISOString().slice(0, 10),
    groups: result.groups.map((group) => ({
      name: group.name,
      rationale: group.rationale,
      ...(group.watch === undefined ? {} : { watch: group.watch }),
      ...(group.tier === undefined ? {} : { tier: group.tier }),
      files: group.files.map((file) => file.path),
    })),
  };
  writeFileSync(
    join(REPLY_DIR, `${fixture.name}${suffix}.json`),
    `${JSON.stringify(reply, null, 2)}\n`,
  );
  console.log(`${fixture.name}${suffix}: ${reply.groups.length} group(s) recorded`);
}

const argv = process.argv.slice(2);
const flag = argv.indexOf("--samples");
const samples = flag === -1 ? 3 : Number(argv[flag + 1]);
const names = flag === -1 ? argv : [...argv.slice(0, flag), ...argv.slice(flag + 2)];

const { model } = loadConfig(REPO_ROOT);
mkdirSync(REPLY_DIR, { recursive: true });
await Promise.all(
  loadFixtures(names).flatMap((fixture) =>
    Array.from({ length: samples }, (_, index) => record(fixture, model, index + 1)),
  ),
);
