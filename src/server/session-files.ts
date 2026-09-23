/** Every read here is gated by the paths the session's grouping lists (`gitPathOf`). */
import {
  MAX_APPROVED_FORM_BYTES,
  type ApprovedForm,
  type ApprovedFormData,
} from "../rounds/approved-form.ts";
import { readDiffBetween, readFileAtCommit } from "../git-file.ts";
import type { AnnotationSide } from "../ledger/records.ts";
import type { SessionRecord } from "../session-store.ts";

export function readSessionFile(
  session: SessionRecord,
  path: string,
  side: AnnotationSide,
): string | undefined {
  const commit = side === "old" ? session.baseCommit : session.headCommit;
  const gitPath = gitPathOf(session, path, side);
  if (gitPath === undefined || commit === undefined) return undefined;
  return readFileAtCommit(session.repoRoot, commit, gitPath);
}

/**
 * The name git knows a file by, or undefined when this session's grouping does
 * not list it at all — which is what keeps `?path=` from being a read-any-file
 * hole. A rename's old version is stored under the name it had then: the old
 * side of its diff is that file.
 */
export function gitPathOf(
  session: SessionRecord,
  path: string,
  side: AnnotationSide,
): string | undefined {
  const file = session.groups.flatMap((group) => group.files).find((entry) => entry.path === path);
  if (file === undefined) return undefined;
  return side === "old" ? (file.previousPath ?? file.path) : file.path;
}

/**
 * Every way of having no diff is named, never served as an empty patch:
 * "nothing", "nothing knowable" and "never recorded" are three different
 * answers. Decided only here — the page renders what it is told and asks git nothing.
 */
export function approvedFormData(
  session: SessionRecord,
  path: string,
  form: ApprovedForm,
): ApprovedFormData {
  const { fromCommit: from, toCommit: to, paths } = form;
  const answered = { path, paths, from, to };
  // Not "unreachable": the round predates stored commits, and naming a rebase
  // would send the reviewer hunting one that never happened.
  if (from === null || to === null) return { ...answered, state: "unrecorded" };
  const read = readDiffBetween(session.repoRoot, from, to, paths);
  if (read.state !== "patch") return { ...answered, state: read.state };
  const { patch } = read;
  if (patch === "") return { ...answered, state: "identical" };
  if (isBinaryPatch(patch)) return { ...answered, state: "binary" };
  // Bytes, not characters: the number is shown to the reviewer as kB, and one
  // line of prose in a non-ASCII language is longer on disk than in memory.
  const bytes = Buffer.byteLength(patch, "utf8");
  if (bytes > MAX_APPROVED_FORM_BYTES) return { ...answered, state: "oversize", bytes };
  return { ...answered, state: "diff", diff: patch };
}

/**
 * git says "no lines to show" in words, not by omission; either wording means a
 * version is not text — including a file that was text when approved.
 */
function isBinaryPatch(patch: string): boolean {
  return /^(Binary files .* differ|GIT binary patch)$/m.test(patch);
}
