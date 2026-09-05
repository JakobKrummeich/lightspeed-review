import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

/** The terminal as the login flow sees it: `ask` reads one line, `say` prints one.
 * Both live on stderr/stdin — stdout carries TOON and nothing else, even here.
 * Injectable so tests can drive the flow with a scripted reader. */
export interface InteractionIo {
  ask(question: string, signal?: AbortSignal): Promise<string>;
  say(line: string): void;
}

/** pi-ai's `AuthInteraction` over a plain terminal: URLs and device codes printed,
 * questions asked a line at a time, `select` a numbered list. `signal` aborts the
 * whole flow (SIGINT, wired by the caller); a prompt's own `signal` goes to the
 * reader because a raced prompt — codex's paste-the-code against its callback
 * server — is cancelled the moment the other side wins. */
export function loginInteraction(io: InteractionIo, signal: AbortSignal): AuthInteraction {
  return {
    signal,
    notify(event) {
      show(io, event);
    },
    async prompt(prompt) {
      if (prompt.type === "select") return chooseByNumber(io, prompt);
      return io.ask(oneLineQuestion(prompt), prompt.signal);
    },
  };
}

function show(io: InteractionIo, event: AuthEvent): void {
  switch (event.type) {
    case "auth_url":
      io.say(`Open this URL to sign in: ${event.url}`);
      if (event.instructions !== undefined) io.say(event.instructions);
      return;
    case "device_code":
      showDeviceCode(io, event);
      return;
    case "info":
      showInfo(io, event);
      return;
    case "progress":
      io.say(event.message);
  }
}

function showInfo(io: InteractionIo, event: AuthEvent & { type: "info" }): void {
  io.say(event.message);
  for (const link of event.links ?? []) io.say(`  ${link.label ?? "link"}: ${link.url}`);
}

/** The one thing the human must carry to another screen, set apart by blank lines. */
function showDeviceCode(io: InteractionIo, event: AuthEvent & { type: "device_code" }): void {
  io.say("");
  io.say(`Visit ${event.verificationUri}`);
  io.say(`and enter the code: ${event.userCode}`);
  if (event.expiresInSeconds !== undefined) {
    io.say(`The code expires in ${Math.round(event.expiresInSeconds / 60)} minutes.`);
  }
  io.say("");
}

async function chooseByNumber(
  io: InteractionIo,
  prompt: AuthPrompt & { type: "select" },
): Promise<string> {
  io.say(prompt.message);
  prompt.options.forEach((option, index) => {
    const description = option.description === undefined ? "" : ` — ${option.description}`;
    io.say(`  ${index + 1}. ${option.label}${description}`);
  });
  for (;;) {
    const answer = (await io.ask(`Choose 1-${prompt.options.length}: `, prompt.signal)).trim();
    const option = /^\d+$/.test(answer) ? prompt.options[Number(answer) - 1] : undefined;
    if (option !== undefined) return option.id;
    io.say(`Answer with a number between 1 and ${prompt.options.length}.`);
  }
}

/** text, secret and manual_code all read one line. An empty answer passes through
 * untouched: only the provider knows what empty means (github-copilot's
 * enterprise-URL prompt reads it as "public github.com"). */
function oneLineQuestion(prompt: AuthPrompt & { type: "text" | "secret" | "manual_code" }): string {
  const placeholder = prompt.placeholder === undefined ? "" : ` [${prompt.placeholder}]`;
  return `${prompt.message}${placeholder}: `;
}
