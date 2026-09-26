# Changelog

## 3.1.0

An agent whose command was killed mid-wait now knows what survived, and one
review no longer splits into two.

- Every wait names the shell tool's timeout parameter: the command does not
  return until the reviewer Sends, so it is called with NO timeout parameter,
  not via `timeout` or `&`. `next.if_killed` and the skill say that a kill ends
  only the command — the server and the review stay live and hold the
  reviewer's Send — and that the recovery is re-running exactly the same
  command, never opening another review, ending or reopening.
- `open` and `publish` say `status: grouping N files — can take minutes` before
  the grouping model call, with the command to re-run if it is killed there, so
  a killed grouping is no longer silent.
- `/health` states the server's state dir. A command that finds a server
  keeping its reviews in another state dir (another `HOME`, another harness) is
  refused `server_state_mismatch` (exit 1), naming both directories, instead of
  reporting a live review as missing or starting a second one beside it. A
  server too old to state its dir is judged by version alone.
- When the server re-attaches an `open` to a live review, `open` says
  `re-attached to the live review` rather than reading as a fresh open.
- A fresh `open` of a branch already live under another spelling of its base
  (`main`, `origin/main`, `refs/heads/main`, or another name at the same
  commit) or from another worktree of the same repository is refused
  `live_review_elsewhere` (exit 2), naming the command that re-attaches to the
  live one. `--reopen` skips the check.
- The review page: each thread card ends in a foot holding the reply box,
  **Reply** and **Resolve**, drawn only when the agent spoke last and the page
  takes writing; a thread whose last word is the reviewer's says "Waiting for
  the agent…". **Reopen** sits in the same foot.
- The header says a short word beside a dot — "Agent listening", "Agent not
  listening", "Agent reading", "Agent working", "Connection lost" — and keeps
  the whole sentence (the plan, the item count, what a Send does now) in its
  tooltip. The conversation's foot still says the whole sentence.
- A 3.0.x server left running is replaced by the next `open` or `publish`, as
  any server of another version is; other commands refuse it `server_stale`
  until then.

## 3.0.1

What the CLI tells the agent to do next is now true in the cases 3.0.0 got
wrong.

- `session_ended` names who ended the review. After an agent's `lightspeed end`,
  `reply`, `work`, `publish` and `open` said "the reviewer ended this review";
  they now say `` `lightspeed end` ended this review, not the reviewer `` (the
  server's 409 carries `endedBy`); the batch that reports the end and the
  branchless refusal word the closer the same way. A new round is still the
  reviewer's call. A 3.0.0 server still running after the upgrade sends no
  `endedBy`, so its refusals say only "this review is ended" until
  `lightspeed stop` and the next command starts a 3.0.1 one.
- With the server gone, a command on a review its session file shows as ended is
  refused `session_ended` rather than sent to re-attach, and `lightspeed end` on
  it answers from the file.
- `pi_auth_missing` says the `open` or `publish` stopped and opened no round,
  not that it "fell back"; the skill tells a bad model (which degrades to
  `grouping.mode: fallback`) apart from missing credentials (which stop the run
  until the human runs `lightspeed login` or exports a key).
- `server_not_running` with no review on disk for the branch points at a fresh
  `lightspeed open <branch> [base] --intent '<why this branch exists>'`, not at
  re-attaching to a review that does not exist.
- A command that hands back a batch the agent is digesting — `open`, or a
  re-run `reply` or `publish` — returns at once and no longer prints
  `next.if_killed`, which read as a wait to come.
- `lightspeed end` on an already-ended review says it was already ended, and
  the server no longer re-closes it (no second round end in the ledger). Ending
  while working with commits of the branch's own that no round has shown — not
  a merge of main, not a rebased copy of a published commit — still ends, and
  warns in `help[]` that the reviewer never saw them, pointing at `--reopen`.
- Every block prints `round` before `turn`, re-attach and publish re-run
  included, and the home view's columns read `branch,base,round,turn,pending`.
- Installed skills are stamped 3.0.1 and refreshed on the next command.

## 3.0.0

A strict turn machine replaces the 2.x `wait`/`ask`/`say`/`start` loop. The
agent ends each turn by talking or by working, never both, and every command
that hands the turn back waits for the reviewer's next Send itself.

### Breaking

- `start`, `wait`, `ask` and `say` are removed. Each now answers `removed_verb`
  (exit 2) — `'<verb>' was removed in 3.0, run lightspeed for your next step` —
  instead of running.
- New verbs: `open` (first round, or re-attach to a live review), `reply --to
<id> "<text>"` (every answer of a discussion turn in one call), `work "<plan>"`
  (discussion over, code changes next) and `publish --intent "<what>"` (new
  commits become the next round; `--to <id> "done: …"` notes land in their
  threads). `open`, `reply` and `publish` wait for the next Send; a killed one is
  re-run as it was and posts nothing twice.
- The agent's turn has two phases, `digesting` and `working` (was `reading` and
  `working`). A 2.x session record is migrated on read.
