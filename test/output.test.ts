import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  errorOutput,
  exitQuietlyWhenReaderCloses,
  renderToon,
  truncateContent,
} from "../src/output.ts";
import { ReviewError, validationError } from "../src/errors.ts";

test("renderToon encodes a record as TOON", () => {
  assert.equal(renderToon({ status: "open", pending: 0 }), "status: open\npending: 0");
});

test("content shorter than the limit is passed through untouched", () => {
  assert.equal(truncateContent("+const user = 1;", 100), "+const user = 1;");
});

test("long content is cut and says how much there was and how to see it all", () => {
  const truncated = truncateContent("x".repeat(50), 10);

  assert.match(truncated, /^x{10}\n\(truncated, 50 chars — use --full\)$/);
});

test("errorOutput nests code, message and detail under error", () => {
  const error = new ReviewError({
    code: "config_missing",
    message: ".lightspeed.conf.json not found in repo root",
    detail: "lightspeed requires explicit `model` and `thinking`",
    suggestions: ["Create .lightspeed.conf.json"],
  });

  assert.deepEqual(errorOutput(error), {
    error: {
      code: "config_missing",
      message: ".lightspeed.conf.json not found in repo root",
      detail: "lightspeed requires explicit `model` and `thinking`",
    },
    help: ["Create .lightspeed.conf.json"],
  });
});

test("errorOutput omits detail when the error carries none", () => {
  const error = new ReviewError({
    code: "config_invalid",
    message: "bad",
    suggestions: ["fix it"],
  });

  assert.deepEqual(errorOutput(error), {
    error: { code: "config_invalid", message: "bad" },
    help: ["fix it"],
  });
});

test("errorOutput renders unexpected non-Review errors as internal_error", () => {
  assert.deepEqual(errorOutput(new Error("boom")), {
    error: { code: "internal_error", message: "boom" },
    help: ["Re-run the command; if it persists this is a lightspeed bug"],
  });
});

test("errorOutput keeps an SDK validation code so an unknown flag still exits 2", () => {
  assert.deepEqual(errorOutput(validationError("unknown flag `--bogus`", ["Run `--help`"])), {
    error: { code: "VALIDATION_ERROR", message: "unknown flag `--bogus`" },
    help: ["Run `--help`"],
  });
});

test("a ReviewError always renders with a help block", () => {
  const output = errorOutput(
    new ReviewError({ code: "config_invalid", message: "bad", suggestions: ["fix it"] }),
  );

  assert.ok(Array.isArray(output.help));
  assert.ok((output.help as string[]).length > 0);
});

test("a reader closing the pipe early ends the process cleanly instead of as a crash", () => {
  const stdout = new EventEmitter();
  const exits: number[] = [];
  exitQuietlyWhenReaderCloses(stdout, (code) => exits.push(code));

  stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

  assert.deepEqual(exits, [0]);
});

test("any other stdout failure still surfaces as the error it is", () => {
  const stdout = new EventEmitter();
  const exits: number[] = [];
  exitQuietlyWhenReaderCloses(stdout, (code) => exits.push(code));

  const failure = Object.assign(new Error("write EIO"), { code: "EIO" });
  assert.throws(() => stdout.emit("error", failure), failure);
  assert.deepEqual(exits, []);
});
