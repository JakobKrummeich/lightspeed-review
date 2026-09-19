import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { ReviewError } from "./errors.ts";

/**
 * Every CLI response is a flat-ish record rendered as TOON. axi-sdk-js keeps
 * its render helpers internal, so this module is our single TOON seam.
 */
export type StructuredOutput = Record<string, unknown>;

export function renderToon(output: StructuredOutput): string {
  return encode(output);
}

/**
 * Cap for one reviewer selection in CLI output, in characters — about fifty
 * tokens. It used to be 2000, which let a single selection cost 372 tokens of a
 * `wait` answer: the selection is a pointer to code the agent has on disk, so
 * enough of it to recognise the passage is all it is for. The reviewer's
 * `comment` is never cut — those are their own words, and the one part of a
 * prompt that exists nowhere else.
 */
export const SELECTION_LIMIT = 200;

/**
 * How many prompts one answer carries. A round the reviewer spent an hour on
 * can queue dozens; handing an agent all of them at once is a context it cannot
 * act on either, and the answer says how many it is holding back.
 */
export const PROMPT_LIMIT = 20;

/**
 * Keeps one reviewer selection from burying a whole `wait` result. The browser
 * always shows the full text; the CLI says how much it held back, where the
 * rest can be read, and how to ask for all of it here.
 */
export function truncateContent(value: string, limit: number, rest: string): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n(truncated, ${value.length} chars — use --full; ${rest})`;
}

const INTERNAL_ERROR_HELP = ["Re-run the command; if it persists this is a lightspeed bug"];

/** Errors go to stdout as TOON: `error: {code, message, detail}` plus `help[]`. */
export function errorOutput(error: unknown): StructuredOutput {
  // A bare AxiError is a validation failure raised through `validationError()`;
  // its code decides the exit status, so it must survive into the payload.
  if (error instanceof AxiError && !(error instanceof ReviewError)) {
    return { error: { code: error.code, message: error.message }, help: error.suggestions };
  }
  if (!(error instanceof ReviewError)) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: { code: "internal_error", message },
      help: INTERNAL_ERROR_HELP,
    };
  }
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    },
    help: error.suggestions,
  };
}

/**
 * A reader that stops early (`lightspeed feedback list | head`) closes the pipe
 * under us, and Node reports that as an unhandled 'error' event on stdout: a
 * stack trace after output that was complete as far as the reader was
 * concerned. Nothing is lost when the pipe closes, so the right answer is to
 * leave quietly; any other stdout failure is still a crash worth seeing.
 */
export function exitQuietlyWhenReaderCloses(
  stream: NodeJS.EventEmitter = process.stdout,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
    exit(0);
  });
}
