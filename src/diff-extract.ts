import { execFileSync } from "node:child_process";
import { ReviewError } from "./errors.ts";
import { startCall } from "./commands/home.ts";
import type { GroupTier } from "./group-tier.ts";

/**
 * `copied`: git's `-C` found the file's text mostly in another file that is
 * still there (`copy from`/`copy to`). Like `renamed` it carries `previousPath`
 * and `similarity`; unlike a rename its source keeps its own history, so
 * `src/rounds/history.ts` follows `previousPath` only for renames.
 */
export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "binary";

/**
 * One `@@ … @@` region kept as the exact bytes git wrote (`header` = the `@@`
 * line, `body` = everything to the next hunk): reassembly from parsed fields
 * would be a claim about the patch, not the patch. Lines end in newlines except
 * at end of patch. Cut on demand by `splitHunks`, never stored on `DiffFile` —
 * hunks double the session JSON (measured: 502,672 bytes → 1,003,911).
 */
export interface DiffHunk {
  header: string;
  body: string;
  /** Counted over this hunk's lines alone, so the hunks partition the file's totals. */
  insertions: number;
  deletions: number;
}

export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  /**
   * Unified diff for this file alone, header included; empty for binary files.
   * The one copy of the patch: per-hunk consumers ask `splitHunks`, not a second copy.
   */
  diff: string;
  insertions: number;
  deletions: number;
  /** True when the diff is big enough that the browser should lazy-render it. */
  oversized: boolean;
  /** Rename or copy source; the old version of the file lives under this name. */
  previousPath?: string;
  /** git's rename/copy similarity (0-100): `98% identical` is skim vs re-read. */
  similarity?: number;
}

/** Group order is the ARRAY position — the LLM returns an ordered array, no `order` field. */
export interface DiffGroup {
  name: string;
  /** One sentence of what happened in this group: the primer under its name. */
  rationale: string;
  /**
   * How this chapter is meant to be read (`src/group-tier.ts`). Optional because
   * sessions written before tiers existed have none, and every reader takes an
   * absent tier as `study` — see `isSweep`.
   */
  tier?: GroupTier;
  files: DiffFile[];
}

/** Aggregates precomputed for the CLI so an agent never has to sum rows itself. */
export interface DiffStats {
  files_changed: number;
  insertions: number;
  deletions: number;
  binary_skipped: number;
}

export interface ExtractedDiff {
  files: DiffFile[];
  stats: DiffStats;
  /**
   * Merge base (old side) and branch tip (new side). Carried so the browser can
   * read whole files out of git instead of guessing around a hunk.
   */
  baseCommit: string;
  headCommit: string;
  /**
   * Subjects of the commits the branch adds, newest first. Corroborate the
   * agent's stated intent, never replace it.
   */
  commits: string[];
}

export const OVERSIZED_LINE_COUNT = 10_000;

/** Reads the merge-base diff (`git diff base...branch`) for a repository. */
export function extractDiff(repoRoot: string, branch: string, base: string): ExtractedDiff {
  const files = parseDiff(runGitDiff(repoRoot, branch, base));
  return {
    files,
    stats: diffStats(files),
    // Removed lines come from the merge base (`base...branch`), not `base`'s tip.
    baseCommit:
      git(repoRoot, ["merge-base", base, branch]) ??
      git(repoRoot, ["rev-parse", `${base}^{commit}`]) ??
      "",
    headCommit: git(repoRoot, ["rev-parse", `${branch}^{commit}`]) ?? "",
    commits: branchCommitSubjects(repoRoot, branch, base),
  };
}

/** `base..branch`: the commits this branch adds, not the ones both share. */
function branchCommitSubjects(repoRoot: string, branch: string, base: string): string[] {
  const log = git(repoRoot, ["log", "--format=%s", `${base}..${branch}`]);
  return log === undefined ? [] : log.split("\n").filter((subject) => subject !== "");
}

/**
 * A git command whose failure is not worth failing the review over — and whose
 * complaint is not worth printing either: an inherited stderr writes prose in
 * front of the TOON an agent is parsing, for a failure this function has
 * already decided to swallow.
 */
