# lightspeed

Semantic diff review with targeted agent feedback.

An agent opens a review of a branch; a human reads the grouped diff in the
browser, selects the exact lines that are wrong and writes a comment. The agent
polls, receives the comment together with the selected code, and fixes it.

## Quickstart

Three commands, from nothing to a review the browser opens on:

```sh
# 1. install the command, and the skill for the agent you use
git clone https://github.com/JakobKrummeich/lightspeed-review.git
./lightspeed-review/install.sh --agent pi # or claude-code, codex, opencode, vscode

# 2. in a repository you want reviewed, say which model groups its diffs
cd ~/your-repo
lightspeed init --config                  # writes .lightspeed.conf.json — put a real model in it

# 3. open a review of a branch
lightspeed start your-branch main --intent "why this branch exists"
```

**Restart your agent after step 1.** Skills are scanned when an agent starts, so
a session that is already running cannot see the file that was just written —
in pi, `/reload` does it without leaving the session.

`start` prints a URL and opens it. You read the grouped diff, select the lines
that are wrong and comment; the agent picks the comments up with
`lightspeed poll your-branch main`, which blocks in the foreground until you
send. Everything below is detail.

## Install

Not published to any registry — the npm package is called `lightspeed-review`
(the plain name is taken) and the command it installs is `lightspeed`. Clone it
once and install the clone globally:

```sh
git clone https://github.com/JakobKrummeich/lightspeed-review.git
./lightspeed-review/install.sh --agent pi
lightspeed --help
```

