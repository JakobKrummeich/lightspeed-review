import {
  composeNote,
  queuedAnnouncement,
  queuesInstead,
  renderCompose,
  renderPanel,
  renderScroll,
  sendIsLocked,
  type PanelState,
} from "../conversation-panel.ts";
import { currentRound } from "../conversation-rounds.ts";
import { sameTurn } from "../agent-presence.ts";
import { submitsOnEnter } from "./enter-key.ts";
import type { LinePlace } from "./line-numbers.ts";
import { atBottom, placeOn, toBottom } from "./panel-dom.ts";
import { composeFrozen, lockControls, sendRefused, type ComposeView } from "./panel-lock.ts";
import {
  answerBox,
  clearGeneralComment,
  deliver,
  echoSent,
  generalCommentBox,
  restoreAnswer,
  withGeneralComment,
} from "./panel-wire.ts";
import { stampPills } from "../queued-pill.ts";
import { readMemory, updateMemory, type ReviewMemoryStorage } from "../review-memory.ts";
import { saveLater } from "./save-later.ts";
import type { FeedbackPrompt, Turn } from "../../session-store.ts";
import type { SessionData } from "./session-api.ts";

export interface MountedPanel {
  queue(prompts: FeedbackPrompt[]): void;
  update(session: SessionData): void;
  setAllApproved(allApproved: boolean): void;
  setTurn(turn: Turn): void;
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
  /** The rail shows this while the panel is shut. */
  onPending(count: number): void;
  /** The panel only says which file and where; opening and scrolling is the diff's craft. */
  onJump(file: string, place: LinePlace | undefined): void;
}

interface PanelView extends ComposeView {
  readonly options: PanelOptions;
}

/**
 * `pending` here is the browser's unsent queue; the session's `pending`
 * (server-held, awaiting a `wait`) is deliberately not shown as removable pills.
 */
export function mountPanel(options: PanelOptions): MountedPanel {
  const { root, key, session, storage } = options;
  // Restored before the first draw, so pills are simply there.
  const remembered = readMemory(storage, key);
  const state = openingState(session, remembered.pending);
  root.innerHTML = renderPanel(state);
  const view: PanelView = {
    options,
    state,
    sending: false,
    scrollHost: root.querySelector<HTMLElement>(".lsr-panel-scroll"),
    composeHost: root.querySelector<HTMLElement>(".lsr-compose"),
  };
  // Draft stored on a delay: typing is a burst, and every keystroke would
  // restringify every queued pill.
  const rememberDraft = saveLater(() =>
    updateMemory(storage, key, { draft: generalCommentBox(root)?.value ?? "" }),
  );
  // Pagehide mid-sentence is exactly what the delay would lose; cut it short.
  window.addEventListener("pagehide", () => rememberDraft.now());
  // Written back, not rendered into markup: a draft ending in whitespace or
  // looking like a tag would not survive textarea markup.
  const composeBox = generalCommentBox(root);
  if (composeBox) composeBox.value = remembered.draft;
  // Newest talk and the current-round line are at the bottom; opening at the
  // top would hide both behind an unsuspected scroll.
  toBottom(view.scrollHost);
  // Once at mount: the row is then always what `lockControls` says it is.
  lockControls(view);

  root.addEventListener("click", (event) => handleClick(view, event));
  root.addEventListener("input", (event) => {
    if (event.target !== generalCommentBox(root)) return;
    rememberDraft.soon();
  });
  // Both guard their own box, so neither can act on the other's Enter.
  root.addEventListener("keydown", (event) => {
    handleComposeKey(view, event);
    handleAnswerKey(view, event);
  });

  return {
    queue(prompts: FeedbackPrompt[]) {
      enqueue(view, prompts);
    },
    update(fresh: SessionData) {
      state.conversation = fresh.conversation;
      state.rounds = fresh.rounds;
      state.declarations = fresh.declarations;
      draw(view);
      setStatus(view, fresh.status);
    },
    setAllApproved(allApproved: boolean) {
      if (allApproved === state.allApproved) return;
      state.allApproved = allApproved;
      drawNote(view);
    },
    setTurn(turn: Turn) {
      if (sameTurn(turn, state.turn)) return;
      state.turn = turn;
      // Full redraw for one line at the foot: `draw` follows the panel to the
      // bottom, so the line lands where the eye already is. It re-locks the
      // controls, which is what a moved turn is about.
      draw(view);
    },
    end() {
      // Not awaited, as the button's own press is not: the send reports
      // through `onEnd`, and a failure leaves the controls full to press again.
      void send(view, true);
    },
  };
}

/**
 * The turn is read off the page's own session rather than waited for over
 * SSE: a reload must show the turn the server already has written down, not a
 * Send that turns into Queue one round trip later.
 */
