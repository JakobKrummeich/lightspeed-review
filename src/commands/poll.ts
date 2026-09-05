import type { CommentDeclaration } from "../declarations.ts";
import { validationError } from "../errors.ts";
import { END_VERDICTS, type EndApproval, type PollPayload } from "../feedback.ts";
import { truncateContent, type StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import type { FeedbackPrompt, ReviewCloser } from "../session-store.ts";
import { apiRequest, jsonPost } from "./api-client.ts";
import { hasFlag, scanArgs, type FlagHit } from "./args.ts";
import { longPoll } from "./long-poll.ts";
import { serverOrigin } from "./server-address.ts";
import { BLOCKS_IN_FOREGROUND, helpReopen } from "./home.ts";

export interface PollArgs {
  /** Unset when the reviewer left it to `resolveSession` to work out. */
  branch: string | undefined;
  base: string | undefined;
  /** `--agent-reply "<summary>"`: answer the reviewer, then keep waiting. */
  agentReply: string | undefined;
  /** `--full`: print selections at their real length instead of truncating. */
  full: boolean;
  /** `--for <id> [--note "<answer>"] [--files <a,b>]`, repeatable: what each comment
   * led to, by the id `poll` printed. Sent with the reply; rejected whole on any problem. */
  declarations: CommentDeclaration[];
}

export interface PollInput {
  repoRoot: string;
  branch: string;
  base: string;
  port: number;
  agentReply?: string;
  full?: boolean;
  declarations?: CommentDeclaration[];
}

const DECLARE_FLAGS = ["--for", "--note", "--files"];

const POLL_FLAGS = ["--agent-reply", "--full", ...DECLARE_FLAGS];

const HELP_DECLARE =
  'Declare per comment when you reply: `--for <id> --note "<answer>" --files <a,b>`' +
  " — the reviewer sees each comment answered by name";

export function parsePollArgs(args: string[]): PollArgs {
  const scanned = scanArgs(args, {
    value: ["--agent-reply", ...DECLARE_FLAGS],
    boolean: ["--full"],
    // Fail loud: a mistyped flag read as a branch name would silently poll the
    // wrong session, or none.
    onUnknown: unknownPollFlag,
  });
  const { agentReply, declarations } = readReplyFlags(scanned.flags);
  checkDeclarations(declarations, agentReply);
  return {
    branch: scanned.positional[0],
    base: scanned.positional[1],
    agentReply,
    full: hasFlag(scanned, "--full"),
    declarations,
  };
}

function unknownPollFlag(flag: string): Error {
  return validationError(`unknown flag ${flag}`, [
    `Known here: ${POLL_FLAGS.join(", ")}`,
    "Run `lightspeed poll --help` for what each flag does",
  ]);
}

/** The reply and its declarations, read in command-line order: `--note` and
 * `--files` attach to the `--for` before them — order is the grammar here. */
function readReplyFlags(flags: FlagHit[]): {
  agentReply: string | undefined;
  declarations: CommentDeclaration[];
} {
  let agentReply: string | undefined;
  const declarations: CommentDeclaration[] = [];
  for (const { flag, value } of flags) {
    if (flag === "--agent-reply") agentReply = flagValue(flag, value);
    else if (flag === "--for") declarations.push({ id: flagValue(flag, value), files: [] });
    else if (flag === "--note") setNote(openDeclaration(declarations, flag), value);
    else if (flag === "--files") setFiles(openDeclaration(declarations, flag), value);
  }
  return { agentReply, declarations };
}

function setNote(declaration: CommentDeclaration, value: string | undefined): void {
  if (declaration.note !== undefined) throw declaredTwice("note", declaration.id);
  declaration.note = flagValue("--note", value);
}

function setFiles(declaration: CommentDeclaration, value: string | undefined): void {
  if (declaration.files.length > 0) throw declaredTwice("files", declaration.id);
  declaration.files = splitFiles(value);
}

/** `--note`/`--files` twice for one `--for` is two answers to one comment —
 * rejected loudly rather than the second silently burying the first. */
function declaredTwice(flag: "note" | "files", id: string): Error {
  return validationError(`--${flag} was given twice for --for ${id}`, [
    `Each --for takes one --${flag}; merge the two`,
  ]);
}

/** Any present token is the value (a note may begin with `-`, "-1 on that"),
 * so only a flag at the end of the line has none. */
function flagValue(flag: string, value: string | undefined): string {
  if (value === undefined) {
    throw validationError(`${flag} needs a value`, [HELP_DECLARE]);
  }
  return value;
}

/** `--note` and `--files` describe the `--for` before them, so one must exist. */
function openDeclaration(declarations: CommentDeclaration[], flag: string): CommentDeclaration {
  const current = declarations.at(-1);
  if (current === undefined) {
    throw validationError(`${flag} comes after the --for it belongs to`, [HELP_DECLARE]);
  }
  return current;
}

function splitFiles(value: string | undefined): string[] {
  const files = (value ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path !== "");
  if (files.length === 0) {
    throw validationError("--files needs a comma-separated list of paths", [HELP_DECLARE]);
  }
  return files;
}

/** What can be decided without the session: a declaration must ride a reply, say
 * something, and name each comment once. Checked here so a bad command line is exit 2
 * before anything is sent; the server re-checks and judges ids and the between-round diff. */
function checkDeclarations(
  declarations: CommentDeclaration[],
  agentReply: string | undefined,
): void {
  if (declarations.length === 0) return;
  if (agentReply === undefined) {
    throw validationError("--for needs --agent-reply: declarations travel with the reply", [
      HELP_DECLARE,
    ]);
  }
  const seen = new Set<string>();
  for (const declaration of declarations) {
    if (seen.has(declaration.id)) {
      throw validationError(`--for ${declaration.id} was given twice`, [
        "Each comment takes one declaration; merge the two",
      ]);
    }
    seen.add(declaration.id);
    if (declaration.note === undefined && declaration.files.length === 0) {
      throw validationError(`--for ${declaration.id} declares nothing`, [
        "Give the comment a --note, --files, or both",
      ]);
    }
  }
}

/** Blocks until the reviewer sends feedback. Deliberately no timeout; broken
 * connections don't end it either — `longPoll` re-makes them while the server is
 * there. Agents are told everywhere to run this in the foreground and wait. */
export async function runPoll(input: PollInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const origin = serverOrigin(input.port);
  if (input.agentReply !== undefined) {
    const declarations = input.declarations ?? [];
    await apiRequest(
      `${origin}/api/session/${key}/reply`,
      jsonPost({
        comment: input.agentReply,
        ...(declarations.length === 0 ? {} : { declarations }),
      }),
      key,
    );
  }
  const result = (await longPoll({
    url: `${origin}/api/poll?key=${key}`,
    key,
    port: input.port,
  })) as PollPayload;
  return pollOutput(result, input);
}

/** Selections can be page-long; `--full` is the way to see one in full. */
function shorten(prompt: FeedbackPrompt): FeedbackPrompt {
  if (prompt.type !== "annotation") return prompt;
  return { ...prompt, selected_text: truncateContent(prompt.selected_text) };
}

function pollOutput(result: PollPayload, input: PollInput): StructuredOutput {
  const target = `${input.branch} ${input.base}`.trimEnd();
  return {
    status: result.status,
    ended: result.ended,
    ...promptBlock(result, input.full ?? false),
    ...endedFacts(result),
    help: result.ended
      ? [endedHelp(result), ...helpApprovals(result, target), helpReopen(target)]
      : [
          `Address the feedback, commit, then run \`lightspeed start ${target}\` to show the updated diff`,
          `Run \`lightspeed poll ${target} --agent-reply "<summary>"\` in the foreground to reply and keep reviewing — ${BLOCKS_IN_FOREGROUND}`,
          ...(hasDeclarableIds(result.prompts) ? [HELP_DECLARE] : []),
        ],
  };
}

/**
 * The prompts, or the definitive statement that there were none. An open poll
 * only returns once something is queued (`drainPending`), so an empty list is
 * the review that ended with nothing waiting — and `prompts: []` would leave an
 * agent unable to tell that from a field that came back empty by accident.
 */
function promptBlock(result: PollPayload, full: boolean): StructuredOutput {
  if (result.prompts.length === 0) {
    return { prompts: 0, message: "no feedback was queued when this review ended" };
  }
  return { prompts: full ? result.prompts : result.prompts.map(shorten) };
}

/** Counts, not paths: no agent should parse the help sentence for a fact the
 * payload can state, and none should be handed a file list it did not ask for.
 * `endedBy` is here for the first reason too. */
function endedFacts(result: PollPayload): Partial<Pick<PollPayload, "approval" | "endedBy">> {
  if (!result.ended) return {};
  const approval = counted(result.approval);
  return {
    ...(approval === undefined ? {} : { approval }),
    ...(result.endedBy !== undefined ? { endedBy: result.endedBy } : {}),
  };
}

const KNOWN_VERDICTS: ReadonlySet<string> = new Set(END_VERDICTS);

/** A server older than the counts sends paths where the numbers now are, and one
 * older than the verdict sends numbers without the word an agent branches on.
 * Either read as a whole account would report a sign-off off an array's
 * truthiness or off a missing field, so a partial account is dropped and the help
 * line says it was not reported — which is what it is, and not "nothing was
 * approved". Present means all five fields, so nothing downstream reads half. */
function counted(approval: EndApproval | undefined): EndApproval | undefined {
  if (approval === undefined) return undefined;
  const numbers: unknown[] = [
    approval.approved,
    approval.unapproved,
    approval.swept,
    approval.total,
  ];
  if (!numbers.every((value) => typeof value === "number")) return undefined;
  return KNOWN_VERDICTS.has(approval.verdict) ? approval : undefined;
}

/** The one command that names files, offered only where a name could matter: a
 * review that ended holding some. Nothing runs it by default. */
function helpApprovals(result: PollPayload, target: string): string[] {
  const approval = counted(result.approval);
  if (approval === undefined || approval.total === 0) return [];
  return [
    `Run \`lightspeed approvals ${target}\` to name the files behind those counts —` +
      " which were approved, which were swept, which nobody signed off on",
  ];
}

/** Only prompts that carry an id can be declared against, so only they earn the hint. */
function hasDeclarableIds(prompts: FeedbackPrompt[]): boolean {
  return prompts.some((prompt) => prompt.type === "annotation" && prompt.id !== undefined);
}

/** The one poll result an agent may act on with nobody left in the loop. The
 * counts state themselves and the words are spent only on the readings no number
 * carries — except the verdict, which is echoed here in the one line every reader
 * reads. An agent that skims the help and never opens the payload is the one this
 * whole sentence exists for, and "ended" alone would let it read a sign-off. */
function endedHelp(result: PollPayload): string {
  return [closerClause(result.endedBy), ...approvalClauses(counted(result.approval))].join("; ");
}

/** Who closed it. A record that does not say must not be read as either party. */
function closerClause(endedBy: ReviewCloser | undefined): string {
  if (endedBy === "reviewer") return "The reviewer ended this review";
  if (endedBy === "agent") return "`lightspeed end` closed this review, not the reviewer";
  return "This review is ended";
}

/** The two readings a number cannot carry. An older server's account is
 * unreadable rather than empty — it recorded approvals, it just did not report
 * them in a shape this reads — and a sweep lane's tick says accepted where the
 * review asked nobody to read, which is what would otherwise turn a `signed-off`
 * verdict into a claim nobody made. */
function approvalClauses(approval: EndApproval | undefined): string[] {
  if (approval === undefined) return ["what was approved was not reported"];
  const verdict = [`verdict: ${approval.verdict}`];
  if (approval.swept === 0) return verdict;
  return [...verdict, "some approvals were swept as bulk the review never asked anyone to read"];
}
