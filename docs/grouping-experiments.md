# Grouping experiments

A log of what was measured about the grouping prompt, so the next edit starts
from evidence instead of from taste. Everything here was run against the eight
fixtures in `test/fixtures/grouping/`, with `anthropic/claude-haiku-4-5`,
thinking off, unless a line says otherwise.

## Round 0 — how noisy is one run?

Three samples per fixture of the shipped prompt. Per-fixture standard deviation
of pairwise f1 was 0.00 to 0.22, typically 0.06. **One recorded reply per
fixture cannot tell an improvement from a re-roll**, which is why the recorder
now takes `--samples` and defaults to three, and why every printed score carries
its spread.

## Round 1 — the model splits about twice as finely as the fixtures

Diagnosis from the same runs: the model returned 1.9 groups for every group the
human grouping has (8.7 vs 4 on the largest fixture), precision 0.59 against
recall 0.41. Hypothesis: telling it to prefer fewer groups raises recall for
less precision than it gains.

Three variants replaced the "as many groups as the change has concerns" clause,
24 runs each:

| variant                                                         | pairwise f1 | groups/human |
| --------------------------------------------------------------- | ----------- | ------------ |
| shipped prompt                                                  | 0.465       | 1.92         |
| `fewest` — fewest groups, "most reviews want three to five"     | **0.496**   | 1.63         |
| `fewest-no-number` — same, without the numeric anchor           | 0.449       | 1.81         |
| `merge-only` — "merge any two groups you'd give the same check" | 0.402       | 1.85         |

The numeric anchor is what does the work; the merge instruction alone made
things worse. But at 48 runs `fewest` was +0.024 ARI over the shipped prompt,
paired per fixture, t ≈ 1.1 — **not significant, so it was not shipped.**

## Round 2 — a disagreement about tests, not a failure

Reading the worst fixture (`close-the-conversation`, f1 0.03) showed the model
pairing each source file with its own test, while the fixture puts all tests in
one trailing group. The prompt's "production code lead and tests trail" does not
say which. Two variants spelled it out — tests in one group after the code,
and "group by the question, not by the module". Neither moved the score
(ΔARI −0.02 to +0.01, |t| < 0.5). Guard failures fell from 7 to 2 in 48 runs,
all of the loose `firstGroupServesTheIntent` alarm — suggestive, not evidence.

## Round 3 — the metric was the problem

Reference groupings that took no thought, scored on the same fixtures:

| grouping                          | pairwise f1 | ARI  |
| --------------------------------- | ----------- | ---- |
| one group of everything           | **0.54**    | 0.00 |
| one group per file                | 0.00        | 0.00 |
| source split from tests, by regex | **0.61**    | 0.42 |
| the model, best variant           | 0.50        | 0.40 |

Pairwise f1 rewarded a grouping with no thought in it above every real answer,
because with three or four human groups a third of all pairs genuinely belong
together. The harness's own comment claimed the opposite. Fixed by making the
**adjusted Rand index** the headline — chance-corrected, so both degenerate
answers score 0 — and by printing the reference groupings on every run.

`anthropic/claude-sonnet-4-5` on the same fixtures scored ARI 0.397 against
haiku's 0.379 (16 runs): the ceiling here is not model capability.

## Round 4 — asking a stronger model instead of counting

Counting compares one answer to one human answer and is blind to a different
answer being just as good. So: `claude-opus-4-8` reads the diff and two
layouts of it, labelled A and B, and says which it would rather review by.
Every pair judged twice with the labels swapped; a fixture whose verdict follows
the label is counted as undecided, not as half a win. `per-file` is judged too,
as calibration — a judge that cannot reject it is not judging.

| the shipped prompt's grouping vs  | wins | losses | undecided |
| --------------------------------- | ---- | ------ | --------- |
| one group per file                | 8    | 0      | 0         |
| source split from tests, by regex | 8    | 0      | 0         |
| the human fixture                 | 2    | 3      | 3         |