function openingState(session: SessionData, pending: PanelState["pending"]): PanelState {
  return {
    pending,
    conversation: session.conversation,
    rounds: session.rounds,
    declarations: session.declarations,
    status: session.status,
    allApproved: false,
    turn: session.turn,
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
  announce(view, queuedAnnouncement(view.state.pending.length));
}

function announce(view: PanelView, text: string): void {
  const region = view.composeHost?.querySelector("#lsr-queue-status");
  if (region) region.textContent = text;
}

function draw(view: PanelView): void {
  const { options, state, scrollHost } = view;
  // Measured before the write: the write changes the height.
  const following = atBottom(scrollHost);
  // The answer box lives inside the scroll, so every redraw replaces it. A pill
  // queued mid-answer is the ordinary way that happens, and it must not cost the
  // reviewer the sentence they were writing.
  const answering = answerBox(options.root)?.value ?? "";
  if (scrollHost) scrollHost.innerHTML = renderScroll(state);
  announce(view, "");
  restoreAnswer(options.root, answering);
  if (following) toBottom(scrollHost);
  options.onPending(state.pending.length);
  // Queue stored on every change, no delay: a pill is one gesture, and the
  // thing a reload must not lose.
  updateMemory(options.storage, options.key, { pending: state.pending });
  // The answer button is rendered by the scroll above, so every redraw hands
  // back a fresh, live one. Re-locked here rather than at each call site: a
  // draw that forgot was a live Answer on the agent's turn.
  lockControls(view);
}

/** The only thing that replaces the compose box, and only when it must. */
function setStatus(view: PanelView, status: SessionData["status"]): void {
  if (status === view.state.status) return;
  view.state.status = status;
  // Carried across the re-render, as the answer box is across a redraw: the row
  // is replaced, and the words in it are the reviewer's whether they went out or
  // not. An end that sent nothing keeps them for the round after the reopen.
  const typed = generalCommentBox(view.options.root)?.value ?? "";
  if (view.composeHost) {
    view.composeHost.innerHTML = renderCompose(view.state, view.state.pending.length);
  }
  const box = generalCommentBox(view.options.root);
  if (box) box.value = typed;
  // The fresh row knows nothing of a send in flight, and the status change the
  // send itself causes must not hand the buttons back early.
  setSending(view, view.sending);
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
  if (target.classList.contains("lsr-prompt-file")) {
    jumpPress(view, target);
    return;
  }
  if (target.classList.contains("lsr-pill-remove")) {
    const index = Number(target.dataset.index);
    view.state.pending = view.state.pending.filter((_, position) => position !== index);
    draw(view);
    return;
  }
  if (target.classList.contains("lsr-answer-send")) {
    void answer(view);
    return;
  }
  if (target.id === "lsr-send") {
    press(view);
    return;
  }
  if (target.id === "lsr-send-end") void send(view, true);
}

/** Button and Enter alike: whose turn it is decides between the two verbs. */
function press(view: PanelView): void {
  // The button's own `disabled` says the same; a stale listener must not queue
  // into a review that is over or under a send still on the wire.
  if (composeFrozen(view)) return;
  if (queuesInstead(view.state)) queueComment(view);
  else void send(view, false);
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

function handleAnswerKey(view: PanelView, event: KeyboardEvent): void {
  const field = answerBox(view.options.root);
  if (field === null || event.target !== field) return;
  if (sendRefused(view)) return;
  if (submitsOnEnter(event, field)) void answer(view);
}

/**
 * Only the words in the answer box go out: the queue stays queued and the
 * general comment stays typed, which is the whole reason `ask` is a verb of
 * its own. Nothing here moves the turn — the agent's blocked `wait` takes it
 * on delivery, as it takes every other send.
 */
async function answer(view: PanelView): Promise<void> {
  if (sendRefused(view)) return;
  const field = answerBox(view.options.root);
  const said = field?.value.trim() ?? "";
  if (said === "") return;
  const prompts: FeedbackPrompt[] = [{ type: "message", comment: said }];
  const before = view.state.conversation;
  setSending(view, true);
  if (await deliver(view.options.key, prompts, false)) {
    // Echoed like any other send, which is also what takes the box away: the
    // answer is now the last word, so the question above it is no longer open.
    echoSent(view.state, before, prompts);
    if (field) field.value = "";
    draw(view);
  }
  setSending(view, false);
}

async function send(view: PanelView, ended: boolean): Promise<void> {
  const { options, state } = view;
  // One press at a time: a second mid-wire would send the same prompts twice.
  if (view.sending) return;
  const prompts = onTheWire(view, ended);
  if (prompts === undefined) return;
  // Conversation before the send, so the echo below can tell whether it is
  // still the one it was written for.
  const before = state.conversation;
  setSending(view, true);
  if (!(await deliver(options.key, prompts, ended))) {
    setSending(view, false);
    return;
  }
  // Not a duplicate of the server's copy: this half is instant and holds even
  // with a dead SSE stream; the `feedback` event brings the server's copy —
  // the truth, and all another tab ever sees.
  echoSent(state, before, prompts);
  // Cleared only for what actually went out. An end on the agent's turn sends
  // nothing — the button says `End without Sending` and the round card promises
  // the queue — so the pills and the half-typed comment stay exactly where the
  // reviewer left them, to go out when the review is reopened.
  if (prompts.length > 0) {
    state.pending = [];
    clearGeneralComment(options.root);
    // Both halves at once, ahead of the delayed write: a reload must not offer
    // to send what the server now owns.
    updateMemory(options.storage, options.key, { pending: [], draft: "" });
  }
  draw(view);
  if (ended) setStatus(view, "ended");
  // After the status: lifting the send lock must never reopen a closed review.
  setSending(view, false);
  // Not left to the SSE round trip: every control must stop at the moment the
  // reviewer said done.
  if (ended) options.onEnd(prompts);
}

function setSending(view: PanelView, sending: boolean): void {
  view.sending = sending;
  lockControls(view);
}

/**
 * Ending is never gated and sending always is, so a locked end is exactly what
 * the button says: it ends, and the queue stays queued rather than going out on
 * somebody else's turn. An unlocked send is only ever about prompts — with none
 * there is no send — while an end may carry nothing at all, which is the happy
 * path of a review where everything was approved.
 */
function onTheWire(view: PanelView, ended: boolean): FeedbackPrompt[] | undefined {
  const locked = sendIsLocked(view.state);
  if (locked && !ended) return undefined;
  const prompts = locked ? [] : withGeneralComment(view.options.root, view.state.pending);
  return prompts.length === 0 && !ended ? undefined : prompts;
}
