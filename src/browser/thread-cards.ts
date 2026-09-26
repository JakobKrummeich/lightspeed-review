/**
 * The conversation column's markup: thread cards grouped by whose move it is,
 * the reviewer's unsent words drawn where they will land, and a delivery word
 * under every message the reviewer sent. Split from the panel, which keeps
 * the compose row and the lock matrix.
 */
import { escapeHtml } from "../escape-html.ts";
import { renderThreadFoot } from "./thread-foot.ts";
import { stalePillRound, type QueuedPill } from "./queued-pill.ts";
import { DELIVERY_LABEL, DRAFT_LABEL, deliveryOf, type DeliveryFacts } from "./delivery.ts";
import {
  cardShut,
  GROUP_TITLE,
  groupCards,
  openingWords,
  type Card,
  type CardGroup,
} from "./thread-groups.ts";
import type { ThreadFold } from "./review-memory.ts";
import type { ThreadMessage } from "../threads.ts";
import type { AnnotationPrompt, ConversationEntry, SessionStatus } from "../session-store.ts";

/** The panel's `ComposeMode`, restated so the two modules do not import each other. */
type CardMode = "send" | "locked" | "queue" | "ended";

export interface ColumnState {
  conversation: ConversationEntry[];
  pending: QueuedPill[];
  mode: CardMode;
  status: SessionStatus;
  round: number;
  delivery: DeliveryFacts;
  folds: Record<string, ThreadFold>;
  resolvedShown: boolean;
}

/** A queued pill with the tray position its × takes back. */
interface Draft {
  pill: QueuedPill;
  index: number;
}

/** What the queue holds for one card: reply drafts drawn in it, the last resolve toggle marked on it. */
interface CardDrafts {
  replies: Draft[];
  resolve?: boolean;
}

export function renderGroups(state: ColumnState): string {
  const drafts = draftsByThread(state.pending);
  return groupCards(state.conversation)
    .map((group) => renderGroup(group, state, drafts))
    .join("\n  ");
}

/**
 * Only the resolved group folds as a whole, and starts folded: history the
 * reviewer has settled should not push what needs them out of sight.
 */
function renderGroup(
  group: CardGroup,
  state: ColumnState,
  drafts: Map<string, CardDrafts>,
): string {
  const title = escapeHtml(`${GROUP_TITLE[group.name]} · ${group.cards.length}`);
  const shown = group.name !== "resolved" || state.resolvedShown;
  const head =
    group.name === "resolved"
      ? `<h3 class="lsr-group-head"><button type="button" class="lsr-group-toggle" data-group-toggle="resolved" aria-expanded="${shown}">${title}</button></h3>`
      : `<h3 class="lsr-group-head">${title}</h3>`;
  const cards = shown
    ? group.cards.map((card) => renderCard(card, state, drafts.get(card.id))).join("\n  ")
    : "";
  return `<section class="lsr-thread-group" data-group="${group.name}">
  ${head}
  ${cards}
  </section>`;
}

/**
 * The last queued toggle per thread wins; replies keep their queue order.
 * Keyed by thread id: a `main` post or legacy card has none, so nothing lands there.
 */
function draftsByThread(pending: readonly QueuedPill[]): Map<string, CardDrafts> {
  const drafts = new Map<string, CardDrafts>();
  pending.forEach((pill, index) => {
    if (pill.type !== "reply" && pill.type !== "resolve") return;
    const held = drafts.get(pill.thread) ?? { replies: [] };
    if (pill.type === "reply") held.replies.push({ pill, index });
    else held.resolve = pill.resolved;
    drafts.set(pill.thread, held);
  });
  return drafts;
}

function renderCard(card: Card, state: ColumnState, drafts: CardDrafts = NO_DRAFTS): string {
  const queued = drafts.resolve;
  const shut = cardShut(card, queued, state.folds);
  const resolved = queued ?? card.resolved;
  const body = shut ? "" : renderCardBody(card, state, drafts.replies, resolved);
  const key = escapeHtml(card.key);
  return `<article class="lsr-thread" data-key="${key}" data-group="${card.group}" data-shut="${shut}" data-resolved="${resolved}"${cardFlags(card)}>
    ${renderCardHead(card, shut, queued, drafts.replies.length)}${body}
  </article>`;
}

