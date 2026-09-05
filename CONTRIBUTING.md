# Contributing

## Setup

```sh
pnpm install
cp .lightspeed.conf.example.json .lightspeed.conf.json   # only to review this repo with lightspeed itself
```

Node >= 22.18. Tests and the CLI run TypeScript sources directly, so there is
nothing to build before working; `dist/` is built by `pnpm run build` and is not
checked in.

## The gate

All five have to pass before a change lands, and CI runs exactly these:

```sh
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run format:check
pnpm run build:skill --check
```

The last one is the one people forget: `skills/lightspeed/SKILL.md` is generated
from the CLI's own `help[]` strings, so changing help text means running
`pnpm run build:skill` and committing the regenerated file with it.

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
