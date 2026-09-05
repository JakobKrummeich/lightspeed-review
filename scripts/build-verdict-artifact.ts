/**
 * Builds the blind A/B page a human reviewer votes on, plus the key decoding the
 * votes. One-off tooling for `docs/grouping-experiments.md`: the judge model is
 * only evidence if a real reviewer agrees, and that check must be blind.
 *
 * Usage: `node scripts/build-verdict-artifact.ts [fixture…]`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadFixtures, loadRecordedReplies, type NamedGroup } from "./grade-grouping.ts";

const ROOT = join(import.meta.dirname, "..");
const OUT_DIR = join(ROOT, ".lavish");
const ASKED = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_FIXTURES();

function DEFAULT_FIXTURES(): string[] {
  // The three the judge was least sure about, so a human vote is worth most.
  return ["intent-above-the-diff", "ledger-scan-scope", "close-the-conversation"];
}

const escape = (text: string): string =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
  );

function renderGroups(groups: NamedGroup[]): string {
  return groups
    .map(
      (group, index) => `
        <li class="group">
          <div class="group-head"><span class="num">${index + 1}</span>${escape(group.name)}</div>
          <ul class="files">${group.files.map((file) => `<li>${escape(file)}</li>`).join("")}</ul>
        </li>`,
    )
    .join("");
}

const questions = loadFixtures(ASKED).map((fixture) => {
  const recorded = loadRecordedReplies(fixture.name)[0]!;
  const modelFirst = Math.random() < 0.5;
  return {
    fixture,
    modelFirst,
    a: modelFirst ? recorded : fixture.human,
    b: modelFirst ? fixture.human : recorded,
  };
});

const cards = questions
  .map(
    ({ fixture, a, b }, index) => `
  <form class="card" data-lavish-question="${escape(fixture.name)}" onsubmit="event.preventDefault();
      const data = new FormData(event.currentTarget);
      const answer = data.get('choice');
      if (!answer) return;
      const note = String(data.get('note') || '').trim();
      window.lavish.queuePrompt('Fixture ${escape(fixture.name)}: I would rather review by ' + answer + (note ? '. ' + note : ''), {
        tag: 'verdict', text: '${escape(fixture.name)} → ' + answer, element: event.currentTarget,
        data: { fixture: '${escape(fixture.name)}', answer, note } });
      event.currentTarget.querySelector('.queued').hidden = false;">
    <header>
      <p class="eyebrow">Diff ${index + 1} of ${questions.length} &middot; ${fixture.files.length} files</p>
      <h2>${escape(fixture.subject)}</h2>
      <p class="intent"><span>stated intent</span>${escape(fixture.intents[0] ?? "")}</p>
    </header>
    <div class="pair">
      <section class="option">
        <h3>Layout A</h3>
        <ol class="groups">${renderGroups(a)}</ol>
      </section>
      <section class="option">
        <h3>Layout B</h3>
        <ol class="groups">${renderGroups(b)}</ol>
      </section>
    </div>
    <footer>
      <p class="ask">Which one would you rather read this change in, group by group, top to bottom?</p>
      <div class="choices">
        <label><input type="radio" name="choice" value="Layout A"> Layout A</label>
        <label><input type="radio" name="choice" value="Layout B"> Layout B</label>
        <label><input type="radio" name="choice" value="no real difference"> No real difference</label>
      </div>
      <input class="note" name="note" placeholder="Why, in a few words (optional)">
      <button type="submit">Queue this answer</button>
      <span class="queued" hidden>queued &mdash; press Send to Agent when you have done all three</span>
    </footer>
  </form>`,
  )
  .join("");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Which review would you rather read?</title>
<style>
:root {
  --sol-base03: #002b36; --sol-base02: #073642; --sol-base01: #586e75; --sol-base00: #657b83;
  --sol-base0: #839496; --sol-base1: #93a1a1; --sol-base2: #eee8d5; --sol-base3: #fdf6e3;
  --sol-blue: #268bd2; --sol-green: #859900;
  color-scheme: light dark;
  --bg: light-dark(var(--sol-base3), var(--sol-base03));
  --surface: light-dark(var(--sol-base2), var(--sol-base02));
  --raised: light-dark(color-mix(in srgb, var(--sol-base2) 55%, var(--sol-base3)), color-mix(in srgb, var(--sol-base02) 80%, var(--sol-base0)));
  --border: light-dark(color-mix(in srgb, var(--sol-base2) 55%, var(--sol-base1)), color-mix(in srgb, var(--sol-base02) 60%, var(--sol-base01)));
  --text: light-dark(var(--sol-base00), var(--sol-base0));
  --strong: light-dark(var(--sol-base01), var(--sol-base1));
  --muted: light-dark(var(--sol-base1), var(--sol-base01));
  --accent: var(--sol-blue);
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}
* { box-sizing: border-box; min-width: 0; }
body { margin: 0; background: var(--bg); color: var(--text); font: 1rem/1.55 var(--font); }
main { max-width: 76rem; margin: 0 auto; padding: 2.5rem 1.25rem 5rem; }
h1 { color: var(--strong); font-size: 1.6rem; margin: 0 0 .4rem; }
.lede { max-width: 46rem; margin: 0 0 2rem; }
.lede strong { color: var(--strong); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: .75rem; padding: 1.25rem; margin: 0 0 1.75rem; }
.card header h2 { color: var(--strong); font-size: 1.15rem; margin: .1rem 0 .5rem; }
.eyebrow { color: var(--muted); font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; margin: 0; }
.intent { background: var(--raised); border-left: 3px solid var(--accent); border-radius: .3rem; margin: 0 0 1rem; padding: .55rem .75rem; }
.intent span { color: var(--muted); display: block; font-size: .75rem; letter-spacing: .05em; text-transform: uppercase; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); gap: 1rem; }
.option { background: var(--raised); border: 1px solid var(--border); border-radius: .55rem; padding: .9rem 1rem; }
.option h3 { color: var(--accent); font-size: .95rem; margin: 0 0 .6rem; }
.groups { list-style: none; margin: 0; padding: 0; }
.group + .group { margin-top: .7rem; }
.group-head { color: var(--strong); font-weight: 600; }
.num { color: var(--muted); display: inline-block; font-variant-numeric: tabular-nums; margin-right: .45rem; }
.files { list-style: none; margin: .2rem 0 0; padding: 0 0 0 1.6rem; }
.files li { font-family: var(--mono); font-size: .82rem; overflow-wrap: anywhere; }
footer { margin-top: 1.1rem; }
.ask { color: var(--strong); margin: 0 0 .5rem; }
.choices { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: .7rem; }
.choices label { cursor: pointer; }
.note { background: var(--bg); border: 1px solid var(--border); border-radius: .35rem; color: var(--text); font: inherit; padding: .45rem .6rem; width: min(100%, 30rem); }
button { background: var(--accent); border: 0; border-radius: .35rem; color: var(--sol-base3); cursor: pointer; font: inherit; margin-left: .5rem; padding: .45rem 1rem; }
.queued { color: var(--sol-green); font-size: .85rem; margin-left: .6rem; }
</style>
</head>
<body>
<main>
  <h1>Which review would you rather read?</h1>
  <p class="lede">Three real diffs from this repository. For each, two ways of splitting it into
  groups a reviewer reads top to bottom. <strong>One of each pair came from the grouping model,
  the other from the hand-written fixture</strong> &mdash; which is which is not shown, and the
  sides were shuffled per diff, so your answer is blind. It decides whether the opus judge that
  currently scores the prompt agrees with an actual reviewer.</p>
  ${cards}
</main>
</body>
</html>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "grouping-verdicts.html"), html);
writeFileSync(
  join(OUT_DIR, "grouping-verdicts.key.json"),
  `${JSON.stringify(
    questions.map(({ fixture, modelFirst }) => ({
      fixture: fixture.name,
      A: modelFirst ? "recorded" : "human",
      B: modelFirst ? "human" : "recorded",
    })),
    null,
    2,
  )}\n`,
);
console.log("wrote .lavish/grouping-verdicts.html and its key");
