# Spec: lightspeed (AXI)

## Objective

An **AXI** (Agent eXperience Interface) CLI for reviewing LLM-agent code changes in the browser. Solves two problems:

1. **Flat file lists in GitLab/GitHub are unreadable for large PRs** — An embedded LLM call groups and orders changed files semantically ("Schema changes", "API handlers", "Tests") so related changes appear together.

2. **Giving targeted feedback to agents is tedious** — User selects any text in the diff (including deleted lines), types feedback in a popup, and it reaches the polling agent with the exact selected text + comment. No verbal file/line description needed.

Built to [AXI principles](https://axi.md): TOON output, contextual disclosure, content-first, structured errors, long-poll feedback.

### User Flow

```
Developer working in TUI with Pi agent:

1. "Show me the MR in lightspeed comparing feature-x to main"

2. Agent: npx lightspeed start feature-x main --intent "<why this branch exists>"
   └─ States the intent — required, repeatable, rendered above the diff
   └─ Extracts git diff
   └─ Spawns Pi (--mode json --no-session) with lightspeed-owned prompts
      → LLM returns semantic groupings
   └─ Opens browser with grouped diff view
   └─ Returns TOON: session key, url, group count, help[] next steps

3. Agent: npx lightspeed poll feature-x main
   └─ Long-polls in the FOREGROUND, blocks until user sends feedback
      (help[] tells the agent never to background it or wrap it in a timeout)

4. User reviews in browser:
   └─ Main area: grouped/ordered diffs, syntax highlighted
   └─ Right column: conversation panel
   └─ Selects text in diff → popup → targeted feedback
   └─ Bottom-right: general comment input + "Send" / "Send & End"

5. User clicks "Send":
   └─ Poll returns TOON feedback: selected text + comments
   └─ Agent fixes code, commits

6. Agent re-attaches: npx lightspeed start feature-x main
   └─ Same session, fresh diff, re-grouped, browser live-updates

7. User clicks "Send & End": final feedback + session closed (≈ approval)
```

## Tech Stack

- **Runtime:** Node.js ≥22.18 (ESM). Native type stripping — `node src/cli.ts` runs TypeScript directly, verified on 22.22.
- **Language:** **TypeScript** (`.ts` sources, `tsc --noEmit` typecheck, no separate runtime step)
- **AXI SDK:** `axi-sdk-js` (MIT) — provides `runAxiCli`, TOON output, structured errors
- **Server:** `node:http` + a ~60-line router (6 routes total). No Express — nothing to learn, zero dep. **D1 decided.** Capability parity confirmed: the annotation popup, selection handling and conversation panel are pure client-side code; the server only serves HTML, JSON and an SSE stream, all of which `node:http` does natively.
- **Diff rendering:** diff2html (MIT) behind adapter interface
- **Browser UI:** Vanilla TS + Tailwind CSS (CDN), no framework
- **LLM:** `@earendil-works/pi-ai` **SDK** (successor to the deprecated `@mariozechner/pi-ai`) — in-process `Context {systemPrompt, messages, tools}` + streaming. No subprocess. Project owns prompts. Pi-only for MVP.
- **Build:** esbuild (bundle to `dist/cli.mjs`)
- **Test:** `node:test` (runs `.ts` test files directly)

## AXI Compliance

| #   | Principle                          | Implementation                                                                                                                |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Token-efficient output**         | All CLI output in TOON via `axi-sdk-js` — except `skill`, whose stdout is the markdown document itself; its errors stay TOON  |
| 2   | **Minimal default schemas**        | Session list: `{branch, base, status, pending}` — 4 fields. `--fields` for more                                               |
| 3   | **Content truncation**             | Diff content truncated in CLI output with `(truncated, N chars — use --full)`. Browser always shows full                      |
| 4   | **Pre-computed aggregates**        | `total_files`, `total_groups`, `files_changed`, `insertions`, `deletions`, `pending_prompts` inline                           |
| 5   | **Definitive empty states**        | `sessions: 0` + explicit `no active sessions` message, never silent empty                                                     |
| 6   | **Structured errors & exit codes** | Errors as TOON on **stdout**, debug on stderr. Exit 0 ok, 1 error, 2 unknown flag. No interactive prompts. `start` idempotent |
| 7   | **Ambient context**                | Ships an installable agent skill. **No session hooks** — YAGNI, dropped                                                       |
| 8   | **Content first**                  | Bare `lightspeed` shows live sessions + `bin: ~/...` + description, not help                                                  |
| 9   | **Contextual disclosure**          | Every output ends with `help[]` next-step command templates                                                                   |
| 10  | **Consistent help**                | `--help` on every subcommand; top-level `--help` lists every command it answers                                               |

## Commands

```bash
# Development
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run lint
pnpm run format:check

# AXI CLI
lightspeed
  # Content-first home view: live sessions, bin path, description, help[]

lightspeed start <branch> [base] --intent "<why>"
  # base defaults to main. Extracts diff → LLM groups → opens browser
  # Idempotent: re-running updates existing session with fresh diff
  # --intent is REQUIRED and repeatable: why the branch exists, written by the
  #   calling agent. Missing → `intent_missing`, exit 2, before any git or LLM work
  # Flags: --intent "<why>", --no-open, --base <ref>, --model <name>, --full

lightspeed poll <branch> [base]
  # Long-polls for feedback. Blocks until Send or Send & End.
  # Runs forever by default: no --timeout-ms, no heartbeat frames (matches lavish-axi).
  # Flags: --agent-reply "..."

lightspeed end <branch> [base]
  # Agent-initiated session end

lightspeed stop
  # Shut down background server

lightspeed login <provider>
  # Human-run OAuth sign-in for subscription providers: anthropic, openai-codex,
  #   github-copilot. Tokens land in <stateDir>/auth.json, mode 600, never echoed;
  #   pi's auth.json is never written. TTY-guarded: refused without a terminal,
  #   because an agent must never run it

lightspeed logout <provider>
  # Delete lightspeed's own stored credential; reports whether an entry was
  #   removed. pi's auth.json is never touched

lightspeed skill --agent <id>
  # Print the integration instructions in the dialect one coding agent expects;
  #   redirect stdout into the file that agent reads. --agent defaults to pi.
  #   pi → .pi/skills/lightspeed/SKILL.md (repo) or ~/.pi/skills/… (machine)
  #   claude-code → .claude/skills/lightspeed/SKILL.md or ~/.claude/skills/…
  #   codex → append to AGENTS.md
  #   opencode → append to AGENTS.md
  #   vscode → .github/copilot-instructions.md
  # The one command whose stdout is markdown, not TOON — it is a document
  #   generator. Errors are still TOON; unknown id → invalid_arguments, exit 2
```

### Session Identity (multi-session)

Session key = `sha256(repoRoot + ":" + branch + ":" + base).slice(0,16)`.

Every command takes `<branch> [base]` explicitly — same pattern as lavish's `<html-file>`. This makes multiple concurrent sessions unambiguous (different repos, different branch pairs).

**Convenience:** if `<branch>` omitted and exactly one active session matches cwd repo, use it. Ambiguous → structured error listing candidates.

## Output Examples (TOON)

### Home view (content first)

```
bin: ~/.local/bin/lightspeed
description: Semantic diff review with targeted agent feedback
sessions[2]{branch,base,status,pending}:
  feature-auth,main,open,0
  fix-billing,develop,feedback,3
help[3]:
  Run `lightspeed start <branch> [base]` to open a review session
  Run `lightspeed poll <branch> [base]` to wait for reviewer feedback — run it in the foreground and let it block; never background it or wrap it in a timeout
  Run `lightspeed end <branch> [base]` to close a session
```

### Empty state (definitive)

```
bin: ~/.local/bin/lightspeed
description: Semantic diff review with targeted agent feedback
sessions: 0
message: no active review sessions
help[1]:
  Run `lightspeed start <branch> [base]` to open a review session
```

### start (aggregates + disclosure)

```
session:
  key: a3f8c21b9e4d5f60
  branch: feature-auth
  base: main
  intents[1]:
    replace session cookies with signed tokens
  url: http://127.0.0.1:4388/session/a3f8c21b9e4d5f60
  status: open
diff:
  files_changed: 23
  insertions: 847
  deletions: 213
  binary_skipped: 2
groups[4]{name,files}:
  Database Schema,3
  API Handlers,8
  Auth Middleware,5
  Tests,7
help[2]:
  Run `lightspeed poll feature-auth main` in the foreground to wait for reviewer feedback; it blocks until they send, so do not background it or add a timeout
  Reviewer selects diff text and sends targeted comments; poll returns them
```

### poll (feedback)

One list only. The earlier duplicated `prompts[]` summary + `annotations[]` detail block is gone — it was redundant.

```
status: feedback
ended: false
prompts[3]:
  - type: annotation
    file: src/api/users.ts
    group: API Handlers
    selected_text: |
      +  const user = await db.user.create({
      +    data: { name, email },
      +  });
    comment: Wrap this in a transaction
  - type: annotation
    file: src/billing/legacy.ts
    group: Cleanup
    selected_text: |
      -  const oldFunction = (x) => x * 2;
    comment: Why removed? Billing still needs it
  - type: message
    comment: Overall good, fix the transaction issue
help[2]:
  Address the feedback, commit, then run `lightspeed start feature-auth main` to show updated diff
  Run `lightspeed poll feature-auth main --agent-reply "<summary>"` in the foreground to reply and keep reviewing
```

### Structured error (stdout, exit 1)

```
error:
  code: config_missing
  message: .lightspeed.conf.json not found in repo root
  detail: lightspeed requires explicit `model` and `thinking`
help[2]:
  Create .lightspeed.conf.json with {"model": "<provider/model>", "thinking": "off"}
  Then re-run `lightspeed start feature-auth main`
```

## Project Structure

```
src/
  cli.ts                → AXI entry: runAxiCli wiring, command routing
  commands/
    home.ts             → Content-first home view
    start.ts            → Diff + LLM group + open browser
    poll.ts             → Long-poll feedback
    end.ts              → End session
  config.ts             → Loads .lightspeed.conf.json, fail-fast validation
  diff-extract.ts       → Git diff extraction + stats
  llm/
    pi-client.ts        → @earendil-works/pi-ai SDK wrapper (Context, stream)
    providers.ts        → Configured providers: builtin overrides + custom ones
    prompts.ts          → System + user prompt templates (project-owned)
    schema.ts           → Typebox schema for grouping output + validator
    grouping.ts         → diff → LLM → validate → repair loop → DiffGroup[]
  server.ts             → node:http: UI, feedback API, poll, SSE
  router.ts             → Tiny method+path router (~60 lines)
  session-store.ts      → JSON state (~/.lightspeed/)
  html-template.ts      → Review page HTML
  output.ts             → TOON builders, help[] composition
  paths.ts              → State dir, port, host
  skill.ts              → Generated agent skill content
src/browser/
  chrome.ts             → Conversation panel, send/end, presence
  diff-view.ts          → Group rendering, collapsible sections, approved checkboxes
  diff-renderer.ts      → Renderer adapter interface
  diff2html-adapter.ts  → MVP renderer
  annotation.ts         → Text selection → popup → queue
  chrome.css
test/
  ...mirrors src/
  fixtures/
skills/
  lightspeed/    → Installable agent skill
bin/
  lightspeed.js
```

## Code Style

```ts
import { AxiError } from "axi-sdk-js";

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "binary";

export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  diff: string;
  insertions: number;
  deletions: number;
}

/** Group order is the ARRAY position — the LLM returns an ordered array, no `order` field. */
export interface DiffGroup {
  name: string;
  rationale: string;
  files: DiffFile[];
}
```

- camelCase functions/vars, PascalCase types, kebab-case files
- Node built-ins → npm deps → local imports
- Throw `AxiError` with structured code, never swallow
- No classes except stores

## LLM Integration

### Config — file, not env

No environment variables. Config lives in `.lightspeed.conf.json` at the **repo root**, committed or gitignored per team choice. Env vars and silent defaults are opaque; required knobs must be visible upfront.

```jsonc
{
  "model": "anthropic/claude-sonnet-4-5", // REQUIRED — no default, no fallback
  "thinking": "off", // REQUIRED — Pi's own ModelThinkingLevel
  "port": 4388, // optional, default 4388
  "stateDir": "~/.lightspeed", // optional, default ~/.lightspeed
  "feedbackLog": "on", // optional, default on
  "providers": {}, // optional, see below — absent means pi-ai's builtins, untouched
}
```

#### `providers` — where a provider actually lives

Each key is a pi provider id, and each entry uses pi's own `models.json` keys
(`name`, `baseUrl`, `api`, `apiKey`, `headers`), so an entry can be pasted
across from a pi config. The one deliberate difference: pi's `models: [...]`
array is a single `model: {...}` here, because a review resolves exactly one
model.

```jsonc
{
  "model": "corp-gateway/gpt-5",
  "thinking": "medium",
  "providers": {
    // A: a provider pi-ai ships, pointed somewhere else. `baseUrl`, `apiKey`
    // and `headers` only — the builtin catalogue, its api and its name stand,
    // so `name`/`api`/`model` written here are `config_invalid` rather than
    // silently ignored.
    "anthropic": { "baseUrl": "http://localhost:3001" },

    // B: a provider pi-ai has never heard of, built from this entry alone.
    // `api`, `baseUrl` and `model.id` are required here.
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

`api` is an allowlist, not a free string — `anthropic-messages`,
`openai-completions`, `openai-responses`, `azure-openai-responses`,
`google-generative-ai` — so a typo is `config_invalid` at load rather than a
stream error mid-request. Everything else is validated as strictly: an unknown
key inside a provider or a model entry, a wrong type, a provider id that is no
provider id, an empty `baseUrl` or `apiKey` (pi-ai reads a request `baseUrl`
for truthiness, so an empty one would silently restore the vendor URL), a
header name that is no HTTP token, and a header value carrying a CR, an LF or a
NUL — that last one is header injection, and the fetch layer would quote the
value, secret and all, into an error message that lands on stdout. No error
message ever repeats an expanded `apiKey` or header value; the `baseUrl` is
named, because a reviewer who cannot see the endpoint cannot debug it.

`model` mirrors pi's model definition; everything but `id` is optional:
`name` (default: `id`), `baseUrl` (default: the provider's), `reasoning`
(`false`), `input` (`["text"]`), `cost` (all zeros — lightspeed prices
nothing), `contextWindow` (`200000`), `maxTokens` (`16384`), plus
`thinkingLevelMap` and `compat`, which are handed to pi-ai untouched.

`${VAR}` in `apiKey` and in header values is read from the environment, and
nowhere else in the config. This is the one place lightspeed goes beyond pi,
which takes those literally: the config is committed to the repository under
review, so it must name the variable and never the secret. An unset variable is
`config_invalid` naming both the variable and the provider; a `$` that is not
`${...}` is a literal.

Credentials for a provider pi-ai ships: the configured `apiKey` wins, else
lightspeed's own `<stateDir>/auth.json`, else pi's `auth.json`, else pi-ai's
own environment variable names. A provider built from the config takes the
configured `apiKey` and nothing else — a gateway that reads the real secret
from a header wants a dummy key, or none at all.

The two credential files are layered, not merged: an OAuth refresh is written
back to whichever file owns the token, because refreshing pi's token into
lightspeed's file would leave pi holding a refresh token the provider may have
rotated away. A logout only ever edits lightspeed's file — signing out of a
review tool must not sign the human out of pi.

**pi's `~/.pi/agent/models.json` is not read.** pi-ai does not read it either:
the pi _agent_ does, and hands the result in. Reading it here would mean the
endpoint a review is sent to lives in a file nobody reviewing this repository
can see; naming it in the repo's own config makes the proxy as reviewable as
the code. The consequence for anyone who assumed otherwise: before `providers`
existed, a pi pointed at a proxy was silently bypassed — lightspeed built every
provider from pi-ai's builtins, each with its vendor `baseUrl` hard-coded, and
borrowed only pi's `auth.json`.

`groupingThreshold` was a config key once. It is still accepted so an existing
config loads after an upgrade, and it is ignored: every diff of two files or
more is grouped by the model.

`thinking` uses Pi's own vocabulary, not a boolean — `ModelThinkingLevel` from `@earendil-works/pi-ai`:

```ts
type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
```

The no-thinking value is **`"off"`**, not `"none"`. Any other string → `config_invalid` listing the valid set.

Missing file or missing required key → fail fast, before any git or LLM work:

```
error:
  code: config_missing
  message: .lightspeed.conf.json not found in repo root
  detail: lightspeed requires explicit `model` and `thinking`
help[1]:
  Create .lightspeed.conf.json with {"model": "<provider/model>", "thinking": "off"}
```

### Pi SDK call (in-process, no subprocess)

```ts
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";

const context: Context = { systemPrompt, messages: [{ role: "user", content: userPrompt }] };
// stream the configured model, collect final assistant text, then validate
```

Prompts owned by `src/llm/prompts.ts`. Expected output — an **ordered array**; position _is_ the order:

```json
{
  "groups": [{ "name": "string", "rationale": "string", "files": ["path"] }]
}
```

### Validation mini-harness

The LLM's answer is never trusted. `src/llm/schema.ts` validates it, and failures are fed **back into the same conversation** so the model can correct itself:

1. Parse JSON. Fail → append a user message with the parse error, retry.
2. Validate against the typebox schema (required fields, types, non-empty groups). Fail → append the validation errors, retry.
3. Cross-check file coverage: every diff path present exactly once, no invented paths. Fail → append the offending paths, retry.
4. Max **2** repair rounds. Still invalid → fall back to an `All Changes` group, whose test files trail in the usual `Tests` group behind it. A diff of nothing but tests stays one `All Changes` group, with nothing to trail behind.

Fallback also covers a missing SDK/auth error. Review is never blocked by the grouping step.

### When grouping is skipped

Only a diff with **one changed file** skips the LLM — there is nothing to order — and it becomes one `All Changes` group. Every larger diff goes to the model, because git's alphabetical file order is the exact defect grouping exists to fix. `start` reports it:

```
grouping:
  mode: skipped
  reason: 1 changed file: nothing to order
```

## Feedback Schema

Lavish-style: selected text + comment. No line numbers — agent maps text to code. **Plus the file path**, which removes the only real ambiguity (same snippet appearing in several files).

```json
{
  "status": "feedback",
  "ended": false,
  "prompts": [
    {
      "type": "annotation",
      "file": "src/api/users.ts",
      "group": "API Handlers",
      "selected_text": "+  const user = await db.user.create({\n+    data: { name, email },\n+  });",
      "comment": "This should be wrapped in a transaction"
    },
    {
      "type": "annotation",
      "file": "src/billing/legacy.ts",
      "group": "Cleanup",
      "selected_text": "-  const oldFunction = (x) => x * 2;",
      "comment": "Why removed? Billing module still needs it"
    },
    { "type": "message", "comment": "Overall looks good" }
  ]
}
```

Rules that make this unambiguous for an agent:

- `file` is always attached — the browser knows which file block the selection came from.
- `+`/`-` prefixes preserved in `selected_text` so the agent knows old vs new code.
- Selection is constrained to a single file block; cross-file selections are split into one annotation per file.
- `group` is included as orienting context (which concern the reviewer was looking at).
- One flat `prompts[]` array — annotations and messages in the order the reviewer queued them. No parallel `annotations[]` block.
- A poll that returns none of them says so definitively: `prompts: 0` plus a message, never a bare `prompts: []`. Only an ended review can answer with nothing queued — an open poll keeps waiting until something is.

## Browser Layout

```
┌──────────────────────────────────────┬──────────────────┐
│  Grouped Diff View                   │  Conversation    │
│                                      │                  │
│  ┌─ Database Schema (1/3 approved)┐  │  [annotation 1]  │
│  │ ☑ prisma/schema.prisma  (collapsed) │  [annotation 2]  │
│  │ ☐ prisma/migrations/...        │  │  [agent reply]   │
│  │  - old line                    │  │                  │
│  │  + new line                    │  │                  │
│  └────────────────────────────────┘  │                  │
│                                      │                  │
│  ┌─ API Handlers (8 files) ───────┐  │                  │
│  │ ...                            │  │                  │
│  └────────────────────────────────┘  ├──────────────────┤
│                                      │ [text input    ] │
│                                      │ [Send][Send&End] │
└──────────────────────────────────────┴──────────────────┘

Selection popup:
┌─────────────────────────┐
│ [file path            ] │
│ [selected text preview] │
│ [comment textarea     ] │
│ [Queue Feedback]        │
└─────────────────────────┘
```

**A round waits for the reviewer.** An agent finishing mid-review used to replace the diff the instant it landed: the reviewer was thrown to the top of a review that had been re-cut under them, in the middle of a group, having asked for nothing. A new round now waits behind an offer in the header — `Round 2 is ready · 4 files`, drawn by `dom/round-offer-mount.ts` off the whole session it holds — and goes on screen only when it is pressed. What counts as being mid-review is `holdsRound` in `src/browser/round-offer.ts`: scrolled off the top, inside a chapter, or holding queued words. A reviewer showing none of the three has nothing to lose, so the round is applied silently, exactly as before; and an ended review is never held, because that is the review stopping rather than a round to be taken. One offer stands at a time and it is always the newest round: a reviewer who read through two of them is not owed two presses. Applying a round is one function (`applyRound` in `dom/session-events.ts`), reached from the event and from the press alike, so the two can never draw different reviews.

**The arrival is announced once.** The header's offer alone was missable — it appears in a corner nobody is reading — so a round that has to wait is also announced by a card over the review (`renderRoundPopup` in `round-offer.ts`, mounted by `dom/round-popup.ts`): the round by the number the reviewer counts, its size, and two honest answers — `Open round N`, or `Keep reading`, which is also what Esc says. Dismissing is not declining: the card folds itself into the header's offer — shrinking away toward the corner the offer lives in — the offer glows once in answer, and then a spark rides the button's border (`offset-path: border-box`) until it is pressed. That orbit is the page's one ongoing animation, allowed because it tells the reviewer nothing new — it holds the place they said they would come back to — and it ends with the offer, however the offer ends: taken from either mouth, or overtaken by the round going on screen. Each round is announced once — a dismissed card never returns for the same round, a newer round is fresh news even over the last card's fold — and taking from card or header clears both, so neither goes on standing for a round already on screen. Under `prefers-reduced-motion` the card is simply there and simply gone, and the spark does not exist.

**The wait is visible.** Presence — an agent parked on `poll`, an agent away with prompts a poll already took — is pushed down the SSE stream and stated in words in the header. The working half of it is also said where the reviewer actually is: a line with three breathing dots at the foot of the conversation, in the place the answer will be written, which is where the eye goes after Send. Both are rendered from the same presence frame — the panel is told by `panel.setWorking`, from the one listener that tells the banner — so neither can go on claiming work after the other has stopped. The line goes the moment the agent polls again, and it is never shown over an ended review. A reviewer who asked for less motion keeps the line, its dots up and still: the line is the news, and the movement was only what made it easy to catch.

**A comment leads back to its lines.** In the panel, an anchored comment is captioned by its file's basename alone — the full path waits in the tooltip, and the chapter name that used to trail it is gone: the chapter heading is on the diff, and repeating it under every comment glued a round's card into one unreadable block. The seams do the separating now — a hairline between the prompts of one turn, which is also what sets the round's closing message apart from the last anchored comment above it. The caption is a press: it enters the chapter holding the file as a real focus press (reported, remembered — a reload after a jump opens where it landed), unfolds the file if its own approval had shut it, and scrolls to the very line the anchor names, in either layout, falling back to the file when the diff on screen no longer prints that line and doing nothing at all for a file the round does not carry. The panel only says which file and where (`onJump`); getting there is the diff's craft (`reveal` in `dom/diff-mount.ts`, `findLine` in `dom/line-numbers.ts` — the inverse of the numbers a selection is anchored by).

**An answer sits under its question.** The agent can answer one comment by its id (`poll --for <id> --note`), and the panel shows that answer inside the reviewer's own prompt, under the words it answers — labelled "the agent's answer", ruled in the accent the way the replay rules the reviewer's quote in violet. It arrives live: the reply publishes a session change, the page refetches, and the redraw carries the note. A declaration that named files but said nothing shows nothing — which files changed is the between-rounds replay's story, told with the diffs to back it.

**Enter sends.** In both comment boxes — the popup's and the panel's — Enter is the button beneath it: it queues the annotation, or sends the general comment along with whatever is queued. Shift+Enter and Alt+Enter break the line, and so do Ctrl+Enter and Cmd+Enter, which browsers type nothing for and `src/browser/dom/enter-key.ts` therefore types itself. An Enter on an empty box does neither: nothing is sent, and no blank first line is typed, because the placeholder is what tells the reviewer Enter is waiting for a comment. Queued pills are sent by the button alone — a stray Enter in an empty box must not fire off a half-read review.

**Nothing dies on a reload.** What the reviewer has done and not yet sent survives the page going away, kept in `localStorage` under one record per session key (`lsr:memory:<key>`, read and written by the pure `src/browser/review-memory.ts`; the mounts hold no state it does not). Two halves with two lifetimes. The reviewer's own unsent words — the queued pills, each with the file, group, selected text and line anchor it would be sent with, and the general comment box as far as it is typed — outlive everything, including a re-group, exactly as they already outlive an agent reply in the open page; a send is what clears them, and a send the server refused clears nothing. Where they were reading — which groups and files stand open, and the review's scroll offset — is stamped with the round it was read in and handed back only to that same round: a re-group replaces the diff those group indices, paths and pixels point into, so the new round opens as it is rendered and at the top, which is what the page does live over SSE too. That stamp is also what keeps the store clean: the paths of a round that has been replaced are dropped the first time the new one reports what it has open. The popup's own comment box is deliberately not kept — it belongs to a live selection that a reload has already taken away, and a comment restored without it would be anchored to nothing.

Storage degrades rather than fails. A record written by another version of the page is dropped on sight rather than migrated, malformed JSON and fields of the wrong type read as the empty record (a page that throws on load is a worse failure than a queue that comes back empty), and a store that is blocked or full costs the memory and nothing else — the write gives up the other reviews first, then this review's place in the diff, and never the queue. Eight reviews are remembered at once, oldest write evicted, so a machine that reviews a branch a day does not grow a store forever.

**Text wraps, the panel does not scroll sideways.** Chat is full of tokens with nothing to break at — a type name, an attribute, a path — and the panel and the popup are 22rem wide. Both wrap mid-token (`overflow-wrap: anywhere`, which also shrinks min-content and so keeps a flex item inside the popup) rather than growing a horizontal scrollbar the reviewer must drag to read the end of their own sentence. Wide quoted code wraps too: it keeps its indentation from `pre-wrap` and scrolls only vertically, past 8rem. The diff itself is untouched and may still scroll sideways — a diff is code at its own width, not prose.

**Approved checkboxes.** Each file carries an `☐ approve` checkbox under its diff, where reading the file ends; ticking it collapses that file and increments the group header counter (`1/3 approved`). Each group header has a tick-all, which ticks every file in the group.

A group is nothing but its files, so a group whose files are all ticked is approved: its tick-all fills in, the card dims, and the group collapses — there is nothing left in it to read. In focus mode the collapse shuts the chapter back onto its gate card, ticked, and the page moves on to the next chapter with something still unticked (wrapping round, sweep chapters skipped); with nothing left to read, the finished card stays. Untick anything inside it and the group un-approves and opens again, because that tick is the reviewer asking to look once more. Only what actually changed hands is opened or shut: a file or a group the reviewer opened by hand is theirs to close, so a tick elsewhere leaves it exactly as they left it. Group approval is derived from the ticked paths and never stored — the tick-all box is the whole of it, so the mark cannot drift from the boxes it is made of, and nothing per group reaches the server. State is client-side and persisted in the session JSON for reload survival; a session loaded with a group already fully ticked renders it marked and collapsed.

**Approval across rounds.** A re-group withdraws approval, except from files a blob sha proves untouched since the reviewer ticked them: those arrive in the new round already ticked and dimmed. Two independent facts are derived in `src/rounds/history.ts` from `SessionRecord.rounds[]`, never stored twice:

- `Approval` — where the file stands with the reviewer: `needs-reapproval` (approved, then edited by the agent), `unapproved` (never approved, whether on its first round or its fifth), `approved` (ticked and provably unmoved). Served on `/api/session/:key/data` as `approval` and written to the ledger as `round_file.approval` (with `round_end.approved`/`carried`). The grouping prompt is told none of it: the model orders the diff, and the diff does not change with who has read it.
- `previous` grouping — what the prompt _is_ told about earlier rounds: last round's groups, in the order the reviewer read them, as `{ name, files }` read off `SessionRecord.groups` by `start` before the server overwrites it. It goes in as a data-only header section, sized against the header it is not part of: `MAX_PREVIOUS_CHARS` (10,000) is the ceiling on the whole section, heading and trailing blank line included, and what it actually gets is whatever the intent and the inventory left spare above `MIN_PATCH_CHARS` (20,000) of room for patches — down to nothing, in which case the heading goes too. What does not fit is cut at a whole group boundary and says how many groups and files it left out. The rule asking the model to hold that reading order lives in `GROUPING_SYSTEM_PROMPT`, so the cacheable prefix stays identical between rounds. Only a round a model grouped is carried: `SessionRound.grouping` records the mode (absent on rounds written before it, read as `llm`), and a `fallback` or `skipped` round — one `All Changes` group over the whole diff — is never handed back, because a catch-all always supports the rule and one degraded round would pin it forever. Stability is asked for and never enforced: no post-pass rewrites the model's answer to match, and a first round sends no section at all.
- `firstSeenRound` — which round the file entered the review in, which is not git's `added`. Ledger-only, as `round_file.first_seen_round`: sessions are overwritten and deleted, so the mining agent cannot otherwise ask how long a file sat unapproved.

Approval never reorders the review: a file keeps its place in its group and a group keeps its place in the review, whatever the reviewer has ticked. Ticking still collapses — the file, and the group once all of its files are ticked — but nothing changes place. Files once sorted `needs-reapproval → unapproved → approved` inside their group, and the prompt asked for groups of nothing but approved files last; both are gone, along with the `already approved` mark the second was read off, because a review that has rearranged itself since the reviewer last looked takes their place in the reading away from them, which costs more than any order it buys. Order is the model's, top to bottom, and the page opens as the survey alone — the group index — with no diff anywhere on it: a chapter is drawn only once it is opened, and then it is the only thing on the page. The index is a plain list — name, files, ±lines, approved counter, press to open — and it singles no group out: which one to read first is the reviewer's call, and the page has no business making it for them. A binary file has no blob sha, so its approval is never carried.

**The header bar knows where you are.** The header draws one segment per group, each as wide as the lines its group changed (`src/browser/progress-bar.ts`) and filled as its files are ticked. The segment of the chapter standing open in focus mode wears an accent ring — `data-current`, stamped at draw time from the focus the diff already holds — so a reviewer deep in a long review can glance up and see which slice of the whole they are in. Each segment is also a real button carrying its chapter number: a press is the same focus move an index entry makes — from the survey or from any other chapter — wired on the header's own host, since the bar lives outside the diff root the other focus controls listen under. The bar stands a spacing step taller than it used to, because a press target is not a picture; a quiet muted ring answers the hover so the accent ring keeps meaning "you are here". And on the survey itself the chapter names speak at the title size with their subtitles at the new lead step (`--lsr-size-lead`) — the index is the one screen the names are the content of, with no code to shout over. On the survey nothing is being read, so nothing is marked; a tick patches the bar in place and never touches the mark, and every way in or out of a chapter is a redraw, which is what moves it.

**Diff against the approved form.** A `needs-reapproval` file carries a per-file switch — `Branch diff` / `Since approval`: the reviewer's own tick is a second thing to read the file against. `Since approval` replaces that one file's diff with `git diff --find-renames <head of the approving round> <head of this round> -- <every name the file has gone by>`, under one line saying why the view takes no feedback and nothing else — the rounds in between were once quoted here, intents and commit subjects, and are gone: the conversation panel already says what the agent said it was doing, and a second copy above the diff read as noise between the reviewer and the change. `src/rounds/approved-form.ts` decides which commits and names those are (pure, from `SessionRecord.rounds[]`); `GET /api/session/:key/approved-form?path=` asks git and answers `404 no_approved_form` for any file the rounds do not put in that state.

A file nobody ever approved can still have moved under the reviewer: the agent kept editing it across rounds, and the branch diff shows the whole change again with nothing marking the six lines that are new since they last read it. Where the blob shas of the last two rounds prove such an edit, the row carries `Branch diff` / `Since last round` instead — the same question put to a different pair of commits, the two rounds' heads. `src/rounds/last-round-form.ts` decides it (pure, only ever the newest pair, and refusing `needs-reapproval` files: the approved form already covers everything since the tick, so one file never carries two comparisons), the page offers the switch by the very same comparison (`src/browser/round-changes.ts`, over the rounds the payload already carries), and `GET /api/session/:key/last-round-form?path=` answers `404 no_last_round_form` everywhere else. All the rest — fetched on press, cached for the page, dropped with the round, annotation refused off the branch diff, the no-diff states below — is the approved form's machinery shared whole; only the words differ, because a sentence about "the form you approved" would claim a verdict nobody gave.

`Branch diff` is pressed on every load and every new round — a withdrawn approval means the file must be read whole again, and the other view answers a question the reviewer asks second. (A layout switch is not a new draw in that sense: it redraws the approved form for any file showing one.) The comparison is fetched on press, not shipped with the page, and cached for the life of the page only: a reload or a new round opens on the branch diff, since a new head commit is a different question, and a new round drops every cached answer with it. Annotation is refused unless a file shows the branch diff (`selection-fragments.ts` reads `data-form` as an allowlist), and the view says why: its line numbers belong to two commits of the branch's history, while the ledger's anchors are numbered against the branch diff. Neither commit is named on screen, so the note points at the press that gets the reviewer a view they can comment on rather than at a range they cannot see, and it is shown only where there is a diff — a state with none has no line numbers to be wrong about.

Why there is no diff, when there is none, is decided in one place — `approvedFormData()` in `src/server.ts` — and never guessed: `identical` (changed and changed back), `binary` (git has no lines for it, which includes a file that was text when it was approved), `unreachable` (a rebase or force-push took one of the commits), `unrecorded` (a round in the pair stored no commit, which is a session older than that field — explicitly not a rebase), and `oversize` (over 512 kB of patch measured in bytes, or more than git will hand over in one piece, with the exact `git diff` to read it). The page renders what it is told and asks git nothing.

Only one state is stated on screen: `needs-reapproval` carries the amber pill `changed after approval`. The others need no words — approved is a ticked, dimmed, collapsed row, and unapproved is an ordinary unticked one. One thing that is not a state is stated beside it: a file the reviewer annotated in the round before this one carries the violet pill `commented last round` — a different colour because the two can share a row and only one of them is a verdict — derived in the browser by `src/browser/commented-files.ts` from the conversation and the rounds the page already has, placing each entry by the rule the conversation panel places it by. A fully approved group reads the same way one level up: ticked, dimmed, collapsed. The dimming stops there rather than stacking, since opacity multiplies and a file dimmed inside a dimmed group would all but vanish.

## Session Lifecycle

1. **start** — creates or updates session (idempotent)
2. **active** — browser open, agent polling
3. **update** — re-run `start`: fresh diff, re-grouped, SSE reload, conversation preserved
4. **Send** — feedback delivered, session stays active
5. **Send & End** — final feedback + `ended: true`. Not an approval in itself: the ended poll payload carries `approval: {verdict, approved, unapproved, swept, total}` — counts, not paths, because the polling agent wrote the branch and already knows its files — and `endedBy`. `verdict` is `signed-off` | `partial` | `none` | `empty`, derived off the same account as the counts so the two cannot disagree; only `signed-off` is a sign-off, and `swept` counts the approvals a sweep lane took in one press, approved and unread. The ended `help[]` line carries only what those fields cannot — who closed it, that a sweep was involved, or that an older server reported no readable account — and never restates the counts. `lightspeed approvals [branch] [base]` names those files, and nothing runs it by default; it prints the first 50 paths of each list beside a `count` block read off the whole review, so a cut listing can never make a count lie, and `--full` prints every path. Agent must not reopen uninvited
6. **end** — agent-initiated close, which the payload marks `endedBy: agent`

## Testing Strategy

- **Framework:** `node:test`
- **Unit:** diff parsing, prompt building, TOON output, feedback normalization, session store
- **Integration:** server routes, CLI command parsing, AXI output shape
- **LLM:** mock Pi subprocess, assert prompt construction + response parsing
- **AXI compliance:** assert TOON format, `help[]` presence, exit codes, empty states
- **Manual:** browser annotation flow, approved-checkbox collapse
- **Repair loop:** mocked LLM returning bad JSON / missing files → asserts retry messages and eventual fallback
- **Config:** missing file, missing `model`, missing `thinking` → `config_missing` / `config_invalid`, exit 1
- **Coverage:** >80% core logic

## Boundaries

### Always

- Run `pnpm test` before committing
- TOON output for all CLI responses
- `help[]` next steps on every output
- Errors to stdout as TOON, debug to stderr
- Exit 2 on unknown flags
- Sanitize content in HTML (XSS)

### Ask First

- Adding npm dependencies beyond tech stack
- Changing CLI command interface or TOON schema
- Changing prompt templates
- Supporting agents beyond Pi
- Introducing environment-variable configuration (config file only)

### Never

- Interactive prompts (breaks agent use) — the one carve-out is `login`/`logout`:
  human-run setup, TTY-guarded, refused without a terminal
- Expose LLM keys in browser or logs
- Store data outside state dir
- Write structured data to stderr
- Silent defaults for `model` / `thinking` — fail fast instead
- Trust raw LLM output without schema validation

## Success Criteria

1. `lightspeed` with no args shows live sessions in TOON with `bin`, `description`, `help[]`
2. `lightspeed start feature-x main` extracts diff, calls Pi for grouping, opens browser — one command, TOON output with aggregates
3. Browser shows groups in LLM order, syntax-highlighted unified diffs
4. User selects any diff text (including `-` lines) → popup → targeted feedback
5. User types general comments in conversation panel
6. `poll` returns TOON feedback with exact selected text + comment
7. "Send" keeps session active; "Send & End" closes it
8. Re-running `start` updates session with fresh diff + re-grouping, preserves conversation
9. Multiple concurrent sessions work (different repos/branch pairs), disambiguated by explicit args
10. Unknown flag → exit 2; config missing → structured error + `help[]`; no sessions → definitive empty state
11. Invalid LLM output is repaired in-conversation (≤2 rounds) or degrades to `All Changes`
12. Diffs ≤7 files skip the LLM call entirely
13. Approved checkbox collapses a file and updates the group counter

## Resolved Questions

1. **Diff format:** Unified only (MVP)
2. **Group ordering:** LLM-determined, UI respects
3. **Multi-round:** Fresh diff on re-start, conversation preserved
4. **Max diff size:** Skip binary, warn >10k lines
5. **Feedback format:** Selected text + **file** + comment, no line numbers
6. **LLM:** CLI owns prompts, uses the pi-ai **SDK** in-process, Pi-only MVP
7. **Multi-session:** Explicit `<branch> [base]` args per command; key = hash(repo+branch+base)
8. **Interface style:** AXI — TOON, content-first, contextual disclosure, structured errors
9. **Language:** TypeScript, run directly by Node ≥22.18 type stripping
10. **Config:** `.lightspeed.conf.json` in repo root; `model`/`thinking` required, fail fast. No env vars
11. **Ordering:** LLM returns an ordered array; position is the order, no `order` field
12. **Grouping threshold:** ≤7 changed files → skip the LLM
13. **Validation:** schema + coverage check, errors fed back into the same conversation, ≤2 repairs
14. **Poll:** no `--timeout-ms`, no heartbeat; blocking foreground, forever
15. **Hooks:** dropped. Skill only

16. **HTTP layer (D1):** `node:http` + tiny router. Decided — no capability loss vs Express for this feature set
17. **Thinking config:** Pi's `ModelThinkingLevel` string (`"off"` … `"max"`), not a boolean
18. **Config filename:** `.lightspeed.conf.json`
19. **Repair rounds:** 2
20. **Side-by-side (D2):** in MVP as Task 13, Phase 5, behind a toggle; cross-column selection forbidden, not split

## Open Decisions

None. **D2 decided:** side-by-side ships in MVP as Task 13 (Phase 5, S) behind a toggle, with selection locked to a single column. Spec approved — implementation not started.

## Post-MVP

- ~~**Persistent approval across rounds.**~~ Shipped: see "Approval across rounds" above and the round backbone below.
- Agents beyond Pi

## Side-by-side (D2) — cost breakdown

| Piece                                    | Work   | Why                                                                                                   |
| ---------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| Rendering                                | **~0** | `diff2html` takes `outputFormat: "side-by-side"`; the adapter already isolates it                     |
| View toggle + persistence                | **S**  | One button, store the choice per session                                                              |
| CSS next to the 300px conversation panel | **S**  | Two code columns plus the panel is tight below ~1400px; needs a breakpoint that falls back to unified |
| **Annotation scoped to one column**      | **S**  | Your call: forbid cross-column selection entirely. Two standard browser techniques, used together     |

### Locking a selection to one column (your suggestion — yes, this is codeable)

Both halves are ordinary DOM work, no library:

1. **`user-select: none` on the other column.** On `mousedown` inside a column, set `user-select: none` on its sibling column. The browser then refuses to include that column's text in the selection — it is not highlighted and not returned by `toString()`. This is the same trick GitHub uses to keep line-number gutters out of copied diffs. Cleared on `mouseup`.
2. **Clamp on `selectionchange` as a backstop.** Keyboard selection and programmatic selection bypass the mousedown path, so on `selectionchange` compare the column ancestor of `anchorNode` and `focusNode`; if they differ, call `selection.extend(lastTextNodeOfAnchorColumn, len)` to pull the focus edge back to the end of the starting column.

Result: a drag that starts in the old column can never reach into the new one, the annotation carries one clean `selected_text`, and there is **no split-into-two-annotations logic to write** — which is what dropped this row from M to S.

Recommendation: keep Phase 3 unified-only, add **Task 13 (side-by-side, S)** to Phase 5 behind a toggle. MVP is not delayed, the feature still ships in MVP, and if it turns ugly the toggle can be dropped without touching anything else.

---

# Spec: Feedback Ledger (post-MVP feature 1)

## Objective

Reviewer feedback currently lives only in the session JSON, which `start` overwrites and `end`
eventually drops. Future agent sessions therefore never learn the reviewer's preferred patterns
except indirectly, through committed code. This feature adds a **durable, append-only ledger** that
records every piece of review feedback together with the code it was about (paths, commit SHAs,
patch, surrounding lines) and with **outcome signals** (did the agent address it, was it approved,
did the reviewer have to repeat it).

The consumer is **an LLM mining agent**: later it reads the ledger, extracts recurring patterns, and
writes them into AGENTS.md / skills for future agents. That mining agent is out of scope; its needs
drive the data shape and the read API.

- **In scope:** write path, storage format, read/export API, opt-out, pruning, round backbone, tests.
- **Out of scope:** the mining prompt, pattern extraction, writing AGENTS.md/skills, any upload,
  and any _browser_ use of the round backbone (see "Multi-round backbone").
- **Non-negotiable:** a ledger failure never breaks a review; data stays local; config only, no env vars.

## Decisions (reviewer-approved)

| #   | Decision           | Choice                                                                                                                                                                                                     |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Storage backend    | **JSONL append-only**, `<stateDir>/feedback/YYYY-MM.jsonl`. No `node:sqlite` (experimental API + warning, binary state). A SQLite index may be derived later without moving the source of truth.           |
| D2  | Code context depth | Selection + **±30 lines of context** + the file's **patch for that round** (stored once per round-file, referenced by items). Caps: selection 4 KB, context 8 KB, comment 16 KB, patch 64 KB / 2000 lines. |
| D3  | Line anchors       | **Capture now**: `line_start`, `line_end`, `side` on annotations (browser knows both since the whole-file syntax work), plus `col_start` / `col_end` when only part of a line was selected.                |
| D4  | Outcome signals    | **Derive now**, built as a shared round backbone with two consumers (below).                                                                                                                               |
| D5  | Ledger location    | **Global**, in `stateDir`, across all repos; every record carries repo root + remote; `--repo` filters.                                                                                                    |
| D6  | Opt-out            | `"feedbackLog": "on" \| "off"` in `.lightspeed.conf.json`, **default `on`**; path + status reported in `start` output.                                                                                     |
| D7  | Mining bookkeeping | `--since` / `--cursor` only; ids are monotonic, the mining agent keeps its own watermark. No mutable ledger state.                                                                                         |
| D8  | Delivery           | Four vertical slices (write path → read API → line anchors → round backbone + outcomes).                                                                                                                   |

## What the mining LLM needs, and what that forces

| Mining question                             | Data needed                                              | Consequence                                                  |
| ------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| What does this reviewer keep asking for?    | comment + exact selected code, verbatim                  | store raw, never summarise                                   |
| What did the agent write that triggered it? | the file's patch for that round                          | per-round per-file patch, stored once                        |
| Is the selection code, a name, a test?      | surrounding lines, path                                  | ±30-line context snippet (language derivable from path)      |
| Did the feedback land?                      | next round's diff for that file, re-annotation, approval | derived `outcome` record with a `verdict`                    |
| What is new since my last mining run?       | time order, stable ids, resumable reads                  | append-only log, monotonic ids, `--since`/`--cursor`         |
| Will it fit my context window?              | cheap default, drill-down                                | `list` capped and without bulk fields, `show <id>` with them |

**Self-containment rule:** every item must be understandable with **no git access** — the repo may be
gone or the branch rebased. Hence code context is copied into the ledger, not referenced by SHA alone.

## Write path — the server is the only writer

| Trigger                           | Record appended                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/sessions` (`start`)    | `round` (repo root/name/remote, branch, base, `base_commit`, `head_commit`, stats, groups) + one `round_file` per file (status, previous_path, blob shas, patch) |
| `POST /api/session/:key/feedback` | `annotation` / `message`, one per prompt, anchored to round + file                                                                                               |
| `poll --agent-reply`              | `agent_reply`                                                                                                                                                    |
| `end` / reviewer "Send & End"     | `round_end` including the set of files ticked `approved`                                                                                                         |
| next `start` on the same branch   | `outcome` per annotation of the previous round                                                                                                                   |

Every write is wrapped: a full disk, a corrupt line or a git failure is swallowed, counted, and
surfaced as `ledger: {status: degraded, reason}` in CLI output.

## Record shape

One JSON object per line, `schema: 1`, stable field names, additive evolution only.

```json
{
  "schema": 1,
  "id": "evt_01JQ8Z5K3M_7f2a",
  "kind": "annotation",
  "at": "2026-02-14T09:31:02.118Z",
  "round": "rnd_01JQ8Z1A9C",
  "repo": {
    "root": "/home/you/lightspeed",
    "name": "lightspeed",
    "remote": "github.com/JakobKrummeich/lightspeed-review"
  },
  "branch": "feat/ledger",
  "base": "main",
  "base_commit": "a1b2c3d…",
  "head_commit": "9f8e7d6…",
  "file": "src/server.ts",
  "previous_path": null,
  "file_status": "modified",
  "group": "Ledger write path",
  "blob_new": "4c9f…",
  "blob_old": "11ab…",
  "line_start": 214,
  "line_end": 219,
  "side": "new",
  "selected_text": "+  if (!ok) throw new Error(…)",
  "comment": "Don't throw here — return a ReviewError…",
  "context": "…±30 lines from the whole file…",
  "truncated": ["context"]
}
```

```json
{
  "schema": 1,
  "id": "evt_01JQA1B2C3_be41",
  "kind": "outcome",
  "at": "2026-02-14T10:02:44.901Z",
  "about": "evt_01JQ8Z5K3M_7f2a",
  "next_round": "rnd_01JQA0ZZ4K",
  "from_commit": "9f8e7d6…",
  "to_commit": "5b4a392…",
  "file_touched": true,
  "response_patch": "@@ -214,6 +214,8 @@ …",
  "re_annotated": false,
  "approved": true,
  "verdict": "addressed"
}
```

A selection clipped to part of a line adds `col_start` / `col_end` to the anchor: 1-based,
inclusive columns into the line as the file has it, counted in UTF-16 code units, with the diff's
`+`/`-` marker not counted. `col_start` belongs to `line_start`, `col_end` to `line_end`, and an
absent one means that boundary line was taken whole — so an annotation on full lines is written
exactly as the record above. Selecting `throw new Error(…)` out of line 214 would read:

```json
{
  "line_start": 214,
  "line_end": 214,
  "side": "new",
  "col_start": 12,
  "col_end": 29,
  "selected_text": "throw new Error(…)"
}
```

`verdict` is `addressed | ignored | repeated | unknown` — the single field that turns a pile of
comments into labelled signal.

## Multi-round backbone — one source of truth, two consumers

Deriving outcomes needs exactly the data the next backlog item (de-focusing settled files) needs. It
is therefore built **once**, as a neutral module, and both consumers read from it.

- **Backbone (in scope)** — `src/rounds/`: a `RoundRecord` appended on every `start` (index,
  base/head commit, per-file status + blob sha, approved set at round end), held in the session
  record and mirrored into the ledger. Pure derivation:
  `fileHistory(rounds, path) → [{round, blob, status, approved}]`,
  `changedBetween(a, b, path) → boolean`,
  `settled(rounds, path) → {approvedAtBlob, changedSince}`.
- **Consumer 1, mining (in scope)** — `src/ledger/outcomes.ts` turns those facts into `outcome`
  records.
- **Consumer 2, browser UI (shipped after the ledger)** — `fileFocus`/`roundFocus`/`carriedApproval`
  on top of `settled()`: approved files arrive ticked and dimmed. See "Approval across rounds".

The ledger feature itself changed no approval behaviour: it only made the round record remember what
the flags were, which the de-focus feature then read.

## Read API

```
$ lightspeed feedback
ledger: {path: ~/.lightspeed/feedback, items: 148, repos: 3,
         first: 2026-01-04, last: 2026-02-14, unresolved: 12}
repos[3]{name,items,repeated,addressed}: …
help[3]: …

$ lightspeed feedback list --repo . --since 30d --limit 50 --format jsonl
$ lightspeed feedback list --verdict repeated --with-patches --max-bytes 200000
$ lightspeed feedback show evt_01JQ8Z5K3M_7f2a
$ lightspeed feedback prune --before 2025-12-01 [--repo <path>]
```

- TOON by default (house style); `--format jsonl` for bulk ingest, `--format md` for prompt-stuffing.
- Patches and code context omitted unless `--with-patches`; every omission or cut is marked, never silent.
- TOON `list` defaults to 20 items and 50000 bytes and says how to lift both; the raw formats carry
  no count block, so they stay uncapped unless `--limit` / `--max-bytes` are passed.
- Chronological order (newest last) so a slice reads as a transcript.
- Empty ledger returns a definitive empty state, like every other command.

## Files

New: `src/ledger/store.ts` (append/read, rotation, caps), `src/ledger/records.ts` (pure builders +
types), `src/ledger/export.ts` (filters, budget, formats), `src/ledger/outcomes.ts` (verdicts),
`src/rounds/history.ts` (shared backbone, pure), `src/commands/feedback.ts`, `test/ledger/*.test.ts`,
`test/rounds/*.test.ts`.

Modified: `src/server.ts` (write hooks), `src/config.ts` (`feedbackLog`), `src/cli.ts`,
`src/commands/command-help.ts`, `src/session-store.ts` (`rounds[]`), `src/browser/annotation.ts` +
`src/browser/dom/*` (line anchors), `src/feedback.ts` (anchor fields), `README.md`.

## Success Criteria

1. A full round — `start`, three annotations, a general comment, an agent reply, `end` — leaves
   exactly those records in the ledger, ids monotonic, one `round` record.
2. Deleting the session file (or all of `sessions/`) loses nothing from the ledger.
3. Every item read back is understandable with the repo **deleted**: path, commit, code, comment.
4. An unwritable ledger, a corrupt line and a git failure each degrade to a reported warning; the
   review still completes.
5. `feedbackLog: "off"` ⇒ zero bytes written, zero behaviour change elsewhere.
6. `feedback list` honours `--repo/--since/--limit/--cursor/--max-bytes/--verdict`, caps its TOON
   output by default, marks every truncation, and has a definitive empty state.
7. Round two of a branch labels each round-one annotation `addressed | ignored | repeated` and stores
   the agent's response patch.
8. `settled(rounds, path)` is correct for approved-then-untouched, approved-then-edited,
   never-approved and renamed files — with no browser or grouping behaviour change.
9. An old line with `schema: 1` still reads after fields are added.
10. `pnpm test`, `typecheck`, `lint`, `build` clean; unit tests for ledger append/read, record
    builders, verdict derivation, export formatting/budgeting, opt-out, and the round backbone.

## Boundaries

- **Always:** wrap every ledger write; cap every stored string and mark truncation; keep records
  additive; keep derivation pure and unit-tested.
- **Ask first:** changing the record schema after slice 1 ships; adding a dependency; storing whole
  file contents; anything that sends data off the machine.
- **Never:** let logging break a review; read config from env vars; commit the ledger or fixtures
  containing real feedback; change approved-flag or grouping behaviour in this feature.

## Engineering Constraints (agent-maintainability + AXI)

These are review gates for every task, not aspirations:

- **Literal dispatch.** Kinds, formats and verdicts are string-literal unions dispatched by literal
  `switch` or an object of named functions. No name-constructed lookup, no auto-discovery, no plugin
  registry for the three output formats.
- **Locality.** A behaviour is understandable from at most two files; record types live beside the
  builders that produce them.
- **Fits in a head.** Cyclomatic complexity ≤ 7 per function; `verdictFor()` is named predicates, not
  a nested `if` tree.
- **No rent-free abstraction.** One backend means no `LedgerBackend` interface; one store means no base
  class; the disabled path is `undefined`, not a null object.
- **Illegal states unrepresentable.** Discriminated unions on `kind`, `verdict` and `context_source`;
  `truncated[]` written only by the single `capField()` helper; ids only from `nextId()`.
- **AXI.** TOON on stdout, `help[]` on every payload, precomputed aggregates, definitive empty states,
  exit 2 on unknown flags, structured errors on stdout, `--help` per subcommand, config not env, and a
  registry-completeness test for the `feedback` subcommands. One carve-out: `skill` prints markdown on
  stdout, because its output is redirected into an agent's instruction file — its errors are still TOON.
