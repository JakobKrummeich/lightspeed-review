import { ReviewError } from "../../errors.ts";
import { renderItems, selectItems } from "../../ledger/export.ts";
import type { StructuredOutput } from "../../output.ts";
import {
  HELP_FORMATS,
  HELP_LIST,
  HELP_PRUNE,
  HELP_SHOW,
  parseArgs,
  rawText,
  readFormat,
  requireStore,
  type FeedbackContext,
} from "./shared.ts";

const SHOW_FLAGS = ["--format"] as const;

/** `show` is the escape hatch from `list`'s omissions: patches always in full. */
export function showFeedback(args: string[], context: FeedbackContext): StructuredOutput | string {
  const parsed = parseArgs(args, SHOW_FLAGS);
  const id = parsed.positional[0];
  if (id === undefined) {
    throw new ReviewError({
      code: "invalid_arguments",
      message: "show needs the item id",
      detail: "ids look like evt_01JQ8Z5K3M_7f2a and come from `feedback list`",
      suggestions: [HELP_LIST, HELP_SHOW],
    });
  }
  const items = selectItems(requireStore(context).read({}).records, {}).items;
  const item = items.find((candidate) => candidate.id === id);
  if (item === undefined) throw itemUnknown(id, items.length);
  const rendered = renderItems([item], { format: readFormat(parsed), withPatches: true });
  if (rendered.format !== "toon") return rawText(rendered.text);
  return { item: rendered.items[0], help: [HELP_LIST, HELP_FORMATS] };
}

function itemUnknown(id: string, available: number): ReviewError {
  return new ReviewError({
    code: "feedback_item_unknown",
    message: `no feedback item with id ${id}`,
    detail: `the ledger holds ${available} item(s); ids come from \`feedback list\``,
    suggestions: [HELP_LIST, HELP_PRUNE],
  });
}