const NO_DRAFTS: CardDrafts = { replies: [] };

function cardFlags(card: Card): string {
  return `${card.fresh ? ` data-new="true"` : ""}${card.legacy ? ` data-legacy="true"` : ""}`;
}

/**
 * The whole head folds the card; the file press inside it jumps instead. A
 * shut card keeps just enough to be told apart: where, and the ask's first
 * words. Never the thread id — `t2` names nothing a reviewer wrote.
 */
function renderCardHead(
  card: Card,
  shut: boolean,
  queued: boolean | undefined,
  unsent: number,
): string {
  const key = escapeHtml(card.key);
  const gist = shut ? `<span class="lsr-thread-gist">${escapeHtml(openingWords(card))}</span>` : "";
  const marks = `${newMark(card)}${queuedMark(queued)}${shut ? unsentMark(unsent) : ""}`;
  const verb = shut ? "Unfold" : "Fold";
  return `<header class="lsr-thread-head" data-fold="${key}">${renderWhere(card)}${gist}${marks}<button type="button" class="lsr-thread-fold" data-fold="${key}" aria-expanded="${!shut}" aria-label="${escapeHtml(`${verb} ${cardLabel(card)}`)}" title="${verb}"></button></header>`;
}

function renderWhere(card: Card): string {
  if (card.item?.type === "annotation") return renderFilePress(card.item);
  return `<span class="lsr-thread-where">${card.main ? "From the agent" : "General"}</span>`;
}

/** How a card is named to a screen reader: where it is anchored, or what it asks. */
function cardLabel(card: Card): string {
  return card.item?.type === "annotation" ? placeOf(card.item) : openingWords(card);
}

function newMark(card: Card): string {
  return card.fresh ? `<span class="lsr-thread-new">new</span>` : "";
}

/** A resolve is queued like any pill; the card says so rather than a line in the tray. */
function queuedMark(queued: boolean | undefined): string {
  if (queued === undefined) return "";
  return `<span class="lsr-thread-queued">${queued ? "resolves" : "reopens"} on your next Send</span>`;
}

/** A folded card must not hide that words are waiting in it. */
function unsentMark(unsent: number): string {
  if (unsent === 0) return "";
  return `<span class="lsr-thread-queued">${unsent === 1 ? "1 reply" : `${unsent} replies`} not sent yet</span>`;
}

function renderCardBody(
  card: Card,
  state: ColumnState,
  replies: readonly Draft[],
  resolved: boolean,
): string {
  const selection =
    card.item?.type === "annotation"
      ? `\n    <pre class="lsr-prompt-selection">${escapeHtml(card.item.selected_text)}</pre>`
      : "";
  const messages = card.messages.map((said) => `\n    ${renderMessage(said, state)}`).join("");
  const unsent = replies.map((draft) => `\n    ${renderDraftBubble(draft)}`).join("");
  const foot = renderThreadFoot({ ...card, label: cardLabel(card) }, resolved, state.mode);
  return `${selection}${messages}${unsent}${foot}`;
}

/**
 * Every message the reviewer sent says how far it got: a Send with nobody
 * listening is held by the server, and read as delivered it hid a stalled review.
 */
function renderMessage(message: ThreadMessage, state: ColumnState): string {
  const who =
    message.role === "reviewer"
      ? `you${renderDelivery(deliveryOf(message.at, state.delivery, state.status))}`
      : "agent";
  return `<div class="lsr-message" data-role="${message.role}">
      <p class="lsr-message-role">${who}</p>
      <p class="lsr-prompt-comment">${escapeHtml(message.comment)}</p>
    </div>`;
}

function renderDelivery(delivery: keyof typeof DELIVERY_LABEL | "draft"): string {
  const label = delivery === "draft" ? DRAFT_LABEL : DELIVERY_LABEL[delivery];
  return ` <span class="lsr-message-delivery" data-delivery="${delivery}">${escapeHtml(label)}</span>`;
}

/**
 * A queued reply sits where it will land, as the reviewer's next message —
 * drawn apart so it cannot pass for one already sent. Its × keeps the tray's
 * class and index, so taking it back is the same press as for any pill.
 */
