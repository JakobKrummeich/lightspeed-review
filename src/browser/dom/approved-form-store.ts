/**
 * One round's fetched forms — the since-approval and since-last-round diffs:
 * which files are showing one, and what git has answered for each. Fetches
 * once per file and form, keeps the answer, and repaints only the block it
 * swapped.
 */
import type { DiffGroup } from "../../diff-extract.ts";
import type { ApprovedFormData } from "../../rounds/approved-form.ts";
import {
  FORM_PENDING,
  FORM_UNAVAILABLE,
  parseFileForm,
  renderFetchedForm,
  type ComparisonForm,
  type FetchedForm,
  type FileForm,
} from "../approved-form.ts";
import type { DiffRenderer } from "../diff-renderer.ts";
import { renderFileBody } from "../diff-view.ts";
import { renderFullFile } from "../full-file.ts";
import { highlightFile, type FileHighlight } from "../syntax-file.ts";
import { loadHighlighter } from "../syntax-grammars.ts";
import { languageForPath } from "../syntax-languages.ts";
import { fileBlock } from "./diff-folds.ts";
import { anchored } from "./fold.ts";
import { fetchApprovedForm, fetchFileSide, fetchLastRoundForm } from "./session-api.ts";
import { highlightBlocks } from "./syntax-highlight.ts";

/** What is known about one file's fetched form, before and after the server answers. */
type FormAnswer = "pending" | "failed" | FormPayload;

/**
 * A comparison keeps git's data and renders per layout; the whole file is one
 * final body — highlighted at fetch time, identical in either layout.
 */
type FormPayload =
  { form: ComparisonForm; data: ApprovedFormData } | { form: "full"; body: string };

/**
 * Each fetched form's own endpoint, keyed so the store can hold a press it
 * cannot fetch for — a form missing here does not compile.
 */
const FETCHERS: Record<
  FetchedForm,
  (key: string, path: string) => Promise<FormPayload | undefined>
> = {
  approved: async (key, path) => asComparison("approved", await fetchApprovedForm(key, path)),
  "last-round": async (key, path) =>
    asComparison("last-round", await fetchLastRoundForm(key, path)),
  full: fetchWholeFile,
};

function asComparison(
  form: ComparisonForm,
  data: ApprovedFormData | undefined,
): FormPayload | undefined {
  return data && { form, data };
}

async function fetchWholeFile(key: string, path: string): Promise<FormPayload | undefined> {
  const contents = await fetchFileSide(key, path, "new");
  if (contents === undefined) return undefined;
  return { form: "full", body: renderFullFile(contents, await highlightWhole(path, contents)) };
}

/**
 * Undefined on any miss — unknown language, failed grammar load, a grammar
 * throwing mid-parse — so the view renders plain rather than failing over a
 * missing colour. Highlights the same string the fetch returned; splitting
 * those would break `renderFullFile`'s length-alignment guard.
 */
async function highlightWhole(path: string, contents: string): Promise<FileHighlight | undefined> {
  const language = languageForPath(path);
  if (language === undefined) return undefined;
  try {
    const hljs = await loadHighlighter([language]);
    return hljs && highlightFile(hljs, language, contents);
  } catch {
    return undefined;
  }
}

export interface ApprovedFormStore {
  /** The reviewer pressed one side of a file's diff switch. */
  pick(option: HTMLElement): Promise<void>;
  /** Re-renders every fetched form on show, after a redraw replaced the lines. */
  restore(): void;
  /** Drops every answer and every showing form with the round they were about. */
  forget(): void;
}

export interface ApprovedFormStoreOptions {
  root: HTMLElement;
  key: string;
  /** The grouping the diff is currently drawn from — live, it moves per round. */
  groups(): DiffGroup[];
  /** The renderer of the current layout — live, it moves on a format switch. */
  renderer(): DiffRenderer;
}

