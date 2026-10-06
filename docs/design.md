# lightspeed — design

This is the design reasoning behind lightspeed: the problem it solves and the
decisions that shape it, each with the reason it was made. It grew out of the
original spec. It is not a reference — for commands, their output and
configuration, read the [README](../README.md); where a decision is explained
there already, this page links to it rather than saying it twice.

## The problem

1. **Flat file lists are unreadable for large changes.** GitLab and GitHub show
   a branch in alphabetical file order. An embedded model call groups and orders
   the changed files by concern ("Schema changes", "API handlers", "Tests"), so
   related changes are read together. See [Grouping](../README.md#grouping).
2. **Giving an agent targeted feedback is tedious.** The reviewer selects any
   text in the diff, deleted lines included, and comments on it. The agent gets
   the exact selection with the comment, as a thread both sides answer in — no
   describing a file and line in words.

## Built for agents (AXI)

lightspeed follows the [AXI principles](https://axi.md): its first reader is an
agent, so the output is shaped for one.

- **The CLI never prints the diff.** The browser shows it; the agent wrote the
  branch and already has it. What the CLI prints is counts computed ahead
  (`files_changed`, `insertions`, the groups), not lists to count.
- **Failures read like results.** Errors are TOON on stdout with a code, a
  message and the one command to run next; stderr is for debugging only. An
  agent reads failures the way it reads answers, so a refusal has to be
  structured and name this session.
- **Every answer ends with what is legal next** — `help[]` or a `next:` rule
  naming only the moves the turn it just stated allows, so an agent is never
  offered a command that will be refused.
- **Content first.** Bare `lightspeed` shows the live reviews and the one next
  command, not the help, so an agent that lost its place finds it there.
- **Empty is said out loud.** `sessions: 0` with a message, never a silent empty
  list.
- **No interactive prompts.** They break agent use. The one exception is
  `login`/`logout`: human-run setup, refused without a terminal.
- **A skill, no session hooks.** The skill is the ambient context; hooks were
  dropped as YAGNI.

## The turn

> Discussion strictly alternates. The agent ends each turn by talking or by
> working, never both. Every command that hands the turn back also waits for the
> next Send.

The states, who may do what in them and which command ends each are in
[The turn](../README.md#the-turn). The reasons behind the rules:

**The turn moves to the agent on delivery, and on nothing else.** Not on the
reviewer's Send: a batch nobody is waiting for is held server-side as
`pending`. Only a batch handed to a waiting `open`, `reply` or `publish` takes
the turn, because only then is there an agent that has actually read it.

**One call is one turn.** `open`, `reply` and `publish` wait for the next Send
themselves, so there is no separate listening command an agent can forget to
run. This is why `wait`, `ask`, `say` and `start` were removed in 3.0: the wait
moved into the commands that end a turn. A removed verb answers
`removed_verb` and points at bare `lightspeed`, so an agent running a stale
skill is sent home rather than left guessing.

**Re-running is re-attaching.** The waiting commands take minutes to hours and
get killed — a harness timeout, a `serve` restart. The recovery is to re-run the
same command, never to open, end or reopen. So the server recognises a `reply`
it already has (by fingerprint, against the same batch or one not yet
acknowledged) and a `publish` whose head is already the last round's, and waits
again instead of posting twice. Every waiting command prints what landed and
`next.if_killed` — the exact command to re-run — before it waits. When the
words do not paste back as printed (a quote, backslash or line break), that
line names `lightspeed open <branch> [base]` instead: the words have landed, and
re-attaching waits for the same Send.

**The newest wait wins.** A session has at most one parked waiting command; a
new one answers the older `superseded: true`. An orphaned wait in a background
job can then never take the next batch into a terminal nobody reads.

**A delivery is not finished until the agent says it arrived.** The server
cannot see this for itself: the answer's bytes reach the client's kernel whether
anything reads them or not, so a command killed mid-delivery looks the same on
the wire as one that read every word. The batch stays on the session record
until the client confirms it (`POST /api/session/:key/delivered`), and every
re-attaching command is handed it again meanwhile. It is persisted rather than
held in memory because a `serve` restart in that window would lose the feedback
for good.

**Reply from working only while nothing changed.** `reply` after `work` is
allowed only while HEAD is the one `work` recorded and the tree still hashes to
the snapshot `work` took (`git diff HEAD --binary` plus each untracked file's
name and bytes). Then there is nothing half-written to protect and talking loses
nothing. Otherwise the agent publishes what it has and asks in the new round.

**No timer, no staleness unlock, no override.** A reload changes nothing: the
page reads the turn off the record it is served with. An agent that died holding
the turn is recovered by re-running the command it died in.

**The lock follows the phase.** While the agent digests, the batch must not
change under it, so composing, replying and resolving are locked; reading and
approving are not. While it works, the reviewer queues, and the queue goes out
with the next round. The server enforces the same lock (409 `agent_holds_turn`).
Ending is never refused, but an ending Send that carries words while the agent
holds the turn is: nothing would ever hand those words to the agent, whose next
call only hears that the review ended.

**One exit-code rule.** Exit 2 when re-running the same command cannot help —
the command line is wrong, or the move is wrong for the review's state. Exit 1
when the machine got in the way (server, git, model, config) and the same
command may work once that is fixed. Every refusal names the one right command.
`publish` checks the turn, the review and the tip before it extracts or groups
anything, so a refused publish costs no model call.

### Threads and items

Every reviewer item opens a thread with a short, session-stable id (`t1`, `t2`…,
minted server-side on Send); `main` is the main chat. What the agent reads after
a Send is one item per thread the batch touched, not the raw list the page
posted:

- An open thread carries everything said in it before this batch, oldest first,
  so the agent answers from the thread rather than from memory.
- A thread resolved in this batch carries only what it was about (`asked`).
- A line thread whose line reads differently in the round on show is marked
  `outdated` (`src/anchor-drift.ts` compares the two rounds' files in git);
  nothing is claimed when git cannot produce the older file.
- A resolve with words means "resolved with a last word — do what it says". A
  bare resolve means "I accept your last answer": for a change request, make
  the agreed change — it is not withdrawn. `next.resolved` spells this out by id.

The reviewer never sees a thread id: `t3` names nothing they wrote, so ids live
in `data-` attributes and a thread is labelled by its anchor or its first words.
Threads are read off the conversation (`src/threads.ts`), never stored beside
it.

## Session identity

The session key is the first 16 hex characters of a sha256 over the repository
root, branch and base. Every command takes `<branch> [base]` explicitly, so
concurrent reviews — other repositories, other branch pairs — are never
ambiguous. As a convenience, a command without a branch uses the one live review
of the current repository; with several it is refused `ambiguous_session`.

## Skill freshness

An agent reads its skill once, at startup, and trusts it; an upgrade that
removes a verb would leave every installed skill teaching it. So every skill
`init` or `skill` writes is stamped with the version and a hash of its content,
and every command but `init` checks the places `init` writes to. The rules and
the stamp are in [Keeping the skill current](../README.md#keeping-the-skill-current).
The two deliberate limits: a project skill is reported, never rewritten, since a
rewrite would leave a tracked file dirty behind the user's back; and an edited
skill is never overwritten. Tests that spawn the CLI point `HOME` at a temporary
directory, so a test run never rewrites the developer's own skills.

## The model

### Config is a file, not the environment

Config lives in `.lightspeed.conf.json` at the repository root, and `model` and
`thinking` have no default. Environment variables and silent defaults are
opaque; required knobs must be visible up front, and a missing one fails before
any git or model work. The reasons and the keys are in
[Configuration](../README.md#configuration).

`thinking` uses pi's own `ModelThinkingLevel` (`off` … `max`), not a boolean, so
it is handed to pi-ai as written.

### Providers

The repository's `providers` entries use pi's own `models.json` keys, so an
entry can be pasted across from a pi config. The one difference: pi's
`models: [...]` is a single `model: {...}`, because a review resolves exactly
one model. Repository `providers` are the top layer over pi's own
`~/.pi/agent/models.json` and pi-ai's builtins; see
[Providers behind a proxy or a gateway](../README.md#providers-behind-a-proxy-or-a-gateway).

The validation is strict where a quiet mistake would cost something:

- `api` is an allowlist, so a typo fails at load rather than as a stream error
  mid-request.
- An empty `baseUrl` is refused because pi-ai reads a request `baseUrl` for
  truthiness: an empty one would silently restore the vendor URL.
- A header value with a CR, LF or NUL is refused: that is header injection, and
  the fetch layer would quote the value, secret and all, into an error that
  lands on stdout.
- `${VAR}` is expanded in `apiKey` and header values only, because the config
  is committed to the repository under review: it must name the variable, never
  the secret. No error repeats an expanded value; the `baseUrl` is named,
  because an endpoint nobody can see cannot be debugged.

The two credential files — lightspeed's `<stateDir>/auth.json` and pi's — are
layered, not merged. An OAuth refresh is written back to whichever file owns
the token, because refreshing pi's token into lightspeed's file would leave pi
holding a refresh token the provider may have rotated away. A logout only ever
edits lightspeed's file: signing out of a review tool must not sign the human
out of pi.

### The model call

The model is called in-process through the `@earendil-works/pi-ai` SDK — no
subprocess — and lightspeed owns the prompts (`src/llm/prompts.ts`). The model
returns an ordered array of groups: position is the order, and there is no
`order` field.

The answer is never trusted. It is parsed, checked against the schema, and
checked for coverage (every changed path exactly once, none invented); each
failure is fed back into the same conversation so the model can correct itself,
for at most two repair rounds. Still invalid, it falls back to one
`All Changes` group with the tests trailing — a review beats no review. Missing
credentials are the exception and fail the command (`pi_auth_missing`); the
README's [Configuration](../README.md#configuration) says why.

Only a diff of one changed file skips the model — there is nothing to order.
Every larger diff is grouped, because git's alphabetical file order is the exact
defect grouping exists to fix.

## Feedback

Lavish-style: the selected text and the comment, plus the **file path**, which
removes the one real ambiguity — the same snippet in several files. Annotations
also carry a line anchor (`line_start`, `line_end`, `side`, and columns when part
of a line was selected), which the agent reads as `at: file:line`.

- The selected text keeps its `+`/`-` prefixes, so the agent knows old code from
  new.
- A selection belongs to one file block; one spanning several files becomes one
  annotation per file, so `file` is always unambiguous.
- `group` rides along as orientation: which concern the reviewer was reading.
- The page posts one flat `prompts[]` — annotations, messages, thread replies,
  resolves — in the order the reviewer queued them.
- A batch with nothing in it says so (`no feedback was queued when this review
ended`); only an ended review can answer with nothing — on an open one the
  waiting command keeps waiting.

## The review page

What the page does is in [Review page](../README.md#review-page) and
[Rounds](../README.md#rounds); the layout is in [wireframes](wireframes.md). The
reasons:

**A round waits for the reviewer.** An agent finishing mid-review used to
replace the diff the instant it landed, throwing the reviewer to the top of a
review re-cut under them. Now a new round waits behind an offer in the header
whenever the reviewer is mid-review — scrolled, inside a chapter, or holding
queued words (`holdsRound` in `src/browser/round-offer.ts`) — and is applied
silently otherwise. Only the newest round is offered: a reviewer who read
through two is not owed two presses. Applying a round is one function
(`applyRound` in `src/browser/dom/session-events.ts`), reached from the event and
from the press alike, so the two can never draw different reviews.

**The arrival is announced once.** The header offer alone was missable, so a
held round is also announced by a card over the review. Dismissing it folds it
into the header offer, which keeps a slow spark circling until pressed —
allowed because it tells the reviewer nothing new: it holds the place they said
they would come back to.
Under `prefers-reduced-motion` the spark does not exist.

**Whose turn it is lives in the panel, not a tooltip.** A `title` is hover-only;
keyboard and touch never reach it. The served page states the turn from the
record, so a reload mid-turn is right on first paint. A turn mode the page does
not know reads as digesting, the strictest lock. When the live stream drops, a
"Connection lost" chip shows and the presence greys, because a page that
silently stopped hearing the agent reads as an agent that stopped talking.

**End is never taken away.** On the agent's turn the button reads
`End without Sending`: the queue is not the reviewer's to send onto somebody
else's turn, and finding that out afterwards is how a reviewer loses six
comments. Every count of the queue counts items by the rule the agent's batch
is sized by (`batchSize` in `src/threads.ts`), so the page and the agent never
disagree about how many things were sent.

**Enter sends, but never a queue on its own.** An Enter on an empty box does
nothing: queued pills are sent by the button alone, because a stray Enter must
not fire off a half-read review.

**Nothing dies on a reload.** Unsent work is kept in `localStorage`
(`src/browser/review-memory.ts`), in two halves with two lifetimes. The
reviewer's own unsent words outlive everything, a re-group included; only a
successful send clears them. Where they were reading is stamped with its round
and handed back only to that round, because a re-group replaces the diff those
group indices, paths and pixels point into. The popup's comment is not kept:
without its selection it would be anchored to nothing. Storage degrades rather
than fails — a record from another version is dropped, malformed data reads as
empty, a full store gives up other reviews before this review's queue — because
a page that throws on load is worse than a queue that comes back empty.

**The replay repeats nothing the panel already showed.** Words count as seen
only when drawn in a visible tab with the panel open. A replay with nothing new
does not open on its own.

**Text wraps; the diff does not.** Chat is full of tokens with nothing to break
at, and the panel is narrow, so prose wraps mid-token instead of scrolling
sideways. A diff is code at its own width and may still scroll.

**Approval is derived, never stored per group.** A group is nothing but its
files, so a group whose files are all ticked is approved, and the mark cannot
drift from the boxes it is made of. Unticking a file reopens its diff — the
reviewer asking to look again; unticking a chapter leaves the chapter where it
is — a withdrawal, not a request to read — though the files inside do reopen
behind it. Only what changed hands is opened or shut: a file the
reviewer opened by hand is theirs to close.

**Approval across rounds.** Carrying a tick forward only on a matching blob sha
and never reordering the review are explained in
[Rounds](../README.md#rounds). Two details are not:

- The rule asking the model to keep last round's reading order lives in the
  system prompt, so the cacheable prefix stays identical between rounds.
- The round a file first entered the review in is written to the ledger
  (`round_file.first_seen_round`), because sessions are overwritten and deleted
  and a mining agent could not otherwise ask how long a file sat unapproved.

**Two comparisons, never on one file.** A file changed after approval offers
`Since approval`; an unapproved file the last round edited offers
`Since last round`. A file never carries both: the approved form already covers
everything since the tick. The words differ because "the form you approved"
would claim a verdict nobody gave. Why there is no diff, when there is none, is
decided in one place (`approvedFormData()` in `src/server/session-files.ts`) and
never guessed; a round that stored no commit is `unrecorded`, explicitly not a
rebase, so the reviewer is not sent hunting one that never happened.

**One state is stated in words.** Of the approval states, only
`changed after approval` carries a pill;
approved and unapproved read from the tick. Dimming stops at the group rather
than stacking, since opacity multiplies and a dimmed file in a dimmed group would
all but vanish.

### Side-by-side

Side-by-side sits behind a toggle and falls back to unified on narrow screens.
A selection never crosses columns, so an annotation carries one clean
`selected_text` and there is no split-into-two logic: on `mousedown` the other
column gets `user-select: none` (the trick that keeps line-number gutters out
of copied diffs), and a `selectionchange` handler clamps keyboard and
programmatic selections back into the starting column
(`src/browser/dom/column-lock.ts`).

## Ending a review

Send & End is not an approval in itself. The ended batch carries counts —
approved, unapproved, swept, total — and a verdict derived from the same account,
so the two cannot disagree; only `signed-off` is a sign-off. Counts, not paths,
because the agent wrote the branch and already knows its files.
`lightspeed approvals` names the paths when something turns on which file; it
prints a count block read off the whole review beside the listing, so a cut
listing can never make a count lie. The agent must not reopen a review
uninvited.

## Settled decisions

- **HTTP:** `node:http` and a small router (`src/router.ts`), no Express. The
  page's interactions are all client-side; the server serves HTML, JSON and an
  SSE stream, all of which `node:http` does natively.
- **Diff size:** binary files are skipped (`binary_skipped`); a file over
  10,000 lines is flagged oversized.
- **Waiting:** no `--timeout-ms`, no heartbeat; the agent calls the waiting
  commands with no shell timeout and re-runs one to re-attach.
- **Repair rounds:** two.
- **Language:** TypeScript, run directly by Node's type stripping.

## Feedback ledger

### Why

Feedback used to live only in the session JSON, which `open`/`publish`
overwrite and `end` eventually drops, so later agent sessions never learnt what
the reviewer keeps asking for. The ledger is a durable, append-only record of
every piece of feedback, the code it was about, and whether it landed. Its
consumer is an LLM mining agent that turns recurring patterns into AGENTS.md
or skills; that agent is out of scope, but its needs drive the data shape.
Usage is in [Feedback ledger](../README.md#feedback-ledger).

Non-negotiable: a ledger failure never breaks a review; the data stays local;
config only, no environment variables.

### Decisions

- **JSONL, append-only**, one file per month under `<stateDir>/feedback/`. Not
  `node:sqlite`: an experimental API with a warning, and binary state. A SQLite
  index can be derived later without moving the source of truth.
- **Self-contained items.** Every item must be understandable with no git
  access — the repository may be gone or the branch rebased. So code is copied
  in, not referenced by sha alone: the selection, ±30 lines of context, and the
  file's patch for that round (stored once per round-file, referenced by items).
  Every stored string is capped, and every cut is marked in `truncated[]`.
- **Raw, never summarised.** The mining agent needs the reviewer's words and the
  selected code verbatim.
- **Line anchors** (`line_start`, `line_end`, `side`, and 1-based UTF-16
  `col_start`/`col_end` when only part of a line was selected, the diff's `+`/`-`
  not counted).
- **Outcomes derived, not asked.** The next `publish` judges each earlier
  comment `addressed`, `ignored`, `repeated` or `unknown` — the one field that
  turns a pile of comments into labelled signal. See
  [Verdicts](../README.md#verdicts).
- **Global, in `stateDir`**, across repositories; every record carries the repo
  root and remote, and `--repo` filters.
- **On by default** (`feedbackLog`), with the path and status reported by
  `open`/`publish`.
- **No mutable bookkeeping.** Ids sort by time; the mining agent keeps its own
  watermark and reads with `--since`/`--cursor`.
- **Cheap by default.** A TOON `list` is capped and leaves the bulk fields out;
  `show <id>` has everything. Chronological order, so a slice reads as a
  transcript.
- **Additive schema.** Records carry `schema: 1`; fields are only ever added, so
  an old line still reads.

### The server is the only writer

The review server appends every record: a round and its files when `open` or
`publish` posts one, the reviewer's annotations and messages on Send, the
agent's replies, the end of a round with its approved set, and the outcomes when
the next round arrives. One writer means one place where records are built and
ids are issued. Every write is wrapped: a full disk, a corrupt line or a git
failure is swallowed, counted, and reported as
`ledger: {status: degraded, reason}`, and the review continues. With the ledger
off, the store is simply absent — no null object, no backend interface for a
single backend.

### One round history, two consumers

Judging outcomes needs the same facts as carrying approval across rounds, so
they are built once: the session holds `rounds[]`, and `src/rounds/history.ts`
derives from it, purely, a file's history, whether it changed between rounds,
and whether it is settled. The ledger's outcomes (`src/ledger/outcomes.ts`) and
the page's carried approval both read those derivations. The ledger itself
changed no approval behaviour; it only made the round record remember what the
ticks were.
