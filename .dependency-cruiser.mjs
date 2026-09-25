// Module boundaries eslint cannot see, because they are about the import graph
// rather than one file: `pnpm arch` cruises src/, scripts/ and bin/ and fails on
// any `error` below. Only production code is cruised — tests may import
// anything — so a rule's `from` never has to exempt test/.

/**
 * Modules outside src/commands/ that still import from it, from before the
 * rule existed. Listed so the rule blocks the next one; an entry is retired
 * by moving what it imports below commands/ (as start-call.ts was) and then
 * deleting it here — never by adding to this list.
 */
const COMMANDS_KNOWN_EXCEPTIONS = [
  // HELP_START, HELP_WAIT, HELP_END and TURN_RULE from home.ts,
  // DEFAULT_PATH_LIMIT from approvals.ts — the skill quotes the CLI's own text.
  "^src/skill\\.ts$",
  // turnHelp from home.ts: a refused move answers with the same help the
  // commands print.
  "^src/server/handlers-turn\\.ts$",
  "^src/server/handlers-stream\\.ts$",
];

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "no-circular",
      comment:
        "A cycle means neither module can be read, tested or moved without the other; put the shared part in a lower module.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "server-internals-only-via-server",
      comment:
        "src/server/ is the HTTP server's inside; everything else reaches it through src/server.ts, so its handlers can change freely.",
      severity: "error",
      from: { pathNot: ["^src/server\\.ts$", "^src/server/"] },
      to: { path: "^src/server/" },
    },
    {
      name: "no-test-imports-in-production",
      comment:
        "test/ is not shipped or built; production code that imports it breaks the moment it runs outside a clone.",
      severity: "error",
      from: {},
      to: { path: "^test/" },
    },
    {
      name: "commands-only-from-cli",
      comment:
        "src/commands/ is the CLI's top layer; core code that imports it inverts the layering and is how the old import cycles formed.",
      severity: "error",
      from: { pathNot: ["^src/cli\\.ts$", "^src/commands/", ...COMMANDS_KNOWN_EXCEPTIONS] },
      to: { path: "^src/commands/" },
    },
  ],
  options: {
    // test/ is followed no further than the offending import: tests may import
    // anything, and their own imports are not production edges.
    doNotFollow: { path: ["node_modules", "^test/"] },
    // bin/ loads the built bundle, which is not source and may not exist yet.
    exclude: { path: ["^dist/"] },
    tsConfig: { fileName: "tsconfig.json" },
    // Type-only imports count: a cycle through `import type` still couples the
    // two modules for every reader, even though the compiler erases it.
    tsPreCompilationDeps: true,
  },
};
