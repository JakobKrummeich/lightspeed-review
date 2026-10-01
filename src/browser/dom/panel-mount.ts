import {
  composeNote,
  queuedAnnouncement,
  queuesInstead,
  renderPanel,
  renderScroll,
  writesLocked,
  type PanelState,
} from "../conversation-panel.ts";
import { currentRound } from "../conversation-rounds.ts";
import { sameTurn } from "../agent-presence.ts";
import { submitsOnEnter } from "./enter-key.ts";
import type { LinePlace } from "./line-numbers.ts";
import { atBottom, placeOn, toBottom } from "./panel-dom.ts";
import { composeFrozen, lockControls, type ComposeView } from "./panel-lock.ts";
import {
  clearGeneralComment,
  generalCommentBox,
  replyBox,
  focusedReply,
  restoreReplies,
  typedReplies,
} from "./panel-wire.ts";
import { stampPills, tallyOf, type QueueTally } from "../queued-pill.ts";
import {
  readMemory,
  updateMemory,
  type ReviewMemory,
  type ReviewMemoryStorage,
} from "../review-memory.ts";
import { deliveryFacts, handedOnTurn } from "../delivery.ts";
import { foldPress, groupPress } from "./panel-folds.ts";
import { keepDraft } from "./panel-draft.ts";
import { send, setStatus } from "./panel-send.ts";
import { editBlur, editKey, holdEdit, keepEdit, leaveEdit, pillPress } from "./panel-pills.ts";
import type { PanelLight } from "./panel-light.ts";
import type { FeedbackPrompt, Turn } from "../../session-store.ts";
import type { SessionData } from "./session-api.ts";
import { batchSize, threadsOf } from "../../threads.ts";
import { presenceOf } from "../../turn.ts";

export interface MountedPanel {
  queue(prompts: FeedbackPrompt[]): void;
  update(session: SessionData): void;
  setAllApproved(allApproved: boolean): void;
  /** `items`: how many the agent is reading, while it digests. */
  setTurn(turn: Turn, items?: number): void;
  /** Nothing may be written — the line popup asks before it queues. */
  writesLocked(): boolean;
  /**
   * To the newest talk. A folded panel lays nothing out, so its draws cannot
   * follow the foot: unfolded, it stands wherever it was when it was folded.
   */
  toFoot(): void;
  /**
   * The same send as Send & End, queue and comment included, so there is one
   * way a review ends however the word was given.
   */
  end(): void;
}

export interface PanelOptions {
  root: HTMLElement;
  key: string;
  session: SessionData;
  storage: ReviewMemoryStorage;
  /**
   * Carries the prompts so the page can name the reviewer's last act without
   * asking the server again.
   */
  onEnd(sent: FeedbackPrompt[]): void;
  /** The rail counts this while the panel is shut; the round offer names it by kind. */
  onPending(queued: QueueTally): void;
  /** The panel only says which file and where; opening and scrolling is the diff's craft. */
  onJump(file: string, place: LinePlace | undefined): void;
  /** Absent, nothing lights: the moments are the page's, the panel only says when. */
  light?: PanelLight;
}

interface PanelView extends ComposeView {
  readonly options: PanelOptions;
}

/**
 * `pending` here is the browser's unsent queue; the session's `pending`
 * (server-held, awaiting a listening agent) is deliberately not shown as
 * removable pills.
 */
