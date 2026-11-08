// The handle actor (T-244; C-046, C-030, C-184): one Durable Object per handle, named `actorNameOf(handle)`, which the
// gateway's door (runtime/src/gateway/actor-door.ts) reaches with `accept`. It keeps the handle's ordered inbox of
// sealed events in its own storage (inbox.ts), drops a known event id, starts no turn for Rosie's own reaction, and
// sends a receipt that reaches it to the receipt hooks, never to the inbox. Each raw text goes to the safety read on
// arrival (T-246, ../safety), then into the batch window (T-247, batch.ts), whose closed batches go to the turn lease
// (T-248, lease.ts) once no safety hold keeps them back.
//
// Not here: what runs inside a turn (T-251, T-252), edits and vote changes after a commit (T-245). The actor never opens
// a sealed box. Never logged: a word, a phone number, a key, a sealed body.

import { DurableObject } from "cloudflare:workers";

import { RECEIPT_KINDS, ACTOR_KINDS } from "../gateway/hand-off";
import type { SealedEvent, SealedHandoff, StoreAnswer } from "../gateway/types";
import { SafetyOnArrival, isReadable, isReadableEvent, type HoldEntry, type SafetyEntry } from "../safety";
import { isLabel, logSink, openTrace, type BundleId, type SpanSink } from "../trace";
import { BatchWindow, type BatchEntry } from "./batch";
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
  private readonly batchWork = new Set<Promise<void>>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    createInboxTables(ctx.storage.sql);
    this.safety = new SafetyOnArrival({
      storage: ctx.storage,
      spanSink: () => logSink({ environment: this.env.ENVIRONMENT, version: this.env.GIT_SHA ?? "unknown" }),
      // A late verdict: danger closes the open batch at once, and a lifted hold lets the waiting batches go on.
      afterLate: (eventId) => {
        this.lend(
          Promise.resolve()
            .then(() => {
              this.batch.afterSafety(eventId);
            })
            .then(() => this.settleBatch()),
        );
      },
    });
    this.batch = new BatchWindow({
      storage: ctx.storage,
      held: () => this.safety.routineHeld() || this.unreadInBatch(),
      isDanger: (eventId) =>
        this.safety.readSafety().some((entry) => entry.eventId === eventId && entry.danger),
      lease: (batch) => this.lease.take(batch),
    });
    this.lease = new TurnLease({
      storage: ctx.storage,
      arm: () => this.batch.arm(),
      lend: (work) => {
        this.lend(work);
      },
    });
    // After a restart the alarm is set again from the stored schedule, so a batch open at the restart still closes and a
    // lease that lapsed while the actor was gone still reruns its turn.
    ctx.waitUntil(this.batch.arm());
  }

  /** The Durable Object alarm: the stored schedule's due entries (a lapsed lease, the batch close, a batch's hand-off). */
  override async alarm(): Promise<void> {
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
      // begins now and the read is queued in arrival order. It runs on; the gateway is answered at once.
      if (answer === "written" && isReadable(handoff)) {
        const eventId = handoff.event.eventId;
        const safe = this.safety.arrive(handoff);
        // Danger closes the batch at once; each safety result may also let a held batch go to the lease.
        this.lend(
          safe
            .then(() => {
              this.batch.afterSafety(eventId);
            })
            .then(() => this.settleBatch()),
        );
        this.ctx.waitUntil(safe);
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

  /** True while routine work must wait: a text is unread, or a safety hold is not released. */
  routineHeld(): boolean {
    return this.safety.routineHeld();
  }

  /**
   * Notes that the shared core released the hold with this id (K-09 releaseSafetyHold's holdId). Only a hold the core
   * recorded, named by its id, is released: an unread hold, or one the core has no id for yet, answers "noSuchHold". A
   * threat's is never released (A3-48) and answers "neverReleased".
   */
  markHoldReleased(holdId: string): "released" | "neverReleased" | "noSuchHold" {
    const answer = this.safety.markHoldReleased(holdId);
    // A lifted hold lets the batches that waited for it go to the lease (nothing polls while they wait).
    if (answer === "released") this.lend(this.settleBatch());
    return answer;
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

  /**
   * True when a batched text the safety read reads has no safety row: its read never started (the read's start failed after
   * the text was stored). Routine work waits, as for a text still unread (T-247 security note d: fail closed).
   */
  private unreadInBatch(): boolean {
    const missing = this.safety.withoutSafetyRow(this.batch.pendingEventIds());
    if (missing.length === 0) return false;
    return readInboxEvents(this.ctx.storage.sql, missing).some((entry) => isReadableEvent(entry.event));
  }

  /** Resolves when the batch work started so far is done (tests). */
  async batchIdle(): Promise<void> {
    while (this.batchWork.size > 0) await Promise.all([...this.batchWork]);
  }

  /** Hands what is ready to the lease and sets the alarm for what is still waiting. */
  private async settleBatch(): Promise<void> {
    await this.batch.release();
    await this.batch.arm();
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
