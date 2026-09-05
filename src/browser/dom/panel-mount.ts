import {
  composeNote,
  renderCompose,
  renderPanel,
  renderScroll,
  SEND_LABEL,
  SENDING_LABEL,
  type PanelState,
} from "../conversation-panel.ts";
import { currentRound } from "../conversation-rounds.ts";
import { enterAction, typeNewline } from "./enter-key.ts";
import type { LinePlace } from "./line-numbers.ts";
import { stampPills, unstampedPill } from "../queued-pill.ts";
import { readMemory, updateMemory, type ReviewMemoryStorage } from "../review-memory.ts";
import { saveLater } from "./save-later.ts";
import type { ConversationEntry, FeedbackPrompt } from "../../session-store.ts";
import { sendFeedback, type SessionData } from "./session-api.ts";

export interface MountedPanel {
  /** Adds annotations queued from the diff and redraws the panel. */
  queue(prompts: FeedbackPrompt[]): void;
  update(session: SessionData): void;
  /** Every file of the review is ticked, or one of them no longer is. */
  setAllApproved(allApproved: boolean): void;
  /** An agent took the feedback away, or came back for more. */
  setWorking(working: boolean): void;
  /**
   * The reviewer said done from somewhere other than the panel's own button:
   * the same send as Send & End, queue and comment included, so there is one
   * way a review ends however the word was given.
   */
  end(): void;
}

export interface PanelOptions {
  root: HTMLElement;
  key: string;
  session: SessionData;
  /** Where the queue and the half-typed comment are kept across a reload. */
  storage: ReviewMemoryStorage;
  /**
   * Server accepted a Send & End; the page locks. Carries the prompts so the
   * page can name the reviewer's last act without asking the server again.
   */
  onEnd(sent: FeedbackPrompt[]): void;
  /** The unsent queue changed — the rail shows this while the panel is shut. */
  onPending(count: number): void;
  /**
   * A comment's file name pressed. The panel only says which file and where;
   * opening and scrolling is the diff's craft.
   */
  onJump(file: string, place: LinePlace | undefined): void;
}

/** One mounted panel: its options, its held state and the hosts it redraws into. */
interface PanelView {
  readonly options: PanelOptions;
  readonly state: PanelState;
  /**
   * Send in flight. Controls locked exactly that long: the one thing worth
   * refusing is the same feedback going twice, not an agent still working.
   */
  sending: boolean;
  /**
   * Held for the panel's life: only the scroll half is redrawn, so a
   * half-typed comment outlives an SSE reply.
   */
  readonly scrollHost: HTMLElement | null;
  readonly composeHost: HTMLElement | null;
}

/**
 * `pending` here is the browser's unsent queue; the session's `pending`
 * (server-held, awaiting a poll) is deliberately not shown as removable pills.
 */
