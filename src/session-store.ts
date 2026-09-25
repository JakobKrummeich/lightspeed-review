import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trailSweeps } from "./group-tier.ts";
import { ReviewError } from "./errors.ts";
import { openCall } from "./start-call.ts";
import { sessionFilePath, sessionsDirPath } from "./paths.ts";

export type * from "./session-types.ts";
import type { DiffGroup } from "./diff-extract.ts";
import type { SessionRecord } from "./session-types.ts";
import { migrateV2 } from "./session-migrate.ts";

/**
 * Timestamps and status transitions belong to the caller, so tests stay
 * deterministic. Only hole-causing fields are checked; retired keys (e.g.
 * `journeys`) are neither errors nor stripped.
 */
function parseSession(contents: string, key: string): SessionRecord {
  let parsed: SessionRecord;
  try {
    parsed = JSON.parse(contents) as SessionRecord;
  } catch (error) {
    throw sessionCorrupt(key, `session ${key} is not readable JSON`, (error as Error).message);
  }
  if (!Array.isArray(parsed.rounds)) {
    throw sessionCorrupt(
      key,
      `session ${key} has no rounds`,
      "it was written before rounds were recorded, so nothing can be said about what was reviewed",
    );
  }
  if (!Array.isArray(parsed.groups) || !parsed.groups.every(readableGroup)) {
    throw sessionCorrupt(
      key,
      `session ${key} has no readable grouping`,
      "its `groups` is missing, or a group in it has no `files`, so there is no review to show",
    );
  }
  // `approvedAtEnd` postdates `rounds`, and `tier` postdates `groups`; both are
  // filled in here so no reader has to ask whether the field is there. A group
  // written before tiers existed opens as `study`: the safe direction for a
  // missing answer is the one that asks for the reading rather than the one
  // that waves it through. Ordered after that default is filled in, never
  // before, since an untiered chapter is one to study and belongs above the bulk.
  return {
    ...migrateV2(parsed),
    groups: trailSweeps(parsed.groups.map((group) => ({ ...group, tier: group.tier ?? "study" }))),
    rounds: parsed.rounds.map((round) => ({ ...round, approvedAtEnd: round.approvedAtEnd ?? [] })),
  };
}

/**
 * Checked here, not at the call site that noticed (`open`): a TypeError out of
 * a session file is a corrupt session however spelt, with the same
 * delete-the-file answer.
 */
function readableGroup(group: unknown): boolean {
  return typeof group === "object" && group !== null && Array.isArray((group as DiffGroup).files);
}

function sessionCorrupt(key: string, message: string, detail: string): ReviewError {
  return new ReviewError({
    code: "session_corrupt",
    message,
    detail,
    suggestions: [
      `Delete \`sessions/${key}.json\` in your state directory and re-run \`${openCall("<branch> [base]")}\``,
    ],
  });
}

export class SessionStore {
  readonly #stateDir: string;
  readonly #directory: string;

  constructor(stateDir: string) {
    this.#stateDir = stateDir;
    this.#directory = sessionsDirPath(stateDir);
  }

  get(key: string): SessionRecord | undefined {
    let contents: string;
    try {
      contents = readFileSync(sessionFilePath(this.#stateDir, key), "utf8");
    } catch {
      return undefined;
    }
    return parseSession(contents, key);
  }

  list(): SessionRecord[] {
    let entries: string[];
    try {
      entries = readdirSync(this.#directory);
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) =>
        parseSession(readFileSync(join(this.#directory, entry), "utf8"), entry.slice(0, -5)),
      );
  }

  save(record: SessionRecord): void {
    mkdirSync(this.#directory, { recursive: true });
    const target = sessionFilePath(this.#stateDir, record.key);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    renameSync(temporary, target);
  }

  remove(key: string): void {
    rmSync(sessionFilePath(this.#stateDir, key), { force: true });
  }
}
