# Spec: lightspeed (AXI)

## Objective

An **AXI** (Agent eXperience Interface) CLI for reviewing LLM-agent code changes in the browser. Solves two problems:

1. **Flat file lists in GitLab/GitHub are unreadable for large PRs** — An embedded LLM call groups and orders changed files semantically ("Schema changes", "API handlers", "Tests") so related changes appear together.

2. **Giving targeted feedback to agents is tedious** — User selects any text in the diff (including deleted lines), types feedback in a popup, and it reaches the waiting agent with the exact selected text + comment, as a thread both sides answer in. No verbal file/line description needed.

Built to [AXI principles](https://axi.md): TOON output, contextual disclosure, content-first, structured errors, long-poll feedback: every command that hands the turn back waits for the next Send.

### User Flow

```
Developer working in TUI with Pi agent:

1. "Show me the MR in lightspeed comparing feature-x to main"

2. Agent: npx lightspeed open feature-x main --intent "<why this branch exists>"
   └─ States the intent — required when opening fresh, repeatable, rendered
      above the diff (a disclosure on the survey, shut until the reviewer presses it)
   └─ Extracts git diff
   └─ Groups it with the configured model (lightspeed-owned prompts)
   └─ Opens browser with grouped diff view
   └─ Prints the round (session key, url, groups), then WAITS in the foreground
      for the reviewer's first Send (help[] tells the agent never to background
      it or wrap it in a timeout). Delivery is the only thing that hands the
      agent the turn.

3. User reviews in browser:
   └─ Main area: grouped/ordered diffs, syntax highlighted
   └─ Right column: conversation panel — one thread per item sent
   └─ Selects text in diff → popup → targeted feedback
   └─ Bottom-right: general comment input + "Send" / "Send & End"

4. User clicks "Send":
   └─ `open` returns the batch: one item per thread (id, status, file:line,
      the reviewer's words) and a `next:` decision rule
   └─ The agent is now digesting; it ends the turn in ONE of two ways:

5a. Talk: npx lightspeed reply --to t1 "<answer>" --to t2 "<doubt>"
   └─ Every answer of the turn in one call, each under its thread
   └─ Hands the turn back and waits for the next Send

5b. Work: npx lightspeed work "<plan>"
   └─ The reviewer's header names the plan; they can only queue
   └─ Agent edits, tests, commits, then:
      npx lightspeed publish --intent "<what changed>" --to t2 "done: …"
   └─ New commits become the next round, re-grouped, browser live-updates;
      the reviewer's queue drops into the round; waits for the next Send

6. User clicks "Send & End": final feedback + session closed (≈ approval)
```

## Tech Stack

- **Runtime:** Node.js ≥22.19 (ESM). Native type stripping — `node src/cli.ts` runs TypeScript directly, verified on 22.22.
- **Language:** **TypeScript** (`.ts` sources, `tsc --noEmit` typecheck, no separate runtime step)
- **AXI SDK:** `axi-sdk-js` (MIT) — provides `runAxiCli`, TOON output, structured errors
- **Server:** `node:http` + a ~60-line router (6 routes total). No Express — nothing to learn, zero dep. **D1 decided.** Capability parity confirmed: the annotation popup, selection handling and conversation panel are pure client-side code; the server only serves HTML, JSON and an SSE stream, all of which `node:http` does natively.
- **Diff rendering:** diff2html (MIT) behind adapter interface
- **Browser UI:** Vanilla TS + Tailwind CSS (CDN), no framework
- **LLM:** `@earendil-works/pi-ai` **SDK** (successor to the deprecated `@mariozechner/pi-ai`) — in-process `Context {systemPrompt, messages, tools}` + streaming. No subprocess. Project owns prompts. Pi-only for MVP.
- **Build:** esbuild (bundle to `dist/cli.mjs`)
- **Test:** `node:test` (runs `.ts` test files directly)

## AXI Compliance

| #   | Principle                          | Implementation                                                                                                                                     |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Token-efficient output**         | All CLI output in TOON via `axi-sdk-js` — except `skill`, whose stdout is the markdown document itself; its errors stay TOON                       |
| 2   | **Minimal default schemas**        | Session list: `{branch, base, turn, round, pending}` — 5 fields; `--all` widens it to every repository                                             |
| 3   | **Content truncation**             | The CLI never prints the diff — the browser shows it. `approvals` lists the first 50 paths of each list, `--full` for every one                    |
| 4   | **Pre-computed aggregates**        | `total_files`, `total_groups`, `files_changed`, `insertions`, `deletions`, `pending_prompts` inline                                                |
| 5   | **Definitive empty states**        | `sessions: 0` + explicit `no active sessions` message, never silent empty                                                                          |
| 6   | **Structured errors & exit codes** | Errors as TOON on **stdout**, debug on stderr. Exit 0 ok, 1 error, 2 usage or refused move. No interactive prompts. Waiting commands re-run safely |
| 7   | **Ambient context**                | Ships an installable agent skill. **No session hooks** — YAGNI, dropped                                                                            |
| 8   | **Content first**                  | Bare `lightspeed` shows live sessions + `bin: ~/...` + description + the one next command, not help                                                |
| 9   | **Contextual disclosure**          | Every output ends with `help[]` or a `next:` decision rule — only the moves that are legal from the turn it just stated                            |
| 10  | **Consistent help**                | `--help` on every subcommand; top-level `--help` lists every command it answers                                                                    |

## The turn

> Discussion strictly alternates. The agent ends each turn by talking or by
> working, never both. Every command that hands the turn back also waits for the
> next Send.

A session has exactly one turn holder at a time, persisted on the record as
`turn: {holder: "reviewer", at}` or `turn: {holder: "agent", mode: "digesting" |
"working", at, note?, head?}`. A session written before v3 is migrated on read:
the v2 `reading` mode becomes `digesting`, and a session written before the turn
existed reads as the reviewer's.

| State         | Reviewer's header                              | Reviewer can                                                            | Agent ends it with                    |
| ------------- | ---------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| You compose   | "Agent is listening" / "Agent isn't listening" | read replies, reply in any thread, resolve threads, add items, **Send** | —                                     |
| Agent digests | "Agent is reading your 5 items"                | read the diff and approve files; compose, replies and queue are locked  | `reply` (talk) or `work` (start work) |
| Agent works   | "Working on: _plan_"                           | **Queue** anything — "queued items go into the next round"              | `publish` (new round)                 |

**End** is available in every state, on both sides.

**The turn moves to the agent on delivery, and on nothing else.** Not on the
reviewer's Send: a batch nobody is waiting for queues server-side as `pending`.
Only a batch handed to a waiting `open`, `reply` or `publish` takes the turn,
because only then is there an agent that has actually read it; the agent is then
_digesting_. `reply` hands the turn back; `work` moves it to _working_; `publish`
opens the next round, drops the reviewer's queue into it and hands the turn
back; `end` ends the review.

**One call is one turn.** `open`, `reply` and `publish` wait for the reviewer's
next Send before they return (or for the review to end), so there is no separate
listening command an agent can forget to run. `work` and `end` wait for nothing.
The waiting commands must run in the foreground and never under a timeout; their
help says so.

**Re-running is re-attaching.** A waiting command that was killed — a harness
timeout, a `serve` restart — is re-run as it was. The server recognises a
`reply` it already has (same fingerprint, and either the same batch or a batch
not yet acknowledged) and a `publish` whose head is already the last round's
under the same rule, so nothing is posted twice; the command simply waits again
— or, if the agent is digesting, is handed that batch back at once. A `publish`
with other words, or after a newer batch was acknowledged, is no re-run: it is
refused as the turn rules it out, never answered `rerun: true`. `open` on a live review
is the same re-attach: no new round, no `--intent` required, just the wait — and
if the agent is digesting, it is handed the same batch again.

**Before it waits, every waiting command says what landed.** `reply` prints
`replied: [ids]` (or `rerun: true` when the server recognised a re-run),
`publish` prints the round it published (or `rerun: true`), `open` prints the
round or the re-attach — each closed by `next.if_killed`: the exact command to
re-run if the wait is killed (`lightspeed open <branch> [base]`, no `--intent`,
for `open`). A command that hands back a batch the agent is digesting does not
wait — it returns that batch at once — so its block carries no `if_killed`. The line is pasted as printed, TOON escapes included, so a `reply`
or `publish` whose words hold an apostrophe, a double quote, a backslash or a
line break — none of which survives that trip — names `lightspeed open <branch>
[base]` instead: the words have landed, and re-attaching waits for the same Send. `open` on a working turn is refused `turn_still_yours` before any
wait is announced, since nobody sends while the agent works; an `--intent` given
to `open` on a live review is reported as ignored in a `note`.

**The newest wait wins.** A session has at most one parked waiting command: a
new poll answers every older one `superseded: true` (exit 0, "another lightspeed
command took over listening"), so an orphaned wait left in a background job can
never take the next batch into a terminal nobody reads.

**A delivery is not finished until the agent says it arrived.** The server
cannot see this for itself: the answer's bytes reach the client's kernel whether
anything reads them or not, so a command killed mid-delivery is
indistinguishable on the wire from one that read every word. The batch is kept
on the record as `batch: {id, prompts, at, acked?}` and the id rides out on the
poll payload; the client confirms with `POST /api/session/:key/delivered`. While
the agent holds the turn, every re-attaching command is handed that batch again.
It is persisted rather than held in memory because a `serve` restart in that
window would otherwise lose the feedback for good.

**Reply from working** is refused unless nothing has changed since `work` — HEAD
is still the one `work` recorded and the tree's content still hashes (`git diff
HEAD --binary` plus each untracked file's name and bytes) to the snapshot `work`
took — because then there is nothing
half-written to protect and talking loses nothing. A tree already dirty at
`work` is fine; a change since is not, even more edits to a file already dirty. The refusal names which condition failed:
`HEAD moved since work`, `the working tree changed since work`, `no HEAD was
recorded at work`, or `no tree was recorded at work`. Otherwise the agent publishes what it has and asks in the new
round.

There is **no timer, no staleness unlock and no override**. A reload changes
nothing: the page reads the turn off the record it is served with. An agent that
died holding the turn is recovered by re-running the command it died in.

**The lock follows the phase.** While the agent _digests_ its batch, the
reviewer can read the diff, approve files and end the review; composing,
replying, resolving, the line popup and removing pills are locked ("Locked while
the agent reads your feedback"), so the batch cannot change under the agent
reading it. While the agent _works_, Send reads `Queue`: the general comment,
line comments, thread replies and resolves pile up as pills in the order they
were made, removable, and all of it goes out with the next round, on the
reviewer's next Send. The end button reads `End without Sending` on the agent's
turn, because the queue is not the reviewer's to send onto somebody else's turn.
The server enforces the lock too: a Send posted while the agent holds the turn
is refused 409 `agent_holds_turn` (the page shows "Not sent — …" in the compose
note). Ending is never refused, but an ending Send that carries words while the
agent holds the turn is — nothing would ever hand them to the agent, whose next
call only hears the review ended — so End without Sending (`prompts: []`) always
goes, and a Send & End only on the reviewer's turn.

| command   | legal from                                    | turn after               | waits for the Send |
| --------- | --------------------------------------------- | ------------------------ | ------------------ |
| `open`    | fresh / any live state (re-attach)            | reviewer, then digesting | **yes**            |
| `reply`   | digesting; working only if nothing changed    | reviewer, then digesting | **yes**            |
| `work`    | digesting                                     | working                  | no                 |
| `publish` | working, with HEAD moved since the last round | reviewer, then digesting | **yes**            |
| `end`     | any                                           | ended                    | no                 |

Every answer the CLI prints carries `turn` and `round`, and a batch closes with
`next:` — a decision rule, not a menu: anything that needs the reviewer goes in
one `reply`; nothing left to discuss and something to change means `work`;
anything ambiguous in a change request is worth asking now; the agent may leave
items unanswered, and ends the turn with `reply` or `work`, never both. When the
batch holds resolves, a `resolved:` line spells out what they mean. Every
suggested `--to` names an open thread of the session — never a resolved one, and
`main` when none is open. Every refusal names the one right command and exits 2
— read the help, do not retry:
`work` or `reply` on the reviewer's turn answer `turn_not_yours`; `publish` while
digesting answers `turn_still_yours`; `publish` on an unmoved HEAD answers
`nothing_to_publish`, naming `reply`; `--to` naming no thread of the session
answers `feedback_item_unknown`. On an ended review every command that speaks
into it is refused `session_ended`, naming who ended it (the reviewer, or an
agent's `lightspeed end` — the server's 409 carries `endedBy`) and pointing at
`lightspeed approvals <branch> <base>` for the verdict it ended on, and a branchless command on a repository
whose latest review ended is refused the same way, naming who ended it (with no
review here at all, `session_not_found`; with several live ones,
`ambiguous_session`); only
when the reviewer asks does `open --reopen` start a new round. `publish` checks
the turn, the review and the tip against the session file before it extracts or
groups anything, so a refused publish costs no model call.

**One exit-code rule.** Exit 2 when re-running the same command cannot help:
the command line is wrong, or the move is wrong for the review's state
(`turn_not_yours`, `turn_still_yours`, `nothing_to_publish`,
`feedback_item_unknown`, `session_ended`, `session_not_found`,
`ambiguous_session`). Exit 1 when the machine got in the way — the server, git,
the model, the config — and the same command may work once that is fixed. Every
server-gone failure (`server_not_running`, `server_unreachable`, a 503 mid-wait)
names `lightspeed open <branch> [base]`, which restarts the server and
re-attaches.

### Threads and items

Every reviewer item, line or general, opens a thread with a short,
session-stable id (`t1`, `t2`…, minted server-side on Send); `main` is the main
chat, where `--to main` lands. What the agent reads after each Send is one item
per thread the batch touched:

- `id` and `status` — `new`, `reply`, `resolved` or `reopened`;
- `at` (`file:line`) and `selected` for a line thread;
- `you` — the agent's own last words in that thread, so it answers in context;
- `reviewer` — the reviewer's new words (a list when there are several).

A thread reply and a Resolve/Reopen toggle are items in the batch like any
other (`{type: "reply" | "resolve", thread, …}`) and travel with the next Send.
`t4 resolved` means, for a question, "no further questions", and for a change
request "I agree with what you last said" — not a withdrawn request. The agent
answering in a resolved thread reopens it. Items from
a v2 session carry no id; the page shows them as read-only legacy threads.

### Removed verbs

`wait`, `ask`, `say` and `start` were removed in 3.0. Each answers
`removed_verb` with `'<verb>' was removed in 3.0, run lightspeed for your next
step` (exit 2), so an agent still running a stale skill is pointed at home
rather than left guessing.

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

lightspeed open <branch> [base] --intent "<why>"
  # base defaults to main. Extracts diff → LLM groups → opens browser, prints
  #   the round, then waits for the reviewer's first Send and prints the batch.
  # On a live review it re-attaches instead: no new round, --intent not needed,
  #   just the wait (and the held batch, if the agent is digesting).
  # --intent is REQUIRED when opening fresh, and repeatable: why the branch
  #   exists, written by the calling agent. Missing → `intent_missing`, exit 2,
  #   before any LLM work
  # Flags: --intent "<why>", --no-open, --reopen, --base <ref>, --model <name>

# The turn verbs. `work`'s plan is the FIRST positional; `reply` and `publish`
# say what they say with `--to <id> "<text>"`, repeatable:
#   lightspeed reply --to <id> "<text>" [--to …] [branch] [base]

lightspeed reply --to <id> "<text>" [--to <id> "<text>"…] [branch] [base]
  # Every answer of a discussion turn in one call, each under its thread
  #   (`main` = the main chat). Hands the turn back and waits for the next Send.
  # Legal while digesting; from working only while HEAD is unmoved and the
  #   tree unchanged since work. Unknown id → `feedback_item_unknown`, exit 2.

lightspeed work "<plan>" [branch] [base]
  # Ends the discussion: the reviewer's header names the plan, and they can
  #   only queue until the agent publishes. Waits for nothing.
  # Legal only while digesting: otherwise `turn_not_yours`, exit 2.

lightspeed publish --intent "<what>" [--to <id> "done: …"] [branch] [base]
  # Ends a working turn: new commits become the next round (re-grouped), the
  #   `--to` notes land in their threads, the reviewer's queue drops into the
  #   round. Waits for the next Send.
  # Refused while digesting (`turn_still_yours`) and on an unmoved HEAD
  #   (`nothing_to_publish`, naming `reply`), both exit 2 — checked against the
  #   session file before any extraction or model call.
  # Flags: --intent (required, repeatable), --to, --model <name>

lightspeed approvals [branch] [base]
  # Names the files behind the counts an ended review reports: approved, swept,
  #   unapproved. Run it when something turns on which file, not by default.
  # Flags: --full (every path, not the first 50 of each list)

lightspeed end [branch] [base]
  # Agent-initiated session end

lightspeed serve
  # Runs the review server in the foreground until it is stopped. `open` spawns
  #   this in the background, so it is only needed for debugging

lightspeed feedback [list | show <id> | prune --before <date>]
  # Reads the durable feedback ledger. Bare, it summarises every recorded review
  #   comment across repositories; `list` filters, `show` prints one in full,
  #   `prune` deletes records older than a date, atomically
  # Flags: --repo, --since, --cursor, --limit, --verdict, --file, --with-patches,
  #   --max-bytes, --format toon|jsonl|md (list); --before, --dry-run (prune)

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

lightspeed init --agent <id> [--scope global|project] [--config]
  # Writes the integration instructions into the file one coding agent reads,
  #   and a starter .lightspeed.conf.json with --config (never over one that
  #   exists). Safe to re-run; --dry-run reports what it would write and changes
  #   nothing. The agent must be restarted before it sees a skill written now.
  #   The skill is stamped (see Skill freshness below)

lightspeed skill --agent <id>
  # Print the integration instructions in the dialect one coding agent expects,
  #   stamped like init's; redirect stdout into the file that agent reads.
  #   codex, opencode and vscode get it between the lightspeed:start/end
  #   markers, like init's block. --agent defaults to pi.
  #   pi → .pi/skills/lightspeed/SKILL.md (repo) or ~/.pi/agent/skills/… (machine)
  #   claude-code → .claude/skills/lightspeed/SKILL.md or ~/.claude/skills/…
  #   codex → append to AGENTS.md
  #   opencode → append to AGENTS.md
  #   vscode → .github/copilot-instructions.md
  # The one command whose stdout is markdown, not TOON — it is a document
  #   generator. Errors are still TOON; unknown id → invalid_arguments, exit 2
```

### Skill freshness

An agent reads its skill once, at startup, and trusts it; an upgrade that
removes a verb leaves every installed skill teaching it. So every skill `init`
or `skill` writes carries one stamp line (under the frontmatter, or first in the
plain dialect and inside the `<!-- lightspeed:start -->` block):

```
<!-- written by lightspeed 3.0.0 for pi; content 0123456789abcdef; a later lightspeed refreshes or reports it, and never overwrites an edit -->
```

`content` hashes the skill as written. Before every command except `init`, the
CLI reads each path `init` can write — the machine-wide ones under `HOME` and
the project ones under the working directory, no network, one read per path —
and for each lightspeed skill it finds:

- stamped, unedited (hash matches), stamp version ≤ the CLI's, content differs
  from what this CLI renders → rewritten in place, silently, when it is
  machine-wide (under `HOME`); reported, never rewritten, when it is a project
  skill, since a rewrite would leave a tracked file dirty behind the user's back;
- stamped and current → left alone;
- unstamped (hand-written or pre-stamp), edited since stamped, stamped by a
  newer lightspeed, or not writable → left alone and reported;
- a stamp line in a shared instructions file outside the lightspeed:start/end
  markers → reported, never rewritten, since nothing says where it ends.

A reported skill adds `skill_stale[N]{path,problem,fix}` to every TOON answer of
that run, successes, failures and help pages alike; `fix` is
`lightspeed init --agent <id> [--scope project], then restart your agent`. A
shared instructions file with neither a lightspeed block nor a stamp is not a
lightspeed skill and is never read further. `init` is exempt because it is the explicit install and
its `--dry-run` writes nothing. `skill` prints its markdown untouched. Tests that
spawn the CLI point `HOME` at a temporary directory, so a run of the suite never
rewrites the developer's own skills.

### Session Identity (multi-session)

Session key = `sha256(repoRoot + ":" + branch + ":" + base).slice(0,16)`.

Every command takes `<branch> [base]` explicitly — same pattern as lavish's `<html-file>`. This makes multiple concurrent sessions unambiguous (different repos, different branch pairs).

**Convenience:** if `<branch>` omitted and exactly one active session matches cwd repo, use it. Ambiguous → structured error listing candidates.

## Output Examples (TOON)

### Home view (content first)

```
bin: ~/.local/bin/lightspeed
description: Semantic diff review with targeted agent feedback
repo: /home/me/app
sessions[1]{branch,base,round,turn,pending}:
  feature-auth,main,1,agent digesting,0
next:
  reread: "Lost the batch? Run `lightspeed open feature-auth main`: it hands back the batch you are digesting at once, and posts nothing"
  talk: "Anything that needs the reviewer — an answer, a doubt about a change request, a question of your own → one call, every reply in it: lightspeed reply --to t1 '<answer>' --to t2 '<answer>' feature-auth main"
  work: "Nothing left to discuss and something to change (clear change requests go straight here) → lightspeed work '<plan>' feature-auth main, then edit, test, commit and publish"
  ambiguity: "Anything ambiguous in a change request? Ask now with reply: asking is cheaper than redoing a round built on a guess."
  rule: "You may leave items unanswered. End this turn with reply or with work, never both."
```

Every row states the turn, because the turn is what decides which command is
legal next, and home closes with the one next step for the session it names — so
an agent that lost its place (or ran a removed verb) finds it here.

On the reviewer's turn home asks the server whether a waiting command is parked
on the session (`GET /api/session/:key/presence` → `{waiting}`; no server means
nobody). Only when nobody is listening does it say to run `open`: with a wait
already parked it says `listening:` — leave it running, since a second `open`
would supersede it; but if the agent cannot see that command's output (a
leftover from a killed shell), run `open` now: the newest wait takes over and
the old one exits `superseded` — and with a Send nobody received it says `receive: the
reviewer sent N items — \`lightspeed open <branch> <base>\` receives them`.

### Empty state (definitive)

```
bin: ~/.local/bin/lightspeed
description: Semantic diff review with targeted agent feedback
repo: /home/me/app
sessions: 0
message: no active review sessions
help[1]: "Run `lightspeed open <branch> [base] --intent '<why this branch exists>'` to open a review; repeat --intent once per reason"
```

### open (the round, then the first batch)

`open` prints two TOON documents, each led by `round:` — the round it opened,
before the wait, and the batch that ended the wait. `turn` and `round` lead
both, because they are what the next command has to be chosen against; `next:`
closes the batch, so the decision rule is the last thing the agent reads.

```
round: 1
turn: reviewer
session:
  key: a3f8c21b9e4d5f60
  branch: feature-auth
  base: main
  intents[1]: replace session cookies with signed tokens
  url: "http://127.0.0.1:4388/session/a3f8c21b9e4d5f60"
ledger:
  status: on
  path: ~/.lightspeed/feedback
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
message: the review is open — give the reviewer the url; waiting for their first Send
next:
  if_killed: "Killed or timed out before the reviewer's Send? Re-run exactly this — it posts nothing twice: lightspeed open feature-auth main"
round: 1
turn: agent digesting
items[2]:
  - id: t1
    status: new
    at: "src/api/users.ts:42"
    selected: "const user = await db.user.create({ data: { name, email } });"
    reviewer: Wrap this in a transaction
  - id: t2
    status: new
    reviewer: "Overall good — why was oldFunction removed? Billing still needs it"
next:
  talk: "Anything that needs the reviewer — an answer, a doubt about a change request, a question of your own → one call, every reply in it: lightspeed reply --to t1 '<answer>' --to t2 '<answer>' feature-auth main"
  work: "Nothing left to discuss and something to change (clear change requests go straight here) → lightspeed work '<plan>' feature-auth main, then edit, test, commit and publish"
  ambiguity: "Anything ambiguous in a change request? Ask now with reply: asking is cheaper than redoing a round built on a guess."
  rule: "You may leave items unanswered. End this turn with reply or with work, never both."
```

### reply (what landed, then the next batch)

Before the wait, what landed and the exact command that recovers a kill. Then
the items the batch touched, one per thread: `you` is the agent's own last words
there, `reviewer` the reviewer's new ones. A uniform list prints as a table. A
batch holding resolves spells out what they mean on a `resolved:` line.

```
round: 1
turn: reviewer
replied[2]: t1,t2
message: replied; waiting for the reviewer's Send
next:
  if_killed: "Killed or timed out before the reviewer's Send? Re-run exactly this — it posts nothing twice: lightspeed reply --to t1 'one transaction already' --to t2 'billing moved to v2 last sprint, nothing calls it' feature-auth main"
round: 1
turn: agent digesting
items[1]{id,status,at,selected,you,reviewer}:
  t2,resolved,"src/billing/legacy.ts:12",const oldFunction = (x) => x * 2;,"billing moved to v2 last sprint, nothing calls it","fine, keep it removed"
next:
  resolved: "t2: the reviewer agrees with your last words there — if that was a change, implement it (work); it is not withdrawn"
  talk: …
  work: …
  ambiguity: …
  rule: …
```

### work

```
round: 1
turn: agent working
plan: wrap the user writes in one transaction
message: "the reviewer's header names this plan; they can queue, not send, until you publish"
next:
  publish: "Edit, test and commit, then → lightspeed publish feature-auth main --intent '<what this round changed>' --to t1 'done: <what you did>' — it waits for the reviewer's Send, so run it in the foreground and never under a timeout; if it is killed anyway, re-run the same command — it posts nothing twice"
  stuck: A question for the reviewer? Publish what you have and ask in the new round. reply works from here only while nothing has changed since work.
```

### publish (ended by the reviewer)

`publish` prints the round it opened (as `open` does) and then the batch; a
Send & End closes it with the approval verdict and nothing left to do.

```
round: 2
turn: ended
ended: true
items[1]{id,status,you}:
  t1,resolved,"done: one transaction around create + audit"
approval:
  verdict: signed-off
  approved: 23
  unapproved: 0
  swept: 0
  total: 23
endedBy: reviewer
help[2]: "The reviewer ended this review; verdict: signed-off","Run `lightspeed approvals feature-auth main` to name the files behind those counts — which were approved, which were swept, which nobody signed off on"
next:
  done: "The review is over. Only if the reviewer asks for another round: `lightspeed open feature-auth main --reopen --intent '<why>'`"
```

### Refused moves (stdout, exit 2)

Every refusal is answered with the one move that is legal instead. The agent
reads failures the way it reads results, so the refusal is structured and the
fixing command names this session. `session_ended`, `session_not_found` and
`ambiguous_session` exit 2 too: re-running the same command cannot help.

```
error:
  code: turn_not_yours
  message: "work is not yours to run: the reviewer holds the turn (turn: reviewer)"
  detail: "the turn moves to you when the reviewer's Send is delivered to a waiting `lightspeed open`, `reply` or `publish`, and never before"
help[1]: "Run `lightspeed open feature-auth main` to listen for the reviewer's next Send — it waits for the reviewer's Send, so run it in the foreground and never under a timeout; if it is killed anyway, re-run the same command — it posts nothing twice"
```

```
error:
  code: nothing_to_publish
  message: "HEAD has not moved since the last round, so there is no round to open"
  detail: publish opens a round on new commits; with nothing committed there is only talk
help[1]: "Commit your changes and publish again, or say why not: `lightspeed reply --to t1 '<answer>' feature-auth main`"
```

```
error:
  code: removed_verb
  message: "'wait' was removed in 3.0, run lightspeed for your next step"
  detail: "`open`, `reply` and `publish` wait for the reviewer's Send themselves; re-run the one that was waiting"
help[1]: "Run `lightspeed` (no arguments): it names the one command to run next"
```

### Structured error (stdout, exit 1)

```
error:
  code: config_missing
  message: .lightspeed.conf.json not found in repo root
  detail: lightspeed requires explicit `model` and `thinking`
help[2]:
  Create .lightspeed.conf.json with {"model": "<provider/model>", "thinking": "off"}
  Then re-run `lightspeed open feature-auth main`
```

## Project Structure

```
src/
  cli.ts                → AXI entry: runAxiCli wiring, command routing
  commands/
    home.ts             → Content-first home view
    open.ts             → Diff + LLM group + open browser, then wait; re-attach on a live review
    round.ts            → The round `open` and `publish` share: extract, group, post, print
    reply.ts            → Every answer of a discussion turn, each under its thread; then wait
    work.ts             → Discussion over, code changes next; waits for nothing
    publish.ts          → New commits become the next round; then wait
    listen.ts           → The wait every turn-ending command ends in: batch, ack, print
    long-poll.ts        → The long poll itself, forever, no timer
    to-args.ts          → `--to <id> "<text>"`, the one two-valued flag
    verb-args.ts        → The grammar the verbs share: message first, then session
    removed-verbs.ts    → wait/ask/say/start answered `removed_verb`, pointing home
    end.ts              → End session
  config.ts             → Loads .lightspeed.conf.json, fail-fast validation
  diff-extract.ts       → Git diff extraction + stats
  llm/
    pi-client.ts        → @earendil-works/pi-ai SDK wrapper (Context, stream)
    providers.ts        → Configured providers: builtin overrides + custom ones
    prompts.ts          → System + user prompt templates (project-owned)
    schema.ts           → Typebox schema for grouping output + validator
    grouping.ts         → diff → LLM → validate → repair loop → DiffGroup[]
  turn.ts               → The turn: who holds it, and how every answer states it
  turn-moves.ts         → The turn machine as pure record transitions
  turn-help.ts          → The turn rule, the `next:` rule and every help line naming a move
  threads.ts            → Threads read off the conversation; ids minted per item
  session-migrate.ts    → 2.x session records read as v3 (reading → digesting)
  server.ts             → node:http: UI, feedback API, long poll, SSE
  router.ts             → Tiny method+path router (~60 lines)
  session-store.ts      → JSON state (~/.lightspeed/)
  html-template.ts      → Review page HTML
  output.ts             → TOON builders, help[] composition
  paths.ts              → State dir, port, host
  skill.ts              → Generated agent skill content
  skill-install.ts      → Where each agent's skill goes, and writing it there
  skill-stamp.ts        → The version stamp on an installed skill
  skill-freshness.ts    → Refreshing stamped skills, reporting the rest (skill_stale)
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

Only a diff with **one changed file** skips the LLM — there is nothing to order — and it becomes one `All Changes` group. Every larger diff goes to the model, because git's alphabetical file order is the exact defect grouping exists to fix. `open` and `publish` report it:

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
    { "type": "message", "comment": "Overall looks good" },
    { "type": "reply", "thread": "t3", "comment": "fine, keep it" },
    { "type": "resolve", "thread": "t3", "resolved": true }
  ]
}
```

That is the wire shape the page POSTs to `/api/session/:key/feedback`. The
server mints a thread id (`t1`, `t2`…) for every annotation and message on
arrival; `reply` and `resolve` name a thread that already exists. What the agent
reads is not this list but the items it folds into — one per thread, see
[Threads and items](#threads-and-items).

Rules that make this unambiguous for an agent:

- `file` is always attached — the browser knows which file block the selection came from.
- `+`/`-` prefixes preserved in `selected_text` so the agent knows old vs new code.
- Selection is constrained to a single file block; cross-file selections are split into one annotation per file.
- `group` is included as orienting context (which concern the reviewer was looking at).
- One flat `prompts[]` array on the wire — annotations, messages, thread replies and resolves in the order the reviewer queued them. No parallel `annotations[]` block.
- A batch that carries none of them says so definitively: `message: no feedback was queued when this review ended`, never a bare `items: []`. Only an ended review can answer with nothing queued — on an open one, the waiting command keeps waiting until something is.

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

**A round waits for the reviewer.** An agent finishing mid-review used to replace the diff the instant it landed: the reviewer was thrown to the top of a review that had been re-cut under them, in the middle of a group, having asked for nothing. A new round now waits behind an offer in the header — `Round 2 is ready · 4 files`, plus `· 2 comments kept` when the reviewer is holding unsent words, drawn by `dom/round-offer-mount.ts` off the whole session it holds — and goes on screen only when it is pressed. What counts as being mid-review is `holdsRound` in `src/browser/round-offer.ts`: scrolled off the top, inside a chapter, or holding queued words. A reviewer showing none of the three has nothing to lose, so the round is applied silently, exactly as before; and an ended review is never held, because that is the review stopping rather than a round to be taken. One offer stands at a time and it is always the newest round: a reviewer who read through two of them is not owed two presses. Applying a round is one function (`applyRound` in `dom/session-events.ts`), reached from the event and from the press alike, so the two can never draw different reviews.

**The arrival is announced once.** The header's offer alone was missable — it appears in a corner nobody is reading — so a round that has to wait is also announced by a card over the review (`renderRoundPopup` in `round-offer.ts`, mounted by `dom/round-popup.ts`): the round by the number the reviewer counts, its size, the promise that their queue survives it (`Your 2 comments stay queued — they go out on your next send.`, said only when there is a queue to reassure anyone about), and two honest answers — `Open round N`, or `Keep reading`, which is also what Esc says. Dismissing is not declining: the card folds itself into the header's offer — shrinking away toward the corner the offer lives in — the offer glows once in answer, and then a spark rides the button's border (`offset-path: border-box`) until it is pressed. That orbit is the page's one ongoing animation, allowed because it tells the reviewer nothing new — it holds the place they said they would come back to — and it ends with the offer, however the offer ends: taken from either mouth, or overtaken by the round going on screen. Each round is announced once — a dismissed card never returns for the same round, a newer round is fresh news even over the last card's fold — and taking from card or header clears both, so neither goes on standing for a round already on screen. Under `prefers-reduced-motion` the card is simply there and simply gone, and the spark does not exist.

**The turn is visible, and it is the only thing that decides what the compose box does.** The presence frame carries separate facts: `waiting` — an agent's command is parked on the long poll right now — `turn`, the review's own record of whose move it is, and, while the agent digests, `items`, the number of threads in the batch it holds. The header states a short label off them, and the turn wins: "Agent is reading your 5 items" while it digests, "Working on: _plan_" while it works (the plan `work` declared; "Working on your feedback" without one), and on the reviewer's turn "Agent is listening" or "Agent isn't listening" — a fact about a live connection, never a timer. The label rides in `title` too, with the send-anyway advice on the reviewer's turn ("no agent is listening — Send anyway, it is handed over when the agent next listens"), because a plan in the header's corner runs long and gets cut off. The tooltip is a hover-only convenience — keyboard and touch never reach a `title` — and not where the status is kept: the conversation panel is. The wording lives once, in `browser/turn-words.ts`, because the foot of the conversation says it in full: a line with three breathing dots in the place the answer will be written, shown on the agent's turn only. The served page states the turn as well — it is on the record, so a reload mid-turn is right in the first paint rather than one SSE frame later. A presence frame with a mode this page does not know reads as digesting, the strictest lock. A reviewer who asked for less motion keeps the line, its dots up and still. When the SSE stream drops, a small "Connection lost — reconnecting…" chip (`#lsr-connection`) shows until it reopens, because a page that silently stopped hearing the agent reads as an agent that stopped talking — and the header presence greys to "Connection lost" (`data-connection="lost"`, the last known label in its `title`), since it can no longer vouch for who is listening.

**The lock follows the phase; End is never taken away.** While the agent _works_, the primary button reads `Queue` and stays live: a press — or Enter in the box — turns the general comment into a pill in the tray the line comments, thread replies and resolves already queue into (`queueComment` in `src/browser/dom/panel-mount.ts`), empties the box, and can be repeated as often as the reviewer likes; the compose note says "Queued items go into the next round." It is one tray, not several queues: one order, one × to take a pill back, one localStorage record, and the reviewer's next Send on their own turn carries all of it in the order queued, with whatever is in the box last. Each press puts the caret back in the box and says `Queued — N waiting for your next Send` into a visually-hidden polite live region, because the box emptying and a pill appearing above it are nothing a screen reader following the box would notice. A general comment's pill wears no round badge — the badge warns that lines may not line up, and a message has none. While the agent _digests_, the batch must not change under it: the box, Send, thread replies, resolve toggles, the line popup and pill removal are locked ("Locked while the agent reads your feedback — you can still read and approve."), and the Send button still counts what is queued, disabled. With the turn back, the button reads `Send to Agent` again — `Send 3 to Agent` while three pills wait, because the queue does not go out by itself. So does it when no agent is listening: that press leaves the page, handed to the agent's next waiting command, so `Queue`, which promises a pill that can still be taken back, would be the wrong word. The end button changes its words rather than going away — `End without Sending` on the agent's turn — because the queue is not the reviewer's to send onto somebody else's turn, and finding that out from the conversation afterwards is how a reviewer loses six comments. The done card and the round card make the same promise in the other direction: what is queued stays queued. The server enforces the same lock: a Send while the agent holds the turn is refused 409 `agent_holds_turn` and the compose note says "Not sent — …"; End without Sending is always accepted, and a Send & End that carries words is refused the same way while the agent holds the turn, since nothing would ever hand those words to the agent.

**The conversation is threads.** Every item the reviewer sent is an `article.lsr-thread` with its whole exchange stacked under it — reviewer, agent, reviewer…, one flat block per message, oldest first — headed by its id (`t3`), its file caption for a line thread, and a **Resolve** toggle, with a reply box at its foot. Threads are read off the conversation (`src/threads.ts`), never stored beside it, and placed in the round segment the item opened in, so a thread stays where it was read. A reply typed in a thread box is a pill naming its thread (`reply in t3`), and so is a resolve: both travel with the next Send, so answering three threads is still one batch for the agent. The fold happens at the press — a resolved thread shrinks to its head plus its first comment as a one-line summary, marked "resolves on your next Send" until it goes — and pressing again takes the queued toggle back out of the tray. The agent's `reply --to t3` and `publish --to t3 'done: …'` land in the thread they name; `--to main` lands in the main chat, and each `--to main` post is its own card: no Resolve toggle and no reply box, since the reviewer answers it from the general comment box. The agent answering in a resolved thread reopens it. Every thread the agent spoke in since the reviewer's last Send is marked **new** and moves to the foot of the current round, latest activity last, so an answer in an old or resolved thread is never left rounds above the fold. Items from a v2 session carry no id: they render as read-only legacy threads, with nothing to reply to or resolve.

**A comment leads back to its lines.** In the panel, an anchored comment is captioned by its file's basename alone — the full path waits in the tooltip, and the chapter name that used to trail it is gone: the chapter heading is on the diff, and repeating it under every comment glued a round's card into one unreadable block. The caption is a press: it enters the chapter holding the file as a real focus press (reported, remembered — a reload after a jump opens where it landed), unfolds the file if its own approval had shut it, and scrolls to the very line the anchor names, in either layout, falling back to the file when the diff on screen no longer prints that line and doing nothing at all for a file the round does not carry. The panel only says which file and where (`onJump`); getting there is the diff's craft (`reveal` in `dom/diff-mount.ts`, `findLine` in `dom/line-numbers.ts` — the inverse of the numbers a selection is anchored by).

**Enter sends.** In both comment boxes — the popup's and the panel's — Enter is the button beneath it: it queues the annotation, or sends the general comment along with whatever is queued — or, on the agent's turn, queues the general comment as a pill, and the placeholder says which (`Enter sends…` / `Enter queues…`). Shift+Enter and Alt+Enter break the line, and so do Ctrl+Enter and Cmd+Enter, which browsers type nothing for and `src/browser/dom/enter-key.ts` therefore types itself. An Enter on an empty box does neither: nothing is sent, and no blank first line is typed, because the placeholder is what tells the reviewer Enter is waiting for a comment. Queued pills are sent by the button alone — a stray Enter in an empty box must not fire off a half-read review.

**Nothing dies on a reload.** What the reviewer has done and not yet sent survives the page going away, kept in `localStorage` under one record per session key (`lsr:memory:<key>`, read and written by the pure `src/browser/review-memory.ts`; the mounts hold no state it does not). Two halves with two lifetimes. The reviewer's own unsent words — the queued pills, each with the file, group, selected text and line anchor it would be sent with (a general comment queued on the agent's turn is a pill too, and leaves the draft as it becomes one), and the general comment box as far as it is typed — outlive everything, including a re-group, exactly as they already outlive an agent reply in the open page; a send is what clears them, and a send the server refused clears nothing. Where they were reading — which groups and files stand open, and the review's scroll offset — is stamped with the round it was read in and handed back only to that same round: a re-group replaces the diff those group indices, paths and pixels point into, so the new round opens as it is rendered and at the top, which is what the page does live over SSE too. That stamp is also what keeps the store clean: the paths of a round that has been replaced are dropped the first time the new one reports what it has open. The popup's own comment box is deliberately not kept — it belongs to a live selection that a reload has already taken away, and a comment restored without it would be anchored to nothing.

Storage degrades rather than fails. A record written by another version of the page is dropped on sight rather than migrated, malformed JSON and fields of the wrong type read as the empty record (a page that throws on load is a worse failure than a queue that comes back empty), and a store that is blocked or full costs the memory and nothing else — the write gives up the other reviews first, then this review's place in the diff, and never the queue. Eight reviews are remembered at once, oldest write evicted, so a machine that reviews a branch a day does not grow a store forever.

**Text wraps, the panel does not scroll sideways.** Chat is full of tokens with nothing to break at — a type name, an attribute, a path — and the panel and the popup are 22rem wide. Both wrap mid-token (`overflow-wrap: anywhere`, which also shrinks min-content and so keeps a flex item inside the popup) rather than growing a horizontal scrollbar the reviewer must drag to read the end of their own sentence. Wide quoted code wraps too: it keeps its indentation from `pre-wrap` and scrolls only vertically, past 8rem. The diff itself is untouched and may still scroll sideways — a diff is code at its own width, not prose.

**Approved checkboxes.** Each file carries an `☐ approve` checkbox under its diff, where reading the file ends; ticking it collapses that file and increments the group header counter (`1/3 approved`). Each group header has a tick-all, which ticks every file in the group.

A group is nothing but its files, so a group whose files are all ticked is approved: its tick-all fills in, the card dims, and the group collapses — there is nothing left in it to read. In focus mode the collapse shuts the chapter back onto its gate card, ticked, and the page moves on to the next chapter with something still unticked, wrapping round; every chapter's card offers its tick, so a sweep chapter is a press on its card and not a reading, and the last chapter of a review can be settled from its card like any other. With nothing left to read, the finished card stays. The tick that approves the last file of the review also puts a card over the page — "Every file is approved", with an **End review** press that is the sidebar's Send & End (queue and comment included) and a **Keep looking** that sends nothing; it goes up on the crossing only (`src/browser/approval-crossing.ts`), never for a page that opened fully approved, and comes down if the finish comes undone. Untick a file inside it and the group un-approves and that file's diff opens again, because that tick is the reviewer asking to look once more; the chapter's own tick, undone, opens nothing — an untick is a withdrawal, not a request to read, and made on the card it leaves the card standing, so the tick and the press through the gate never take one press for the other. Only what actually changed hands is opened or shut: a file or a group the reviewer opened by hand is theirs to close, so a tick elsewhere leaves it exactly as they left it. Group approval is derived from the ticked paths and never stored — the tick-all box is the whole of it, so the mark cannot drift from the boxes it is made of, and nothing per group reaches the server. State is client-side and persisted in the session JSON for reload survival; a session loaded with a group already fully ticked renders it marked and collapsed.

**Approval across rounds.** A re-group withdraws approval, except from files a blob sha proves untouched since the reviewer ticked them: those arrive in the new round already ticked and dimmed. Two independent facts are derived in `src/rounds/history.ts` from `SessionRecord.rounds[]`, never stored twice:

- `Approval` — where the file stands with the reviewer: `needs-reapproval` (approved, then edited by the agent), `unapproved` (never approved, whether on its first round or its fifth), `approved` (ticked and provably unmoved). Served on `/api/session/:key/data` as `approval` and written to the ledger as `round_file.approval` (with `round_end.approved`/`carried`). The grouping prompt is told none of it: the model orders the diff, and the diff does not change with who has read it.
- `previous` grouping — what the prompt _is_ told about earlier rounds: last round's groups, in the order the reviewer read them, as `{ name, files }` read off `SessionRecord.groups` by `publish` before the server overwrites it. It goes in as a data-only header section, sized against the header it is not part of: `MAX_PREVIOUS_CHARS` (10,000) is the ceiling on the whole section, heading and trailing blank line included, and what it actually gets is whatever the intent and the inventory left spare above `MIN_PATCH_CHARS` (20,000) of room for patches — down to nothing, in which case the heading goes too. What does not fit is cut at a whole group boundary and says how many groups and files it left out. The rule asking the model to hold that reading order lives in `GROUPING_SYSTEM_PROMPT`, so the cacheable prefix stays identical between rounds. Only a round a model grouped is carried: `SessionRound.grouping` records the mode (absent on rounds written before it, read as `llm`), and a `fallback` or `skipped` round — one `All Changes` group over the whole diff — is never handed back, because a catch-all always supports the rule and one degraded round would pin it forever. Stability is asked for and never enforced: no post-pass rewrites the model's answer to match, and a first round sends no section at all.
- `firstSeenRound` — which round the file entered the review in, which is not git's `added`. Ledger-only, as `round_file.first_seen_round`: sessions are overwritten and deleted, so the mining agent cannot otherwise ask how long a file sat unapproved.

Approval never reorders the review: a file keeps its place in its group and a group keeps its place in the review, whatever the reviewer has ticked. Ticking still collapses — the file, and the group once all of its files are ticked — but nothing changes place. Files once sorted `needs-reapproval → unapproved → approved` inside their group, and the prompt asked for groups of nothing but approved files last; both are gone, along with the `already approved` mark the second was read off, because a review that has rearranged itself since the reviewer last looked takes their place in the reading away from them, which costs more than any order it buys. Order is the model's, top to bottom, under the two rules the code keeps whatever came back — the `Tests` chapter trails the chapters a reviewer ranks, and every chapter tiered `sweep` trails them all — both settled once in the `groups` array itself (`trailTests`, then `trailSweeps` in `src/group-tier.ts`, after the tier is final), never re-sorted by a renderer: the header bar, the survey lane, "Chapter n of m", Previous/Next and the chapter a finished one moves on to all name a chapter by its place in that array, so one order is the only way they can agree. And the page opens as the survey alone — the group index — with no diff anywhere on it: a chapter is drawn only once it is opened, and then it is the only thing on the page. The index is a plain list — name, files, ±lines, approved counter, press to open — and it singles no group out: which one to read first is the reviewer's call, and the page has no business making it for them. A binary file has no blob sha, so its approval is never carried.

**The header bar knows where you are.** The header draws one segment per group, each as wide as the lines its group changed (`src/browser/progress-bar.ts`) and filled as its files are ticked. The segment of the chapter standing open in focus mode wears an accent ring — `data-current`, stamped at draw time from the focus the diff already holds — so a reviewer deep in a long review can glance up and see which slice of the whole they are in. Each segment is also a real button carrying its chapter number: a press is the same focus move an index entry makes — from the survey or from any other chapter — wired on the header's own host, since the bar lives outside the diff root the other focus controls listen under. The bar stands a spacing step taller than it used to, because a press target is not a picture; a quiet muted ring answers the hover so the accent ring keeps meaning "you are here". And on the survey itself the chapter names speak at the title size — the index is the one screen the names are the content of, with no code to shout over. Their subtitles, the rationales, are not on the survey: each is said once, at the lead step (`--lsr-size-lead`), on its chapter's gate card, set apart by its ink alone — `--lsr-lead-ink`, the accent's hue at a lightness neither the body text nor the accent's presses wear, with no stripe, label or box — so it is read before the press. On the survey nothing is being read, so nothing is marked; a tick patches the bar in place and never touches the mark, and every way in or out of a chapter is a redraw, which is what moves it.

**Diff against the approved form.** A `needs-reapproval` file carries a per-file switch — `Branch diff` / `Since approval`: the reviewer's own tick is a second thing to read the file against. `Since approval` replaces that one file's diff with `git diff --find-renames <head of the approving round> <head of this round> -- <every name the file has gone by>`, under one line saying why the view takes no feedback and nothing else — the rounds in between were once quoted here, intents and commit subjects, and are gone: the conversation panel already says what the agent said it was doing, and a second copy above the diff read as noise between the reviewer and the change. `src/rounds/approved-form.ts` decides which commits and names those are (pure, from `SessionRecord.rounds[]`); `GET /api/session/:key/approved-form?path=` asks git and answers `404 no_approved_form` for any file the rounds do not put in that state.

A file nobody ever approved can still have moved under the reviewer: the agent kept editing it across rounds, and the branch diff shows the whole change again with nothing marking the six lines that are new since they last read it. Where the blob shas of the last two rounds prove such an edit, the row carries `Branch diff` / `Since last round` instead — the same question put to a different pair of commits, the two rounds' heads. `src/rounds/last-round-form.ts` decides it (pure, only ever the newest pair, and refusing `needs-reapproval` files: the approved form already covers everything since the tick, so one file never carries two comparisons), the page offers the switch by the very same comparison (`src/browser/round-changes.ts`, over the rounds the payload already carries), and `GET /api/session/:key/last-round-form?path=` answers `404 no_last_round_form` everywhere else. All the rest — fetched on press, cached for the page, dropped with the round, annotation refused off the branch diff, the no-diff states below — is the approved form's machinery shared whole; only the words differ, because a sentence about "the form you approved" would claim a verdict nobody gave.

`Branch diff` is pressed on every load and every new round — a withdrawn approval means the file must be read whole again, and the other view answers a question the reviewer asks second. (A layout switch is not a new draw in that sense: it redraws the approved form for any file showing one.) The comparison is fetched on press, not shipped with the page, and cached for the life of the page only: a reload or a new round opens on the branch diff, since a new head commit is a different question, and a new round drops every cached answer with it. Annotation is refused unless a file shows the branch diff (`selection-fragments.ts` reads `data-form` as an allowlist), and the view says why: its line numbers belong to two commits of the branch's history, while the ledger's anchors are numbered against the branch diff. Neither commit is named on screen, so the note points at the press that gets the reviewer a view they can comment on rather than at a range they cannot see, and it is shown only where there is a diff — a state with none has no line numbers to be wrong about.

Why there is no diff, when there is none, is decided in one place — `approvedFormData()` in `src/server.ts` — and never guessed: `identical` (changed and changed back), `binary` (git has no lines for it, which includes a file that was text when it was approved), `unreachable` (a rebase or force-push took one of the commits), `unrecorded` (a round in the pair stored no commit, which is a session older than that field — explicitly not a rebase), and `oversize` (over 512 kB of patch measured in bytes, or more than git will hand over in one piece, with the exact `git diff` to read it). The page renders what it is told and asks git nothing.

Only one state is stated on screen: `needs-reapproval` carries the amber pill `changed after approval`. The others need no words — approved is a ticked, dimmed, collapsed row, and unapproved is an ordinary unticked one. One thing that is not a state is stated beside it: a file the reviewer annotated in the round before this one carries the violet pill `commented last round` — a different colour because the two can share a row and only one of them is a verdict — derived in the browser by `src/browser/commented-files.ts` from the conversation and the rounds the page already has, placing each entry by the rule the conversation panel places it by. A fully approved group reads the same way one level up: ticked, dimmed, collapsed. The dimming stops there rather than stacking, since opacity multiplies and a file dimmed inside a dimmed group would all but vanish.

## Session Lifecycle

1. **open** — creates the session and its first round, then waits; on a live session it re-attaches (no new round)
2. **active** — browser open, the agent's waiting command parked on the long poll
3. **Send** — the batch is delivered, the agent digests it, then `reply` (talk) or `work` → `publish` (a new round: fresh diff, re-grouped, SSE update, conversation preserved); session stays active
4. **re-run** — a waiting command that was killed is re-run as it was; nothing is posted twice
5. **Send & End** — final feedback + `ended: true`. Not an approval in itself: the ended batch payload carries `approval: {verdict, approved, unapproved, swept, total}` — counts, not paths, because the agent wrote the branch and already knows its files — and `endedBy`. `verdict` is `signed-off` | `partial` | `none` | `empty`, derived off the same account as the counts so the two cannot disagree; only `signed-off` is a sign-off, and `swept` counts the approvals a sweep lane took in one press, approved and unread. The ended `help[]` line carries only what those fields cannot — who closed it, that a sweep was involved, or that an older server reported no readable account — and never restates the counts. `lightspeed approvals [branch] [base]` names those files, and nothing runs it by default; it prints the first 50 paths of each list beside a `count` block read off the whole review, so a cut listing can never make a count lie, and `--full` prints every path. Agent must not reopen uninvited; `open --reopen` does it when asked
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
2. `lightspeed open feature-x main --intent …` extracts diff, calls Pi for grouping, opens browser — one command, TOON output with aggregates, then waits for the first Send
3. Browser shows groups in LLM order, syntax-highlighted unified diffs
4. User selects any diff text (including `-` lines) → popup → targeted feedback
5. User types general comments in conversation panel
6. The waiting command returns TOON items with exact selected text + comment, one per thread, and the turn with it
7. "Send" keeps session active; "Send & End" closes it
8. `publish` updates the session with fresh diff + re-grouping, preserves conversation
9. Multiple concurrent sessions work (different repos/branch pairs), disambiguated by explicit args
10. Unknown flag → exit 2; config missing → structured error + `help[]`; no sessions → definitive empty state
11. Invalid LLM output is repaired in-conversation (≤2 rounds) or degrades to `All Changes`
12. Diffs ≤7 files skip the LLM call entirely
13. Approved checkbox collapses a file and updates the group counter

## Resolved Questions

1. **Diff format:** Unified only (MVP)
2. **Group ordering:** LLM-determined, UI respects
3. **Multi-round:** Fresh diff on `publish`, conversation preserved
4. **Max diff size:** Skip binary, warn >10k lines
5. **Feedback format:** Selected text + **file** + comment, no line numbers
6. **LLM:** CLI owns prompts, uses the pi-ai **SDK** in-process, Pi-only MVP
7. **Multi-session:** Explicit `<branch> [base]` args per command; key = hash(repo+branch+base)
8. **Interface style:** AXI — TOON, content-first, contextual disclosure, structured errors
9. **Language:** TypeScript, run directly by Node ≥22.19 type stripping
10. **Config:** `.lightspeed.conf.json` in repo root; `model`/`thinking` required, fail fast. No env vars
11. **Ordering:** LLM returns an ordered array; position is the order, no `order` field
12. **Grouping threshold:** ≤7 changed files → skip the LLM
13. **Validation:** schema + coverage check, errors fed back into the same conversation, ≤2 repairs
14. **Waiting (`open`/`reply`/`publish`):** no `--timeout-ms`, no heartbeat; foreground, forever; re-run to re-attach
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

Reviewer feedback currently lives only in the session JSON, which `open`/`publish` overwrite and `end`
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
| D6  | Opt-out            | `"feedbackLog": "on" \| "off"` in `.lightspeed.conf.json`, **default `on`**; path + status reported in `open`/`publish` output.                                                                            |
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

| Trigger                                 | Record appended                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/sessions` (`open`/`publish`) | `round` (repo root/name/remote, branch, base, `base_commit`, `head_commit`, stats, groups) + one `round_file` per file (status, previous_path, blob shas, patch) |
| `POST /api/session/:key/feedback`       | `annotation` / `message`, one per prompt (a thread reply is a `message`; a resolve writes nothing), anchored to round + file                                     |
| `reply` / `publish --to`                | `agent_reply`                                                                                                                                                    |
| `end` / reviewer "Send & End"           | `round_end` including the set of files ticked `approved`                                                                                                         |
| next `publish` on the same branch       | `outcome` per annotation of the previous round                                                                                                                   |

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

- **Backbone (in scope)** — `src/rounds/`: a `RoundRecord` appended on every `open`/`publish` (index,
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

1. A full round — `open`, three annotations, a general comment, an agent reply, `end` — leaves
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