**The judge contradicts the counting harness where it mattered.** ARI ranked
the regex split above the model (0.42 vs 0.36); the judge preferred the model's
grouping on all 8 fixtures, both orders. The two agree elsewhere: on
`baseline` vs `fewest` the judge split 3–1 with 4 fixtures flipping when the
labels swapped — a coin flip, exactly what the paired t said.

So the harness now has two instruments with different failure modes: counting
is free, deterministic and catches regressions; the judge is slow, costs a
strong model, and is the one that answers "did the review get better to read".
Neither is trusted alone — which is why the calibration pair and the swapped
order are in the script rather than in someone's head.

## Round 5 — the tests rule, stated and then enforced

Round 2 spelled out "all tests in one trailing group" in the prompt and the score
did not move; reading the replies showed why: the model keeps pairing each source
file with its own test, because that is how the files look related. An
instruction ignored twice is a rule the code should keep, so `trailTests`
(`src/llm/tests-last.ts`) now rewrites every grouping — model reply or fallback —
into one final `Tests` group.

Order matters and the first shape was wrong. Tests placed ahead of the
mechanical group read fine until `formatting-only`, whose only other group _is_
mechanical: the reviewer then opened on tests and met the change carrying the
intent at the bottom. Last means last, behind mechanical bulk. Two ignorable
groups need no order between them; the thinking goes first.

After the rewrite, on 24 recorded replies: **ARI 0.56 ±0.35** (tau 0.72 ±0.15),
against 0.36 for the shipped prompt in round 4 — the largest movement any change
has produced here, and the first time the model outscores the regex split (0.42)
on the counting harness. That is the fixtures' own convention finally being met,
not a claim about readability.

One guard had to move with it. `mechanicalGroupIsLast` failed on
`formatting-only` because `trailTests` now parks tests behind the mechanical
group — the guard was asserting the order the code had deliberately reversed.
It now ranks only the groups a reviewer ranks, ignoring a trailing test-only
group. `formatting-only` still scores ARI 0.00: its fixture puts a test file in
the mechanical group, and `trailTests` pulls it out. The fixture is the older
opinion of the two.

## Round 6 — the reviewer disagrees with both instruments

The judge had never been checked against the person the tool is for. Two blind
rounds on the A/B page `scripts/build-verdict-artifact.ts` builds: the same diff
in two layouts, sides shuffled per diff, nothing saying which came from the
model. Three fixtures per round, six votes.

| round               | reviewer chose model | judge (opus-5)        |
| ------------------- | -------------------- | --------------------- |
| before `trailTests` | 3 / 3                | 1 win, 2 undecided    |
| after `trailTests`  | 3 / 3                | 2 losses, 1 undecided |