function renderDraftBubble(draft: Draft): string {
  const comment = draft.pill.type === "resolve" ? "" : draft.pill.comment;
  return `<div class="lsr-message lsr-draft" data-role="reviewer">
      <p class="lsr-message-role">you${renderDelivery("draft")}${renderRemove(draft.index)}</p>
      <p class="lsr-prompt-comment">${escapeHtml(comment)}</p>
    </div>`;
}

function renderRemove(index: number): string {
  return `<button type="button" class="lsr-pill-remove" data-index="${index}" title="Take back">×</button>`;
}

/**
 * New comments not sent yet, just above the compose box: they have no thread
 * until they are sent. A reply or resolve whose thread is not on screen lands
 * here too, so no pill is ever out of reach of its ×.
 */
export function renderDrafts(state: ColumnState): string {
  const onScreen = new Set(
    groupCards(state.conversation)
      .filter((group) => group.name !== "resolved" || state.resolvedShown)
      .flatMap((group) => group.cards.map((card) => card.id)),
  );
  const loose = state.pending
    .map((pill, index) => ({ pill, index }))
    .filter(({ pill }) => !threadsTo(pill) || !onScreen.has(pill.thread));
  if (loose.length === 0) return "";
  return `<section class="lsr-thread-group lsr-drafts" data-group="new">
  <h3 class="lsr-group-head">New · ${DRAFT_LABEL}</h3>
  ${loose.map((draft) => renderDraftCard(draft, state.round)).join("\n  ")}
  </section>`;
}

function threadsTo(pill: QueuedPill): pill is QueuedPill & { thread: string } {
  return pill.type === "reply" || pill.type === "resolve";
}

function renderDraftCard(draft: Draft, round: number): string {
  const { pill } = draft;
  const selection =
    pill.type === "annotation"
      ? `\n    <pre class="lsr-prompt-selection">${escapeHtml(pill.selected_text)}</pre>`
      : "";
  const comment = pill.type === "resolve" ? "" : pill.comment;
  return `<article class="lsr-thread lsr-pill" data-draft="true">
    <header class="lsr-thread-head">${draftWhere(pill)}${renderStaleBadge(pill, round)}${renderRemove(draft.index)}</header>${selection}
    <div class="lsr-message lsr-draft" data-role="reviewer">
      <p class="lsr-message-role">you${renderDelivery("draft")}</p>
      <p class="lsr-prompt-comment">${escapeHtml(comment)}</p>
    </div>
  </article>`;
}

function draftWhere(pill: QueuedPill): string {
  if (pill.type === "annotation") return renderFilePress(pill);
  return `<span class="lsr-thread-where">${escapeHtml(looseName(pill))}</span>`;
}

function looseName(pill: Exclude<QueuedPill, AnnotationPrompt>): string {
  if (pill.type === "message") return "General";
  if (pill.type === "reply") return "Reply";
  return pill.resolved ? "Resolve" : "Reopen";
}

/** No stamp, no badge: absence is not a claim. */
function renderStaleBadge(pill: QueuedPill, current: number): string {
  const stale = stalePillRound(pill, current);
  if (stale === undefined) return "";
  // Escaped: comes from `localStorage`, which may be hand-edited.
  const name = escapeHtml(`round ${stale + 1}`);
  const why = escapeHtml(
    `Queued in round ${stale + 1} — the diff has changed since, so its lines may not line up.`,
  );
  return `<span class="lsr-pill-round" role="note" title="${why}" aria-label="${why}">${name}</span>`;
}

/** `users.ts:12`, or just the name when there is no anchor. */
function placeOf(prompt: AnnotationPrompt): string {
  const name = prompt.file.split("/").at(-1) ?? prompt.file;
  return prompt.side === undefined ? name : `${name}:${prompt.line_start}`;
}

/**
 * Basename and line only; full path in the tooltip — every comment paying the
 * path's width glued the card into one block. Without an anchor the press
 * still opens the file.
 */
function renderFilePress(prompt: AnnotationPrompt): string {
  const path = escapeHtml(prompt.file);
  const anchor =
    prompt.side === undefined ? "" : ` data-side="${prompt.side}" data-line="${prompt.line_start}"`;
  return `<button type="button" class="lsr-prompt-file" data-file="${path}"${anchor} title="${path}">${escapeHtml(placeOf(prompt))}</button>`;
}