export function createApprovedFormStore(options: ApprovedFormStoreOptions): ApprovedFormStore {
  const { root, key } = options;
  /**
   * Answer per file-and-form key: flipping back and forth costs one git
   * subprocess, not one per press. Keyed by both even though a file offers one
   * form per round: an answer must never be served as a view it was not
   * fetched for.
   */
  const answers = new Map<string, FormAnswer>();
  /**
   * Which files show a fetched form. Page-lifetime only: it is a question, not
   * a setting, and a reload should open on the branch diff.
   */
  const showing = new Map<string, FetchedForm>();

  /** One file's diff switch pressed; the rest of the review is untouched. */
  async function pick(option: HTMLElement): Promise<void> {
    const block = option.closest(".lsr-file");
    const path = block instanceof HTMLElement ? block.dataset.file : undefined;
    const form = parseFileForm(option.dataset.form);
    if (path === undefined || form === undefined) return;
    if (form !== "branch") return showFetchedForm(path, form);
    showing.delete(path);
    repaint(key, path, showForm(root, path, "branch", branchBody(options, path)));
  }

  /**
   * The side that costs a round trip: git asked once per file and form, answer
   * kept. A file already being asked about is left alone — the press that
   * started it will paint what comes back.
   */
  async function showFetchedForm(path: string, form: FetchedForm): Promise<void> {
    showing.set(path, form);
    const known = answers.get(answerKey(form, path));
    if (known === "pending") return;
    if (known !== undefined && known !== "failed") {
      repaint(key, path, showForm(root, path, form, fetchedBody(answers, options, path, form)));
      return;
    }
    answers.set(answerKey(form, path), "pending");
    showForm(root, path, form, FORM_PENDING[form]);
    const data = await FETCHERS[form](key, path).catch(() => undefined);
    // Reviewer switched back, or a new round redrew the page, while git
    // answered: keeping the stale answer would serve a later press a diff of
    // the wrong two commits.
    if (showing.get(path) !== form) {
      answers.delete(answerKey(form, path));
      return;
    }
    // Failure remembered only so a redraw does not read as "still loading";
    // pressing again asks once more.
    answers.set(answerKey(form, path), data ?? "failed");
    repaint(key, path, showForm(root, path, form, fetchedBody(answers, options, path, form)));
  }

  return {
    pick,
    restore() {
      // Redrawn from cache in the new layout: a format switch must not take
      // away the view being read. No repaint: the caller repaints the fresh draw.
      for (const [path, form] of showing) {
        showForm(root, path, form, fetchedBody(answers, options, path, form));
      }
    },
    forget() {
      answers.clear();
      showing.clear();
    },
  };
}

/** One key per question asked of the server, which is a path under a form. */
function answerKey(form: FetchedForm, path: string): string {
  return `${form}:${path}`;
}

/**
 * Swaps one file's diff for another form. Only diff and switch change: place,
 * collapse state and tick stay put.
 */
function showForm(
  root: HTMLElement,
  path: string,
  form: FileForm,
  body: string,
): HTMLElement | null {
  const block = fileBlock(root, path);
  if (!block) return null;
  const header = block.querySelector<HTMLElement>(".lsr-file-header");
  // The attribute is what the selection code reads to know these lines are
  // not the branch diff's.
  block.setAttribute("data-form", form);
  for (const option of block.querySelectorAll<HTMLElement>(".lsr-form-option")) {
    option.setAttribute("aria-pressed", String(option.dataset.form === form));
  }
  const diff = block.querySelector<HTMLElement>(".lsr-file-diff");
  // Two forms are two heights, so the swap moves everything below. Anchor on
  // the header: browser scroll anchoring is off wherever this review folds.
  anchored(header === null ? null : { element: header, walk: false }, () => {
    if (diff) diff.innerHTML = body;
  });
  return block;
}

/**
 * Highlights this block and no other: repainting the whole review would merge
 * a second set of spans into already-coloured lines.
 */
function repaint(key: string, path: string, block: HTMLElement | null): void {
  if (!block) return;
  highlightBlocks([block], key).catch(() =>
    console.error(`lightspeed: ${path} is left unhighlighted`),
  );
}

/**
 * One file's fetched form as it stands now. A question still with git reads
 * as pending, not failed.
 */
function fetchedBody(
  answers: Map<string, FormAnswer>,
  options: ApprovedFormStoreOptions,
  path: string,
  form: FetchedForm,
): string {
  const known = answers.get(answerKey(form, path));
  if (known === undefined || known === "pending") return FORM_PENDING[form];
  if (known === "failed") return FORM_UNAVAILABLE[form];
  if (known.form === "full") return known.body;
  return renderFetchedForm(known.form, { data: known.data, renderer: options.renderer() });
}

function branchBody(options: ApprovedFormStoreOptions, path: string): string {
  const file = options
    .groups()
    .flatMap((group) => group.files)
    .find((entry) => entry.path === path);
  return file === undefined ? "" : renderFileBody(file, options.renderer());
}