**Six votes, six for the model over the hand-written fixture.** The reviewer's
reasons on round 1 were the tests rule verbatim ("would be perfect if all tests
formed the last group, which I can then just ignore") — which is what round 5
then built; on round 2, with that fixed, the votes came with no complaint at all.

So all three instruments now disagree in a readable way. ARI ranks the fixtures
top by construction. The judge reasons from the same rules the prompt states and
still lands on the fixture — it is closer to the fixture author's taste than to
the reviewer's. The reviewer takes the model's finer, more descriptive groups
every time, which is exactly what the fixtures, and therefore ARI, penalise.

Votes and reasons: `test/fixtures/grouping-reviewer-verdicts.json`. Six votes is
not a lot; it is also six more ground truth than the project had, and it is
unanimous.

## Round 7 — the question was settled by asking who it was for

The open question was which instrument gets to say "better": rewrite the
fixtures around the votes, score against the votes directly, or recalibrate the
judge. Put to the reviewer, the question dissolved. The fixtures and the judge
were only ever proxies for him; he had now answered directly, 6 times out of 6,
and a proxy that disagrees with the principal is not an instrument, it is an
error. There is nothing left to calibrate against — the votes are unanimous, so
"prefer the model" fits them perfectly and is unfalsifiable.

So grouping is good enough for now, and the useful evidence is the next kind:
the reviewer using the tool on real diffs. **Nothing here is a gate, nothing
here is gold.** ARI, tau, the guards and the judge stay as regression
detectors — something changed, go look — because the reviewer cannot be in the
loop on every run. The search for a better prompt stops: ~350 calls over five
variants produced nothing above noise, and the one change that did move anything
(`trailTests`) came from a reviewer's sentence, not from a score.

## What this leaves

- The shipped prompt is unchanged: no variant beat it by more than noise, on
  either instrument.
- The model's grouping is worth its call — the judge takes it over both
  thoughtless layouts every time — and is still a little behind a human's, which
  is where the remaining work is.
- ARI's ranking of the regex split above the model is a known wrong answer.
  Read the counting harness for movement between runs of the same shape, not as
  a verdict on quality.
- The tests convention is settled: stated in the prompt and enforced in code by
  `trailTests`, because stating it was not enough.
- **Ground truth is the reviewer**, in
  `test/fixtures/grouping-reviewer-verdicts.json`. The fixtures are recorded
  past groupings; ARI, tau and the judge are regression detectors. None of them
  ranks a grouping the reviewer has ranked himself.
- Judge verdicts are recorded in `test/fixtures/grouping/verdicts/` with reasons,
  so they can be read and argued with.
- Next evidence comes from use, not from this harness: what the reviewer wants
  changed after reviewing real diffs with the tool. Reopen this log then, with a
  complaint in hand and a hypothesis under it.

## Round 8 — the rule was right, the classifier was this repository's

Reopened with a complaint in hand, as the previous round asked for. The reviewer
saw tests near the top of a review, and C# tests grouped with the production
class they cover. Both are one miss: `trailTests` knew a test by a `test/` or
`tests/` path segment or a `.test.`/`.spec.` infix, which is how this repository
writes tests and not how .NET, Go, Python, the JVM, Ruby, PHP or C++ do.
`MyProj.Tests/OrderServiceTests.cs` read as production code, so the step that
enforces the rule had nothing to move and the model's file-by-file pairing
stood.

The classifier is now a named table of conventions, one line each, rather than a
regular expression to be extended in place. False positives are the expensive
direction — a production file misread as a test is dragged out of the reading
order the model chose and parked at the bottom — so directory rules match whole
path segments and suffix rules name their extensions: `src/testing/harness.ts`,
`contest/`, `latest/`, `TestData/fixtures.json`, `Testable.java` and
`openapi_spec.yaml` are all production. Rust's inline `#[cfg(test)]` tests are
out of reach of any path and are not claimed.

The harness kept its own copy of the old expression, which also drove the
`source split from tests` reference layout; it now imports the shipped one, so
the guards and the tool cannot disagree about what a test is. Scores are
unchanged by the widening — aggregate **ARI 0.56 ±0.35**, tau 0.72 ±0.15, regex
split 0.42, on the same 24 recorded replies — because every fixture is a diff of
this repository, where the old two conventions already saw every test. That is
the point of running it: the change is measured as no regression on what was
measurable, and the fix itself is only visible on diffs from other ecosystems,
which this harness has none of.

Also fixed on the way: `trailTests` claimed in its own comment, and in round 5
above, to rewrite the fallback grouping, and did not. The code was brought to
the documentation for the fallback only — one undifferentiated group is the
reading order a reviewer is least helped by, so the one rule that needs no model
applies there too, while a diff of nothing but tests keeps its `All Changes`
group and a one-file diff is left alone, because that path reports "nothing to
order" and a call that then orders the file argues with itself.

Review of the round found the classifier claiming more than it could keep. The
rules were a `Record` whose keys nothing read and a hand-written list of paths
in the test file beside it, and the two had already drifted apart inside the
commit that introduced them: twenty-five claimed extensions had no test, and two
rows passed because a different rule matched them. Each convention now carries
its own examples and counterexamples and the tests iterate the table, so a
convention cannot be listed without being exercised, and a rule another rule has
swallowed whole — `src/test`, under the `tests?/` directory rule — fails instead
of reading as coverage. `Spec` turned out to be a test convention only on the
JVM's scripting languages: in .NET, Java, VB, F# and Swift it names a production
type holding a specification, and five such files were being exiled to the
bottom of the review.

## Round 9 — the subtitle stopped asking and started telling

Reopened with two complaints from use, which is the evidence round 7 asked for.

The first was the subtitle. Every rationale the model wrote was a question,
because the prompt asked for one: "what to check in that group: the question the
reviewer should hold those files against". The reviewer's reading of that in
practice — "Heading: 'Session Lifecycle handling in frontend', Subheading: 'Does
the session lifecycle handling in frontend look right?'" — is the failure the
instruction invited: with nothing to add, the model restates the heading and
puts a question mark on it. What he wanted instead was "a short concise summary
of what these changes _do_, a short primer that complements the even shorter
title". So `rationale` is now one short sentence saying what the group's change
does, questions and restatements of the name are banned in as many words, and
the reviewer's own example is in the prompt as the bad half of a good/bad pair.

The second was order: "new dependencies, security-critical, git hooks" rank
high, and "dependency/git hook changes should be above tests for sure" — but
"not the top priority... I would let the LLM sort it in". So it is a prompt
rule, in the same prose as the other ordering principles, saying they rank high
and above the tests in every case and leaving their position against the stated
intent to the model. No second post-processing pass: `trailTests` stays the only
order the code enforces.

`trailTests`'s own hardcoded rationale went with the first complaint — "Do these
check what the change above promises?" was a check-question, and it also pointed
at "the change above" from a position it cannot be sure it has, since a fallback
of nothing but tests can leave it standing alone. It now says what those files
are, which holds wherever the group lands.

Re-recorded all 24 replies and re-graded:

| replies                  | ARI        | pairwise f1 | tau        |
| ------------------------ | ---------- | ----------- | ---------- |
| before, check-question   | 0.56 ±0.35 | 0.61        | 0.72 ±0.15 |
| after, summary rationale | 0.55 ±0.34 | 0.61        | 0.70 ±0.15 |

Inside the spread on ARI everywhere; tau on `require-intent` moved further than
its spread (0.83 ±0.01 → 0.76 ±0.04) and `close-the-conversation` only just
overlaps. Note also that 17 of the 24 replies came back with a different file
partition, not merely different rationale text: the sample was re-rolled, and
that ARI held across a full re-roll is the finding, not that nothing moved.

One `firstGroupServesTheIntent` alarm on `require-intent` (2/3), on
`require-intent.3.json`. It is the loose guard that has flickered since round 2,
but not only that: the first group is named "Intent requirement and validation"
and holds `src/cli.ts` and `src/errors.ts` while `src/commands/start.ts` — which
its own rationale talks about, and which the human fixture puts in that group —
sits in the group below. The reply drifted, and with both prompt edits recorded
in one shot the drift is unattributable. Noise is the most likely reading; it is
not nothing.

The qualitative check is the actual result. Counting only what the model wrote —
24 of the rationales on disk are the one hardcoded `Tests` string — **0 of 112
are questions, where 112 of 113 before this were**. The one before-rationale
that was not a question was not a summary either ("Review the referenced design
documents to understand the architectural decisions and implications."), which
is the same complaint with a full stop on it:

- "Adds --intent as a required, repeatable flag to the start command and
  extracts it from CLI arguments."
- "Factors breakpoint queries into functions that account for panel collapse,
  making the breakpoint 352px lower when the panel is shut."
- "Changes rounds from optional to required, rejecting legacy sessions without
  round history instead of treating them as empty."
- "Points the browser bundle entry point to the new main.ts location under dom/."

One recording attempt. No rationale restates its own name — even a short one
("Marks task 8 complete in project planning documents." under "Task tracking")
names the documents the heading does not. The priority rule cannot be seen in these numbers at all: none of the eight
fixtures adds a dependency, touches a git hook or changes anything
security-critical, which is the same blindness the C# entry in `todo.md` names.
It ships on the reviewer's say-so, and the next diff that installs a package is
where it gets looked at.

## Round 10 — the mood the question mark was hiding

Review of round 9 counted what round 9 only sampled, and found three things the
first pass left.

**The prompt banned questions and left the voice open.** 19 of the 112
model-written rationales came back as orders — "Add the focus field to the
SessionData interface…", "Remove unnecessary null-coalescing operators…",
"Stop skipping diffs based on file count…" — with whole fixtures drifting that
way (`attention-per-file` 5 of 5). Read under a group name that is a subtitle,
those are instructions to the reviewer, which is the complaint the round began
with: "instead of telling me what to do". A question mark was never the thing;
the mood was. The instruction now says it in as many words — say what the change
does, in the third person, never a question, never an instruction to the
reviewer — and carries a second bad example next to the reviewer's own.

Re-recorded and re-graded after the wording change:

| replies                   | ARI        | pairwise f1 | tau        | questions | imperatives |
| ------------------------- | ---------- | ----------- | ---------- | --------- | ----------- |
| before round 9            | 0.56 ±0.35 | 0.61        | 0.72 ±0.15 | 112 / 113 | —           |
| round 9, questions banned | 0.55 ±0.34 | 0.61        | 0.70 ±0.15 | 0 / 112   | 19 / 112    |
| round 10, voice pinned    | 0.55 ±0.32 | 0.61        | 0.66 ±0.16 | 0 / 115   | 0 / 115     |

Every rationale on disk now opens in the third person: 24 `Adds`, 14 `Updates`,
8 `Marks`, 7 `Introduces`, and not one bare verb. That is the second qualitative
result in two rounds, and it is again the evidence that counts here. ARI is flat
across both re-rolls; tau has drifted down 0.72 → 0.70 → 0.66 over three
recordings of three different prompts, which is worth naming rather than
rounding away — the ordering metric is the one moving, no prompt line was about
order except the priority bullet, and no fixture exercises that bullet. Most
likely re-roll drift on a spread of ±0.15; if the next round records again and
tau keeps sliding, it is not.

**Accepted, with a second explanation on the record.** Shown this slide, the
author of the references accepted it and named a cause the metric cannot see:
their own preferences moved over these rounds, so the reference orderings the
tau is measured against are partly stale. That makes a falling tau ambiguous by
construction — a prompt drifting away from the references and references drifting
away from the prompt produce the same number. Nothing to fix in the prompt; the
thing to fix, when it next matters, is the reference set. Until it is re-cut,
tau on these fixtures is a weak signal and should not be used alone to reject a
prompt round.

**The lockfile was two rules at once.** "A package added to the manifest" ranks
high; "generated output" is quarantined last. `pnpm-lock.yaml` is both, and
nothing said which won — an ambiguity this round's own priority bullet
introduced, on precisely the file the reviewer asked the rule for. The
mechanical bullet now ends it: a dependency lockfile is not that bulk, however
it was generated, and goes high with the manifest that pins it.

The harness had the same bug with the opposite sign. `MECHANICAL_NAME` in
`grade-grouping.ts` matched `lockfile`, so a model that obeyed the new rule and
opened on "Lockfile and dependency bump" would have failed
`mechanicalGroupIsLast` — the guard punishing the wanted answer. `lockfile` is
out of that pattern, with the reason written beside it. No score moves: no
fixture here adds a dependency, which is exactly why nobody noticed.

**The judge's cache was going stale in silence.** Verdicts were keyed
`<judge>.<reference>.<fixture>.<a|b>`, with reply content nowhere in the key and
`if (existsSync(path)) return;` in front of it. Re-recording the replies in
round 9 left all 48 cached verdicts reasoning about groupings that no longer
existed — one of them argues about "A's stray single-file group … four tight
questions instead of five" for a fixture that now has four groups with different
membership — and the next `judge:grouping` run would have skipped every one and
printed them as current. The judge is documented as the instrument that says
whether a review got better to read; an instrument that quietly reports last
month's reading is worse than none. The key now carries a content hash of the
grouping judged, the hash is stored in the verdict, and `loadVerdicts` drops any
verdict whose grouping has been re-recorded and says how many it dropped. The 48
are deleted rather than migrated: they were cast on layouts that no longer
exist, and the next judged run pays for its own evidence.

Also from that review, in the code rather than the prompt: the two rationales
this repository writes itself now have tests instead of comments. The `Tests`
group's string is asserted question-free, position-independent and identical
whatever sits above it; the `All Changes` fallback string, which a reviewer
meets on every ordinary one-file review and not only on the degraded path, was
"ungrouped diff" — a label, not a sentence — and is now "Not ordered by a model:
the files are in the order git listed them." The prompt tripwires that pinned
sentence construction rather than intent were loosened to match on the rule, and
the `stated intent` tripwire was tightened: the new priority bullet also
contains those two words, so the old assertion could no longer fail if the
opening rule were deleted.

## Round 11 — the first round that changed what the model sees

Every round before this one changed what the model was _told_. This one changed
what it was _shown_: the prompt used to cut each file's diff at a flat 4 000
characters, head first and mid-line, so a large file was grouped on its opening
hunks alone and everything below them was invisible. The budget is now shared
out between the files by water-filling, and a file that must still be cut is cut
at a hunk boundary with a note saying what was dropped — `4 of 11 hunks shown,
380 further changed lines not shown`.

**What the fixtures were losing.** 11 of the 96 files across the eight fixtures
were truncated. `ledger-scan-scope` was the worst: 8 of its 12 files cut, the
model seeing 38.7% of a 91,421-character diff — while the prompt came to 36,571
characters against a 120,000 budget, so 80,000 characters were going unspent at
the same time as the model was being starved. `require-intent` saw 76.6% of its
diff, `close-the-conversation` 93.5%. All eight now send every patch whole; the
largest prompt of the set is 92,487 characters. No fixture ever tripped the
old all-or-nothing "diffs omitted" path, so that defect was real but unreached
here.

**Re-recorded, all 24 replies.** Aggregate ARI 0.55 → 0.57, pairwise f1
0.61 → 0.63, ordering tau 0.66 → 0.70. Guards unchanged: the same lone
`firstGroupServesTheIntent` miss on `require-intent` (2/3). Per fixture, the
two that gained most are the two that gained sight — `drop-grouping-threshold`
0.93 → 1.00 and `require-intent` 0.78 → 0.82 — with `ledger-scan-scope`, whose
diff was the one being starved, 0.73 → 0.75. Against them,
`close-the-conversation` 0.26 → 0.25 and `intent-above-the-diff` 0.61 → 0.59.
Every one of these movements is inside the run-to-run spread this log opened by
measuring, so none of them is a result on its own.

**Why tau is worth a line here.** It had slid 0.72 → 0.70 → 0.66 across rounds
8-10 and recovered to 0.70 in this one. Round 10's entry says plainly that part
of that slide is the reference orderings going stale rather than the prompt
getting worse, and nothing about this round re-cut the references — so the
recovery is no more trustworthy than the slide was. What is different is the
kind of change being measured: a round that alters the model's evidence can move
a metric for a reason that is not drift, which is the first time that has been
true in this log. It is still one re-roll of three samples.

**What this round deliberately did not do.** It did not touch a word of the
system prompt. A follow-up round hardened the arithmetic — the allocator now
reclaims the share a file cannot spend, the stated intent is capped so agent
free text cannot blow the budget, and the cap is pinned by a seeded fuzz and an
alignment sweep rather than by one lucky shape — and changed nothing about the
prompts these eight fixtures produce, verified byte for byte, so it was not
re-recorded.