export function mountPanel(options: PanelOptions): MountedPanel {
  const { root, key, session, storage } = options;
  // Restored before the first draw, so pills are simply there.
  const remembered = readMemory(storage, key);
  const state = openingState(session, remembered);
  root.innerHTML = renderPanel(state);
  const view: PanelView = {
    options,
    state,
    sending: false,
    scrollHost: root.querySelector<HTMLElement>(".lsr-panel-scroll"),
    composeHost: root.querySelector<HTMLElement>(".lsr-compose"),
  };
  keepDraft(root, storage, key, remembered.draft);
  // Newest talk and the current-round line are at the bottom; opening at the
  // top would hide both behind an unsuspected scroll.
  toBottom(view.scrollHost);
  // Once at mount: the row is then always what `lockControls` says it is.
  lockControls(view);

  root.addEventListener("click", (event) => handleClick(view, event));
  // Both guard their own box, so neither can act on the other's Enter.
  root.addEventListener("keydown", (event) => {
    handleComposeKey(view, event);
    handleReplyKey(view, event);
    editKey(view, event, draw);
  });
  root.addEventListener("focusout", (event) => editBlur(view, event, draw));
  root.addEventListener("mousedown", (event) => holdEdit(view, event));

  return {
    queue(prompts: FeedbackPrompt[]) {
      // The popup asks first; a stale one must still not write into a lock.
      if (writesLocked(state)) return;
      enqueue(view, prompts);
    },
    update(fresh: SessionData) {
      state.conversation = fresh.conversation;
      state.rounds = fresh.rounds;
      // Against the turn the page already has: a presence event can outrun the refetch.
      state.delivery = handedOnTurn(deliveryFacts(fresh), state.turn);
      // Status first: the thread foot is drawn from it, and a review that just
      // ended must not keep a Reply the draw below would otherwise leave behind.
      setStatus(view, fresh.status);
      draw(view);
    },
    setAllApproved(allApproved: boolean) {
      if (allApproved === state.allApproved) return;
      state.allApproved = allApproved;
      drawNote(view);
    },
    setTurn(turn: Turn, items?: number) {
      if (sameTurn(turn, state.turn) && items === state.items) return;
      state.turn = turn;
      state.delivery = handedOnTurn(state.delivery, turn);
      if (items === undefined) delete state.items;
      else state.items = items;
      // Full redraw for one line at the foot: `draw` follows the panel to the
      // bottom, so the line lands where the eye already is. It re-locks the
      // controls, which is what a moved turn is about.
      draw(view);
    },
    writesLocked: () => writesLocked(state),
    toFoot: () => toBottom(view.scrollHost),
    end() {
      // Not awaited, as the button's own press is not: the send reports
      // through `onEnd`, and a failure leaves the controls full to press again.
      void send(view, true, draw);
    },
  };
}

/**
 * The turn is read off the page's own session rather than waited for over
 * SSE: a reload must show the turn the server already has written down, not a
 * Send that turns into Queue one round trip later.
 */
function openingState(session: SessionData, remembered: ReviewMemory): PanelState {
  return {
    pending: remembered.pending,
    conversation: session.conversation,
    rounds: session.rounds,
    status: session.status,
    allApproved: false,
    ...presenceOf(session),
    delivery: deliveryFacts(session),
    folds: remembered.folds,
    resolvedShown: remembered.resolvedShown,
  };
}

/**
 * The one way into the tray, for a line comment from the popup and a general
 * comment from the box alike, so both queue up in the order they were made.
 * Stamped with the round on screen: a pill's anchor points into this round's
 * diff, and the tray says so if the queue outlives it.
 */
function enqueue(view: PanelView, prompts: FeedbackPrompt[]): void {
  const { state } = view;
  state.pending = [...state.pending, ...stampPills(prompts, currentRound(state.rounds))];
  draw(view);
}

/**
 * The agent's turn turns the box into one more pill rather than a send: the
 * tray is already what goes out on the reviewer's next Send, and a second queue
 * beside it would be a second order to keep. Cleared from the draft at once,
 * ahead of the delayed write: a reload must not offer the same words twice,
 * once as a pill and once in the box.
 */
function queueComment(view: PanelView): void {
  const { root, storage, key } = view.options;
  const box = generalCommentBox(root);
  const comment = box?.value.trim() ?? "";
  // Back to the box either way, so a run of comments needs no reach for the mouse.
  box?.focus();
  if (comment === "") return;
  clearGeneralComment(root);
  updateMemory(storage, key, { draft: "" });
  enqueue(view, [{ type: "message", comment }]);
  // After the draw, which empties it: the same count queued twice is news twice.
  announce(view, queuedAnnouncement(batchSize(view.state.pending)));
}

function announce(view: PanelView, text: string): void {
  const region = view.composeHost?.querySelector("#lsr-queue-status");
  if (region) region.textContent = text;
}

function draw(view: PanelView): void {
  const { options, state, scrollHost } = view;
  // Measured before the write: the write changes the height.
  const following = atBottom(scrollHost);
  // The reply boxes live inside the scroll, so every redraw replaces them; a
  // pill queued mid-reply must not cost the reviewer the sentence, nor the focus.
  const typed = typedReplies(options.root);
  const focused = focusedReply(options.root);
  // So is a queued pill's words being edited, and the caret with them.
  keepEdit(options.root, () => {
    if (scrollHost) scrollHost.innerHTML = renderScroll(state);
  });
  announce(view, "");
  restoreReplies(options.root, typed);
  if (focused !== undefined) replyBox(options.root, focused)?.focus();
  if (following) toBottom(scrollHost);
  // After the scroll: whether a new card is in sight decides how it is lit.
  options.light?.drawn(state);
  options.onPending(tallyOf(state.pending));
  // Queue stored on every change, no delay: a pill is one gesture, and the
  // thing a reload must not lose.
  updateMemory(options.storage, options.key, { pending: state.pending });
  // The thread controls are rendered by the scroll above, so every redraw hands
  // back fresh, live ones. Re-locked here rather than at each call site: a
  // draw that forgot would be a live Reply while the agent digests.
  lockControls(view);
}

