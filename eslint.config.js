import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    // A unit past seven branches no longer fits in one head, and a function
    // past sixty content lines no longer fits on one screen — both mean the
    // reader must hold state the code should be holding. Files get 300 content
    // lines before they are doing more than one job. Tests are exempt: their
    // "branches" are optional-chained assertions, not control flow, and their
    // length is table-driven repetition, not tangling.
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    rules: {
      complexity: ["error", 7],
      "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Three files run past 300 lines by breadth, not depth: many small,
    // individually documented units of one kind (config validators, ledger
    // record builders, export renderers). Splitting them would scatter one
    // catalog across files and add a navigation hop to every lookup without
    // removing a single branch. They stay whole, and they stay listed here so
    // the next 300-line file has to argue its case in this comment.
    files: ["src/config.ts", "src/ledger/records.ts", "src/ledger/export.ts"],
    rules: { "max-lines": "off" },
  },
  {
    files: ["scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    // `src/browser/dom/**` is the half of the browser code that touches a real
    // DOM: it is typed against lib.dom by tsconfig.browser.json, excluded from
    // the main project, and bundled for the page. Everything else — the server
    // included — may import the rest of `src/browser/`, which is pure rendering,
    // but importing this is a type error waiting to be a runtime one. Its own
    // modules and its tests are exempt; nothing else has business here.
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    ignores: ["src/browser/dom/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/browser/dom/*", "**/browser/dom/**", "./dom/*", "./dom/**"],
              message:
                "src/browser/dom/** is DOM-only and bundled for the page: keep shared logic in" +
                " src/browser/ or src/ so the server can import it.",
            },
          ],
        },
      ],
    },
  },
);