`--agent <id>` also writes that agent's skill where the agent reads it, which is
the [Agents](#agents) section done for you; `LIGHTSPEED_AGENT=pi ./install.sh`
is the same thing without an interactive command line. Left out, nothing is
guessed and no skill is written: every agent reads a different file, so an
install for the wrong one writes a document nothing loads and still looks like
it worked. The script prints the line to run next instead.

`install.sh` is `npm install -g .` with the three things worth remembering built
in: it installs the clone's dependencies first, because the `prepare` script
that builds `dist/` needs them (so nothing built is checked in); the global
command it leaves behind is a link into the clone, so keep the clone where it
is; and it falls back to a `~/.local` prefix when npm's global one is
root-owned, rather than asking for a sudo. To upgrade: `git pull &&
./install.sh`.

(`npm i -g github:…` fails on npm 11 — it runs `prepare` before it installs the
dev dependency that builds the bundle. Install from a clone, or from a tarball
made with `npm pack`.)

Requires Node >= 22.18 and a `.lightspeed.conf.json` in the repo root of every
repository you review, which is the next section.

Sessions and the feedback ledger live in `~/.lightspeed` — state left behind by
the old `lightspeed-review` name is moved there on first run.

Agents learn the commands from `skills/lightspeed/SKILL.md`, which is generated
from the CLI's own help by `pnpm run build:skill`.

## Configuration

`.lightspeed.conf.json` belongs in the root of every repository you review, not
in lightspeed's own checkout: it says which model reads that repository's diffs
and where the request is sent, so it is committed alongside the code it reviews
and whoever reviews the repo can see both. No key defaults from the
environment — a `${VAR}` inside a provider's `apiKey` or headers is the one
thing read from it — and `model` and `thinking` have no defaults at all, because
a required knob that defaults silently is one nobody notices they are using.
The shape of the file is checked when it loads, before diff or model work: a
missing file is `config_missing`, and an unknown key, a wrong type or an
out-of-range value is `config_invalid` naming the key, so a typo decides nothing
quietly. The exception is the two `providers` rules that depend on what pi-ai
ships, which cannot be known until a model is resolved; they are described with
`providers` below.

This repository is the one exception to its own advice: its `.lightspeed.conf.json`
is git-ignored and `.lightspeed.conf.example.json` is committed in its place.
Whoever works on lightspeed reviews it with their own model, and often through a
local proxy that is a dead port on every other machine — committing one
checkout's file would hand every contributor a config that fails. Copy the
example and edit it. A repository whose config names nothing machine-local
should commit it, as the paragraph above says.

| Key           | Default         | Absent means                                                         |
| ------------- | --------------- | -------------------------------------------------------------------- |
| `model`       | none, required  | `config_invalid`: nothing is guessed for you                         |
| `thinking`    | none, required  | `config_invalid`, listing the seven levels                           |
| `port`        | `4388`          | the review server listens on 4388                                    |
| `stateDir`    | `~/.lightspeed` | sessions and the feedback ledger live under `~/.lightspeed`          |
| `feedbackLog` | `on`            | every round is appended to the durable ledger                        |
| `classify`    | none            | files are classified by the built-in rules alone                     |
| `providers`   | none            | Pi's `~/.pi/agent/models.json` providers layer over pi-ai's builtins |

`model` is `<provider-id>/<model-id>`, written exactly as pi writes the pair.
The provider id is one pi-ai ships — `anthropic`, `openai`, `google`,
`github-copilot`, `openrouter` and some thirty more — or one this file defines
under `providers`; the model id is that provider's own, and no id is invented
here. `pi --list-models [search]` prints the pairs your install can reach, so
`pi --list-models haiku` answers `anthropic claude-haiku-4-5`; a provider you
built yourself is in no such list, and its id is the `model.id` you wrote for it
from its own documentation.

A pair nothing resolves is `pi_model_unknown` — and it does not fail the review,
because grouping is the only thing the model is used for: the round comes back
as one `All Changes` group whose reason, printed by `start`, is the rule that
was broken and not the pair you wrote — for a model id, that `model` must be
`<provider>/<model-id>`, e.g. `anthropic/claude-sonnet-4-5`. So a wrong model id
costs a reading order rather than a review, and a diff of one file never notices
at all, because that one skips the model. `start --model <name>` overrides the
configured model for a single run, which is how to try one without editing the
file.

`thinking` is pi's own `ModelThinkingLevel` and not a boolean: `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`, handed to pi-ai as written. No thinking
is **`off`**, not `none` — `none` is `config_invalid` listing the seven — and
`off` is the one level that sends no reasoning parameter with the request.

`port` is where the review server listens, on `127.0.0.1` and nowhere else: a
review is read on the machine that runs it. It must be 1-65535. A review server
of lightspeed's own already listening there is reused rather than replaced, and
`serve` pointed at it says `server_already_running`; a port some other process
holds is `port_unavailable` rather than a silent second choice, because a
reviewer following a URL to the wrong port learns nothing from it. `stateDir`
holds `sessions/` and `feedback/`, and expands a leading `~/` or a bare `~` and
nothing else — a tilde further along the path is a literal character.
`feedbackLog` is `on` or `off`; `off` writes no ledger at all and changes
nothing else about a review.

`classify` names the files this repository knows something about that no general
rule could. Lightspeed classifies every changed file twice over: `mechanical` is
bulk with nothing to decide — a rename git scored 100% identical, a
whitespace-only reformat, a file whose own banner says a generator wrote it,
documentation, styling and translation catalogues — and `guardrail` is a file
whose change is never bulk: shell and PowerShell scripts, anything under
`.github/`, `.circleci/`, `.husky/` or `.githooks/`, dependency manifests and
their lockfiles, Dockerfiles, compose files, Makefiles and Terraform. Guardrail
wins: a deploy script whose whole change is re-indentation is still a deploy
script, and a lockfile is guardrail however it was generated. The two marks go
on the inventory line the grouping model reads, which already ranks scripts,
hooks and dependencies high and quarantines mechanical change last.

The built-in rules key on what git reports and on language-agnostic filename
classes only, so they say the same thing in a Rails app and in a Go service and
nothing about any one repository. Yours is what `classify` is for: two lists of
globs that **add** to those rules and never replace them.

```json
"classify": { "mechanical": ["docs/api/**"], "guardrail": ["app/payments/**"] }
```

`**` crosses directory separators, `*` stops at one, and everything else is
literal — a glob is matched against the file's path from the repository root.
Either list may be left out. An empty string is `config_invalid`, like every
other value that would look configured and decide nothing. A glob under
`mechanical` cannot downgrade a guardrail file, by the same rule that makes
guardrail win over the built-ins.

`groupingThreshold` was a key once. It is still accepted and ignored — nothing
reads it, it is only kept off the unknown-key list: every diff of two files or
more is grouped by the model, so it decides nothing, and an upgrade must not
fail on a config that still names it.

The smallest config that reviews anything:

```json
{ "model": "anthropic/claude-haiku-4-5", "thinking": "off" }
```

A fuller one, naming every key but a provider entry:

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "thinking": "medium",
  "port": 4388,
  "stateDir": "~/.lightspeed",
  "feedbackLog": "on",
  "classify": { "mechanical": ["docs/api/**"], "guardrail": ["app/payments/**"] }
}
```

Provider setup follows Pi on this machine. Repository `.lightspeed.conf.json`
`providers` are the highest layer. Under them, Pi's `~/.pi/agent/models.json`
adds providers, endpoints, model definitions, and headers; Pi's stored/runtime
credentials win over its `models.json` `apiKey`, which is a fallback before the
provider environment. Pi headers always resolve and merge with credential and
model headers. Thus a repository may deliberately override a Pi endpoint, while
Pi's local models and credentials never need copying into repository config.
Expiring OAuth tokens are refreshed and written back to Pi's `auth.json` like
any other Pi client would.

```sh
pi auth login anthropic          # or: export ANTHROPIC_API_KEY=…
```

Without either, `start` **fails** with `pi_auth_missing` rather than
reviewing an ungrouped diff — an unconfigured provider is an unfinished install,
not a bad day for the model, and one big group is exactly the failure grouping
exists to prevent. Every other model failure still degrades to that one group,
because a review beats no review.

### Providers behind a proxy or a gateway

Lightspeed reads Pi's `~/.pi/agent/models.json` directly at request setup. Its
provider objects stay Pi-shaped: `baseUrl`, `apiKey`, `headers`, `models`, and
model definitions are applied without copying credentials into a repository.
This includes custom providers and model-level headers. Pi configuration is
machine-local; it is never written to, logged, or merged into
`.lightspeed.conf.json`.

The optional repository `providers` key is a higher-precedence override. Each
entry uses the existing Lightspeed shape — a single `model: {...}` instead of
Pi's `models: [...]` because a repository override resolves one review model.
Use it only when this repository must route differently from the user's Pi
configuration.

```jsonc
{
  "model": "corp-gateway/gpt-5",
  "thinking": "medium",
  "providers": {
    // A provider pi-ai ships, pointed somewhere else: `baseUrl`, `apiKey` and
    // `headers` only. Its models, its api and its name stand, so a `model`
    // written here is refused instead of quietly deciding nothing.
    "anthropic": { "baseUrl": "http://localhost:3001" },

    // A provider pi-ai has never heard of, built from this entry alone:
    // `api`, `baseUrl` and `model.id` are required, the rest is defaulted.
    "corp-gateway": {
      "name": "Corp LLM gateway",
      "baseUrl": "https://llm.corp.internal/openai",
      "api": "azure-openai-responses",
      "apiKey": "unused-by-the-gateway",
      "headers": { "x-corp-auth": "${CORP_LLM_TOKEN}" },
      "model": { "id": "gpt-5", "reasoning": true, "contextWindow": 200000, "maxTokens": 16384 },
    },
  },
}
```

`api` is one of `anthropic-messages`, `openai-completions`, `openai-responses`,
`azure-openai-responses`, `google-generative-ai` — an allowlist, so a typo is
`config_invalid` at load rather than a failed request later. So is an unknown
key, a wrong type, an id that is no provider id, an empty `baseUrl` or `apiKey`,
a header name that is no HTTP token, and a header value with a line break in it.
The comments and trailing commas above are for reading this page: the file
itself is parsed as strict JSON, and either one makes it unparseable.

Which of the two shapes an entry is, only pi-ai's own list of builtins knows, so
those two rules are the ones the load cannot apply. `name`, `api` or `model` on
a builtin id, and a provider pi-ai has never heard of that is missing `api`,
`baseUrl` (its own or its `model`'s) or `model.id`, are refused at the first
model call — which is the grouping call, so the round degrades to one
`All Changes` group carrying the refusal as its reason, like any other model
failure. The entry is never used either way; the difference is that this one
costs a reading order rather than the run.

`${VAR}` is expanded in `apiKey` and in header values, and nowhere else: this
file is committed to the repository under review, so it names the variable a
secret lives in, never the secret. An unset variable fails the load, naming
both the variable and the provider. No error message repeats an expanded key or
header value — a `baseUrl` it does name, because a request that failed against a
proxy is undebuggable without it.

For a provider pi-ai ships, repository `providers.apiKey` wins. Otherwise Pi
uses a stored/runtime credential before `models.json` `apiKey`; that configured
value supports Pi's `$NAME`, `${NAME}`, `$$`, `$!`, and `!command` syntax, then
falls back to provider environment handling. Pi provider headers use the same
syntax and always merge with credential and model headers. A gateway that reads
its secret from a header is happy with a dummy key, or none.

## Agents

Any of the five supported coding agents is onboarded with one command:

```sh
lightspeed init --agent claude-code                  # for this machine
lightspeed init --agent claude-code --scope project  # for this repository only
```

It writes the integration instructions — printed in the dialect that agent
expects — into the file that agent actually reads, creating the directory on the
way. These are the destinations, and they are read out of the same table the
command writes by, so `lightspeed init --help` cannot disagree with them:

| Agent       | Machine-wide (default)                     | `--scope project`                    |
| ----------- | ------------------------------------------ | ------------------------------------ |
| pi          | `~/.pi/agent/skills/lightspeed/SKILL.md`   | `.pi/skills/lightspeed/SKILL.md`     |
| Claude Code | `~/.claude/skills/lightspeed/SKILL.md`     | `.claude/skills/lightspeed/SKILL.md` |
| Codex       | `~/.codex/AGENTS.md`                       | `AGENTS.md`                          |
| opencode    | `~/.config/opencode/AGENTS.md`             | `AGENTS.md`                          |
| VS Code     | none — Copilot reads instructions per repo | `.github/copilot-instructions.md`    |

pi's skill directory is `~/.pi/agent/skills/`, not `~/.pi/skills/`; a README
older than this one said the latter, which pi does not scan, so the skill it
told you to write was never loaded. `lightspeed init --agent vscode` without
`--scope project` fails rather than invent a machine-wide file for it.

**Skills are scanned when an agent starts.** A session that is already running
will not see a skill written under it, however correct the path — restart the
agent, or run `/reload` in pi. This is the step that makes a working install
look like it did nothing.

`init` is safe to re-run and says what it did: `written`, `updated` or
`unchanged`. pi and Claude Code get a file of their own, replaced whole. Codex,
opencode and VS Code get a marked block inside an instructions file they share
with everything else you tell them:

```
<!-- lightspeed:start -->
…
<!-- lightspeed:end -->
```

A re-run refreshes what is between the markers and leaves the rest of the file
alone, so upgrading never appends a second copy. `--dry-run` reports what would
change and writes nothing.

`--config` drops a starter `.lightspeed.conf.json` into the current directory and
refuses to overwrite one that is already there. It needs no `--agent`, because
the two are separate jobs: a skill has five possible destinations and no safe
default, a config has exactly one place to go. `lightspeed init --config` on its
own is the right command in a repository whose agent already has the skill.

pi and Claude Code get the SKILL.md format, frontmatter and all — the same
document `pnpm run build:skill` checks in; the other three get plain markdown.

### Writing the file yourself

`lightspeed skill --agent <id>` prints the same document to stdout and writes
nothing, for a path `init` does not know about:

```sh
mkdir -p ~/.pi/agent/skills/lightspeed && lightspeed skill --agent pi > ~/.pi/agent/skills/lightspeed/SKILL.md
mkdir -p .claude/skills/lightspeed && lightspeed skill --agent claude-code > .claude/skills/lightspeed/SKILL.md
mkdir -p ~/.codex && lightspeed skill --agent codex >> ~/.codex/AGENTS.md
mkdir -p ~/.config/opencode && lightspeed skill --agent opencode >> ~/.config/opencode/AGENTS.md
mkdir -p .github && lightspeed skill --agent vscode > .github/copilot-instructions.md
```

The `>>` rows append with no markers around them, so re-running one of those
appends a second copy — which is what `init` exists to stop.

## For agents

Hand this to a coding agent working in a repository that does not have
lightspeed set up yet. It needs no interpretation:

```
Set lightspeed up in this repository. These are two separate jobs; do both.

