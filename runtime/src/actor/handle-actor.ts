// The handle actor (T-244; C-046, C-030, C-184): one Durable Object per handle, named `actorNameOf(handle)`, which the
// gateway's door (runtime/src/gateway/actor-door.ts) reaches with `accept`. It keeps the handle's ordered inbox of
// sealed events in its own storage (inbox.ts), drops a known event id, starts no turn for Rosie's own reaction, and
// sends a receipt that reaches it to the receipt hooks, never to the inbox. Each raw text goes to the safety read on
// arrival (T-246, ../safety), then into the batch window (T-247, batch.ts), whose closed batches go to the turn lease
// (T-248, lease.ts) once each of their texts has been read; the open safety holds go with the turn to its commit
// (QUESTIONS.md CQ-65 as DL-119 replaced it: holds bind commits, not hand-offs). Each run of a turn pins its bundle first
// (T-249, ../bundle). A turn parked after its third lapse with no commit (T-253) has its park's span on the turn's trace,
// under the bundle pinned for it (`parkTrace`).
//
// A safety read lives in memory, so the actor keeps a stored alarm at each read's 4 s deadline (T-1088): if the actor is
// evicted mid-read (a deploy, a reset), the alarm brings a new instance, which resumes every read cut off, in arrival
// order, the moment it starts (any request or alarm starts it); a resumed read ends through the same settle path as one
// on arrival, so its batch is handed on and its danger closes the open batch. The same alarm brings back every text
// whose unread hold is open (no verdict in 4 s, the outage line sent) for its re-read every 30 s until a verdict lands
// (DL-127), so a late answer lost with an evicted instance cannot leave a text unread and held for good.
//
// The same one alarm keeps the handle's clock rows (T-254, ../clocks): the stored schedule gains a clock entry at the
// handle's earliest armed row, and the alarm then fires the due rows through the clocks' one fire path, each a clock
// turn whose commit reads the holds open and the texts not read yet, as a turn's does. The minute sweep and staging's
// Fire now hand a row in through `fireClockRow`; the clock arming (T-255) names the handle through `syncClocks`.
//
// The actor keeps its own copies for the database-down path (T-269, ./copies): the handle's stopped flag, copied from each
// commit the lease is answered committed, before the run is answered, so it is set before that turn's reply can go; the
// checked safety lines, copied from the safety read's bundle each time a text is written; each live safety timer's due
// time, address (as K-34 seals it) and emergency contact, reloaded after a commit that wrote a timer row; and the queue of
// writes to replay when PostgreSQL returns (danger, stops, then the rest, each once), where the safety read's records
// wait. Each bundle a turn pins gives the copies its keyword list and stop and start replies (T-270). A commit whose answer
// was lost, which only a park's alreadyCommitted tells of (T-1206), is read again: before the next turn opens, the stopped
// flag reads stopped and the timers' copy is marked stale; then the flag is read again from the handle's phone row and
// the timers are reloaded, and each later commit tries again until each read succeeds (fails safe).
//
// PostgreSQL down (T-270, ../outage/db): the actor follows each text until a commit takes it. While PostgreSQL is known
// down, closed batches stay with the batch window, in order, and the lease holds its turn as it is (a lapse is no crash);
// a text waiting 20 s gets the outage line once, never to a stopped number; a STOP or a START is taken at once (the flag
// copied, its reply straight through Linq, its record queued for the return, and it joins no turn); a running safety
// timer due fires from the copy. On return the write-on-return queue replays danger, then stops, then the rest (the STOP
// and START records through `recordStopOrStart`), and only then does the lease resume and the queued batches go on. Every
// commit is preceded by that replay (QUESTIONS.md CQ-104 (f)).
//
// Not here: what runs inside a turn (T-251, T-252), edits and vote changes after a commit (T-245). This file opens no
// sealed box: the safety read does, and the PostgreSQL-down path, to read a STOP or a START, each with the handle's key.
// Never logged: a word, a phone number, a key, a sealed body.

import { DurableObject } from "cloudflare:workers";

