# Security

## What runs where

`lightspeed serve` is a plain HTTP server bound to `127.0.0.1`; there is no
option to bind anywhere else. It reads the repository through `git` —
`execFileSync` with an argument list, never a shell — and only the files a
session's grouping names: `?path=` is looked up in the session, not on disk
(`src/server/session-files.ts`).

Two checks keep loopback-only meaning loopback-only, in `src/server/security.ts`:

- **Host** must name the loopback server. A page on another origin cannot reach
  the API through DNS rebinding.
- **Origin**, when a browser sends one, must be this server's own origin. Without
  it, any site the reviewer visits could POST feedback into the agent's prompt
  stream or shut the server down. A request with no Origin is a CLI client,
  which a browser cannot fake.

## What is trusted

Every process on the same machine. Session keys are a hash of repository path,
branch and base — an identifier, not a secret — and there is no authentication
between the CLI, the browser page and the server. If you share the machine with
people you would not let read the diff, do not run a review on it.

## What leaves the machine

The diff of the branch under review, and the intent you give `start`, are sent to
the model named in `.lightspeed.conf.json` for grouping. Nothing else is sent
anywhere; there is no telemetry. Provider credentials come from the environment
(`${VAR}` in the config) or from `lightspeed login`, which stores them in
`auth.json` under the state directory (`~/.lightspeed` unless `stateDir` says
otherwise) with mode `0600`.

## Reporting

Open a private security advisory on GitHub
(<https://github.com/JakobKrummeich/lightspeed-review/security/advisories/new>) rather
than a public issue. Expect an acknowledgement within a week.
