---
name: lightspeed
description: Get a human review of a branch diff. Use when work is ready for review, when a reviewer asked to see changes in a browser, or when you need targeted feedback on specific lines rather than a summary.
---

# lightspeed

Semantic diff review: a reviewer reads your branch diff in a browser, comments
on the lines they care about and sends the batch to you. You answer in threads,
change the code, and publish the next round.

## The turn

> Discussion strictly alternates: the reviewer sends a batch, you digest it and hand back.
>
> End each turn by talking (reply) or by working (work), never both; ask about anything ambiguous before you work.
>
> Every command that hands the turn back also waits for the next Send, so one call is one turn.

The review has three live states. The reviewer composes (their turn); you
digest the batch they sent (your turn, short: they are locked out until you
hand back); you work (your turn: they can only queue, and what they queue
goes into your next round).

| command | legal when | waits for the reviewer's Send | turn after |
| --- | --- | --- | --- |
| `open` | no review yet, a live one (re-attach), or an ended one with `--reopen` | yes | yours, digesting |
| `reply --to <id> '…'` | digesting (from working only if nothing changed since `work`) | yes | the reviewer's |
| `work '<plan>'` | digesting | no | yours, working |
| `publish --intent '…'` | working, with new commits | yes | the reviewer's |
| `end` | always | no | ended |

`open`, `reply` and `publish` hand the turn back **and** wait for the
next Send, so one call is one turn: it does not return until the reviewer Sends (often minutes to hours), so call your shell tool with NO timeout parameter, not via `timeout` or `&`; if it is killed anyway, only the command died — the server and this review stay live and hold the reviewer's Send: re-run exactly the same command with NO timeout (it posts nothing twice), and never open another review, end or reopen to recover. There is no separate
`wait` to forget. Plain `lightspeed` (no arguments) shows where you are
and the one command to run next.

## The loop

1. **Open the review.**
   > Run `lightspeed open <branch> [base] --intent '<why this branch exists>'` to open a review; repeat --intent once per reason

   It extracts `git diff <base>...<branch>`, groups the files, opens the
   reviewer's browser, prints the session URL and waits for their first Send.
   `--intent` is **required** when opening fresh: you are the only party that
   knows why the branch exists. Omitting it fails with `intent_missing`
   before any git or model work.
2. **Digest the batch.** It lists one item per thread (`t1`, `t2`…): new
   items, replies in threads you answered, and threads the reviewer resolved.
   End the turn with exactly one of:
   - talk — Anything that needs the reviewer — an answer, a doubt about a change request, a question of your own → one call, every reply in it: lightspeed reply --to t4 '<answer>' --to t2 '<answer>' <branch>
   - work — Nothing left to discuss and something to change (clear change requests go straight here) → lightspeed work '<plan>' <branch>, then edit, test, commit and publish

   Anything ambiguous in a change request? Ask now with reply: asking is cheaper than redoing a round built on a guess. You may leave items unanswered. End this turn with reply or with work, never both.
3. **Work.** Edit, test, commit. A question for the reviewer? Publish what you have and ask in the new round. reply works from here only while nothing has changed since work.
4. **Publish.** Edit, test and commit, then → lightspeed publish <branch> --intent '<what this round changed>' --to t4 'done: <what you did>' — it does not return until the reviewer Sends (often minutes to hours), so call your shell tool with NO timeout parameter, not via `timeout` or `&`; if it is killed anyway, only the command died — the server and this review stay live and hold the reviewer's Send: re-run exactly the same command with NO timeout (it posts nothing twice), and never open another review, end or reopen to recover
   Files the reviewer already approved come back ticked unless you touched them.
5. **Close it** when the reviewer is done.
   > Run `lightspeed end <branch> [base]` to close the review from your side

## What an item says

```
items[2]:
  - id: t4
    status: new
    at: src/turn.ts:20
    selected: "note?: string"
    reviewer: why is note optional here?
  - id: t2
    status: reply
    at: src/poll.ts:40
    you: it retries 3x
    reviewer: and on a 503?
```

- `id` is what `--to` takes; `main` is the main chat, where your own
  top-level remarks go — each `--to main` is its own card on the page.
