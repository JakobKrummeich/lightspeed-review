/**
 * The panel's two light moments behind one handle, so the panel mount says
 * when and this module says what: Warp Send on a send that went out, the
 * return beam on a draw that brought the agent's words. Every draw is also
 * filed as seen, for the round replay not to repeat it.
 */
import { currentRound } from "../conversation-rounds.ts";
import { agentMessages, messageNews } from "../message-news.ts";
import type { SeenReplies } from "../seen-replies.ts";
import { keepFireflyTime } from "./firefly-clock.ts";
import { returnBeam } from "./return-beam.ts";
import { warpSend } from "./warp-send.ts";
import type { ConversationEntry, RoundMark } from "../../session-store.ts";

/** What a draw of the panel showed: the conversation, and the round of the session it came in. */
export interface DrawnTalk {
  conversation: ConversationEntry[];
  rounds: readonly RoundMark[];
}

export interface PanelLight {
  /** Before the draw that takes the sent drafts away. */
  sent(ended: boolean): void;
  /** After every draw of the conversation, the first one at mount included. */
  drawn(talk: DrawnTalk): void;
}

/**
 * `conversation` is what the page opened on: seen, so never news to the beam.
 * `seen` keeps its own account of what was drawn: the beam's resets with the
 * page, the replay's outlives it.
 */
export function mountPanelLight(
  root: HTMLElement,
  conversation: ConversationEntry[],
  seen: SeenReplies,
): PanelLight {
  let beamed = agentMessages(conversation);
  return {
    sent: (ended) => warpSend(root, ended),
    drawn: (talk) => {
      keepFireflyTime(root);
      const news = messageNews(beamed, talk.conversation);
      beamed = news.seen;
      seen.drawn(news.seen, currentRound(talk.rounds));
      if (news.cards.length > 0) returnBeam(root, news.cards);
    },
  };
}