1. The config, which this repository needs: run `lightspeed init --config`.
   If it reports `config.status: written`, open `.lightspeed.conf.json` and replace
   the `<provider/model>` placeholder with a real `provider/model` pair — `pi --list-models`
   prints the ones this machine can reach. If it reports `exists`, leave the file alone.
2. The skill, which you need, and only if you do not already have one: run
   `lightspeed init --agent <your agent: pi | claude-code | codex | opencode | vscode>`.
   Add `--scope project` if it should live in this repo rather than on the machine.
   Skip this step entirely if `lightspeed start` is already something you know how to run.
3. If step 2 wrote a skill, tell me to restart you (or run `/reload` if you are pi).
   Skills are scanned at startup, so you cannot use the one you just wrote until then.
4. Then open a review with:
   `lightspeed start <branch> <base> --intent "<why this branch exists>"`
   then `lightspeed poll <branch> <base>` in the foreground — it blocks until I send
   feedback, so do not background it and do not wrap it in a timeout.
```

Credentials are agent-independent: the model named in `.lightspeed.conf.json`
is paid for with an API key or proxy (`providers` above, or the provider's own
environment variable), with pi's own `~/.pi/agent/auth.json` — picked up
automatically — or with a subscription via `lightspeed login <provider>`
(`anthropic` · `openai-codex` · `github-copilot`), run by a human, once per
machine.

## Grouping

What the model is told about order: the group carrying the stated intent opens
the review, cause comes before consequence, a contract before its uses, and a
new dependency, a security-critical change or a git hook ranks high and above
the tests in every case — where such a group sits against the intent is the
model's to judge. Each group's `rationale` is one short sentence saying
what that group's change does, a primer under the name; it is never a question
and never the name again in longer words. Nor does it address the reviewer: a
sentence that asks him something, orders him to do something or calls him
`you` is sent back for one repair round, because a chapter that asks
"does this look right?" has handed the reading back to the person it was
supposed to brief.

Each group also carries a `tier`. `study` is a chapter to read; `sweep` is one
with nothing in it to decide — every file marked mechanical on the inventory
and no guardrail file among them — and the review sinks those below the
chapters to study, where the survey files them under a rule of their own and
the whole lane is approved in one press instead of a file at a time. The model
names the tier and `src/llm/reading-tier.ts` may only raise it: a chapter
holding a guardrail file is `study` whatever came back, and so is the `Tests`
chapter. Raising only is what keeps a wrong tier cheap — it costs reading time,
never an unread change.

The sinking happens once, in the `groups` array (`trailSweeps` in
`src/group-tier.ts`, run after the tier is settled and again on any grouping
that reaches the server or the session store from elsewhere), and no renderer
sorts for itself: the header bar, the survey, "Chapter n of m", Previous/Next
and the chapter a finished one moves on to all name a chapter by its position
in that array, so a swept chapter that is second on the bar and last in the
survey is not a thing the review can say.

One rule survives the model either way: tests trail. Whatever grouping comes
back — and the fallback group too — every test file is pulled into a single
`Tests` group at the end, because a test read before the code it covers is a
puzzle. Told to do this the model still pairs each source file with its own
test, so `src/llm/tests-last.ts` does it, and it knows the conventions of the
languages people write in: `.test.` and `.spec.` files and `__tests__/`,
`OrderServiceTests.cs` and `Orders.Tests.Unit/`, `service_test.go`,
`test_service.py` and `conftest.py`, `src/test/java/…` and
`OrderServiceTest.java`, `OrderSpec.groovy`, `order_spec.rb`, `mesh_test.cc`,
`OrderTest.php`, and `test/` or `tests/` in any language. Rust's `#[cfg(test)]`
unit tests live inside the file they cover, so no path can find them and none is
claimed. Every rule matches a whole path segment or a named extension, so
`src/testing/harness.ts`, `contest/`, `latest/`, `packages/e2e/src/server.ts`,
`OpenApiSpec.cs` and `TestData/fixtures.json` stay production code: exiling a
file the reviewer must read costs more than missing a test. Each convention
carries the paths it must claim and the paths it must not, and the tests iterate
them, so a convention cannot be listed without being exercised.

