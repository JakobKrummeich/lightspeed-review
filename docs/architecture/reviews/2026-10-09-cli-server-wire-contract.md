# The CLI ⇄ server protocol has no contract the compiler can see

- **Date:** 2026-10-09
- **Status:** Proposed — needs a human decision, no code was changed
- **Scope:** `src/commands/api-client.ts` and its callers (`work.ts`, `reply.ts`, `end.ts`, `round.ts`, `long-poll.ts`, `listen.ts`, `presence.ts`, `server-address.ts`); `src/server/http.ts`, `src/server/validate.ts`, `src/server/handlers-{session,turn,feedback,stream,review}.ts`, `src/server.ts`, `src/feedback.ts`; new `src/api-contract.ts` and `test/api-contract.test.ts`

## 1. Context

History at the time of writing: 350 commits, 2026-09-05 → 2026-10-09 (so the
evidence file's 90-day and 180-day windows both cover the whole history). 267
non-merge commits touch `src`, `scripts`, `bin` or `test`.

Most of the module pairs in the evidence file are a source module and its own
test mirror (`src/browser/dom ↔ test/browser/dom` 0.89, `src/commands ↔
test/commands` 0.83, and so on). Those are expected and say nothing about
boundaries. Nested pairs (`src/browser ↔ src/browser/css`) co-change by
construction. The proposal looks past both kinds, at **sibling source modules
that should be independent**:

| Signal                                                                   | Number                     |
| ------------------------------------------------------------------------ | -------------------------- |
| Commits touching `src/server/` or `src/server.ts`                        | 40                         |
| …of which also touch `src/commands/`                                     | **21 (52%)**               |
| `src/server` cross-module share (evidence §4)                            | 0.92 (33 / 36)             |
| `src/commands/feedback.ts ↔ src/server/handlers-stream.ts`               | 7 co-changes, support 0.64 |
| `src/commands/work.ts ↔ src/server/handlers-turn.ts`                     | 7, 0.54                    |
| `src/commands/home.ts ↔ src/server/handlers-stream.ts`                   | 7, 0.44                    |
| `src/commands/wait.ts` (since removed) `↔ src/server/handlers-stream.ts` | 6, 0.43                    |
| `src/commands/home.ts ↔ src/server/handlers-turn.ts`                     | 6, 0.46                    |

These are the strongest file pairs between sibling source modules in the repo,
apart from one renderer and its own stylesheet. The browser stylesheet hotspot
from the previous review has dissolved: `src/browser/chrome.css` is now an
`@import` list over 21 area files, guarded by
`test/browser/stylesheet-boundary.test.ts`.

The CLI talks to the server over HTTP, so commands and handlers that serve one
agent verb are _meant_ to change together. The co-change itself is not the
problem. The problem is that the dependency it reveals has **no import edge
anywhere**. `pnpm arch` cannot see it, `pnpm typecheck` cannot see it, and only
an end-to-end test that happens to exercise the exact field ever catches drift.
That is Tornhill's hidden dependency in its literal form.

## 2. Finding

**Every request body and every answer on the CLI's routes crosses the process
boundary as `unknown`. Each side describes the shape separately, and nothing
links the two descriptions.** These are the three untyped edges, read out of the
code:

- `src/commands/api-client.ts:21` — `apiRequest(url, init, about): Promise<unknown>`
- `src/commands/api-client.ts:225` — `jsonPost(body: unknown): RequestInit`
- `src/server/http.ts:30` — `sendJson(response, status, body: unknown)`

**Requests.** The CLI builds four bodies as untyped object literals:
`work.ts:62` `jsonPost({ plan, head, tree })`, `reply.ts:63`
`jsonPost({ replies, ...state })`, `round.ts:120` (twelve fields) and
`long-poll.ts:65` `jsonPost({ delivery })`. The server already has types for
them, but the CLI cannot use or does not use them:

- `WorkRequest` (`src/server/validate.ts:109`) and `ReplyRequest`
  (`validate.ts:70`) live inside `src/server/`. The dependency-cruiser rule
  `server-internals-only-via-server` **forbids `src/commands/` from importing
  them**, so the boundary rule that keeps handlers private also keeps their
  contract private.
- `CreateSessionRequest` (`src/rounds/session-round.ts:20`) is importable, and
  `round.ts` already imports from that file (`currentGroupingMode`). But
  `publishRound()` never uses the type, so a renamed field there still compiles.

**Answers.** The CLI states each answer's shape with an ad-hoc cast at the call
site. The server builds the same shape by spreading literals:

| Route                            | Server builds                                                                                              | CLI assumes                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /api/session/:key/work`    | `{ ...turnFacts(updated), changed, open }` (`handlers-turn.ts:44`)                                         | `as Partial<TurnFacts> & { changed?: boolean; open?: string[] }` (`work.ts:64`)          |
| `POST /api/session/:key/reply`   | `{ ...turnFacts(updated), replied: n }` / `{ …, rerun: true }` (`handlers-feedback.ts:185`, `:171`)        | `as Partial<TurnFacts> & { rerun?: boolean }` (`reply.ts:65`)                            |
| `POST /api/session/:key/end`     | `{ status: "ended", ...turnFacts(ended) }` (`handlers-session.ts:199`)                                     | `as Partial<TurnFacts>` (`end.ts:44`)                                                    |
| `POST /api/sessions`             | `{ ...answerFor(…), reattached: true }` / `ledger` / `rerun: true` (`handlers-session.ts:60, 64, 88, 119`) | `as CreatedSession`, an interface declared **client-side** in `src/commands/round.ts:59` |
| `GET /api/session/:key/presence` | `{ waiting }` (`handlers-stream.ts:43`)                                                                    | `as { waiting?: unknown }` (`presence.ts:17`)                                            |

Note that `replied` is already invisible to the CLI's type. That is harmless
today, but it shows the two descriptions have started to diverge.

**One route nearly does it right**, and it is the precedent for this proposal.
`GET /api/poll` answers with `PollPayload`, declared once in
`src/feedback.ts:38`, built by `batchPayload()` (`feedback.ts:140`) on the
server, and read as `PollPayload` in `src/commands/listen.ts`. Even here the
shared type hides one drift. A superseded wait is answered 200 with
`SUPERSEDED = { superseded: true, message }` (`handlers-stream.ts:89, 104`),
which has none of `PollPayload`'s required `status`, `ended` and `items`.
`PollPayload` absorbs it only through the optional `superseded?` and
`message?` fields, and `listen.ts:37` casts the answer `as PollPayload`. The
team has also been fixing this disease one symbol at a time:

- `27c5c51` (#58): _"Type every 422 refusal by the one code list the CLI
  relays, so a new refusal code fails typecheck instead of reaching agents as
  internal_error"_
- `fa24dc7` (#50): _"Type nextRule per turn, so a renamed rule key fails to
  compile instead of printing undefined"_

The refusal _bodies_ are typed now. The _success_ bodies and _requests_ are
not.

**Commits that changed a field on both sides by hand**, with no compiler
linking them:

- `2fe9a3c` _"Measure a reply from working against the tree work found…"_:
  `work.ts` starts sending `tree`, and `validate.ts`, `handlers-turn.ts` and
  `handlers-feedback.ts` start reading it. Only `test/commands/reply.test.ts`
  ties them together.
- `5c44cbf` _"Match local publish re-run check to server…"_: 10 source files on
  both sides, written to make two copies of one rule agree.
- `ecb9044` (the turn machine, 27 command files / 8 server files) and `0ba35d6`
  (11 / 6): protocol redesigns where every field was carried across by hand.

**Blast radius.** This is every agent verb: `open`, `publish`, `reply`,
`work`, `end`, and the wait behind all of them. These are the lines a coding
agent reads and acts on, and the repo's own commit history shows that a wrong
or `undefined` field there costs the agent a round. The cost of the gap is
unpredictability. A server-side rename passes `pnpm typecheck` and `pnpm arch`,
and fails only if some test drives that exact field end to end.

## 3. Proposal

### Target state

One file, `src/api-contract.ts`, sits below both `src/commands/` and
`src/server/` and imports neither. It declares every route the CLI calls, keyed
by the **same literal** that appears in the server's route table:

```ts
/** Every route the CLI calls, keyed exactly as `src/server.ts` registers it. */
export interface CliRoutes {
  "POST /api/sessions": { request: CreateSessionRequest; answer: CreatedSession };
  "POST /api/session/:key/work": { request: WorkRequest; answer: WorkAnswer };
  "POST /api/session/:key/reply": { request: ReplyRequest; answer: ReplyAnswer };
  "POST /api/session/:key/end": { request: undefined; answer: EndAnswer };
  "POST /api/session/:key/delivered": {
    request: { delivery: string };
    answer: { confirmed: boolean };
  };
  "GET /api/session/:key/presence": { request: undefined; answer: { waiting: boolean } };
  "GET /api/poll": { request: undefined; answer: PollPayload | Superseded };
  "POST /api/shutdown": { request: undefined; answer: { status: "stopping" } };
  "GET /health": {
    request: undefined;
    answer: { status: "ok"; version: string; stateDir: string };
  };
}
export type CliRoute = keyof CliRoutes;

/** A wait another waiting command took over: no turn, no items, nothing to do. */
export interface Superseded {
  superseded: true;
  message: string;
}
```

Two thin helpers replace the untyped edges:

- **Client** (`src/commands/api-client.ts`):
  `callApi(origin, route, { key }, body, about): Promise<CliRoutes[R]["answer"]>`.
  It wraps today's `apiRequest`/`jsonPost` unchanged (same error mapping, same
  `parseBody`, same retry of a failed GET). The only new logic is substituting
  `:key` in the route's path.
- **Server** (`src/server/http.ts`):
  `sendAnswer(response, route, body: CliRoutes[R]["answer"])`, which is
  `sendJson(response, 200, body)` with a typed `body`.

**Grep test:** searching `"/api/session/:key/work"` lands on three places: the
contract entry, the route table in `src/server.ts`, and the one `callApi` in
`work.ts`. Today it lands only on the route table. The CLI's call is a template
string, `` `/api/session/${key}/work` ``, which does not match.

The client keeps reading answers through `turnBlock()`, which accepts
`Partial<TurnFacts>`. A full `TurnFacts` is assignable to it, so no reader
changes behaviour.

Three client calls stay on raw `fetch` as deliberate exceptions, because
`apiRequest`'s semantics would change what they do. Where one reads an answer,
it reads it with the contract's type, not through `callApi`:

- **`/health`** (`server-address.ts:79`) is the version handshake with a server
  that may not speak this contract (`src/version.ts`), so it keeps parsing
  defensively.
- **Presence** (`presence.ts:13-17`) must answer at once, server or no server.
  It aborts after 800 ms and turns any non-ok status or error into `false`.
  Through `apiRequest` it would lose the timeout, retry a failed GET after
  50 ms (`api-client.ts:210-222`), and throw `session_not_found` on a 404
  instead of returning `false`.
- **Shutdown** (`server-address.ts:100`) returns `response.ok`. Through
  `apiRequest` a non-ok status would throw a `ReviewError` instead of
  returning `false`. It reads no body, so nothing there changes.

The server answers all three routes through `sendAnswer`.

### Stepwise plan

Each step is behaviour-preserving, types-and-call-sites only, and sized for one
daily run. Every gate stays green after each step, because nothing on the wire
changes.

1. **Create `src/api-contract.ts` with the types already shared.** Move
   `DomainErrorBody` and `SessionEndedBody` (from `src/server/http.ts`) and
   `LedgerReport` (from `src/server/ledger-log.ts`) into the new file, and
   re-export them from their old homes. Point `src/commands/api-client.ts:2`
   and `src/commands/round.ts:15` at the contract instead of `../server.ts`.
   The contract must import only `errors.ts`, `session-types.ts`, `turn.ts`,
   `threads.ts`, `feedback.ts` and `rounds/session-round.ts` types. Importing
   `server.ts` would make a cycle, and `no-circular` would fail `pnpm arch`.
2. **The `work` route end to end.** Add `CliRoutes` with only
   `"POST /api/session/:key/work"`, `callApi` and `sendAnswer`. Move
   `WorkRequest` from `validate.ts` to the contract (`validate.ts` imports it
   back). Declare `WorkAnswer = TurnFacts & { changed: boolean; open: string[] }`.
   Migrate `work.ts:60-64` and `handlers-turn.ts:44`. Move the work route's
   entry in `src/server.ts:178` into the contract-typed `cliHandlers` record
   (section 4). From now on, each route added to `CliRoutes` fails typecheck
   until it has a handler.
3. **Land the behavioural test** (section 4). Its route list is typed by
   `CliRoutes`, so every later step that adds a route must add it there too,
   or fail typecheck.
4. **`reply`:** move `ReplyRequest`, declare
   `ReplyAnswer = TurnFacts & ({ replied: number } | { rerun: true })`, and
   migrate `reply.ts:61-65` and `handlers-feedback.ts:171, 185`.
5. **`end`:** migrate `end.ts:40-44` and `handlers-session.ts:185, 199`.
6. **`sessions`:** move `CreatedSession` from `commands/round.ts` into the
   contract, with a re-export from `round.ts` for its other importers, and
   reference `CreateSessionRequest` from the contract. Give `answerFor()`
   (`handlers-session.ts:145`) its return type. Migrate `round.ts:118-138` and
   the four `sendJson(response, 200, …)` calls at `handlers-session.ts:60, 64,
88, 119`.
7. **`delivered` and `poll`:** migrate `long-poll.ts:63-67` to `callApi`, and
   type `pollOnce`'s result as `CliRoutes["GET /api/poll"]["answer"]`. It keeps
   its own `node:http` connection for the reason documented at
   `long-poll.ts:30`. Declare `Superseded` in the contract, type
   `handlers-stream.ts:104`'s `SUPERSEDED` with it, and drop the
   `superseded?`/`message?` fields from `PollPayload` (`feedback.ts:61-62`), so
   the poll answer is a discriminated union. `batchOutput()`
   (`listen.ts:45`) narrows on `"superseded" in result`, and
   `supersededOutput()` takes a `Superseded`. No byte on the wire changes.
   Migrate `handlers-stream.ts:89, 118, 138, 145, 169`.
8. **`presence`, `shutdown` and `/health`, server side:** migrate
   `handlers-stream.ts:43`, `server.ts:193` and `server.ts:151` to
   `sendAnswer`. On the client, `presence.ts:17` reads the answer as
   `Partial<CliRoutes["GET /api/session/:key/presence"]["answer"]>` and keeps
   its raw `fetch`, timeout and catch-to-`false`. `requestShutdown` and the
   `/health` probe stay as they are (section 3).
9. **Close the old doors.** Stop exporting `apiRequest` and `jsonPost` from
   `api-client.ts`, and move `test/commands/api-client.test.ts` and
   `long-poll.test.ts` onto `callApi`. Narrow `sendJson`'s `status` to the
   refusal statuses (section 4), and send the browser routes' seven 200s
   (`handlers-feedback.ts:48, 85`, `handlers-review.ts:36, 67, 96, 120, 131`)
   through `sendPageJson`. Drop the transitional re-exports added in steps 1, 2
   and 6 (including `server.ts:41-42`) once nothing imports through them.

## 4. Fitness function

The compiler is the fitness function, and no test reads source text. Three
type decisions turn each kind of drift into a `pnpm typecheck` failure. One
behavioural test then checks the wiring the compiler cannot see. Nothing here
needs a new dependency or touches the protected `.dependency-cruiser.mjs` or
`eslint.config.js`.

- **The contract and the route table cannot disagree.** `src/server.ts`
  registers every contract route from one record typed by the contract, and
  spreads it into the table next to the browser routes:

  ```ts
  const cliHandlers: { [R in CliRoute]: ContextHandler } = {
    "POST /api/session/:key/work": handleWork,
    // …one entry per CliRoutes key
  };
  return [...cliRouteEntries(cliHandlers, bind) /* , browser routes as today */];
  ```

  `cliRouteEntries` splits each key into `method` and `pattern`. A contract
  entry with no handler fails typecheck, and so does a handler under a key the
  contract lacks. The route literal is written once on the server, not next to
  a copy.

- **Every success answer is typed.** `sendAnswer` types each body by its
  route. Step 9 narrows `sendJson`'s `status` from `number` to the statuses it
  sends for refusals and failures (`400 | 403 | 404 | 409 | 422 | 500 | 503`),
  so an untyped 200 no longer compiles. The browser routes' 200s go through
  `sendPageJson(response, body: unknown)`. That is a named door, and the
  `PageRoutes` follow-on (section 6) closes it.

- **Commands reach the server through `callApi`.** Step 9 stops exporting
  `apiRequest` and `jsonPost`, so `callApi` is the only path with the
  client's error mapping. Raw `fetch` stays callable for the three argued
  exceptions in section 3 (`/health`, presence, shutdown). Forbidding a fourth
  would need `no-restricted-globals` in the protected `eslint.config.js`. That
  is a human decision, so this proposal records it and does not take it.

The behavioural test, `test/api-contract.test.ts`, starts the real server and
checks that every contract route reaches a handler. That proves
`cliRouteEntries` splits keys the way the router matches them. Its route list
is typed by the contract, so a new route cannot be left out:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRoute } from "../src/api-contract.ts";
import { createReviewServer } from "../src/server.ts";
import { SessionStore } from "../src/session-store.ts";

/** Every contract route, in request order: shutdown last, because it stops the server. */
const EVERY_ROUTE: { [R in CliRoute]: true } = {
  "GET /health": true,
  "POST /api/sessions": true,
  "POST /api/session/:key/work": true,
  "POST /api/session/:key/reply": true,
  "POST /api/session/:key/end": true,
  "POST /api/session/:key/delivered": true,
  "GET /api/session/:key/presence": true,
  "GET /api/poll": true,
  "POST /api/shutdown": true,
};

test("every contract route reaches a handler on the real server", async () => {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-contract-")));
  const server = createReviewServer({ store, port: 0 });
  const { port } = await server.start();
  try {
    const unrouted: string[] = [];
    for (const route of Object.keys(EVERY_ROUTE)) {
      const [method, pattern] = route.split(" ") as [string, string];
      const url = `http://127.0.0.1:${port}${pattern.replace(":key", "no-such-session")}`;
      const body = (await (await fetch(url, { method })).json()) as { error?: { code?: string } };
      // A handler may refuse (no session, no body); only the router says not_found.
      if (body.error?.code === "not_found") unrouted.push(route);
    }
    assert.deepEqual(unrouted, []);
  } finally {
    await server.stop();
  }
});
```

The compiler checks fail `pnpm typecheck`, and the test fails `pnpm test`.
Both are already gates.

## 5. Alternatives rejected

- **Leave it, because the command tests run against the real server.** They do:
  `test/commands/work.test.ts:45` and `reply.test.ts:77` start
  `createReviewServer`. That catches drift only for fields a test asserts on,
  and only after the fact. The repo has already decided twice (#50, #58) that
  "fails typecheck" beats "a test might notice" for exactly this kind of
  agent-facing field. This proposal applies the same decision to the rest of
  the protocol.
- **Runtime schema validation (zod or similar) on both sides.** Rejected for
  now. It adds a dependency and a second description of every type, while the
  server already validates every request by hand in `validate.ts`. Both ends
  ship in one package, pinned to one version by the `/health` handshake, so
  compile-time sharing gives the guarantee at no runtime cost.
- **Generate a client from an OpenAPI document.** Framework-grade machinery for
  nine routes. It also fails the grep test: generated names land in generated
  files, not at the code that runs.
- **Export the request types through `src/server.ts`, as `DomainErrorBody` is
  today.** This is the smallest diff, but it makes the HTTP server's entry
  module the CLI's type library. `round.ts` already imports `LedgerReport` from
  `../server.ts` for this reason. That direction invites a value import from
  CLI to server later, and it leaves the client-declared `CreatedSession` where
  the server cannot see it. A neutral file both sides import is the boundary
  `commands-only-from-cli` already asks for ("lives below commands/, as
  open-call.ts and turn-help.ts do").
- **A test that scans `src/` for `sendAnswer(`, `callApi(` or the route
  literals.** It was the first draft of section 4. Matching text proves
  nothing: a commented-out call passes, and a helper that forwards the route
  as a variable fails. The compiler already knows which call sites are typed,
  so the checks belong there.
- **Moving presence and shutdown onto `callApi` too.** That would change
  behaviour (section 3), or it would need `callApi` to grow a timeout, a retry
  switch and a non-throwing mode for two callers. Typing their answers is
  enough.
- **Free-standing `as WorkAnswer` / `satisfies WorkRequest` without a route
  map.** Better than today, but nothing stops reply's answer from being cast as
  `WorkAnswer`. Keying by the route literal ties the request, the answer and
  the URL together. It is a plain interface with literal keys: the "use a
  dict" shape, not a plugin system.
- **Change it in one commit.** About 30 call sites on both sides of the
  repo's second-busiest boundary. That is past the daily diff limit and past
  cheap review. A half-migrated state is safe to leave overnight: nothing on
  the wire changes, every migrated route is already compiler-checked, and the
  old untyped path keeps compiling until step 9 removes it.

## 6. Non-goals

- **No wire change.** No field is renamed, added, made required on the wire, or
  removed. The `Partial<TurnFacts>` tolerance in `turnBlock()` stays. Tightening
  it is a behaviour decision for a separate change.
- **Not the browser client.** `src/browser/dom/session-api.ts` reads
  `handlers-review.ts`/`handlers-feedback.ts` with six `as` casts. It is the
  same pattern, but those answer types (`SessionData`, `ApprovedFormData`,
  `ReplayData`) are already shared declarations. Until a follow-on run
  extends `CliRoutes` into a `PageRoutes`, their handlers answer through
  `sendPageJson`.
- **Not the test helper.** `test/helpers/review-server.ts` posts raw payloads.
  Tests may import anything, and typing fixtures is daily-agent sized.
- Secondary finding, for a future run: `src/` holds 36 loose files (5,620 LOC)
  in name families (`session-*`, `skill-*`, `turn-*`, `git-*`). This is stable
  and greppable today, so it is not pressing.
- The 2026-08-28 stylesheet proposal's Status line is left untouched. Moving it
  to "implemented" is the daily agent's call, not a supersession.
