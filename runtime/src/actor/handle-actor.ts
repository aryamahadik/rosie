// The handle actor (T-244; C-046, C-030, C-184): one Durable Object per handle, named `actorNameOf(handle)`, which the
// gateway's door (runtime/src/gateway/actor-door.ts) reaches with `accept`. It keeps the handle's ordered inbox of
// sealed events in its own storage (inbox.ts), drops a known event id, starts no turn for Rosie's own reaction, and
// sends a receipt that reaches it to the receipt hooks, never to the inbox. Each raw text goes to the safety read on
// arrival (T-246, ../safety), then into the batch window (T-247, batch.ts), whose closed batches go to the turn lease
// (T-248, lease.ts) once each of their texts has been read; the open safety holds go with the turn to its commit
// (QUESTIONS.md CQ-65 as DL-119 replaced it: holds bind commits, not hand-offs). Each run of a turn pins its bundle first
// (T-249, ../bundle).
//
// A safety read lives in memory, so the actor keeps a stored alarm at each read's 4 s deadline (T-1088): if the actor is
// evicted mid-read (a deploy, a reset), the alarm brings a new instance, which resumes every read cut off, in arrival
// order, the moment it starts (any request or alarm starts it); a resumed read ends through the same settle path as one
// on arrival, so its batch is handed on and its danger closes the open batch. The same alarm brings back every text
// whose unread hold is open (no verdict in 4 s, the outage line sent) for its re-read every 30 s until a verdict lands
// (DL-127), so a late answer lost with an evicted instance cannot leave a text unread and held for good.
//
// Not here: what runs inside a turn (T-251, T-252), edits and vote changes after a commit (T-245). The actor never opens
// a sealed box. Never logged: a word, a phone number, a key, a sealed body.

import { DurableObject } from "cloudflare:workers";

import { BundlePins, bundleKvOf, type PinEntry } from "../bundle";
import { RECEIPT_KINDS, ACTOR_KINDS } from "../gateway/hand-off";
import type { SealedEvent, SealedHandoff, StoreAnswer } from "../gateway/types";
import {
  REREAD_MS,
  SafetyOnArrival,
  isReadable,
  isReadableEvent,
  type HoldEntry,
  type SafetyEntry,
} from "../safety";
import { isLabel, logSink, openTrace, type BundleId, type SpanSink } from "../trace";
import {
  actorClock,
  BatchWindow,
  scheduleEntry,
  SCHEDULE_SAFETY,
  unscheduleEntry,
  type BatchEntry,
} from "./batch";
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
import { TurnLease, type TurnEntry } from "./lease";

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
  private readonly batchWork = new Set<Promise<void>>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    createInboxTables(ctx.storage.sql);
    this.safety = new SafetyOnArrival({
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
      lease: (batch) => this.lease.take(batch),
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
      pin: (request, signal) => this.pins.pin(request, signal),
      holds: () => this.safety.openHolds(),
      unread: () => this.unreadTexts(),
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
   * cut-off read, a re-read; then a lapsed lease; the batch close; a batch's hand-off). A throw in the safety part never
   * keeps the lease and batch handlers from running.
   */
  override async alarm(): Promise<void> {
    this.resumeSafetyGuarded();
    await this.lease.onAlarm();
    await this.batch.onAlarm();
  }

  /**
   * The gateway's one call. "written": the event is stored (or, for a receipt, passed to the hooks). "duplicate": its
   * event id was known and nothing changed. A throw means nothing was kept: the gateway answers 503.
   */
  async accept(handoff: SealedHandoff): Promise<StoreAnswer> {
    const started = Date.now();
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
      if (answer === "written") await this.batch.arm();
    } else {
      answer = await this.passReceipt(handoff);
    }
    this.recordSpan(handoff, route, answer, Date.now() - started);
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

  /** Writes to the shared core what the actor sent straight through Linq while PostgreSQL was down; returns how many. */
  writeSafetyOnReturn(): Promise<number> {
    return this.safety.writeOnReturn();
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

  /** One K-08 `receive` span for the actor's part of the hop; a span the contract refuses is not logged and changes nothing. */
  private recordSpan(
    handoff: SealedHandoff,
    route: "inbox" | "receipt",
    answer: StoreAnswer,
    ms: number,
  ): void {
    try {
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