- `status`: `new` (a new item), `reply` (the reviewer answered in a
  thread; `you` is what you said last there), `resolved` or
  `reopened`. Resolving a question means "no further questions"; resolving
  a change request means "I agree with what you last said" — implement that
  agreed version, it is not withdrawn. A batch holding resolves says so on a
  `resolved:` line of `next:`. Every `--to` a line suggests names an
  open thread; never answer into one the reviewer resolved unless you must —
  doing so reopens it.
- `at` is `file:line` (or `file:start-end`) in your branch; `(base)`
  marks lines numbered in the base. `selected` quotes the reviewer's
  selection, cut at 200 characters with a pointer to the rest.
  General items have neither.

## Rules

- `open`, `reply` and `publish` do not return until the reviewer
  Sends — often minutes to hours. Call your shell tool with NO timeout
  parameter, not via `timeout` or `&`. If one is killed anyway, only that
  command died: the server and the review stay live and hold the reviewer's
  Send. Re-run exactly the same command with NO timeout — the server
  recognises it, posts nothing twice and hands you whatever the reviewer sent.
  Never open another review, `end` or `--reopen` to recover.
- Before it waits, each of the three prints what landed (`replied`, the round, or
  `rerun: true`) closed by `next.if_killed` — that exact command; one
  that hands back a batch you are digesting returns at once, without it. An
  `open` or `publish` with files to group says so first, on a
  `status:` line with its own `next.if_killed`: grouping can take
  minutes. Only one wait per review: a newer one makes the older exit
  `superseded: true`, which asks nothing of you.
- Every refusal of a move — out of turn, an ended, unknown or ambiguous
  review — names the one right command in its `help[]` and exits 2: read
  it rather than retrying. `turn_not_yours`: the reviewer holds the turn.
  `turn_still_yours`: you are working, so publish. `nothing_to_publish`:
  HEAD has not moved since the last round, so commit or reply.
- `wait`, `ask`, `say` and `start` were removed in 3.0 and answer
  `removed_verb`.
- An ended review answers `ended: true`. It is not by itself an approval:
  read `approval.verdict` — `signed-off` (every file approved),
  `partial`, `none` or `empty`. `swept` counts approvals that came out
  of a sweep lane: accepted, never read. `lightspeed approvals [branch] [base]`
  names the files (first 50 per list; `--full` for all).
  `endedBy` says whether the reviewer or an agent's `end` closed it. A
  plain `open` on it is refused with `session_ended`. Only when the
  reviewer asks for another round:
  `lightspeed open <branch> [base] --reopen --intent '<why>'`.
- Every command takes `<branch> [base]` explicitly, which is what makes
  concurrent reviews unambiguous. Omit the branch only when the repository has
  exactly one live session. `base` defaults to `main`.
- State the intent in the reviewer's terms — what the branch is for, not a list
  of the files you touched.

## Setup

The repository needs `.lightspeed.conf.json` in its root.
Run `lightspeed init --config` to write one:

```json
{ "model": "anthropic/claude-sonnet-4-5", "thinking": "off" }
```

`model` is never defaulted and no command lists the ids. Name one you can
reach:
- `anthropic/claude-sonnet-4-5`
- `anthropic/claude-haiku-4-5`
- `openai/gpt-5`

A model nobody has, or a bad answer from one, does not fail the run: the
round opens with `grouping.mode: fallback`, the whole diff as one group, and
a `fix` line naming the key to change. Missing credentials do: a diff of more
than one file stops with `pi_auth_missing` (exit 1, no round opened) until
the human runs `lightspeed login <provider>` or exports the provider's key —
ask them, then re-run the command.

Optional keys: `port` (4388), `stateDir` (`~/.lightspeed`),
`feedbackLog` (`on`), `classify` — two glob lists,
`{"mechanical": [], "guardrail": []}`, naming this repository's bulk files and
the files no verdict may call bulk.

Subscription users run `lightspeed login <provider>` (`anthropic` ·
`openai-codex` · `github-copilot`) once per machine — humans only, in
their own terminal; an agent must never run it.

## Output

Every command answers TOON on stdout, led by `round` and `turn` and closed
by `next:`: the rule for what to do next, keyed by what you decide. Every failure
answers `error: {code, message, detail}` plus `help[]` — exit 2 when
re-running the same command cannot help: the command line is wrong, or the move
is wrong for the review's state (out of turn, ended, not found, ambiguous), and
`help[]` names the right one. Exit 1 when the machine got in the way — the
server, git, the model, the config — and the same command may work once that is
fixed. Run
`lightspeed <command> --help` for a command's flags and two worked examples.
