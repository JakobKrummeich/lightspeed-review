import { createInterface } from "node:readline/promises";
import { createModels } from "@earendil-works/pi-ai";
import type { AuthInteraction, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { loadLedgerConfig } from "../config.ts";
import { ReviewError } from "../errors.ts";
import { LOGIN_PROVIDERS, lightspeedAuthPath, lightspeedAuthStore } from "../llm/pi-auth.ts";
import type { StructuredOutput } from "../output.ts";
import { repoRootOrNone } from "../repo.ts";
import { HELP_START } from "./home.ts";
import { loginInteraction, type InteractionIo } from "./login-interaction.ts";

/** The one method of pi-ai's `Models` a login needs; a fake fits in a test. */
export interface LoginModels {
  login(providerId: string, type: "oauth", interaction: AuthInteraction): Promise<Credential>;
}

/** Seams for tests: the terminal, the TTY check and the provider registry. */
export interface LoginDeps {
  createLoginModels?: (credentials: CredentialStore) => Promise<LoginModels>;
  isTTY?: boolean;
  io?: InteractionIo;
}

export interface LoginInput {
  provider: string;
  stateDir: string;
  deps?: LoginDeps;
}

/** Where login/logout keep credentials. Login runs before a repo has config (it
 * makes the very first credential), so this resolves like the ledger reader: the
 * config file where one exists, defaults where none does. A config present but
 * broken still fails loudly. */
export function authStateDir(cwd: string): string {
  return loadLedgerConfig(repoRootOrNone(cwd) ?? cwd).stateDir;
}

/** Human-run OAuth sign-in, the one interactive surface. Exists for subscriptions
 * (Claude Pro/Max, ChatGPT plans, Copilot) no environment variable can express.
 * The credential lands in lightspeed's own `<stateDir>/auth.json` and nowhere else;
 * grouping reads and refreshes it there on every later run. */
export async function runLogin(input: LoginInput): Promise<StructuredOutput> {
  const { provider, stateDir, deps = {} } = input;
  const supported: readonly string[] = LOGIN_PROVIDERS;
  if (!supported.includes(provider)) throw unsupported(provider);
  requireTerminal(deps);
  const models = await (deps.createLoginModels ?? oauthLoginModels)(lightspeedAuthStore(stateDir));
  const credential = await interactiveLogin(models, provider, deps);
  return {
    login: { provider, type: credential.type, path: lightspeedAuthPath(stateDir) },
    help: [`Set \`model\` in .lightspeed.conf.json to \`${provider}/<model-id>\``, HELP_START],
  };
}

/** Every builtin provider, writing to lightspeed's own store: a login must never
 * edit the pi agent's file. `providers/all` is imported here, not at module top —
 * it pulls in every provider pi-ai ships and logout needs none of them. */
async function oauthLoginModels(credentials: CredentialStore): Promise<LoginModels> {
  const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
  const models = createModels({ credentials });
  for (const provider of builtinProviders()) models.setProvider(provider);
  return models;
}

/** The flow, framed by a terminal and a SIGINT wire: Ctrl+C aborts (readline
 * swallows the signal during a question, so the interface re-raises it); listener
 * and interface are both gone before the command answers, whatever the flow did. */
async function interactiveLogin(
  models: LoginModels,
  provider: string,
  deps: LoginDeps,
): Promise<Credential> {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(new Error("interrupted"));
  let owned: TerminalIo | undefined;
  const io = deps.io ?? (owned = terminalIo(interrupt));
  process.once("SIGINT", interrupt);
  try {
    return await models.login(provider, "oauth", loginInteraction(io, controller.signal));
  } catch (error) {
    throw loginFailed(provider, error);
  } finally {
    process.removeListener("SIGINT", interrupt);
    owned?.close();
  }
}

interface TerminalIo extends InteractionIo {
  close(): void;
}

/** Questions and guidance on stderr, answers from stdin: stdout stays TOON-only. */
function terminalIo(interrupt: () => void): TerminalIo {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on("SIGINT", interrupt);
  return {
    ask: (question, signal) => rl.question(question, signal === undefined ? {} : { signal }),
    say: (line) => void process.stderr.write(`${line}\n`),
    close: () => rl.close(),
  };
}

function unsupported(provider: string): ReviewError {
  return new ReviewError({
    code: "login_unsupported",
    message: `\`${provider}\` is not a provider lightspeed can sign in to`,
    detail: `login covers the subscription OAuth flows pi-ai ships: ${LOGIN_PROVIDERS.join(", ")}`,
    suggestions: [
      "For an API key or a proxy, set `providers.<id>.apiKey` or `headers` in" +
        " .lightspeed.conf.json — that path needs no login",
      "pi-ai's own environment variable names work too, e.g. `export ANTHROPIC_API_KEY=…`",
    ],
  });
}

/** Checked before anything is built: the flow blocks on questions only a person
 * can answer, so an agent running it would hang its own review. */
function requireTerminal(deps: LoginDeps): void {
  const attached = deps.isTTY ?? (process.stdin.isTTY === true && process.stderr.isTTY === true);
  if (attached) return;
  throw new ReviewError({
    code: "login_needs_terminal",
    message: "login is for the human at the keyboard — an agent must never run it",
    detail: "the flow opens a browser and asks questions only a person can answer",
    suggestions: [
      "Run `lightspeed login <provider>` yourself, in your own terminal, once per machine",
    ],
  });
}

function loginFailed(provider: string, error: unknown): ReviewError {
  if (error instanceof ReviewError) return error;
  return new ReviewError({
    code: "login_failed",
    message: `signing in to \`${provider}\` did not complete`,
    detail: error instanceof Error ? error.message : String(error),
    suggestions: [`Re-run \`lightspeed login ${provider}\``],
  });
}