export function mountPanel(options: PanelOptions): MountedPanel {
  const { root, key, session, storage } = options;
  // Last visit's unsent queue, restored before the first draw so pills are
  // simply there.
  const remembered = readMemory(storage, key);
  const state: PanelState = {
    pending: remembered.pending,
    conversation: session.conversation,
    rounds: session.rounds,
    declarations: session.declarations,
    status: session.status,
    allApproved: false,
    agentWorking: false,
  };
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

  root.addEventListener("click", (event) => handleClick(view, event));
  root.addEventListener("input", (event) => {
    if (event.target !== generalCommentBox(root)) return;
    rememberDraft.soon();
  });
  root.addEventListener("keydown", (event) => handleComposeKey(view, event));

  return {
    queue(prompts: FeedbackPrompt[]) {
      // Stamped with the round on screen: a pill's anchor points into this
      // round's diff, and the tray says so if the queue outlives it.
      state.pending = [...state.pending, ...stampPills(prompts, currentRound(state.rounds))];
      draw(view);
    },
    update(fresh: SessionData) {
      // Rounds come with the conversation: a `start` appends one, and entries
      // above its line become the round before.
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
    setWorking(working: boolean) {
      if (working === state.agentWorking) return;
      state.agentWorking = working;
      // Full redraw for one line at the foot: `draw` follows the panel to the
      // bottom, so the line lands where the eye already is.
      draw(view);
    },
    end() {
      // Not awaited, as the button's own press is not: the send reports
      // through `onEnd`, and a failure leaves the controls full to press again.
      void send(view, true);
    },
  };
}

function draw(view: PanelView): void {
  const { options, state, scrollHost } = view;
  // Measured before the write: the write changes the height.
  const following = atBottom(scrollHost);
  if (scrollHost) scrollHost.innerHTML = renderScroll(state);
  if (following) toBottom(scrollHost);
  options.onPending(state.pending.length);
  // Queue stored on every change, no delay: a pill is one gesture, and the
  // thing a reload must not lose.
  updateMemory(options.storage, options.key, { pending: state.pending });
}

/**
 * Reading the live end? Scrolled up, a reply must not yank the panel away.
 * Within a line counts as at bottom: rounded scroll positions are off by
 * fractions of a pixel.
 */
function atBottom(scrollHost: HTMLElement | null): boolean {
  if (scrollHost === null) return true;
  return scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight < 32;
}

function toBottom(scrollHost: HTMLElement | null): void {
  if (scrollHost) scrollHost.scrollTop = scrollHost.scrollHeight;
}

/** The only thing that replaces the compose box, and only when it must. */
function setStatus(view: PanelView, status: SessionData["status"]): void {
  if (status === view.state.status) return;
  view.state.status = status;
  if (view.composeHost) view.composeHost.innerHTML = renderCompose(view.state);
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
  if (target.id === "lsr-send" || target.id === "lsr-send-end") {
    void send(view, target.id === "lsr-send-end");
  }
}

/**
 * File-name press, read off the button's own data so a redraw can never leave
 * a handler pointing at a gone comment. Half an anchor is treated as none:
 * better the file than a lie.
 */
function jumpPress(view: PanelView, target: HTMLElement): void {
  const file = target.dataset.file;
  if (file === undefined) return;
  view.options.onJump(file, placeOn(target));
}

/** The anchor a file press carries, or none when it never had a whole one. */
function placeOn(target: HTMLElement): LinePlace | undefined {
  const side = target.dataset.side;
  if (side !== "old" && side !== "new") return undefined;
  const line = Number(target.dataset.line);
  return Number.isInteger(line) && line > 0 ? { side, line } : undefined;
}

function handleComposeKey(view: PanelView, event: KeyboardEvent): void {
  // Compared against the box: only the compose box sends on Enter.
  const field = generalCommentBox(view.options.root);
  if (field === null || event.target !== field) return;
  // Browsers send no keystrokes from a disabled box; this makes the lock a
  // panel property, not an element state.
  if (view.sending) return;
  const action = enterAction(event);
  if (action === "newline") {
    event.preventDefault();
    typeNewline(field);
    return;
  }
  if (action !== "submit") return;
  // Enter sends only off a typed comment: a stray Enter in an empty box must
  // not fire the queue half-read, and types no newline either — a blank first
  // line would hide the placeholder.
  event.preventDefault();
  if (field.value.trim() === "") return;
  void send(view, false);
}

async function send(view: PanelView, ended: boolean): Promise<void> {
  const { options, state } = view;
  // One press at a time: a second mid-wire would send the same prompts twice.
  if (view.sending) return;
  const prompts = withGeneralComment(options.root, state.pending);
  // Ending may carry nothing (all approved, nothing to say is the happy
  // path); sending is only ever about prompts — with none there is no send.
  if (prompts.length === 0 && !ended) return;
  // Conversation before the send, so the echo below can tell whether it is
  // still the one it was written for.
  const before = state.conversation;
  setSending(view, true);
  if (!(await deliver(options.key, prompts, ended))) {
    // Nothing was cleared: controls come back full and the press can be repeated.
    setSending(view, false);
    return;
  }
  // Not a duplicate of the server's copy: this half is instant and holds even
  // with a dead SSE stream; the `feedback` event brings the server's copy —
  // the truth, and all another tab ever sees.
  echoSent(state, before, prompts);
  state.pending = [];
  clearGeneralComment(options.root);
  // Both halves at once, ahead of the delayed write: a reload must not offer
  // to send what the server now owns.
  updateMemory(options.storage, options.key, { pending: [], draft: "" });
  draw(view);
  if (ended) setStatus(view, "ended");
  // After the status: lifting the send lock must never reopen a closed review.
  setSending(view, false);
  // Not left to the SSE round trip: every control must stop at the moment the
  // reviewer said done.
  if (ended) options.onEnd(prompts);
}

/**
 * Locks the compose row during a send. Patched into existing elements:
 * re-rendering would replace the textarea and lose a comment typed mid-flight
 * — the very thing the lock prevents.
 */
function setSending(view: PanelView, sending: boolean): void {
  view.sending = sending;
  // An ended review stays locked: lifting the send lock hands nothing back.
  const locked = sending || view.state.status === "ended";
  for (const id of ["#lsr-send", "#lsr-send-end", "#lsr-general-comment"]) {
    const control = composeControl(view, id);
    if (control) control.disabled = locked;
  }
  const button = composeControl(view, "#lsr-send");
  if (button) button.textContent = sending ? SENDING_LABEL : SEND_LABEL;
}

/** One of the compose row's controls as the last draw of the row left it. */
function composeControl(
  view: PanelView,
  id: string,
): HTMLButtonElement | HTMLTextAreaElement | null {
  return view.composeHost?.querySelector<HTMLButtonElement | HTMLTextAreaElement>(id) ?? null;
}

/**
 * Echoes the sent prompts onto the conversation, stamped like the server
 * stamps them. Empty sends append nothing (a bare "reviewer" turn reads as
 * lost words). Stands down if the conversation moved since the send began:
 * the server writes feedback before publishing `feedback`, so a fresh read
 * already carries these words and echoing would double them; a read that
 * raced ahead is one round trip from the one that does — a beat late beats double.
 */
function echoSent(state: PanelState, before: ConversationEntry[], prompts: FeedbackPrompt[]): void {
  if (prompts.length === 0 || state.conversation !== before) return;
  state.conversation = [
    ...state.conversation,
    {
      role: "reviewer",
      at: new Date().toISOString(),
      roundIndex: currentRound(state.rounds),
      prompts,
    },
  ];
}

/** False means the prompts never left the page, so nothing may be cleared. */
async function deliver(key: string, prompts: FeedbackPrompt[], ended: boolean): Promise<boolean> {
  try {
    await sendFeedback(key, prompts, ended);
    return true;
  } catch {
    console.error("lightspeed: feedback was not delivered — nothing was cleared");
    return false;
  }
}

function generalCommentBox(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>("#lsr-general-comment");
}

/**
 * What goes on the wire: pills minus the page's round stamps (the server
 * records arrival rounds itself), plus the comment box as one more message.
 */
function withGeneralComment(root: HTMLElement, pending: PanelState["pending"]): FeedbackPrompt[] {
  const prompts = pending.map(unstampedPill);
  const comment = generalCommentBox(root)?.value.trim() ?? "";
  return comment ? [...prompts, { type: "message", comment }] : prompts;
}

function clearGeneralComment(root: HTMLElement): void {
  const box = generalCommentBox(root);
  if (box) box.value = "";
}
