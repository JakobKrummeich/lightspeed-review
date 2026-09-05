import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { authStateDir, runLogin, type LoginDeps } from "../../src/commands/login.ts";
import { ReviewError } from "../../src/errors.ts";
import { lightspeedAuthPath } from "../../src/llm/pi-auth.ts";
import { expandHome } from "../../src/paths.ts";

const oauthCredential: Credential = {
  type: "oauth",
  refresh: "refresh-secret",
  access: "access-secret",
  expires: 9,
};

interface Seen {
  store?: CredentialStore;
  login?: { provider: string; type: string; interaction: AuthInteraction };
}

/** A login flow in a jar: records the store and the call, answers instantly. */
function fakeDeps(result: Credential | Error = oauthCredential): { deps: LoginDeps; seen: Seen } {
  const seen: Seen = {};
  const deps: LoginDeps = {
    isTTY: true,
    io: { ask: async () => "", say: () => undefined },
    createLoginModels: async (credentials) => {
      seen.store = credentials;
      return {
        login: async (provider, type, interaction) => {
          seen.login = { provider, type, interaction };
          if (result instanceof Error) throw result;
          return result;
        },
      };
    },
  };
  return { deps, seen };
}

function tempStateDir(): string {
  return join(mkdtempSync(join(tmpdir(), "lsr-login-")), "state");
}

test("a provider outside the allowlist is login_unsupported naming the three", async () => {
  const { deps, seen } = fakeDeps();

  await assert.rejects(
    () => runLogin({ provider: "mistral", stateDir: tempStateDir(), deps }),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "login_unsupported" &&
      ["anthropic", "openai-codex", "github-copilot"].every(
        (id) => error.detail?.includes(id) === true,
      ) &&
      error.suggestions.some((line) => line.includes("providers")),
  );
  assert.equal(seen.store, undefined, "no models were built for a refused provider");
});

test("login without a terminal is refused before any models are built", async () => {
  const { deps, seen } = fakeDeps();
  deps.isTTY = false;

  await assert.rejects(
    () => runLogin({ provider: "anthropic", stateDir: tempStateDir(), deps }),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "login_needs_terminal" &&
      /human at the keyboard/.test(error.message) &&
      /agent must never run it/.test(error.message),
  );
  assert.equal(seen.store, undefined);
});

test("a completed login reports the provider, the credential type and the file", async () => {
  const { deps, seen } = fakeDeps();
  const stateDir = tempStateDir();

  const output = await runLogin({ provider: "anthropic", stateDir, deps });

  assert.deepEqual(output.login, {
    provider: "anthropic",
    type: "oauth",
    path: lightspeedAuthPath(stateDir),
  });
  assert.equal(seen.login?.provider, "anthropic");
  assert.equal(seen.login?.type, "oauth", "subscription flows are OAuth, never api_key");
  assert.equal(typeof seen.login?.interaction.prompt, "function");
  assert.equal(typeof seen.login?.interaction.notify, "function");
  const help = output.help as string[];
  assert.ok(help.some((line) => line.includes("model") && line.includes("anthropic/")));
  assert.ok(help.some((line) => line.includes("lightspeed start")));
});

test("no token material reaches the output", async () => {
  const { deps } = fakeDeps();

  const output = await runLogin({ provider: "openai-codex", stateDir: tempStateDir(), deps });

  const rendered = JSON.stringify(output);
  assert.doesNotMatch(rendered, /refresh-secret|access-secret/);
});

test("the login models are built on lightspeed's own store, nothing of pi's", async () => {
  const { deps, seen } = fakeDeps();
  const stateDir = tempStateDir();

  await runLogin({ provider: "github-copilot", stateDir, deps });

  assert.ok(seen.store, "the factory received a credential store");
  await seen.store.modify("github-copilot", async () => ({ type: "api_key", key: "k" }));
  assert.ok(
    existsSync(lightspeedAuthPath(stateDir)),
    "a write through that store lands in the state dir",
  );
});

test("a failed flow is login_failed carrying the underlying message", async () => {
  const { deps } = fakeDeps(new Error("port 1455 is busy"));

  await assert.rejects(
    () => runLogin({ provider: "openai-codex", stateDir: tempStateDir(), deps }),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "login_failed" &&
      error.detail === "port 1455 is busy",
  );
});

test("without any config file the state dir is the default one", () => {
  const cwd = mkdtempSync(join(tmpdir(), "lsr-login-cwd-"));

  assert.equal(authStateDir(cwd), expandHome("~/.lightspeed"));
});

test("a config that names a stateDir decides where credentials live", () => {
  const cwd = mkdtempSync(join(tmpdir(), "lsr-login-cwd-"));
  const stateDir = join(cwd, "custom-state");
  writeFileSync(join(cwd, ".lightspeed.conf.json"), JSON.stringify({ stateDir }));

  assert.equal(authStateDir(cwd), stateDir);
});

test("a config that is present but broken still fails loudly", () => {
  const cwd = mkdtempSync(join(tmpdir(), "lsr-login-cwd-"));
  writeFileSync(join(cwd, ".lightspeed.conf.json"), "{ not json");

  assert.throws(
    () => authStateDir(cwd),
    (error: unknown) => error instanceof ReviewError && error.code === "config_invalid",
  );
});
