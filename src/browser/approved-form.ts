import { escapeHtml } from "../escape-html.ts";
import type { ApprovedFormData, ApprovedFormState } from "../rounds/approved-form.ts";
import type { DiffRenderer } from "./diff-renderer.ts";

/**
 * The other side of a file's diff switch: what changed since the reviewer last
 * held the file (since approval, or since the last round). Diff plus one line
 * on why it takes no feedback. Pure, like `diff-view.ts`: markup asserted
 * without a DOM.
 */

/**
 * Which diff a file is showing. `branch` (vs the target branch) is the default:
 * a file that changed under the reviewer still has to be reviewed as a whole.
 */
export type FileForm = "branch" | "approved" | "last-round" | "full";

export const DEFAULT_FILE_FORM: FileForm = "branch";

/**
 * The one form annotations may be filed against; a single grep-able name, not
 * a repeated literal. Allowlist on purpose: new forms are unannotatable until
 * someone says otherwise.
 */
export const ANNOTATABLE_FORM: FileForm = "branch";

/**
 * Forms that cost a round trip (everything but the branch diff). The store
 * fetches, caches and repaints these, keyed by this type so a new `FileForm`
 * must declare which side it stands on.
 */
export type FetchedForm = Exclude<FileForm, "branch">;

/**
 * The fetched forms that diff two commits and answer with `ApprovedFormData`;
 * `full` shows one whole version and has no diff states to speak for.
 */
export type ComparisonForm = Exclude<FetchedForm, "full">;

export const BRANCH_OPTION = { form: "branch", label: "Branch diff" } as const;

/** The whole current file, offered on every file that has a new side to show. */
export const FULL_OPTION = { form: "full", label: "Whole file" } as const;

/**
 * The two switch pairs, each starting from the branch diff. Which pair a file
 * carries is `diff-view.ts`'s call; options name what they show, not what
 * pressing does.
 */
export const APPROVED_FORM_OPTIONS: readonly { form: FileForm; label: string }[] = [
  BRANCH_OPTION,
  { form: "approved", label: "Since approval" },
];

export const LAST_ROUND_FORM_OPTIONS: readonly { form: FileForm; label: string }[] = [
  BRANCH_OPTION,
  { form: "last-round", label: "Since last round" },
];

const EVERY_OPTION = [...APPROVED_FORM_OPTIONS, ...LAST_ROUND_FORM_OPTIONS, FULL_OPTION];

/** Narrows a `data-form` attribute, which is text the DOM may have lost. */
export function parseFileForm(value: string | undefined): FileForm | undefined {
  return EVERY_OPTION.find((option) => option.form === value)?.form;
}

export interface ApprovedFormView {
  data: ApprovedFormData;
  renderer: DiffRenderer;
}

/** Shas are shown at git's own short width; the full one is in the payload. */
const SHORT_SHA = 7;

/**
 * Read off the switch options, not written out again: renaming the option must
 * not leave the sentence naming a button that is not there. Fallback unreachable.
 */
const BRANCH_LABEL =
  EVERY_OPTION.find((option) => option.form === ANNOTATABLE_FORM)?.label ?? ANNOTATABLE_FORM;

/**
 * Why annotation is off: fetched views are numbered against other commits,
 * while anchors are numbered against the branch diff — filing one as the other
 * would put a comment on a line nobody looked at.
 */
const NO_FEEDBACK = `Feedback is off in this view: these line numbers are not the branch diff's, and that is where a comment is anchored — press ${BRANCH_LABEL} to leave one.`;

/**
 * Shown while git (a subprocess, not instant) answers. Worded per view:
 * "since you approved" claims a tick the other switch never got.
 */
export const FORM_PENDING: Record<FetchedForm, string> = {
  approved: `<p class="lsr-approved-pending">Reading what changed since you approved this…</p>`,
  "last-round": `<p class="lsr-approved-pending">Reading what changed since the last round…</p>`,
  full: `<p class="lsr-approved-pending">Reading the whole file…</p>`,
};

