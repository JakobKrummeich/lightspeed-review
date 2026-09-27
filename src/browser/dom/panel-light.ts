/**
 * The panel's two light moments behind one handle, so the panel mount says
 * when and this module says what: Warp Send on a send that went out, the
 * return beam on a draw that brought the agent's words.
 */
import { agentMessages, messageNews } from "../message-news.ts";
import { keepFireflyTime } from "./firefly-clock.ts";
import { returnBeam } from "./return-beam.ts";
import { warpSend } from "./warp-send.ts";
import type { ConversationEntry } from "../../session-store.ts";

export interface PanelLight {
  /** Before the draw that takes the sent drafts away. */
  sent(ended: boolean): void;
  /** After every draw of the conversation, the first one at mount included. */
  drawn(conversation: ConversationEntry[]): void;
}

/** `conversation` is what the page opened on: seen, so never news. */
export function mountPanelLight(root: HTMLElement, conversation: ConversationEntry[]): PanelLight {
  let seen = agentMessages(conversation);
  return {
    sent: (ended) => warpSend(root, ended),
    drawn: (fresh) => {
      keepFireflyTime(root);
      const news = messageNews(seen, fresh);
      seen = news.seen;
      if (news.cards.length > 0) returnBeam(root, news.cards);
    },
  };
}