import { BundlePins, bundleKvOf, type PinEntry, type PinRequest, type TurnPin } from "../bundle";
import { ActorClocks, type DueClock, type FireBy, type FireReport } from "../clocks";
import { RECEIPT_KINDS, ACTOR_KINDS } from "../gateway/hand-off";
import type { SealedEvent, SealedHandoff, StoreAnswer } from "../gateway/types";
import { DbOutage, STOP_OR_START_CALL, type OutageView } from "../outage/db";
import {
  REREAD_MS,
  SAFETY_RETURN_CALLS,
  SafetyOnArrival,
  isReadable,
  isReadableEvent,
  type HoldEntry,
  type SafetyEntry,
} from "../safety";
import { isLabel, logSink, openTrace, type BundleId, type SpanSink, type TraceContext } from "../trace";
import {
  actorClock,
  BatchWindow,
  scheduleEntry,
  SCHEDULE_SAFETY,
  unscheduleEntry,
  type BatchEntry,
  type ClosedBatch,
} from "./batch";
import {
  ActorCopies,
  readCommit,
  ReturnQueue,
  type CheckedLineCopy,
  type QueuedEntry,
  type QueuedWrite,
  type ReplayReport,
  type ReplayStep,
  type SafetyTimerCopy,
  type StoppedCopy,
} from "./copies";
import {
  createInboxTables,
  markReceiptSeen,
  readInbox,
  readInboxEvents,
  startsTurn,
  unmarkReceipt,
  writeToInbox,
  type InboxEntry,
} from "./inbox";
import {
  TurnLease,
  type CommitTurnCommitted,
  type CommitTurnRef,
  type LostCommit,
  type ParkTraceRequest,
  type TurnEntry,
} from "./lease";

/** A delivery receipt as the actor passes it on: the scrubbed K-06 event (no words) with `partKey` beside it. */
export interface ReceiptHandoff {
  event: SealedEvent;
  partKey: string | null;
  traceId: string;
  bundleId: BundleId;
}

/**
 * Where a receipt that reaches the actor goes. The outbox dispatcher (C-052, T-257) and clock arming (C-021) join
 * here; until they are wired (D-017) the default hooks do nothing. A hook that throws makes the receipt fail (the
 * gateway answers 503 and Linq retries); the receipt is then handled again on the retry.
 */
export interface ReceiptHooks {
  toDispatcher(receipt: ReceiptHandoff): void | Promise<void>;
  toClockArming(receipt: ReceiptHandoff): void | Promise<void>;
}

const unwiredHooks: ReceiptHooks = {
  toDispatcher: () => undefined,
  toClockArming: () => undefined,
};

let receiptHooks: ReceiptHooks = unwiredHooks;

/** Sets the receipt hooks for this Worker isolate; returns the function that puts the earlier ones back. */
export function setReceiptHooks(hooks: ReceiptHooks): () => void {
  const before = receiptHooks;
  receiptHooks = hooks;
  return () => {
    receiptHooks = before;
  };
}

/**
 * The actor's own copies, as a reader sees them (T-269): the stopped flag, the checked safety lines, the live safety timers
 * (each address as K-34 seals it), whether the timers' copy is behind a write, and the queued writes as labels.
 */
export interface CopiesView {
  stopped: StoppedCopy | null;
  lines: CheckedLineCopy[];
  timers: SafetyTimerCopy[];
  timersStale: boolean;
  returns: QueuedEntry[];
}

/** A hand-off the actor cannot read; `code` is a label, and the message never holds words. */
export class ActorRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ActorRefusal";
    this.code = code;
  }
}

function checkHandoff(handoff: SealedHandoff): "inbox" | "receipt" {
  const { event } = handoff;
  if (typeof event.eventId !== "string" || event.eventId === "") throw new ActorRefusal("noEventId");
  if (ACTOR_KINDS.includes(event.kind)) return "inbox";
  if (RECEIPT_KINDS.includes(event.kind)) {
    // A receipt has no words, so nothing sealed may ride on it.
    if (event.sealed !== null) throw new ActorRefusal("receiptWithWords");
    return "receipt";
  }
  throw new ActorRefusal("unroutable");
}

