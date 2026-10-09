# The CLI ⇄ server protocol has no contract the compiler can see

- **Date:** 2026-10-09
- **Status:** Proposed — needs a human decision, no code was changed
- **Scope:** `src/commands/api-client.ts` and its callers (`work.ts`, `reply.ts`, `end.ts`, `round.ts`, `long-poll.ts`, `presence.ts`, `server-address.ts`); `src/server/http.ts`, `src/server/validate.ts`, `src/server/handlers-{session,turn,feedback,stream}.ts`, `src/server.ts`; new `src/api-contract.ts`

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

**One route already does it right**, and it is the precedent for this proposal.
`GET /api/poll` answers with `PollPayload`, declared once in
`src/feedback.ts:38`, built by `batchPayload()` (`feedback.ts:140`) on the
server, and read as `PollPayload` in `src/commands/listen.ts`. The team has also
been fixing this disease one symbol at a time:

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
  "GET /api/poll": { request: undefined; answer: PollPayload };
  "POST /api/shutdown": { request: undefined; answer: { status: "stopping" } };
}
export type CliRoute = keyof CliRoutes;
```

Two thin helpers replace the untyped edges:

- **Client** (`src/commands/api-client.ts`):
  `callApi(origin, route, { key }, body, about): Promise<CliRoutes[R]["answer"]>`.
  It wraps today's `apiRequest`/`jsonPost` unchanged (same error mapping, same
  `parseBody`). The only new logic is substituting `:key` in the route's path.
- **Server** (`src/server/http.ts`):
  `sendAnswer(response, route, body: CliRoutes[R]["answer"])`, which is
  `sendJson(response, 200, body)` with a typed `body`.

**Grep test:** searching `"/api/session/:key/work"` lands on three places: the
contract entry, the route table in `src/server.ts`, and the one `callApi` in
`work.ts`. Today it lands only on the route table. The CLI's call is a template
string, `` `/api/session/${key}/work` ``, which does not match.

The client keeps reading answers through `turnBlock()`, which accepts
`Partial<TurnFacts>`. A full `TurnFacts` is assignable to it, so no reader
changes behaviour. `/health` stays a deliberate exception on the client side:
it is the version handshake with a server that may not speak this contract
(`src/version.ts`), so `server-address.ts:79` keeps parsing it defensively.
Only the server's answer to `/health` gets a type.

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
   Migrate `work.ts:60-64` and `handlers-turn.ts:44`.
3. **Land the fitness function** (section 4), with today's remaining raw call
   sites recorded in its `NOT_YET_ON_CONTRACT` list. From this commit on, no
   new raw call can be added, and the list can only shrink.
4. **`reply`:** move `ReplyRequest`, declare
   `ReplyAnswer = TurnFacts & ({ replied: number } | { rerun: true })`, and
   migrate `reply.ts:61-65` and `handlers-feedback.ts:171, 185`. Remove
   `reply.ts` from the list.
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
   `long-poll.ts:30`. Migrate `handlers-stream.ts:89, 118, 138, 145, 169`.
8. **`presence` and `shutdown`:** migrate `presence.ts:13-17` and
   `server-address.ts:100`, and type the `/health` answer server-side
   (`server.ts:151`). After this step, only `server-address.ts`'s `/health`
   probe remains in the list, as the permanent, commented exception.
9. **Drop the transitional re-exports** added in steps 1, 2 and 6 (including
   `server.ts:41-42`) once nothing imports through them.

## 4. Fitness function

A new `test/api-contract.test.ts`, using only `node:test` and `node:fs`, in the
same source-scanning style as `test/browser/stylesheet-boundary.test.ts`. It
needs no new dependency and does not touch the protected
`.dependency-cruiser.mjs` or `eslint.config.js`. The compiler enforces each
call site's types once it uses `callApi`/`sendAnswer`. The test enforces that
call sites _use_ them, and that the contract and the route table cannot
silently disagree.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const commandFiles = readdirSync(new URL("../src/commands/", import.meta.url), { recursive: true })
  .map(String)
  .filter((name) => name.endsWith(".ts"));
const serverFiles = [
  "server.ts",
  ...readdirSync(new URL("../src/server/", import.meta.url)).map((n) => `server/${n}`),
];

/** "POST /api/session/:key/work" → ["POST", "/api/session/:key/work"], read off the contract. */
const ROUTES = [...src("api-contract.ts").matchAll(/^\s*"(GET|POST) (\/[^"]+)": \{/gm)].map(
  ([, method, path]) => ({ key: `${method} ${path}`, method: method!, path: path! }),
);

/**
 * Command files still calling the server without the contract. This list only
 * ever shrinks; a stale entry fails too, so it cannot outlive its migration.
 * `server-address.ts` stays: `/health` is the handshake with a server that may
 * not speak this contract at all (src/version.ts).
 */
const NOT_YET_ON_CONTRACT = new Set([
  "server-address.ts",
  // step 3 records the rest here: end.ts, reply.ts, round.ts, long-poll.ts, presence.ts
]);

test("every contract route is registered by the server under the same literal", () => {
  const table = src("server.ts");
  const missing = ROUTES.filter(
    (r) => !table.includes(`method: "${r.method}", pattern: "${r.path}"`),
  );
  assert.deepEqual(
    missing.map((r) => r.key),
    [],
  );
});

test("every contract route is answered through sendAnswer", () => {
  // Silent incompleteness: a route whose handler still uses sendJson(…, 200, …)
  // type-checks, and its answer is back to `unknown` on the wire.
  const server = serverFiles.map(src).join("\n");
  const unanswered = ROUTES.filter((r) => !server.includes(`sendAnswer(response, "${r.key}"`));
  assert.deepEqual(
    unanswered.map((r) => r.key),
    [],
  );
});

test("commands reach the server only through callApi", () => {
  const raw = commandFiles.filter(
    (name) =>
      name !== "api-client.ts" && /\b(apiRequest|jsonPost|fetch)\(/.test(src(`commands/${name}`)),
  );
  assert.deepEqual(
    raw.sort(),
    [...NOT_YET_ON_CONTRACT].sort(),
    "call the server with callApi and a CliRoutes key, or argue the exception in NOT_YET_ON_CONTRACT",
  );
});
```

All three assertions fail loudly in `pnpm test`, which is already a gate.

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
  eight routes. It also fails the grep test: generated names land in generated
  files, not at the code that runs.
- **Export the request types through `src/server.ts`, as `DomainErrorBody` is
  today.** This is the smallest diff, but it makes the HTTP server's entry
  module the CLI's type library. `round.ts` already imports `LedgerReport` from
  `../server.ts` for this reason. That direction invites a value import from
  CLI to server later, and it leaves the client-declared `CreatedSession` where
  the server cannot see it. A neutral file both sides import is the boundary
  `commands-only-from-cli` already asks for ("lives below commands/, as
  open-call.ts and turn-help.ts do").
- **Free-standing `as WorkAnswer` / `satisfies WorkRequest` without a route
  map.** Better than today, but nothing stops reply's answer from being cast as
  `WorkAnswer`. Keying by the route literal ties the request, the answer and
  the URL together. It is a plain interface with literal keys: the "use a
  dict" shape, not a plugin system.
- **Change it in one commit.** About 30 call sites on both sides of the
  repo's second-busiest boundary. That is past the daily diff limit and past
  cheap review. The ratchet list makes a half-migrated state safe to leave
  overnight.

## 6. Non-goals

- **No wire change.** No field is renamed, added, made required on the wire, or
  removed. The `Partial<TurnFacts>` tolerance in `turnBlock()` stays. Tightening
  it is a behaviour decision for a separate change.
- **Not the browser client.** `src/browser/dom/session-api.ts` reads
  `handlers-review.ts`/`handlers-feedback.ts` with six `as` casts. It is the
  same pattern, but those answer types (`SessionData`, `ApprovedFormData`,
  `ReplayData`) are already shared declarations. A follow-on run can extend
  `CliRoutes` into a `PageRoutes` once this one has proven itself.
- **Not the test helper.** `test/helpers/review-server.ts` posts raw payloads.
  Tests may import anything, and typing fixtures is daily-agent sized.
- Secondary finding, for a future run: `src/` holds 36 loose files (5,620 LOC)
  in name families (`session-*`, `skill-*`, `turn-*`, `git-*`). This is stable
  and greppable today, so it is not pressing.
- The 2026-08-28 stylesheet proposal's Status line is left untouched. Moving it
  to "implemented" is the daily agent's call, not a supersession.