A one-file diff is the exception, and stays one `All Changes` group: it is
reported as `skipped` because there is nothing to order, and ordering it anyway
would contradict that. So does a degraded grouping of nothing but tests —
pulling the tests out of it would leave the group behind them empty.

## Commands

| Command                                             | Purpose                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `lightspeed start <branch> [base] --intent "<why>"` | Extract the diff, group it, open the review page                                                                     |
| `lightspeed poll [branch] [base]`                   | Block until the reviewer sends feedback                                                                              |
| `lightspeed approvals [branch] [base]`              | Name the files behind poll's counts: approved, swept, unapproved — the first 50 of each list, `--full` for every one |
| `lightspeed end [branch] [base]`                    | Close the session from the agent side                                                                                |
| `lightspeed stop`                                   | Shut the background review server down                                                                               |
| `lightspeed feedback [sub]`                         | Read the feedback ledger: summary, list, show, prune                                                                 |
| `lightspeed init --agent <id>`                      | Write one agent's integration instructions where it reads them                                                       |
| `lightspeed skill --agent <id>`                     | Print one agent's integration instructions — see [Agents](#agents)                                                   |
| `lightspeed serve`                                  | Run the review server in the foreground — `start` spawns it for you                                                  |
| `lightspeed login <provider>`                       | Sign in to a subscription provider — a human, in their own terminal                                                  |
| `lightspeed logout <provider>`                      | Drop lightspeed's stored credential for one provider                                                                 |

