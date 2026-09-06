import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderReviewPage } from "../src/html-template.ts";
import { DEFAULT_STATIC_DIR, loadAssets } from "../src/static-assets.ts";
import type { SessionRecord } from "../src/session-store.ts";

const session: SessionRecord = {
  key: "abc123",
  repoRoot: "/repo",
  branch: "feature-auth",
  base: "main",
  status: "open",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  groups: [],
  conversation: [],
  pending: [],
  approved: [],
  rounds: [],
};

test("the page loads the browser bundle and its stylesheet", () => {
  const html = renderReviewPage(session);

  assert.match(html, /<link rel="stylesheet" href="\/static\/app.css"/);
  assert.match(html, /<script type="module" src="\/static\/app.js"><\/script>/);
});

/**
 * Shell names assets as literals, server snapshots the build by name, nothing links the two:
 * rename an esbuild entry point and every page 404s. Reads the actual build, so fails on a stale one too.
 */
test("every asset the page shell asks for is in the built bundle", () => {
  const html = renderReviewPage(session);
  const requested = [...html.matchAll(/\/static\/([\w.-]+)/g)].map((match) => match[1]!);
  const assets = loadAssets(DEFAULT_STATIC_DIR);

  assert.ok(requested.length > 0, "the shell should ask for at least one asset");
  for (const asset of requested) {
    assert.ok(
      assets.has(asset),
      `the shell asks for /static/${asset}, which the build does not have`,
    );
  }
});

test("the page carries the session key so the bundle knows what to fetch", () => {
  assert.match(renderReviewPage(session), /data-session-key="abc123"/);
});

test("the page renders the status banner so it is right before the bundle loads", () => {
  const html = renderReviewPage(session);

  assert.match(html, /id="lsr-status-banner"/);
  assert.match(html, /data-status="open"/);
  // Server cannot know presence from the record; the page claims neither until the stream says so.
  assert.match(html, /data-waiting="false"/);
  assert.match(html, /data-working="false"/);
});

test("the round offer waits in the header, empty until the bundle has news", () => {
  const header =
    /<header class="lsr-header">[\s\S]*?<\/header>/.exec(renderReviewPage(session))?.[0] ?? "";

  // Hidden and wordless from the server: only the browser knows whether a round may take the screen.
  assert.match(
    header,
    /<button id="lsr-round-offer" class="lsr-round-offer" type="button" hidden><\/button>/,
  );
});

test("the round popup has a reserved landmark, empty until a round arrives", () => {
  // Classless on purpose: the shell's grid guard reads a class on a body child as a region owed
  // a cell, and an overlay floats.
  assert.match(renderReviewPage(session), /<div id="lsr-round-popup" hidden><\/div>/);
});

test("the finish has a reserved landmark too, empty until the last tick", () => {
  assert.match(renderReviewPage(session), /<div id="lsr-done-popup" hidden><\/div>/);
});

test("an ended session is shown as ended without waiting for the bundle", () => {
  assert.match(renderReviewPage({ ...session, status: "ended" }), /lsr-ended-overlay/);
});

