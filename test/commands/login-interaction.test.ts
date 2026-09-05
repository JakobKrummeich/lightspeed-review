import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { loginInteraction, type InteractionIo } from "../../src/commands/login-interaction.ts";

/** Terminal stand-in: canned answers in, every question and line recorded. */
function scriptedIo(answers: string[]): {
  io: InteractionIo;
  asked: string[];
  signals: (AbortSignal | undefined)[];
  said: string[];
} {
  const asked: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const said: string[] = [];
  const io: InteractionIo = {
    ask: async (question, signal) => {
      asked.push(question);
      signals.push(signal);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("the test script ran out of answers");
      return answer;
    },
    say: (line) => void said.push(line),
  };
  return { io, asked, signals, said };
}

function interaction(io: InteractionIo): AuthInteraction {
  return loginInteraction(io, new AbortController().signal);
}

const selectPrompt: AuthPrompt = {
  type: "select",
  message: "How do you want to sign in?",
  options: [
    { id: "browser", label: "Browser" },
    { id: "device", label: "Device code", description: "for headless machines" },
  ],
};

test("a select answers with the id of the numbered choice", async () => {
  const { io, said } = scriptedIo(["2"]);

  assert.equal(await interaction(io).prompt(selectPrompt), "device");
  assert.ok(said.some((line) => line.includes("How do you want to sign in?")));
  assert.ok(said.some((line) => line.includes("1") && line.includes("Browser")));
  assert.ok(
    said.some((line) => line.includes("2") && line.includes("Device code")),
    `no line offered option 2: ${said.join(" | ")}`,
  );
});

test("a select re-asks until the answer is one of the offered numbers", async () => {
  const { io, asked } = scriptedIo(["7", "browser", "1"]);

  assert.equal(await interaction(io).prompt(selectPrompt), "browser");
  assert.equal(asked.length, 3, "an out-of-range and a non-number answer are both re-asked");
});

test("a text prompt returns the raw answer, and an empty answer is allowed", async () => {
  const { io, asked } = scriptedIo([""]);
  const prompt: AuthPrompt = {
    type: "text",
    message: "GitHub Enterprise URL (leave empty for github.com)",
    placeholder: "https://github.example.com",
  };

  assert.equal(await interaction(io).prompt(prompt), "");
  assert.ok(asked[0]?.includes("GitHub Enterprise URL"), asked[0]);
  assert.ok(asked[0]?.includes("https://github.example.com"), "the placeholder is shown");
});

test("manual_code and secret prompts read one line the same way", async () => {
  const manual = scriptedIo(["auth-code-123"]);
  const secret = scriptedIo(["hunter2"]);

  assert.equal(
    await interaction(manual.io).prompt({ type: "manual_code", message: "Paste the code" }),
    "auth-code-123",
  );
  assert.equal(
    await interaction(secret.io).prompt({ type: "secret", message: "API key" }),
    "hunter2",
  );
});

test("a prompt's own signal is handed to the reader, so a raced prompt can be cancelled", async () => {
  const { io, signals } = scriptedIo(["code"]);
  const controller = new AbortController();

  await interaction(io).prompt({
    type: "manual_code",
    message: "Paste the code",
    signal: controller.signal,
  });

  assert.equal(signals[0], controller.signal);
});

test("an auth_url event prints the url and its instructions", () => {
  const { io, said } = scriptedIo([]);

  interaction(io).notify({
    type: "auth_url",
    url: "https://example.com/authorize?x=1",
    instructions: "A browser window should open.",
  });

  assert.ok(said.some((line) => line.includes("https://example.com/authorize?x=1")));
  assert.ok(said.some((line) => line.includes("A browser window should open.")));
});

test("a device_code event prints the verification uri, the code and the expiry", () => {
  const { io, said } = scriptedIo([]);

  interaction(io).notify({
    type: "device_code",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresInSeconds: 900,
  });

  assert.ok(said.some((line) => line.includes("https://github.com/login/device")));
  assert.ok(said.some((line) => line.includes("ABCD-1234")));
  assert.ok(
    said.some((line) => line.includes("15 minute")),
    `no line mentioned the expiry: ${said.join(" | ")}`,
  );
});

test("info and progress events print their message as plain lines", () => {
  const { io, said } = scriptedIo([]);
  const it = interaction(io);

  it.notify({ type: "info", message: "Fetching the Copilot model list" });
  it.notify({ type: "progress", message: "Waiting for the browser" });

  assert.ok(said.includes("Fetching the Copilot model list"));
  assert.ok(said.includes("Waiting for the browser"));
});
