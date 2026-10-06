# Changelog

## Unreleased

- `publish` on a branch and base with no review refuses `session_not_found`
  the way every other session verb does: it names the branch and base and the
  live reviews in this repository, and the `publish` command to run instead,
  rather than printing the session's hash key.
- Grouping runs on pi-ai 1.0.4. pi-ai renamed the Azure provider from
  `azure-openai-responses` to `azure`, so Azure models are now
  `azure/<model>` — e.g. `"model": "azure/gpt-5"` in
  `.lightspeed.conf.json`. The old name still works: a `model` or a
  `providers` entry under `azure-openai-responses` resolves to `azure`, and
  `open` and `publish` print a help line with the exact edit. pi's own
  `auth.json` and `models.json` entries under the old name keep working too —
  the credential is read, never rewritten, and a `models.json` entry applies
  to `azure` — until you rename them as pi asks. The `api` value
  `azure-openai-responses` for a provider you define is unchanged.
- A provider you defined yourself under the key `azure` in
  `.lightspeed.conf.json` now collides with pi-ai's builtin `azure`
  provider: the entry is rejected as a `config_invalid` override of a
  provider pi-ai ships, and grouping silently falls back to one chapter
  with that as its reason. Rename the key —
  e.g. `providers.azure-foundry` — and the matching `model` prefix, e.g.
  `"model": "azure-foundry/my-deployment"`.
- Azure AI Foundry chat models served over Chat Completions, starting with
  `azure/deepseek-v4-pro`, can group a review.

## 3.7.0

- The **Between rounds** replay no longer repeats what you already read in
  the conversation panel. An answer the panel showed before the round
  arrived is left off its card, and the round reply keeps only the parts
  you have not seen, shown once in its own block above the cards rather
  than on a card; what changed is always shown. A card with no code change
  says "No code change — see the reply." only when it shows a reply, and
  plain "No code change." otherwise. Words the agent sent
  together with the new round still appear. A replay left with nothing
  new — no unread words and no change — no longer opens on its own;
  **Replay last round** still opens it. A reply counts as seen only once it
  was on screen — drawn while the tab was visible and the panel open — and
  which replies you have seen is remembered across reloads.
- **Send N to Agent** counts what you did, not the pills it took: every new
  comment is one, and every thread you replied in or resolved is one however
  many replies and toggles went into it, so a reply and a resolve on one
  thread read **Send 1 to Agent**. The tray, the rail's badge, the
  "Queued — N" announcement and the done and new-round cards count the same
  way; the new-round card names a thread with a reply and a resolve as a
  reply.
- Queued words can be edited before they are sent. Click the text of a
  queued reply, line comment or general comment — or tab to it and press
  Enter — and it opens in place as a box: Enter saves, Escape puts the words
  back, clicking away saves (switching to another window leaves it open
  as you left it), and saving it empty takes the item back as its
  × does. The item keeps its place in the queue, its line and its round.
  Like ×, it is locked while the agent reads your feedback and once the
  review has ended.

## 3.6.0

- The constellation sheet names every chapter. Names were capped at eight,
  so a review of 16 chapters showed figures with no name; now every chapter
  with a star gets its name and file count. When the spots round a figure
  are taken, its name goes to the nearest clear spot close to its stars, and
  names still never overlap each other or the button.
- The general comment box has no border and is one line taller; while it
  has the caret an accent ring says so, and under forced colours its edge
  still shows. **Send & End** now stands at the right edge, apart from
  **Send to Agent**.
- An expanded diff no longer shows a dark strip above its first hunk header:
  the header is the top band of the block, in both schemes.