test("a page opened on a review that ended long ago still sums it up", () => {
  // Counted server-side from the record: the summary must not depend on the bundle.
  const html = renderReviewPage({
    ...session,
    status: "ended",
    endedBy: "reviewer",
    groups: [
      {
        name: "Schema",
        rationale: "why",
        files: [
          {
            path: "src/db.ts",
            status: "modified",
            diff: "@@ -1 +1 @@\n-old\n+new",
            insertions: 3,
            deletions: 1,
            oversized: false,
          },
        ],
      },
    ],
    rounds: [{ index: 0, at: "2025-01-01T00:00:00.000Z", files: [], approvedAtEnd: [] }],
  });

  assert.match(html, /lsr-closing-verdict/);
  assert.match(html, /lsr-closing-count">1<\/span><span class="lsr-closing-label">round/);
  assert.match(html, /You ended this review\./);
});

test("the header carries a segmented switch that shows which view is on", () => {
  const html = renderReviewPage(session);

  assert.match(html, /id="lsr-view-switch"/);
  assert.match(html, /data-format="line-by-line" aria-pressed="true">\s*Unified/);
  assert.match(html, /data-format="side-by-side" aria-pressed="false">\s*Side-by-side/);
});

test("the header carries a segmented switch for the colour scheme", () => {
  const html = renderReviewPage(session);

  assert.match(html, /id="lsr-scheme-switch"/);
  assert.match(html, /data-scheme="system" aria-pressed="true">\s*Auto/);
  assert.match(html, /data-scheme="light" aria-pressed="false">\s*Light/);
  assert.match(html, /data-scheme="dark" aria-pressed="false">\s*Dark/);
});

test("branch names are escaped rather than injected", () => {
  const html = renderReviewPage({ ...session, branch: '<img src=x onerror="alert(1)">' });

  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

/** A round the page can name a reason for. */
function withRound(intents: string[], commits: string[]): SessionRecord {
  return {
    ...session,
    rounds: [
      {
        index: 0,
        at: "2025-01-01T00:00:00.000Z",
        intents,
        commits,
        files: [],
        approvedAtEnd: [],
      },
    ],
  };
}

test("the page opens with what the change is for, before any group", () => {
  const html = renderReviewPage(withRound(["sign the tokens"], ["wire up the signer"]));

  assert.ok(html.indexOf("sign the tokens") < html.indexOf(`id="lsr-diff"`));
  assert.match(html, /id="lsr-intent"/);
  // The commits are recorded on the round and rendered nowhere: see `intent-view.ts`.
  assert.doesNotMatch(html, /wire up the signer/);
});

/** The reason heads the scrolling region, not a page row: read first, then it leaves the screen. */
test("the intent and the diff scroll as one region", () => {
  const html = renderReviewPage(withRound(["sign the tokens"], []));
  const region =
    /<main id="lsr-review" class="lsr-review">([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";

  assert.match(region, /id="lsr-intent"/);
  assert.match(region, /id="lsr-diff"/);
  assert.ok(region.indexOf(`id="lsr-intent"`) < region.indexOf(`id="lsr-diff"`));
});

test("every landmark the bundle insists on is one the shell renders", () => {
  // `readPage` gives up on the first missing landmark: a rename breaks not one feature but the
  // whole mount. Read from source — `main.ts` cannot be imported (stylesheets, EventSource, runs itself).
  const bundle = readFileSync(new URL("../src/browser/dom/main.ts", import.meta.url), "utf8");
  const wanted = [...bundle.matchAll(/querySelector<HTMLElement>\("#([\w-]+)"\)/g)].map(
    ([, id]) => id,
  );
  const html = renderReviewPage(session);

  assert.ok(wanted.includes("lsr-review"), "the scroll container is one of them");
  for (const id of wanted)
    assert.match(html, new RegExp(`id="${id}"`), `the shell renders no #${id}`);
});

/** Rendered by the server, so the reason is never a frame behind the page. */
test("an intent is escaped in the shell exactly as it is in the bundle", () => {
  const html = renderReviewPage(withRound(["<script>alert(1)</script>"], []));

  assert.doesNotMatch(html, /<script>alert\(1\)/);
  assert.match(html, /&lt;script&gt;/);
});

/** The server draws the shut block, so the browser never has one to fold away. */
test("the reasons the server renders are behind the press, not on the screen", () => {
  const html = renderReviewPage(withRound(["sign the tokens"], []));

  assert.match(html, /class="lsr-intent-press" aria-expanded="false"/);
  assert.match(html, /<div class="lsr-intent-body" id="lsr-intent-body" hidden>/);
});

test("a session with no rounds still renders the page, with an empty intent band", () => {
  const html = renderReviewPage(session);

  assert.match(html, /<section id="lsr-intent" class="lsr-intent"><\/section>/);
});
