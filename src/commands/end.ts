import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { apiRequest } from "./api-client.ts";
import { serverOrigin } from "./server-address.ts";
import { helpReopen } from "./home.ts";

export interface EndInput {
  repoRoot: string;
  branch: string;
  base: string;
  port: number;
}

/** Agent-initiated close: the review is over without waiting for a reviewer. */
export async function runEnd(input: EndInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  await apiRequest(`${serverOrigin(input.port)}/api/session/${key}/end`, { method: "POST" }, key);
  const target = `${input.branch} ${input.base}`;
  return {
    session: { key, branch: input.branch, base: input.base, status: "ended" },
    message: "the review session is closed; the browser shows it as ended",
    help: [helpReopen(target)],
  };
}
