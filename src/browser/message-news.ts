/**
 * Which of the agent's messages are new since the panel last drew — what the
 * return beam lights. The panel redraws the whole column on every refresh, so
 * nothing on screen remembers what was there before; this does, as the set
 * of agent messages already drawn. The reviewer's own words are never news:
 * they were on screen before they were sent.
 */
import { groupCards } from "./thread-groups.ts";
import type { ConversationEntry } from "../session-store.ts";

export interface MessageNews {
  /** Every agent message now drawn: the next draw is judged against this. */
  seen: Set<string>;
  /** Keys of the cards holding a new one, top to bottom. */
  cards: string[];
}

/**
 * What the page opened on counts as seen: a reload is not the agent speaking,
 * and the first draw must not light every card it has.
 */
export function agentMessages(conversation: ConversationEntry[]): Set<string> {
  return new Set(agentSaid(conversation).map(({ said }) => said));
}

export function messageNews(
  seen: ReadonlySet<string>,
  conversation: ConversationEntry[],
): MessageNews {
  const said = agentSaid(conversation);
  const cards = said.filter((one) => !seen.has(one.said)).map(({ card }) => card);
  return { seen: new Set(said.map((one) => one.said)), cards: [...new Set(cards)] };
}

/** A message is its card and its time: the agent says one thing per card per reply. */
function agentSaid(conversation: ConversationEntry[]): { card: string; said: string }[] {
  return groupCards(conversation).flatMap((group) =>
    group.cards.flatMap((card) =>
      card.messages
        .filter((message) => message.role === "agent")
        .map((message) => ({ card: card.key, said: `${card.key} ${message.at}` })),
    ),
  );
}