export class HandleActor extends DurableObject {
  private readonly safety: SafetyOnArrival;
  private readonly batch: BatchWindow;
  private readonly lease: TurnLease;
  private readonly pins: BundlePins;
  private readonly clocks: ActorClocks;
  private readonly copies: ActorCopies;
  private readonly returns: ReturnQueue;
  private readonly outage: DbOutage;
  private readonly batchWork = new Set<Promise<void>>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    createInboxTables(ctx.storage.sql);
    // The actor's own copies and its write-on-return queue (T-269), before the safety read, which queues its records there.
    this.copies = new ActorCopies({ storage: ctx.storage, now: () => actorClock().now() });
    this.returns = new ReturnQueue({ storage: ctx.storage, now: () => actorClock().now() });
    this.safety = new SafetyOnArrival({
      returns: this.returns,
      // The copy of the stopped flag (T-269), or a STOP no commit has taken that the actor has not taken either (T-270).
      stopped: () => this.copies.readStopped()?.stopped === true || this.outage.stopPending(),
      storage: ctx.storage,
      spanSink: () => logSink({ environment: this.env.ENVIRONMENT, version: this.env.GIT_SHA ?? "unknown" }),
      // A late answer or a re-read's: danger closes the open batch at once, a lifted unread hold lets the waiting batches
      // go on, and a re-read moved 30 s on moves the safety alarm with it.
      afterLate: (eventId) => {
        this.lend(
          Promise.resolve()
            .then(() => {
              this.batch.afterSafety(eventId);
            })
            .then(() => this.settleBatch()),
        );
      },
      storedTexts: (eventIds) => readInboxEvents(ctx.storage.sql, eventIds),
    });
    this.batch = new BatchWindow({
      storage: ctx.storage,
      held: (eventIds) => this.unreadAmong(eventIds),
      isDanger: (eventId) =>
        this.safety.readSafety().some((entry) => entry.eventId === eventId && entry.danger),
      lease: (batch) => this.handOff(batch),
    });
    this.pins = new BundlePins({
      storage: ctx.storage,
      now: () => actorClock().now(),
      kv: () => bundleKvOf(this.env.BUNDLES),
      spanSink: () => logSink({ environment: this.env.ENVIRONMENT, version: this.env.GIT_SHA ?? "unknown" }),
    });
    this.lease = new TurnLease({
      storage: ctx.storage,
      arm: () => this.batch.arm(),
      lend: (work) => {
        this.lend(work);
      },
      pin: (request, signal) => this.pinAndCopy(request, signal),
      holds: () => this.safety.openHolds(),
      unread: () => this.unreadTexts(),
      parkTrace: (request) => this.parkTrace(request),
      committed: (turn, answer) => {
        this.afterCommit(turn, answer);
      },
      commitLost: (lost) => {
        this.afterLostCommit(lost);
      },
      // PostgreSQL down (T-270): the lease holds its turn as it is, and the queue is replayed before any commit.
      held: () => this.outage.isDown(),
      beforeCommit: () => this.outage.beforeCommit(),
    });
    // The clock rows' part of the one alarm (T-254): a clock entry in the same stored schedule, at the handle's earliest
    // armed row; a clock turn's commit is handed the holds open and the texts not read yet, read at commit time.
    this.clocks = new ActorClocks({
      storage: ctx.storage,
      now: () => actorClock().now(),
      arm: () => this.batch.arm(),
      context: () => ({ holds: this.safety.openHolds(), unread: this.unreadTexts() }),
      logContext: () => ({ environment: this.env.ENVIRONMENT, version: this.env.GIT_SHA ?? "unknown" }),
      staging: () => this.env.ENVIRONMENT === "staging",
    });
    // The PostgreSQL-down path (T-270), on the actor's own storage, copies and write-on-return queue.
    this.outage = new DbOutage({
      storage: ctx.storage,
      now: () => actorClock().now(),
      copies: this.copies,
      returns: this.returns,
      replay: () => this.writeOnReturn(),
      texts: (eventIds) => readInboxEvents(ctx.storage.sql, eventIds),
      pending: () => ({ window: this.batch.pendingEventIds(), lease: this.lease.pendingEventIds() }),
      safetyEntry: (eventId) => this.safety.readSafety().find((entry) => entry.eventId === eventId),
      resume: () => {
        this.lend(this.resumeAfterOutage());
      },
      release: () => {
        this.lend(this.batch.release().then(() => this.batch.arm()));
      },
      arm: () => this.batch.arm(),
      lend: (work) => {
        this.lend(work);
      },
    });
    // A new instance resumes at once every safety read the last one was cut off in (T-1088), before any new text's read,
    // and reads again every text whose re-read is due (DL-127). A failure here must not keep the actor from starting.
    this.resumeSafetyGuarded();
    // After a restart the alarm is set again from the stored schedule, so a batch open at the restart still closes, a
    // lease that lapsed while the actor was gone still reruns its turn, and a read still unresolved is looked at again.
    ctx.waitUntil(this.batch.arm());
  }

  /**
   * The Durable Object alarm: the stored schedule's due entries (the safety work first, so a line waits for nothing: a
   * cut-off read, a re-read; then a lapsed lease; the batch close; a batch's hand-off; then the clock rows, T-254). A
   * throw in the safety part never keeps the lease and batch handlers from running; the clock part never throws, and it
   * sets the alarm again from the whole schedule.
   */
  override async alarm(): Promise<void> {
    this.resumeSafetyGuarded();
    // The PostgreSQL-down path's due work (T-270: a safety timer due, a text waiting 20 s, the next ask), lent: it never
    // holds the lease and batch handlers back.
    this.outage.wake();
    await this.lease.onAlarm();
    await this.batch.onAlarm();
    await this.clocks.onAlarm();
  }

  /**
   * The clock arming's call (T-255) once it arms a row of this handle, named by K-04 handles.id: fires the handle's due
   * rows through the clocks' fire path, then keeps the alarm's clock entry at its earliest armed row (T-254). A handle id
   * other than the one this actor already names is refused, with nothing read.
   */
  syncClocks(handleId: string): Promise<FireReport[]> {
    return this.clocks.sync(handleId);
  }

  /** One clock row of this handle, handed by the minute sweep (a missed row) or staging's Fire now: the alarm's own path. */
  fireClockRow(request: { row: DueClock; by: FireBy }): Promise<FireReport> {
    return this.clocks.fireRow(request.row, request.by);
  }

  /**
   * The gateway's one call. "written": the event is stored (or, for a receipt, passed to the hooks). "duplicate": its
   * event id was known and nothing changed. A throw means nothing was kept: the gateway answers 503.
   */
  async accept(handoff: SealedHandoff): Promise<StoreAnswer> {
    // The receive span's start (K-08: `at` is when the hop started; T-1170), read once as the call begins, on the
    // actor's clock (its batch window's, which the composition root gives the safety read too): no span begun inside
    // this call, such as the safety read's, starts before it when spans are judged in start order.
    const started = actorClock().now();
    const route = checkHandoff(handoff);
    let answer: StoreAnswer;
    if (route === "inbox") {
      // One synchronous step: the check and the write cannot be split by a concurrent retry.
      // The text joins the batch window in the same all-or-nothing step as its write (T-247).
      answer = this.ctx.storage.transactionSync(() => {
        const written = writeToInbox(this.ctx.storage, handoff);
        if (written === "written" && startsTurn(handoff.event)) {
          this.batch.add(this.seqOf(handoff.event.eventId), handoff.event.eventId);
        }
        return written;
      });
      // The safety read starts in the same step as the write, before any batch (arch 02 step S): the 4 s deadline
      // begins now and the read is queued in arrival order. It runs on; the gateway is answered at once. The stored alarm
      // is set for its deadline, so an eviction mid-read cannot leave it unread (T-1088).
      if (answer === "written" && isReadable(handoff)) {
        const eventId = handoff.event.eventId;
        const safe = this.safety.arrive(handoff);
        this.settleAfter(eventId, safe);
        this.syncSafetySchedule();
      }
      if (answer === "written") {
        this.refreshLines();
        // Followed by the PostgreSQL-down path until a commit takes it (T-270).
        if (startsTurn(handoff.event)) this.outage.arrive(handoff.event, this.seqOf(handoff.event.eventId));
        await this.batch.arm();
      }
    } else {
      answer = await this.passReceipt(handoff);
    }
    this.recordSpan(handoff, route, answer, started);
    return answer;
  }

  /** The inbox in arrival order (what a turn reads later). */
  readInbox(): InboxEntry[] {
    return readInbox(this.ctx.storage.sql);
  }

  /** Each stored text's safety state, in arrival order (the batch and the turn read it: T-247). */
  readSafety(): SafetyEntry[] {
    return this.safety.readSafety();
  }

  /** The holds on routine work, in the order they were made. */
  readHolds(): HoldEntry[] {
    return this.safety.readHolds();
  }

  /**
   * True while routine work must wait: a text is unread, or a safety hold is not released. A text not handed on yet whose
   * read never started (no safety row) counts as unread, as it does for the batch (T-248 security note d).
   */
  routineHeld(): boolean {
    return this.safety.routineHeld() || this.withoutSafetyRow(this.batch.pendingEventIds());
  }

  /**
   * Notes that the shared core released the hold with this id (K-09 releaseSafetyHold's holdId). Only a hold the core
   * recorded, named by its id, is released: an unread hold, or one the core has no id for yet, answers "noSuchHold". A
   * threat's is never released (A3-48) and answers "neverReleased". A released hold no longer binds a commit; it never kept
   * a batch back (holds bind commits, not hand-offs: DL-119), so nothing is handed on here.
   */
  markHoldReleased(holdId: string): "released" | "neverReleased" | "noSuchHold" {
    return this.safety.markHoldReleased(holdId);
  }

  /** Every batch the actor holds, in order: closed ones with how they closed and whether the lease has them, and the open one last. */
  readBatches(): BatchEntry[] {
    return this.batch.read();
  }

  /** Every turn the lease has opened, in order, with its state and, while it holds the lease, when the lease lapses. */
  readTurns(): TurnEntry[] {
    return this.lease.read();
  }

  /** The batch ids the lease has taken that wait for the next turn. */
  readWaitingBatches(): number[] {
    return this.lease.waiting();
  }

  /** The bundle pinned for each turn id, in the order the pins were taken (T-249). */
  readPins(): PinEntry[] {
    return this.pins.read();
  }

  /**
   * True when one of these texts has not been read yet, so the batch that holds it waits (CQ-65 as DL-119 replaced it:
   * holds bind commits, not hand-offs): its read is running, was never wired, or gave no verdict yet (the safety read's
   * `unreadAmong`), or it never started (no safety row: T-247 security note d, fail closed). An outcome hold keeps nothing
   * back: the turn carries it to its commit (lease.ts).
   */
  private unreadAmong(eventIds: readonly string[]): boolean {
    return this.safety.unreadAmong(eventIds) || this.withoutSafetyRow(eventIds);
  }

  /**
   * True when one of these texts is one the safety read reads but has no safety row: its read never started (the read's
   * start failed after the text was stored). Routine work waits, as for a text still unread (T-247 security note d).
   */
  private withoutSafetyRow(eventIds: readonly string[]): boolean {
    return this.missingSafetyRows(eventIds).length > 0;
  }

  /** The texts among these that the safety read reads but that have no safety row (their read never started), in arrival order. */
  private missingSafetyRows(eventIds: readonly string[]): string[] {
    const missing = this.safety.withoutSafetyRow(eventIds);
    if (missing.length === 0) return [];
    return readInboxEvents(this.ctx.storage.sql, missing)
      .filter((entry) => isReadableEvent(entry.event))
      .map((entry) => entry.event.eventId);
  }

  /**
   * The handle's texts not read yet, by event id in arrival order (CommitContext.unread; QUESTIONS.md CQ-65's addendum,
   * DL-127): being read, never wired, given up with no hold open (the safety read's own), or waiting with no safety row (its
   * read never started). T-252's gate counts each as an open hold; a text under an open unread hold is among the holds.
   */
  private unreadTexts(): string[] {
    const unread = new Set([
      ...this.safety.unreadTexts(),
      ...this.missingSafetyRows(this.batch.pendingEventIds()),
    ]);
    if (unread.size === 0) return [];
    const inOrder = readInboxEvents(this.ctx.storage.sql, [...unread]).map((entry) => entry.event.eventId);
    // A text the inbox does not hold cannot be put in order; it is named all the same (fails closed).
    return [...inOrder, ...[...unread].filter((eventId) => !inOrder.includes(eventId))];
  }

  /**
   * The trace a park goes on (T-253): the turn's first text's trace id (CQ-06), under the bundle pinned for the turn id
   * (T-249), or the one its first text arrived under when no run was ever pinned; null when neither is known (the park is
   * then tried again later). A trace that cannot be opened is null too. Nothing is recorded here.
   */
  private parkTrace(request: ParkTraceRequest): { bundleId: BundleId; trace: TraceContext } | null {
    const pinned = this.pins.read().find((entry) => entry.turnId === request.turnId)?.bundleId;
    const bundleId = pinned ?? request.arrivedUnder;
    if (bundleId === null) return null;
    try {
      const trace = openTrace({
        openedBy: "textWebhook",
        bundleId,
        incomingTraceId: request.traceId,
        sink: logSink({ environment: this.env.ENVIRONMENT, version: this.env.GIT_SHA ?? "unknown" }),
        now: () => actorClock().now(),
      });
      trace.setTurn(request.turnId);
      trace.listJoined(request.joinedTraceIds);
      return { bundleId, trace };
    } catch {
      return null;
    }
  }

  /** Resolves when the batch work started so far is done (tests). */
  async batchIdle(): Promise<void> {
    while (this.batchWork.size > 0) await Promise.all([...this.batchWork]);
  }

  /**
   * The settle path of a text's safety work, on arrival or resumed after an eviction (T-248's handoff): danger closes the
   * open batch at once, and the end of the read may let a waiting batch go to the lease.
   */
  private settleAfter(eventId: string, safe: Promise<void>): void {
    this.lend(
      safe
        .then(() => {
          this.batch.afterSafety(eventId);
        })
        .then(() => this.settleBatch()),
    );
    this.ctx.waitUntil(safe);
  }

  /** Hands what is ready to the lease and sets the alarm for what is still waiting (a read still running included). */
  private async settleBatch(): Promise<void> {
    this.syncSafetySchedule();
    await this.batch.release();
    await this.batch.arm();
  }

  /**
   * Resumes every safety read an eviction cut off (T-1088), in arrival order, each through the settle path; starts the
   * re-read of every text whose unread hold is open and whose re-read is due (DL-127: its answer is dealt with through
   * `afterLate`); and sets the safety alarm for what is left. Nothing is read while the safety read is not wired.
   */
  private resumeSafety(): void {
    for (const resumed of this.safety.resumeCutOff()) this.settleAfter(resumed.eventId, resumed.work);
    this.safety.rereadDue();
    this.syncSafetySchedule();
  }

  /**
   * `resumeSafety` for the constructor and the alarm, which go on whatever it does (T-1088 security note c): on a throw
   * (the inbox or the safety clock failed) the safety entry is moved 30 s on, so the work is looked at again then and the
   * alarm never comes straight back to the same failure.
   */
  private resumeSafetyGuarded(): void {
    try {
      this.resumeSafety();
    } catch {
      try {
        scheduleEntry(this.ctx.storage.sql, SCHEDULE_SAFETY, actorClock().now() + REREAD_MS);
      } catch {
        // The storage itself failed: the platform runs the alarm again.
      }
    }
  }

  /**
   * Keeps the safety entry of the stored schedule in step with the safety read (`nextWakeIn`): at the earliest 4 s deadline
   * of a text still being read, so an actor evicted mid-read is woken to resume it; while a text's work runs past its
   * deadline, in 1 s until its line's 5 s budget is spent and every 30 s after; at the next re-read of a text whose unread
   * hold is open (every 30 s until a verdict lands). None when nothing is left, or when nothing is wired to read (then
   * nothing could be read, and no alarm keeps firing for it). The time left is counted on the safety read's clock and set
   * on the schedule's. When the safety read cannot say (its clock or storage failed), it is looked at again in 30 s.
   */
  private syncSafetySchedule(): void {
    const sql = this.ctx.storage.sql;
    let left: number | null;
    try {
      left = this.safety.nextWakeIn();
    } catch {
      left = REREAD_MS;
    }
    if (left === null) {
      unscheduleEntry(sql, SCHEDULE_SAFETY);
      return;
    }
    scheduleEntry(sql, SCHEDULE_SAFETY, actorClock().now() + Math.max(0, left));
  }

  private lend(work: Promise<void>): void {
    const tracked = work.catch(() => undefined);
    this.batchWork.add(tracked);
    void tracked.finally(() => this.batchWork.delete(tracked));
    this.ctx.waitUntil(tracked);
  }

  private seqOf(eventId: string): number {
    const row = this.ctx.storage.sql
      .exec<{ seq: number }>("SELECT seq FROM inbox WHERE event_id = ?", eventId)
      .one();
    return row.seq;
  }

  /**
   * Replays the write-on-return queue (T-269): what the actor sent by itself while PostgreSQL was down is written to the
   * shared core, danger first, then stops, then the rest, each in the order queued and each once; a write the core is not
   * answering yet for stops the replay there. T-270 calls it when PostgreSQL is back.
   */
  writeOnReturn(): Promise<ReplayReport> {
    return this.returns.replay((write) => this.replayWrite(write));
  }

  /** Replays the write-on-return queue and says how many writes the shared core took (T-246's name, kept). */
  async writeSafetyOnReturn(): Promise<number> {
    return (await this.writeOnReturn()).written;
  }

  /** The actor's own copies and its queued writes, as labels and sealed values only (T-269). */
  readCopies(): CopiesView {
    return {
      stopped: this.copies.readStopped(),
      lines: this.copies.readLines(),
      timers: this.copies.readTimers(),
      timersStale: this.copies.timersStale(),
      returns: this.returns.read(),
    };
  }

  /** The PostgreSQL-down path's state, as labels and times only (T-270). */
  readOutage(): OutageView {
    return this.outage.read();
  }

  /** Resolves when the PostgreSQL-down path's work started so far is done (tests). */
  outageIdle(): Promise<void> {
    return this.outage.idle();
  }

  /**
   * Sends one queued write: the safety read's records through the safety read, a STOP or START the actor took while
   * PostgreSQL was down through the down path (T-270). A write of any other call waits, and nothing queued after it goes
   * before it.
   */
  private replayWrite(write: QueuedWrite): Promise<ReplayStep> {
    if (SAFETY_RETURN_CALLS.includes(write.call)) return this.safety.replayOnReturn(write);
    if (write.call === STOP_OR_START_CALL) return this.outage.replayStopOrStart(write);
    return Promise.resolve("notBack");
  }

  /**
   * The batch window's hand-off to the lease (T-270): kept back (as for no turn able to run, so the batch stays stored, in
   * order) while PostgreSQL is known down or one of its texts is a STOP or START not decided on; otherwise taken, without
   * the STOP and START texts the actor took while it was down.
   */
  private async handOff(batch: ClosedBatch): Promise<"taken" | "unwired"> {
    const kept = this.outage.handOff(batch);
    if (kept === null) return "unwired";
    return this.lease.take(kept);
  }

  /** Pins a run's bundle (T-249), and copies its keyword list and stop and start replies (T-270); a copy that fails changes nothing. */
  private async pinAndCopy(request: PinRequest, signal: AbortSignal): Promise<TurnPin | null> {
    const pinned = await this.pins.pin(request, signal);
    if (pinned !== null) {
      try {
        this.copies.refreshKeywords(pinned.bundle.manifest);
      } catch {
        // The copy keeps the list it had.
      }
    }
    return pinned;
  }

  /** PostgreSQL is back and the queue's danger and stop writes are in (T-270): the held turn runs again, then the batches go on. */
  private async resumeAfterOutage(): Promise<void> {
    await this.lease.resume();
    await this.batch.release();
    await this.batch.arm();
  }

  /**
   * A commit came back committed (T-269; the lease calls this before the run that sent it is answered): the stopped flag a
   * STOP or START wrote is copied at once, so it is set before that turn's reply can go; a commit that may have written a
   * safety timer row, or any commit while the timers' copy is stale, reloads the handle's live timers (named by the turn's
   * K-04 handle id), as work lent to the platform. The lease's own `repeated` goes with the answer (T-1204): K-05's
   * commitResult has no flag of its own, and a repeat reloads whatever the answer's shape, since its first answer, maybe
   * lost, named the rows. While a lost commit's stopped flag is still not read after this commit's own write of it, if any
   * (T-1206), the flag is read again.
   */
  private afterCommit(turn: CommitTurnRef, answer: CommitTurnCommitted): void {
    const read = readCommit(answer.committed, { repeated: answer.repeated });
    if (read.stopped !== null) this.copies.noteStopped({ ...read.stopped, turnId: turn.id });
    // A lost commit's stopped flag still not read (T-1206; a write copied here lets it go): this commit's handle id reads it.
    if (this.copies.stoppedUnread()) this.rereadStopped(turn.handleId);
    if (read.timersWritten || this.copies.timersStale()) this.reloadTimers(turn.handleId);
  }

  /**
   * A commit went through with its answer lost (T-1206; the lease calls this before the turn finishes, so before the next
   * turn opens): the copies cannot read what it wrote, a STOP or START or a safety timer row. So, at once, the stopped flag
   * reads stopped (the stricter reading) and the timers' copy is marked stale, which hold if nothing more can be done
   * (no handle id, an eviction); then, as work lent to the platform, the flag is read again from the handle's phone row and
   * the live timers are reloaded, named by the handle id the turn's last commit named. A read that fails leaves its mark,
   * and each later commit tries it again.
   */
  private afterLostCommit(lost: LostCommit): void {
    this.copies.noteLostCommit(lost.turnId);
    this.copies.markTimersStale();
    if (lost.handleId === null) return;
    this.rereadStopped(lost.handleId);
    this.reloadTimers(lost.handleId);
  }

  /** Reads the handle's stopped flag again (T-1206), as work lent to the platform; it never throws. */
  private rereadStopped(handleId: string): void {
    this.lend(this.copies.rereadStopped(handleId).then(() => undefined));
  }

  /** Reloads the handle's live timers, as work lent to the platform; the PostgreSQL-down path's alarm follows (T-270). */
  private reloadTimers(handleId: string): void {
    this.lend(
      this.copies.refreshTimers(handleId).then(() => {
        this.outage.timersChanged();
      }),
    );
  }

  /**
   * Copies the checked safety lines from the safety read's bundle, as they are now (T-269: refreshed on every write). A
   * failure keeps the copy as it was: the next text refreshes it.
   */
  private refreshLines(): void {
    try {
      this.copies.refreshLines(this.safety.checkedLines());
    } catch {
      // The copy keeps the lines it had.
    }
  }

  /** Resolves when the safety work of every text that has arrived is done (tests). */
  safetyIdle(): Promise<void> {
    return this.safety.idle();
  }

  private async passReceipt(handoff: SealedHandoff): Promise<StoreAnswer> {
    const { event } = handoff;
    if (markReceiptSeen(this.ctx.storage, event.eventId) === "duplicate") return "duplicate";
    const receipt: ReceiptHandoff = {
      event,
      partKey: handoff.partKey,
      traceId: handoff.traceId,
      bundleId: handoff.bundleId,
    };
    try {
      await receiptHooks.toDispatcher(receipt);
      await receiptHooks.toClockArming(receipt);
    } catch (error) {
      unmarkReceipt(this.ctx.storage, event.eventId);
      throw error;
    }
    return "written";
  }

  /**
   * One K-08 `receive` span for the actor's part of the hop, on the actor's clock: `at` is `started`, read as the
   * call began, and `ms` runs from then to its answer. A span the contract refuses is not logged and changes nothing.
   */
  private recordSpan(
    handoff: SealedHandoff,
    route: "inbox" | "receipt",
    answer: StoreAnswer,
    started: number,
  ): void {
    try {
      const ms = Math.max(0, actorClock().now() - started);
      const sink: SpanSink = logSink({
        environment: this.env.ENVIRONMENT,
        version: this.env.GIT_SHA ?? "unknown",
      });
      const context = openTrace({
        openedBy: "textWebhook",
        bundleId: handoff.bundleId,
        incomingTraceId: handoff.traceId,
        sink,
      });
      const eventId = handoff.event.eventId;
      const stored = answer === "written" && route === "inbox";
      context.record({
        hop: "receive",
        at: new Date(started).toISOString(),
        ms,
        outcome: answer === "duplicate" ? "dropped" : "ok",
        provider: "linq",
        ...(isLabel(eventId) ? { eventId } : {}),
        got: { door: "handleActor", route, kind: handoff.event.kind },
        decided: {
          stored: stored,
          startsTurn: stored && startsTurn(handoff.event),
        },
      });
    } catch {
      // No span for this call; the answer stands.
    }
  }
}
