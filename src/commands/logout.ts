import { lightspeedAuthPath, lightspeedAuthStore } from "../llm/pi-auth.ts";
import type { StructuredOutput } from "../output.ts";

export interface LogoutInput {
  provider: string;
  stateDir: string;
}

/** Removes lightspeed's own stored credential and nothing else. Any provider id is
 * accepted (a missing entry answers `removed: false` rather than arguing about
 * names); pi's file is never touched — the store this builds cannot even name it. */
export async function runLogout(input: LogoutInput): Promise<StructuredOutput> {
  const store = lightspeedAuthStore(input.stateDir);
  const removed = (await store.read(input.provider)) !== undefined;
  if (removed) await store.delete(input.provider);
  return {
    logout: { provider: input.provider, removed, path: lightspeedAuthPath(input.stateDir) },
    help: [
      `Run \`lightspeed login ${input.provider}\` to sign in again`,
      "Credentials the pi agent holds are untouched; `pi auth logout` manages those",
    ],
  };
}
