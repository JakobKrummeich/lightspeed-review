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
- Refusals exit 2 and name the one right command: `turn_not_yours`,
  `turn_still_yours`, `nothing_to_publish`, `feedback_item_unknown`.
- Bare `lightspeed` names the one next command for the session it shows.
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
  reconnecting…" chip shows while the live update stream is down.