/**
 * Note written into the existing live region, not a compose redraw: that
 * would throw away a half-typed comment, and ticking the last file is exactly
 * when one might exist.
 */
function drawNote(view: PanelView): void {
  const note = view.composeHost?.querySelector(".lsr-complete");
  if (note) note.textContent = composeNote(view.state);
}

function handleClick(view: PanelView, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  // First, while the index it read is the drawn one; any other press then
  // leaves an open box before it acts.
  if (pillPress(view, target, draw)) return;
  leaveEdit(view, target, draw);
  if (controlPress(view, target)) return;
  // Last: anywhere on a card's head folds it, but its own presses act instead.
  if (groupPress(view, target) || foldPress(view, target)) draw(view);
}

/** Every press that is not a fold; true when the press was one of them. */
function controlPress(view: PanelView, target: HTMLElement): boolean {
  if (target.classList.contains("lsr-prompt-file")) {
    jumpPress(view, target);
    return true;
  }
  return threadPress(view, target) || composePress(view, target);
}

function composePress(view: PanelView, target: HTMLElement): boolean {
  if (target.id === "lsr-send") press(view);
  else if (target.id === "lsr-send-end") void send(view, true, draw);
  else return false;
  return true;
}

/** The thread card's own two controls; true when the press was one of them. */
function threadPress(view: PanelView, target: HTMLElement): boolean {
  const thread = target.dataset.thread;
  if (thread === undefined) return false;
  if (target.classList.contains("lsr-thread-resolve")) toggleResolve(view, thread);
  else if (target.classList.contains("lsr-thread-reply-add")) addReply(view, thread);
  else return false;
  return true;
}

/**
 * Resolving sends nothing by itself: it is a pill, and travels with the next
 * Send. Pressed again before then, the pill is taken back rather than a
 * second, opposite one queued — the thread is where the server has it again.
 */
function toggleResolve(view: PanelView, thread: string): void {
  if (composeFrozen(view)) return;
  const { state } = view;
  const kept = state.pending.filter((pill) => pill.type !== "resolve" || pill.thread !== thread);
  if (kept.length !== state.pending.length) {
    state.pending = kept;
    draw(view);
    return;
  }
  const resolved = !threadsOf(state.conversation).some((one) => one.id === thread && one.resolved);
  enqueue(view, [{ type: "resolve", thread, resolved }]);
}

/** A reply is one more pill in the batch; the box empties and keeps the focus. */
function addReply(view: PanelView, thread: string): void {
  if (composeFrozen(view)) return;
  const box = replyBox(view.options.root, thread);
  const comment = box?.value.trim() ?? "";
  if (comment === "") return;
  if (box) box.value = "";
  enqueue(view, [{ type: "reply", thread, comment }]);
  // After the draw, which replaced the box: the fresh one takes the focus.
  replyBox(view.options.root, thread)?.focus();
  announce(view, queuedAnnouncement(batchSize(view.state.pending)));
}

/** Button and Enter alike: whose turn it is decides between the two verbs. */
function press(view: PanelView): void {
  // The button's own `disabled` says the same; a stale listener must not queue
  // into a review that is over, locked, or under a send still on the wire.
  if (composeFrozen(view)) return;
  if (queuesInstead(view.state)) queueComment(view);
  else void send(view, false, draw);
}

function jumpPress(view: PanelView, target: HTMLElement): void {
  const file = target.dataset.file;
  if (file === undefined) return;
  view.options.onJump(file, placeOn(target));
}

function handleComposeKey(view: PanelView, event: KeyboardEvent): void {
  const field = generalCommentBox(view.options.root);
  if (field === null || event.target !== field) return;
  if (!submitsOnEnter(event, field)) return;
  // Only off a typed comment: a stray Enter in an empty box must not fire the
  // queue half-read. The turn and the lock are `press`'s, as for the button.
  if (field.value.trim() === "") return;
  press(view);
}

function handleReplyKey(view: PanelView, event: KeyboardEvent): void {
  const field = event.target;
  if (!(field instanceof HTMLElement) || !field.classList.contains("lsr-thread-reply-box")) return;
  const thread = field.dataset.thread;
  if (thread === undefined) return;
  if (submitsOnEnter(event, field as HTMLTextAreaElement)) addReply(view, thread);
}