function git(repoRoot: string, args: string[]): string | undefined {
  try {
    return (
      execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export function diffStats(files: DiffFile[]): DiffStats {
  return {
    files_changed: files.length,
    insertions: files.reduce((total, file) => total + file.insertions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    binary_skipped: files.filter((file) => file.status === "binary").length,
  };
}

/**
 * `--histogram`: anchors hunks on rare lines so an inserted block reads as one.
 * `-M40% -C40%`: renames and copies reported whatever the user's `diff.renames`
 * says, paired down to 40% similar rather than git's default 50%. A file moved
 * to another directory has its imports re-pointed on the way, and with a test
 * id renamed or a hook generalised on top it scored 43–49% — under the default,
 * so the review showed it twice, as a deleted file and an added one. 40% is the
 * lowest threshold at which every extra rename pair in the user's real history
 * was a true move; from 30% down, CSS modules and boilerplate start pairing
 * with strangers. Copies share the number — git keeps one score for both, and a
 * bare `-C` after `-M40%` resets it to 50% (measured, git 2.43) — so keeping
 * `-C` means `-C40%`, measured too: over 30+ ranges of that history, 40%
 * instead of 50% paired 8 more copies. 6 were templates
 * (`FacilitatorIntentHandler.cs → ParticipantIntentHandler.cs` 40%,
 * `SubmitValueSelectionCommand.cs → Reassign/Reopen/SubmitGroupWorkCommand.cs`
 * 49%, `useAdvancePhaseButton.ts → useIntentSender.ts` 49%) and 2 strangers,
 * both CSS modules sharing boilerplate (`SelectionResultsView.module.css →
 * Eyebrow.module.css` 45%, `LanguageSwitcher.module.css → ValueTabs.module.css`
 * 48%). A stranger costs the reviewer one switch to the whole-file view, which
 * every `copied` file offers (pinned in `test/browser/diff-view.test.ts`), and
 * that is cheaper than losing the six.
 * `--full-index`: rounds compare `index` shas to tell edited from untouched;
 * abbreviated width is git's choice (repo size, `core.abbrev`), so two rounds
 * could name one object differently — the full sha never varies.
 */
const DIFF_ARGS = ["diff", "--histogram", "-M40%", "-C40%", "--full-index"];

/** `base...branch`: everything the branch added since the two last agreed. */
function ref(base: string, branch: string): string {
  return `${base}...${branch}`;
}

/**
 * `stdio` is explicit because the default inherits stderr: git wrote its own
 * three-line complaint to the terminal while we reported the same failure as
 * TOON on stdout, so an agent capturing `2>&1` — the common case — parsed
 * `fatal: ...` prose ahead of the answer. The complaint is captured, not
 * silenced: its first line is the diagnosis, and it goes in `detail`.
 */
function runGitDiff(repoRoot: string, branch: string, base: string): string {
  try {
    return execFileSync("git", [...DIFF_ARGS, "--no-color", ref(base, branch)], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new ReviewError({
      code: "git_ref_not_found",
      message: `git could not diff ${base}...${branch}`,
      detail: firstLine(error),
      suggestions: [
        `Check both refs exist: \`git rev-parse ${branch}\` and \`git rev-parse ${base}\``,
        `Then re-run \`${startCall(`${branch} ${base}`)}\``,
      ],
    });
  }
}

/**
 * Git's first line says what is wrong; the lines under it are the hint it gives
 * a human at a terminal ("Use '--' to separate paths from revisions"), which
 * costs an agent tokens to re-read the `help[]` it already has.
 */
function firstLine(error: unknown): string {
  const said = String((error as { stderr?: unknown }).stderr ?? (error as Error).message).trim();
  return said.split("\n")[0]?.trim() ?? said;
}

/** Splits a unified diff into one entry per file. */
export function parseDiff(diff: string): DiffFile[] {
  return splitFileSections(diff).map(parseFileSection);
}

function splitFileSections(diff: string): string[] {
  const sections: string[][] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) sections.push([line]);
    else sections.at(-1)?.push(line);
  }
  return sections.map((lines) => lines.join("\n"));
}

function parseFileSection(section: string): DiffFile {
  const lines = section.split("\n");
  const isBinary = lines.some(
    (line) => line.startsWith("Binary files ") || line.startsWith("GIT binary patch"),
  );
  const counts = countChangedLines(lines);
  const previousPath = readPreviousPath(lines);
  const similarity = readSimilarity(lines);
  return {
    path: readPath(lines),
    ...(previousPath === undefined ? {} : { previousPath }),
    ...(similarity === undefined ? {} : { similarity }),
    status: readStatus(lines, isBinary),
    diff: isBinary ? "" : section.replace(/\n+$/, ""),
    insertions: isBinary ? 0 : counts.insertions,
    deletions: isBinary ? 0 : counts.deletions,
    oversized: lines.length > OVERSIZED_LINE_COUNT,
  };
}

/**
 * The whole shape identifies a hunk header, not the opening `@@`: excludes
 * combined-diff `@@@` headers and anything malformed. Content that is itself a
 * patch can't match — inside a hunk every line carries a marker column, shifting
 * its `@@` one right.
 */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * Cuts a patch into header + hunks as byte-for-byte slices: concatenating
 * `header` and each hunk's `header`+`body` reproduces the input. A 100%-identical
 * rename is all header; a binary file is nothing. Combined diffs (`@@@`) come
 * back whole in `header` with no hunks — nothing dropped, so "no hunks" never
 * means lines went missing. Counting reuses `countChangedLines` so per-hunk
 * numbers add up to the per-file ones, undercount included.
 */
export function splitHunks(diff: string): { header: string; hunks: DiffHunk[] } {
  const lines = diff.split("\n");
  const starts = lines.flatMap((line, index) => (HUNK_HEADER.test(line) ? [index] : []));
  return {
    header: region(lines, 0, starts[0] ?? lines.length),
    hunks: starts.map((start, nth) => {
      const end = starts[nth + 1] ?? lines.length;
      return {
        header: region(lines, start, start + 1),
        body: region(lines, start + 1, end),
        ...countChangedLines(lines.slice(start + 1, end)),
      };
    }),
  };
}

/**
 * Lines `from`..`to` with joining newlines. A region reaching the patch's end
 * ends bare: `parseFileSection` strips git's trailing newlines between sections.
 */
function region(lines: string[], from: number, to: number): string {
  const text = lines.slice(from, to).join("\n");
  return from >= to || to >= lines.length ? text : `${text}\n`;
}

/**
 * Marker-column counting undercounts on purpose: lines whose content opens with
 * `--`/`++` (`--i;`, a patch of a patch) are excluded with the `---`/`+++` headers,
 * where `--numstat` counts them. Counts are a sense of size only; the real fix is
 * following `@@` ranges, not widening a prefix test. Pinned by the test "a changed
 * line that begins with ++ or -- is counted by neither the file nor its hunks".
 */
function countChangedLines(lines: string[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) insertions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { insertions, deletions };
}

function readStatus(lines: string[], isBinary: boolean): DiffFileStatus {
  if (isBinary) return "binary";
  if (lines.some((line) => line.startsWith("new file mode"))) return "added";
  if (lines.some((line) => line.startsWith("deleted file mode"))) return "deleted";
  if (lines.some((line) => line.startsWith("rename to "))) return "renamed";
  if (lines.some((line) => line.startsWith("copy to "))) return "copied";
  return "modified";
}

/** The pre-image name of a renamed or copied file; undefined for every other file. */
function readPreviousPath(lines: string[]): string | undefined {
  const from = lines.find(
    (line) => line.startsWith("rename from ") || line.startsWith("copy from "),
  );
  return from === undefined ? undefined : unquote(from.slice(from.indexOf("from ") + 5));
}

/** git's own `similarity index 96%`, for a rename or a copy; never a guess of ours. */
function readSimilarity(lines: string[]): number | undefined {
  const line = lines.find((candidate) => candidate.startsWith("similarity index "));
  const percent = line === undefined ? Number.NaN : Number.parseInt(line.slice(17), 10);
  return Number.isNaN(percent) ? undefined : percent;
}

/**
 * Prefers the post-image path (`+++ b/…`, `rename to …`) so renames report their
 * new name; falls back to the `diff --git` header for binary files (no `---`/`+++`).
 */
function readPath(lines: string[]): string {
  const plusLine = lines.find((line) => line.startsWith("+++ ") && line !== "+++ /dev/null");
  if (plusLine) return stripPathPrefix(plusLine.slice(4));

  const renameLine = lines.find((line) => line.startsWith("rename to "));
  if (renameLine) return unquote(renameLine.slice("rename to ".length));

  const minusLine = lines.find((line) => line.startsWith("--- ") && line !== "--- /dev/null");
  if (minusLine) return stripPathPrefix(minusLine.slice(4));

  return headerPostImagePath(lines[0] ?? "");
}

/**
 * `diff --git a/x b/y` → `y`. Binary files have no `+++` line, so this header is
 * the only source for their path. Paths may contain spaces, so the split is on
 * the last ` b/` (or the second quoted token when git quoted the names).
 */
function headerPostImagePath(header: string): string {
  const rest = header.slice("diff --git ".length);
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/);
  if (quoted) return stripPathPrefix(quoted[2] ?? "");
  const separator = rest.lastIndexOf(" b/");
  return stripPathPrefix(separator === -1 ? rest : rest.slice(separator + 1));
}

function stripPathPrefix(token: string): string {
  const path = unquote(token.trim());
  return path.replace(/^[ab]\//, "");
}

/** git wraps paths containing spaces or non-ASCII in C-style quotes. */
function unquote(token: string): string {
  if (!token.startsWith('"')) return token;
  try {
    return JSON.parse(token) as string;
  } catch {
    return token.slice(1, -1);
  }
}