Every command prints TOON on stdout — failures included, as
`error: {code, message, detail}` plus `help[]`. The one exception is `skill`,
whose stdout is the markdown document itself; its failures are still TOON.

## Intent

`start` requires `--intent`, repeatable. The agent that opens the review is the
only party that knows why the branch exists, and a reviewer who does not know
what a change is _for_ cannot tell a mistake from a decision:

```sh
lightspeed start feature-auth main \
  --intent "replace session cookies with signed tokens" \
  --intent "drop the legacy /login handler"
```

The reasons render above the diff, in the order given, and go to the grouping
model as the strongest signal it gets. They belong to the round, so the next
`start` can state different ones without disturbing what is already approved.
Omitting the flag fails with `intent_missing` before any git or model work.

## Rounds

`start` is meant to be re-run after every round of fixes, and each run appends a
round to the session. A file the reviewer ticked approved in an earlier round
arrives in the next one **already ticked and dimmed**, and only while its blob
sha proves the text has not moved since — edit it and the tick is gone, and the
file says **changed after approval** so the reviewer knows their own verdict was
withdrawn by the edit. Every file the reviewer wrote a comment on in the round
before says **commented last round**, so the answer they came back to read is
visible from the file row rather than only from the conversation beside it. Un-ticking is the same authority the other way: take a
tick off and the file is unapproved from that moment, in the next round as much
as in this one. All of this holds however the previous round was left — sending
feedback, ending the review or just re-running `start` all carry the ticks
forward. A file the round has no blob sha for is never carried, because the
round cannot prove the text stood still: a binary file has no sha in its patch,
and neither has a rename git found 100% identical, whose patch is a `rename
from`/`rename to` pair and no `index` line. Git knows the second one's sha and
would name it under `--raw`, so that one is a gap in what lightspeed asks for.

