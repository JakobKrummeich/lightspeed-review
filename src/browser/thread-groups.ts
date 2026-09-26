/**
 * Which threads the panel shows where, and folded or not — pure, so the
 * sorting is testable without markup. Grouped by whose move it is, not by
 * round: a reviewer scanning for what needs them should not have to read
 * every round's history to find it.
 */
import { MAIN_THREAD, threadsOf, type Thread } from "../threads.ts";
import type { ThreadFold } from "./review-memory.ts";
import type { ConversationEntry } from "../session-store.ts";

/**
 * Top to bottom: settled history first, what needs the reviewer last, next to
 * the compose box where their answer will be written.
 */
export type GroupName = "resolved" | "waiting" | "needs";

const GROUP_ORDER: readonly GroupName[] = ["resolved", "waiting", "needs"];

export const GROUP_TITLE: Record<GroupName, string> = {
  resolved: "Resolved",
  waiting: "Waiting on agent",
  needs: "Needs you",
};

/** A thread as the panel draws it: `main` split into one card per post. */
export interface Card extends Thread {
  /** Stable across reloads — what a remembered fold is filed under. */
  key: string;
  /** The agent has spoken in it since the reviewer's last Send. */
  fresh: boolean;
  main: boolean;
  group: GroupName;
}

export interface CardGroup {
  name: GroupName;
  cards: Card[];
}

export function groupCards(conversation: ConversationEntry[]): CardGroup[] {
  const cards = cardsOf(conversation).sort((a, b) => order(latestOf(a), latestOf(b)));
  return GROUP_ORDER.map((name) => ({
    name,
    cards: cards.filter((card) => card.group === name),
  })).filter((group) => group.cards.length > 0);
}

/**
 * Each `main` post is its own card — one ever-growing card read as one old
 * thread. Legacy words are history from before 3.0: never news, whatever
 * their stamp.
 */
function cardsOf(conversation: ConversationEntry[]): Card[] {
  const lastSend = conversation.findLast((entry) => entry.role === "reviewer")?.at ?? "";
  let legacy = 0;
  return threadsOf(conversation)
    .flatMap(splitMain)
    .map((thread) => {
      const fresh =
        thread.legacy !== true &&
        thread.messages.some((said) => said.role === "agent" && said.at > lastSend);
      const key = thread.legacy === true ? `legacy@${legacy++}` : keyOf(thread);
      return { ...thread, key, fresh, group: groupOf(thread, fresh) };
    });
}

function splitMain(thread: Thread): (Thread & { main: boolean })[] {
  if (thread.id !== MAIN_THREAD) return [{ ...thread, main: false }];
  return thread.messages.map((said) => ({
    ...thread,
    messages: [said],
    at: said.at,
    ...(said.roundIndex === undefined ? {} : { roundIndex: said.roundIndex }),
    main: true,
  }));
}

function keyOf(thread: Thread & { main: boolean }): string {
  return thread.main ? `${MAIN_THREAD}@${thread.at}` : thread.id;
}

/**
 * A `main` post has nobody to answer it in a thread, so once the reviewer has
 * sent since, it is read — history, like a resolved thread.
 */
function groupOf(thread: Thread & { main: boolean }, fresh: boolean): GroupName {
  if (thread.main) return fresh ? "needs" : "resolved";
  if (thread.legacy === true || thread.resolved) return "resolved";
  return thread.messages.at(-1)?.role === "agent" ? "needs" : "waiting";
}

function latestOf(thread: Thread): string {
  return thread.messages.reduce((latest, said) => (said.at > latest ? said.at : latest), thread.at);
}

function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Settled — resolved, or a resolve queued at the press — shuts by default.
 * The reviewer's own choice wins only while the card is as settled as when it
 * was made: a thread reopened by the agent's answer must not stay folded
 * because it was once folded as resolved.
 */
export function cardShut(
  card: Card,
  queued: boolean | undefined,
  folds: Readonly<Record<string, ThreadFold>>,
): boolean {
  const settled = cardSettled(card, queued);
  const fold = folds[card.key];
  return fold !== undefined && fold.resolved === settled ? fold.shut : settled;
}

export function cardSettled(card: Card, queued: boolean | undefined): boolean {
  return queued ?? card.group === "resolved";
}

const OPENING_WORDS = 8;

/** Enough to tell threads apart on a folded card; the whole ask is one press away. */
export function openingWords(card: Card): string {
  const words = (card.messages[0]?.comment ?? "").trim().split(/\s+/);
  const head = words.slice(0, OPENING_WORDS).join(" ");
  return words.length > OPENING_WORDS ? `${head}…` : head;
}
