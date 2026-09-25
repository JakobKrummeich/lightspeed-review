# Changelog

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
  `session_ended`, naming who ended it. Server-gone failures name
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