Approval never reorders the review. A tick still collapses the file it was given
to, and the group with it once every file in it is ticked — there is nothing left
in them to read — but nothing moves: a file sits where its group put it, and a
group where the grouping put it, for the whole round. A review that rearranged
itself between one look and the next cost the reviewer the place they were
reading. The page opens as an index — every group with its file count, its
±lines and how much of it is approved — with every group collapsed until the
reviewer opens one. The index names no entry point of its own: where to start is
the reviewer's call. The grouping model is told nothing about what the reviewer
approved: it orders the diff, and the diff is the same diff either way.

The review does not start over each round either. Every round after the first
hands the model the grouping it returned last time — the group names, their
order and their files, as the reviewer read them — and asks it to hold that
reading order wherever the diff still supports it: a new file goes in the group
it belongs to, a group whose files are gone is dropped, and a group is renamed
or added only where the change has made the old one false. Nothing enforces it
in code; the grouping is still the model's, and a round that genuinely turned
the change into a different change is allowed to say so. What it buys is that a
reviewer coming back for round three recognises the review they left, instead of
re-learning the map to find the hunk they asked about. The memory is never paid
for out of the diff: the prompt sizes its inventory and patches first, and the
grouping gets whatever is spare above a floor of 20,000 characters of patch, up
to a ceiling of 10,000 for the whole section, heading included. What does not
fit is cut at a group boundary and says how many groups and files were left out,
and where nothing is spare the section is not sent at all — the diff is the
thing under review and it wins the budget every time.

Only a round a model actually grouped is handed back. A round that degraded —
provider down, three invalid replies, or a one-file diff — is a single `All
Changes` group holding everything, and every round records which it was, so that
catch-all is never fed back as the order the reviewer read: one flaky round
would otherwise flatten the review for good, since a group containing every file
is one the next round can always claim to be preserving. The round after a
degraded one starts over with no memory, which is the right way round — there
was nothing in that round's order for the reviewer to learn.

