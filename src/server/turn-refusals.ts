/**
 * Every wrong-state call is refused with the one call that is right from where
 * the session stands (D5). Structured rather than prose because the agent reads
 * failures the way it reads results, and each fixing command names this session.
 */
import type { SessionRecord } from "../session-types.ts";
import { turnLabel } from "../turn.ts";
import { openIds } from "../threads.ts";
import { helpReattach, publishCall, replyCall, shownIds, workCall } from "../turn-help.ts";
import type { DomainErrorBody } from "./http.ts";

function targetOf(session: SessionRecord): string {
  return `${session.branch} ${session.base}`;
}

/** The ids a fixing command may name: the session's open ones, or the main chat. */
function idsOf(session: SessionRecord): string[] {
  return shownIds(openIds(session.conversation, session.batch?.prompts));
}

/** The reviewer holds the turn: the only move is to listen for their Send. */
export function reviewerHolds(session: SessionRecord, verb: string): DomainErrorBody {
  return {
    error: {
      code: "turn_not_yours",
      message: `${verb} is not yours to run: the reviewer holds the turn (turn: ${turnLabel(session)})`,
      detail:
        "the turn moves to you when the reviewer's Send is delivered to a waiting" +
        " `lightspeed open`, `reply` or `publish`, and never before",
    },
    help: [helpReattach(targetOf(session))],
  };
}

/** Working: talking now would strand half-written edits, so publish them. */
export function stillWorking(session: SessionRecord, why: string): DomainErrorBody {
  return {
    error: {
      code: "turn_still_yours",
      message: `you are working (turn: ${turnLabel(session)}) — publish what you have`,
      detail: why,
    },
    help: [
      `Commit, then run \`${publishCall(targetOf(session), idsOf(session)[0])}\` — the reviewer can answer in the new round`,
    ],
  };
}

/** Digesting: publish comes after work, and work after the discussion. */
export function stillDigesting(session: SessionRecord): DomainErrorBody {
  const target = targetOf(session);
  return {
    error: {
      code: "turn_still_yours",
      message: `publish ends a working turn; you are digesting (turn: ${turnLabel(session)})`,
      detail: "end this turn with reply (talk) or work (change code); publish follows work",
    },
    help: [
      `Something to change: \`${workCall(target)}\` first, then commit and publish`,
      `Something to say: \`${replyCall(target, idsOf(session))}\``,
    ],
  };
}

export function nothingToPublish(session: SessionRecord): DomainErrorBody {
  return {
    error: {
      code: "nothing_to_publish",
      message: "HEAD has not moved since the last round, so there is no round to open",
      detail: "publish opens a round on new commits; with nothing committed there is only talk",
    },
    help: [
      `Commit your changes and publish again, or say why not: \`${replyCall(targetOf(session), idsOf(session))}\``,
    ],
  };
}

export function unknownThreads(
  session: SessionRecord,
  unknown: string[],
  known: Iterable<string>,
): DomainErrorBody {
  return {
    error: {
      code: "feedback_item_unknown",
      message: `no such item: ${unknown.join(", ")} — nothing was posted`,
      detail: `items in this review: ${[...known].join(", ")}`,
    },
    help: [`Re-run with ids from the list: \`${replyCall(targetOf(session), idsOf(session))}\``],
  };
}
