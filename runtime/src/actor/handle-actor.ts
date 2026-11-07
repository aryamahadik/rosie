// The handle actor (T-244; C-046, C-030, C-184): one Durable Object per handle, named `actorNameOf(handle)`, which the
// gateway's door (runtime/src/gateway/actor-door.ts) reaches with `accept`. It keeps the handle's ordered inbox of
// sealed events in its own storage (inbox.ts), drops a known event id, starts no turn for Rosie's own reaction, and
// sends a receipt that reaches it to the receipt hooks, never to the inbox.
//
// Not here: the safety read on arrival (T-246), batching (T-247), the lease (T-248), edits and vote changes after a
// commit (T-245). The actor never opens a sealed box. Never logged: a word, a phone number, a key, a sealed body.

import { DurableObject } from "cloudflare:workers";

import { RECEIPT_KINDS, ACTOR_KINDS } from "../gateway/hand-off";
import type { SealedEvent, SealedHandoff, StoreAnswer } from "../gateway/types";
import { isLabel, logSink, openTrace, type BundleId, type SpanSink } from "../trace";
import {
  createInboxTables,
  markReceiptSeen,
  readInbox,
  startsTurn,
  unmarkReceipt,
  writeToInbox,
  type InboxEntry,
} from "./inbox";

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
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    createInboxTables(ctx.storage.sql);
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
      answer = writeToInbox(this.ctx.storage, handoff);
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