A file that says **changed after approval** carries its own switch, and nothing
else does — **commented last round** is a note about where the reviewer was
looking, not a verdict, and asks for no second view. **Branch diff** is the ordinary one and what the file opens on;
**Since approval** shows only what the agent did to that file after the tick —
the head commit of the round the reviewer approved it in against the head commit
of this one — and nothing else: why the agent did it is the conversation panel's
answer, in its own place. Without it, re-reading a file whose approval an edit
undid means reading every line of it again to find the lines that are new.

The second view is asked for when it is pressed, not shipped with the page, and
it lasts as long as the page does: a reload or a new round opens on the branch
diff again, because a new head commit is a different question. Feedback is off
in it, and it says so — those line numbers are not the branch diff's, which is
where a comment is anchored. When there is no diff to show, the view says which of
the reasons it is rather than showing nothing: the file was changed and changed
back, one of the versions is binary, a rebase took one of the commits away, the
review is too old to have recorded them, or the patch is too large to render —
in which case it hands over the `git diff` that produces it, naming every name
the file has been through.

## Feedback ledger

Every round, comment and agent reply is also appended to a durable, append-only
ledger under `<stateDir>/feedback/YYYY-MM.jsonl` (default
`~/.lightspeed/feedback/`), together with the code it was about. It is
local, shared by every repository you review, and never uploaded — later an
agent mines it for the patterns this reviewer keeps asking for.

Read it back with `feedback`. It is the one command that needs neither a git
repository nor `model`/`thinking` in the config — the ledger spans repositories
and a mining agent reads it from anywhere; `--repo .` is the only part that
needs a repository to point at:

```sh
lightspeed feedback                                   # summary + verdict counts
lightspeed feedback list --repo . --since 30d         # TOON items, oldest first
lightspeed feedback list --since 30d --format jsonl   # raw JSONL for bulk ingest
lightspeed feedback show <id>                         # one item, patch and context in full
lightspeed feedback prune --before 2025-12-01 --dry-run # what a prune would delete
lightspeed feedback prune --before 2025-12-01         # delete old records, for good
```

Nothing is ever deleted on its own: `prune` is manual, needs an explicit
`--before`, and reports every month file it deletes or rewrites, how many
records and feedback items went, and the date range they covered. `--dry-run`
prints that exact report and touches nothing.

Each item is self-contained — path, commits, selected code, comment, verdict —
so it still makes sense with the repository under review moved or deleted. A bare
`list` is deliberately cheap: the oldest 20 items within a 50000-byte budget,
with the round patch and the copied code context left out. `--limit`,
`--max-bytes` and the printed cursor lift the caps, `--with-patches` brings the
two bulk fields back, `show <id>` has everything for one item, and every
omission or byte-budget cut is marked and counted. `--format jsonl` and
`--format md` print raw text a pipe reads whole, so they stay uncapped unless
you pass those flags yourself.

### Verdicts

When the next `start` opens a round on the same branch, every earlier comment is
judged against what the agent actually did — the diff between the two rounds'
head commits, whether the reviewer marked the file again, and whether they
ticked it approved. That judgement is the item's `verdict`:

| Verdict     | What happened                                                                    |
| ----------- | -------------------------------------------------------------------------------- |
| `addressed` | The file changed between the rounds, or the reviewer approved it as it stands    |
| `ignored`   | Nothing changed and nobody approved it                                           |
| `repeated`  | The reviewer marked the same file again in a later round                         |
| `unknown`   | Not judged yet, or the commits are gone (a rebase or force-push) — never a guess |

A comment is re-judged on every later round, so a verdict reflects the whole
review, not just the round after it. `feedback list --verdict repeated` is the
shortest path to what this reviewer has had to say twice.

`start` prints where it writes and whether it is healthy. Switch it off with:

```json
{ "model": "anthropic/claude-haiku-4-5", "thinking": "off", "feedbackLog": "off" }
```

A ledger failure never fails a review: it is reported as
`ledger: {status: degraded, reason}` and the round continues.

## Review page

- The first round of a review is handed over before it is shown: a cover saying
  how many reasons there are, then one sheet per `--intent`, then the review.
  One press moves on, `Esc` skips the rest, and either way it is over — the
  wrapper opens once per review, never on a later round, never on a round that
  stated no reason, and never on a review that has ended.