- While the agent holds the turn, working or reading, the header's presence
  flies the same firefly as the foot of the conversation, a little smaller,
  in place of the still dot. It keeps its path across redraws, holds still
  for a reviewer who asked for less motion, and stays lit under forced
  colours (so does the foot's).
- A thread you spoke last in shows no reply box while the agent works:
  only "Waiting for the agent…" and **Resolve**. The box comes back when the
  agent answers in that thread, or when the turn is yours again.
- **Resolve** and **Reply** are soft pills with no border, **Resolve** at
  the left and **Reply**, in the accent, at the right. The thread's reply box
  has no border either and takes the compose box's focus ring.
- The new-round card and the replay card lift off the page on their shadow,
  with no border line; under forced colours their edge still shows.
- Resolved threads read in less height: an unfolded resolved card shows its
  exchange as a transcript at the card's full width and a size down,
  without the chat bubbles that left a long answer a thin column of text.
  A folded card's first words get a line of their own under its file,
  so neither is cut to a stub.

## 3.5.0

The opening shows the review's shape before it hands it over, and every new
round arrives by a jump into hyperspace.

- The round's files drift as faint stars behind the reasons, one star per
  file (at most 600), brighter the more lines it changed. The sky is seeded
  from the chapter names and file paths, so the same round draws the same
  sky every time. A resize lays it out again for the new size, and it
  follows the machine's scheme when that changes mid-opening, repainting in
  the new inks.
- A new last sheet, with no words on it: the stars gather into one
  constellation per chapter and the chapter names come up under their
  figures, with each chapter's file count (at most eight names; a long name
  wraps to a second line and ends in an ellipsis past two; names are measured
  in their own font, so CJK and wide ones keep apart too; a name that would
  overlap gives its place to the next chapter's). Its **Open the review**
  button stands in the middle of the constellations, in a box the layout
  keeps clear of stars, figure lines and names, and waits 1.5 s after the
  names; `Esc` still skips.
  A screen reader hears the chapter names in the sheet's label. The last
  reason's button now reads **Enlighten me**.
- The last press jumps into the review from the middle of the sky, where the
  button stood: the stars streak outward, the edges
  close in and a flash covers the swap, a second in all. This replaces the
  flood of light.
- Rounds 2 and later arrive the same way: when the replay will open on its
  own for a new round, the same one-second jump starts before the round is
  drawn, the new diff swaps in under it, and the replay opens as it lands.
  `Esc` lands at once;
  nothing else on the page hears a key while it plays. A round that arrives
  while the first round's opening is still up closes the opening first.
- A round's replay is claimed for one tab the moment the round arrives, not
  when its cards come back: the tab on screen that jumps is the one that
  opens it, and other tabs on the review neither jump nor open (two tabs that
  hear of the round in the same instant may both show it, as before). A tab
  in the background leaves the round to the tab on screen, and claims it when
  it comes back only if nobody did. A replay whose cards could not be fetched
  does not open on its own after a reload either, but its reopen control
  stays and fetches them again.
- While the opening is up the page behind it is inert, so `Tab` stays on the
  top sheet, and the room never scrolls: a long reason on a short screen
  keeps the sky and the flash centred.
- Light scheme draws the sky as a star atlas — ink cores in a thin wash on
  the paper; dark as a night sky — white cores in a wide glow.
- Under `prefers-reduced-motion` the sky is still, the constellations are
  already formed and the last press lands at once, with no jump. Under forced
  colours the sky is not drawn: the chapter names stand alone.
- The motes are gone: the drifting stars take their place.

## 3.4.0

The review lights up at the moments a turn changes hands: sending, the
agent's answer, each approval and the last one.

- While the agent works, a firefly drifts in the working line instead of
  three breathing dots.
- Every tick sends a particle down the progress bar to the fill's new edge,
  and the fill grows once it lands. Completing a chapter flashes its segment;
  approving the last file lights the whole bar. A tick that moves focus on to
  the next chapter, and the survey's bulk **Approve**, play the same way. An
  untick takes the light down and its width applies at once.
- Every file approved opens the done card with a supernova — a point of
  light, two rings and a flare — and the ✓ settles out of it. Nothing on the
  card moves after that. The heading now opens the card, with the ✓ beside
  it at the right edge, and the buttons span the card: **End review** on the
  left, **Keep looking** on the right. The card drops its "Nothing left to
  read" line, and its note ends at "or keep looking.".
- An approve box, per file or per chapter, no longer draws a tick mark: an
  approved box is filled with the accent, one still to approve is an empty
  outline, drawn darker in the light scheme so it holds 3:1 against the page.
  Under forced colours the filled box takes the system highlight, so the two
  still read apart.
- A send goes out at warp: what was sent squeezes into streaks that shoot into
  the button that sent it, and the button flares as they land. It starts once
  delivery succeeds, so a failed send never animates.
- The agent's answer arrives on a beam from the header's turn dot to the first
  new card, a spark runs once round each new card's edge and the answer fades
  in. A card out of sight gets no beam; the dot's pulse alone says it. An
  answer to a folded panel opens it at the newest talk, beam and all.
- When the turn comes back while the tab is in the background, the title
  reads `● Your turn` and the favicon pulses; both clear when the tab is seen
  or the turn goes back to the agent. A review that has ended never lights
  them, not even for the turn its end hands back; reopened with
  `open --reopen`, it lights them again. The review page now has a favicon.
- Under `prefers-reduced-motion`, every moment shows its end state without
  movement, and the lit favicon holds still.
- New `--lsr-light-*` tokens carry the light's colours; light scheme draws
  ink-coloured cores so the light reads on a pale surface.

## 3.3.0

The survey reads as a list of things to open, not as headings over a missing
diff.

- Every chapter on the survey is a card on the surface tone that ends in
  **Open →**, tints under the pointer and shows a focus ring when reached by
  Tab; Enter or Space opens it as a click does.
- A review of one chapter to study draws that chapter's label as the screen's
  primary button, **Open the chapter →**, so a lone "All Changes · 1 file"
  no longer reads as an empty section. This holds on first open and after
  taking a new round. A review whose only chapter is swept keeps the lane's
  **Approve** as its one primary press.
- The survey's styles moved from `css/index.css` into their own
  `css/survey.css`, which brings `index.css` back under the stylesheet ceiling.

## 3.2.0

The agent reads each thread whole, and the reviewer's panel says whose move it
is.

- Every block printed before a wait ends on a top-level `url:` line, so the
  review's address is the last thing the agent sees before the command blocks.
  The grouping notice (`status: grouping N files`) is the one exception.
- Batch items for a reply or a reopened thread carry `thread[]` — every earlier
  message as `{who, said}` — so the agent answers the whole exchange, not the
  last line. A resolved thread's item carries only what it was about (`asked`)
  and the reviewer's last words; `next.resolved` says per thread whether to act on a last word or keep
  the last answer's promise.
- A thread anchored in an earlier round whose line has changed since says so:
  `outdated: "anchored in round N; that line has changed since"`.
- The conversation panel groups threads by whose move it is — Resolved,
  Waiting on agent, Needs you — and remembers which cards and groups the
  reviewer folded. Cards show where a thread sits and its first words, never
  raw ids.
- Drafts sit inside their thread's card, marked not sent yet; a comment on a
  new line shows as a New · not sent yet card, and the tray counts what is not
  sent yet.
- Each sent message says how far it got: sent, seen by agent, or sent · agent
  not listening.
- The round offer counts queued replies and resolves as what they are, and the
  stale badge marks only line comments.
- Installed skills are stamped 3.2.0 and refreshed on the next command.

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
- `/health` states the server's state dir. A command — bare `lightspeed`
  included — that finds a server keeping its reviews in another state dir
  (another `HOME`, another harness) is refused `server_state_mismatch` (exit 1),
  naming both directories, instead of reporting a live review as missing or
  starting a second one beside it. A server too old to state its dir is judged
  by version alone.
- When the server re-attaches an `open` to a live review, `open` says
  `re-attached to the live review` rather than reading as a fresh open.
- A fresh `open` of a branch already live under another spelling of its base
  (`main`, `origin/main`, `refs/heads/main`, or another name at the same
  commit) or from another worktree of the same repository is refused
  `live_review_elsewhere` (exit 2), naming the command that re-attaches to the
  live one. `--reopen` skips the check.
- The review page: each thread card ends in a foot — the reply box across the
  card's full width, then **Reply** and **Resolve** as one pair of buttons at
  the right — drawn whenever the reviewer can write (their turn, or queueing
  while the agent works), whoever spoke last, so they can reply twice in a row.
  While the agent holds the turn, a thread whose last word is the reviewer's
  says "Waiting for the agent…" above it. **Reopen** sits in the same row.
- The header says a short word beside a dot — "Agent listening", "Agent not
  listening", "Agent reading", "Agent working", "Connection lost" — at one
  weight in every state, and keeps the whole sentence (the plan, the item
  count, what a Send does now) in its tooltip. The dot is the accent while an
  agent works, reads or listens and grey when none does; a lost connection
  greys the word and drops the dot. The conversation's foot still says the
  whole sentence.
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
