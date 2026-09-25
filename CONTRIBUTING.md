# Contributing

## Setup

```sh
pnpm install
cp .lightspeed.conf.example.json .lightspeed.conf.json   # only to review this repo with lightspeed itself
```

Node >= 22.19. Tests and the CLI run TypeScript sources directly, so there is
nothing to build before working; `dist/` is built by `pnpm run build` and is not
checked in.

`pnpm install` also points git at `.githooks/` (`core.hooksPath`), unless a
hooks path is already set — then run `git config core.hooksPath .githooks`
yourself if you want the hook. Its pre-commit hook runs prettier over the staged
files and re-stages them, so `format:check` never fails a commit over whitespace.
A file with unstaged changes as well is committed exactly as staged and left
unformatted — formatting it would sweep the unstaged hunks into the commit — and
the hook says so. It never blocks a commit; CI is the gate.

## The gate

All of these have to pass before a change lands, and CI runs exactly these:

```sh
pnpm run typecheck
pnpm run lint
pnpm run test:coverage
pnpm run format:check
pnpm run build:skill --check
pnpm run dup
pnpm run arch
pnpm audit --prod --audit-level=high
```

`pnpm run check` runs all but the tests and the audit in one go. The no-mistakes
gate (`.no-mistakes.yaml`) runs `test:coverage` and `check`.

- `test:coverage` is the whole suite with coverage floors for `src/` and
  `scripts/` (lines 97%, branches 93%, functions 94% — a point under what the
  suite covered when the floors came in). Plain `pnpm test` runs the same tests
  without coverage, which is quicker while working.
- `dup` is jscpd over `src/`, `scripts/` and `bin/` (`.jscpd.json`), failing past
  1% duplicated lines. Tests are not scanned: spelling each case out in full is
  what makes it readable on its own.
- `arch` is dependency-cruiser over the imports of `src/`, `scripts/` and `bin/`
  (`.dependency-cruiser.mjs`; type-only imports count). No import cycles;
  `src/server/` is imported only through `src/server.ts`; production code never
  imports `test/`; `src/commands/` is the CLI's top layer, imported only by
  `src/cli.ts` and itself. What core code and a command both need lives below
  `commands/` (as `src/start-call.ts` does). The few modules that imported
  `commands/` before the rule are listed in the config as known exceptions, to
  be retired, not added to.
- The audit covers runtime dependencies at high severity and above. It is not a
  gate for the maintenance agent, whose work an unrelated new advisory would
  otherwise block.

`build:skill --check` is the one people forget: `skills/lightspeed/SKILL.md` is
generated from the CLI's own `help[]` strings, so changing help text means
running `pnpm run build:skill` and committing the regenerated file with it.

## Style

Comments say **why**, not what. The code already states what it does; a comment
earns its place by recording the reason a thing is the way it is — the failure
it prevents, the constraint it obeys, the option that was rejected. eslint holds
functions to a complexity of 7 and 60 lines, and files to 300, because a unit
past that is one the reader has to hold in their head instead of read.

Tests go under `test/`, mirroring `src/`. Write the failing test first: a test
that never failed has not been shown to test anything.

## Commits

One descriptive sentence saying what the change is _for_. No
`feat:`/`fix:`/`chore:` prefixes, no ticket numbers, no trailing period.

```
Move isSkillAgent next to the ids it narrows, so a second command can reuse it
Split popup.css out of base.css: the annotation popup and what is typed in
```

Keep them small and focused — one reason per commit, so the log reads as the
history of decisions it is.
