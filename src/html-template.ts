import { escapeHtml } from "./escape-html.ts";
import { renderIntent } from "./browser/intent-view.ts";
import { renderStatusBanner } from "./browser/status-banner.ts";
import { currentCommits, currentIntents } from "./rounds/session-round.ts";
import { COLOR_SCHEME_OPTIONS, DEFAULT_SCHEME } from "./browser/color-scheme.ts";
import { DEFAULT_FORMAT, VIEW_FORMAT_OPTIONS } from "./browser/view-format.ts";
import type { SessionRecord } from "./session-store.ts";

/**
 * The review page shell. Groups and diffs are fetched from
 * `/api/session/:key/data` by the browser bundle rather than inlined, so the
 * HTML stays small and a re-group is a fetch instead of a reload.
 */
export function renderReviewPage(session: SessionRecord): string {
  const title = `${session.branch} ← ${session.base}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} · lightspeed</title>
    <link rel="stylesheet" href="/static/app.css" />
    <script type="module" src="/static/app.js"></script>
  </head>
  <body data-session-key="${escapeHtml(session.key)}" data-panel="open">
    <header class="lsr-header">
      <h1>${escapeHtml(session.branch)} <span class="lsr-base">← ${escapeHtml(session.base)}</span></h1>
      <span id="lsr-progress" class="lsr-progress"></span>
      <div id="lsr-view-switch" class="lsr-switch" role="group" aria-label="Diff view">
        ${renderViewOptions()}
      </div>
      <div id="lsr-scheme-switch" class="lsr-switch" role="group" aria-label="Colour scheme">
        ${renderSchemeOptions()}
      </div>
      <button id="lsr-replay-reopen" class="lsr-replay-reopen" type="button" hidden>Replay last round</button>
      <!-- Empty and hidden until a round arrives that the reviewer is in the
           middle of something to take: the bundle writes what it says, because
           only the browser knows whether they are somewhere in this round. -->
      <button id="lsr-round-offer" class="lsr-round-offer" type="button" hidden></button>
      <div id="lsr-status-banner">${renderStatusBanner({ status: session.status, agentWaiting: false, agentWorking: false, review: session })}</div>
    </header>
    <main id="lsr-review" class="lsr-review">
      <section id="lsr-intent" class="lsr-intent">${renderIntent({
        intents: currentIntents(session),
        commits: currentCommits(session),
      })}</section>
      <div id="lsr-diff" class="lsr-diff"></div>
    </main>
    <button id="lsr-panel-rail" class="lsr-panel-rail" type="button" aria-controls="lsr-panel" aria-expanded="true" aria-label="Hide the conversation">
      <span class="lsr-rail-badge" hidden></span>
    </button>
    <aside id="lsr-panel" class="lsr-panel"></aside>
    <div id="lsr-opening"></div>
    <div id="lsr-replay"></div>
    <div id="lsr-round-popup" hidden></div>
  </body>
</html>
`;
}

/** The initial pressed option matches what the bundle renders before it loads. */
function renderViewOptions(): string {
  return VIEW_FORMAT_OPTIONS.map(
    ({ format, label }) =>
      `<button type="button" class="lsr-switch-option" data-format="${format}" aria-pressed="${format === DEFAULT_FORMAT}">
          ${label}
        </button>`,
  ).join("\n        ");
}

/**
 * Auto is pressed until the bundle reads the stored choice: the page itself is
 * already following the OS through `light-dark()`, so it never contradicts.
 */
function renderSchemeOptions(): string {
  return COLOR_SCHEME_OPTIONS.map(
    ({ scheme, label }) =>
      `<button type="button" class="lsr-switch-option" data-scheme="${scheme}" aria-pressed="${scheme === DEFAULT_SCHEME}">
          ${label}
        </button>`,
  ).join("\n        ");
}