- A delivered batch prints as `items` — one per thread, with `id`, `status`
  (`new`, `reply`, `resolved`, `reopened`), `at`, `selected`, `you` and
  `reviewer` — closed by a `next:` decision rule, instead of `prompts[]` and
  `help[]`.
- One exit-code rule: exit 2 when re-running the same command cannot help — a
  wrong command line or a move wrong for the review's state (`turn_not_yours`,
  `turn_still_yours`, `nothing_to_publish`, `feedback_item_unknown`,
  `session_ended`, `session_not_found`, `ambiguous_session`) — and exit 1 when
  the machine got in the way. Every refusal names the one right command.
- Every waiting command prints what landed before it waits (`replied: [ids]`,
  the round, or `rerun: true`), closed by `next.if_killed` — the exact command to
  re-run, or `open` to re-attach when a word would not paste as printed. The
  newest wait wins: an older one on the same review exits `superseded: true`.
- An unquoted `--to` text or plan is refused rather than half-posted: a `--to`
  whose text is the next flag, words past the branch and base, and a would-be
  branch git does not know while a review is live here (`'it' is not a branch —
quote the whole text after --to`).
- A batch holding resolves carries a `resolved:` line saying what they mean, and
  every suggested `--to` names an open thread, never a resolved one. The working
  rule's second key is `stuck`.
- `reply` from working is measured against the tree `work` found, and the
  refusal names which condition failed. `publish` checks the turn, the review
  and the tip before any model call. `open` on a working turn is refused, and an
  `--intent` on a live review is reported as ignored.
- A branchless command on a repository whose latest review ended is refused
  `session_ended`, naming who ended it; with no review here at all it is
  `session_not_found` (was `ambiguous_session`, which now means several live
  reviews). Server-gone failures name
  `lightspeed open <branch> [base]`, which restarts the server and re-attaches.
- Bare `lightspeed` names the one next command for the session it shows, and
  asks the server whether a wait is already parked before it suggests `open`.
- Installed skills are stamped 3.0.0 and refreshed (machine-wide) or reported
  (project) on the next command.

### Review page

- The conversation is threads: each item with its whole exchange stacked under
  it, a reply box at its foot and a **Resolve** toggle that folds it. Replies and
  resolves queue as pills and go out with the next Send. Items from a 2.x
  session show as read-only legacy threads.
- The page locks by phase: while the agent digests a batch, composing, replying,
  resolving, the line popup and pill removal are locked; while it works,
  everything queues for the next round. End is always available.
- The header says "Agent is reading your N items", "Working on: <plan>",
  "Agent is listening" or "Agent isn't listening", and a "Connection lost —
  reconnecting…" chip shows while the live update stream is down, with the
  header presence greyed to "Connection lost".
- The server enforces the lock: a Send while the agent holds the turn is refused
  `agent_holds_turn` and the page says "Not sent — …", a Send & End carrying
  words included; End without Sending always goes. `work` and `publish` on an
  ended review point at `lightspeed approvals` for the verdict it ended on.
- Each `--to main` post is its own card, with no Resolve toggle or reply box.
  The agent answering in a resolved thread reopens it, and every thread the
  agent spoke in since the last Send is marked new and moved to the foot of the
  current round.