- The page opens on the survey and nothing else: what the change is for, and
  under it the chapters the model grouped the diff into. No diff is drawn
  there. Pressing a chapter opens it alone, and that is where the lines are
  read.
- Grouped, unified diff by default; a per-session toggle switches to
  side-by-side above 1400px.
- Select lines, comment, send. The agent sees the selection verbatim.
- Renames say what they came from and how much of the file survived.
- The heaviest added branching in the review is marked **densest logic**, on the
  file row and on the group in the index. Branching a change only re-adds counts
  for nothing — a reindented or renamed block scores zero, however many `if`s it
  touches — and no swept chapter carries the badge: the lane is the part of the
  survey the page has already said not to read.
- A reload keeps the work: the queued feedback pills, the comment you were
  halfway through typing, the chapter you were reading, which files you had
  open in it and where you had scrolled to. Sending the queue is what clears
  it. A new round does not put you
  back where you were in the diff it replaced — that diff is gone — but it does
  keep anything you have not sent yet.

## Judging the grouping prompt

Ground truth here is the reviewer, recorded in
`test/fixtures/grouping-reviewer-verdicts.json`: two blind rounds, the same diff
in two layouts with the sides shuffled and nothing saying which came from the
model. Six votes, six for the model's grouping over the hand-written fixture.
So the fixtures below are **recorded past groupings, not gold** — they are how a
change is noticed, not what makes one right.

`pnpm run grade:grouping` scores a grouping against a recorded one, over
fixtures built from this repository's own history (`test/fixtures/grouping/`) —
including a formatting-only change and a rename-heavy one, the cases the prompt
has never seen. Two numbers, because one hides the difference between wrong
groups and right groups in the wrong order: the adjusted Rand index for the
grouping, Kendall tau over reading position for the order. Three guards need no
human fixture at all — no group opens with a test and then shows the code it
covers, the mechanical group is last, and the first group touches a file the
stated intent names.

The index is adjusted for chance because the unadjusted version was measured
against answers that took no thought, and lost: putting every file in one group
scores pairwise f1 0.54 on these fixtures, better than any grouping the model
has produced for them. Every run therefore prints those reference groupings
next to the score, and the score itself with its run-to-run spread.

Scores are printed, never asserted: a fixture's grouping is one defensible
reading order out of several, and the reviewer picked against it every time it
was put to him. `node scripts/record-grouping-replies.ts
[--samples N]` runs the configured model over every fixture three times and
saves the answers under `test/fixtures/grouping/replies/`; those replies are
committed, so a prompt edit is judged against a recorded baseline rather than a
memory of one. Three times because two runs of one prompt on one diff differ by
about half of what a shippable improvement is worth.

The current run, `anthropic/claude-haiku-4-5` with thinking off, 3 replies for
each of 8 fixtures: grouping **ARI 0.55**, ordering **tau 0.66**, against 0.36 /
0.62 before `trailTests` put every test in one final group. The remaining
distance to the fixtures is mostly the model splitting finer than they do —
which is the part the reviewer said he preferred.

`pnpm run judge:grouping` answers the question the counting cannot. A stronger
model reads the diff and two layouts of it, blind, and says which it would
rather review by — every pair judged twice with the labels swapped, and a
fixture whose verdict follows the label counted as undecided rather than as half
a win. One group per file is judged too, as calibration: a judge that cannot
reject it is a judge whose other verdicts mean nothing. A verdict is cached
under the content hash of the grouping it was cast on, so re-recording the
replies retires every verdict about them instead of serving them as current —
which is what the cache did once, for 48 verdicts, until the key learnt what it
was keying on. `verdicts/` is empty for that reason: the groupings those
verdicts read no longer exist.

Both automatic instruments have been caught disagreeing with the reviewer.
Counting ranked a regular-expression split of source from tests above the model;
the judge takes the model over both thoughtless layouts 8 out of 8, but lands on
the hand-written fixture where the reviewer chose the model, 0 for 6. Neither is
a verdict on quality. **Read both as regression detectors** — something changed,
go look — and settle quality with a blind round in front of the person the tool
is for.

`docs/grouping-experiments.md` is the log: five prompt variants, none beating
the shipped prompt by more than noise over ~350 calls, the measurement that
turned out to be the thing worth fixing, and the votes that ended the search.