/** The fetch failed — server gone, or the round moved on under the page. */
export const FORM_UNAVAILABLE: Record<FetchedForm, string> = {
  approved: `<p class="lsr-approved-missing">What changed since you approved this file could not be read. Press Branch diff for the ordinary one.</p>`,
  "last-round": `<p class="lsr-approved-missing">What changed since the last round could not be read. Press Branch diff for the ordinary one.</p>`,
  full: `<p class="lsr-approved-missing">The whole file could not be read — too large to show here, or the branch moved on. Press Branch diff for the ordinary one.</p>`,
};

/** Either comparison view, under the approved form's markup and classes. */
export function renderFetchedForm(form: ComparisonForm, view: ApprovedFormView): string {
  return `<div class="lsr-approved-form">
      ${note(view.data)}
      ${renderBody(form, view)}
    </div>`;
}

/**
 * Only where there is something to select: other states show no line numbers,
 * so a note about wrong line numbers would point at nothing.
 */
function note(data: ApprovedFormData): string {
  if (data.state !== "diff") return "";
  return `<p class="lsr-approved-note">${NO_FEEDBACK}</p>`;
}

function short(commit: string): string {
  return escapeHtml(commit.slice(0, SHORT_SHA));
}

type NoDiffVoice = Record<Exclude<ApprovedFormState, "diff">, (data: ApprovedFormData) => string>;

/**
 * Why there is no diff, one sentence per reason per view. Literal-keyed records
 * so a state added server-side stops compiling here until both views answer it.
 * Voices differ: each sentence may only claim what actually happened (a tick
 * given vs a round read).
 */
const NO_DIFF: Record<ComparisonForm, NoDiffVoice> = {
  approved: {
    identical: () =>
      "This file is byte for byte the form you approved: it was changed in a round in between and changed back.",
    binary: () =>
      "Git has no lines to show for this change: one of the two versions is binary. If the file was text when you approved it, that is itself the change.",
    unreachable: () =>
      "The form you approved cannot be reconstructed: git no longer has one of the two commits, which is what a rebase or a force-push does to a branch.",
    unrecorded: () =>
      "This review recorded no commit for one of the two rounds — it was started before lightspeed stored them — so there is nothing to compare your approval against. Nothing was rewritten.",
    oversize: (data) =>
      `The change since your approval is ${size(data.bytes)} — too large to render here. Read it with \`${gitCommand(data)}\`.`,
  },
  "last-round": {
    // Near-unreachable (switch only offered where blobs prove an edit), but
    // every state the server can name must have its sentence.
    identical: () => "This file is byte for byte what the last round showed.",
    binary: () =>
      "Git has no lines to show for this change: one of the two versions is binary. If the file was text last round, that is itself the change.",
    unreachable: () =>
      "The form the last round showed cannot be reconstructed: git no longer has one of the two commits, which is what a rebase or a force-push does to a branch.",
    unrecorded: () =>
      "This review recorded no commit for one of the two rounds — it was started before lightspeed stored them — so there is nothing to compare the last round against. Nothing was rewritten.",
    oversize: (data) =>
      `The change since the last round is ${size(data.bytes)} — too large to render here. Read it with \`${gitCommand(data)}\`.`,
  },
};

/** The diff, or the plain sentence that says why there is none. */
function renderBody(form: ComparisonForm, view: ApprovedFormView): string {
  const { data } = view;
  if (data.state === "diff") {
    return `<div class="lsr-approved-diff">${view.renderer.renderFile(data.diff ?? "")}</div>`;
  }
  return missing(NO_DIFF[form][data.state](data));
}

function missing(text: string): string {
  return `<p class="lsr-approved-missing">${escapeHtml(text)}</p>`;
}

/**
 * The command the server ran, so the reviewer can rerun it. All historical
 * paths named and renames followed: `git diff` given only today's path prints
 * nothing for a renamed file — the case where this message matters most.
 */
function gitCommand(data: ApprovedFormData): string {
  const paths = data.paths.length > 0 ? data.paths : [data.path];
  return `git diff --find-renames ${short(data.from ?? "")} ${short(data.to ?? "")} -- ${paths.join(" ")}`;
}

/** Sized when git handed the patch over; a patch too big for git itself is not. */
function size(bytes: number | undefined): string {
  if (bytes === undefined) return "larger than git will hand over in one piece";
  return `${Math.round(bytes / 1024)} kB of patch`;
}
