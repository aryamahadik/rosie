// The Linq webhook entry (T-241; C-044; arch 02 step 1 "Receive", line 109).
//
// Answers: a body over its cap (T-1180; body.ts; GatewayDeps.linqBodyLimitBytes, LINQ_BODY_LIMIT_BYTES by default) 413,
// before the body is read whole, with nothing verified, written or handed on (a 4xx, so Linq does not send it again);
// a bad or stale signature 401, with nothing written or handed on; a signed event type Rosie does not use 200,
// handed on to no one; a known event id 200 and dropped; a failing scrub-seal-write (a key store that gives no key, a
// seal or a write that fails, an event it cannot route, a verify result it does not know, or a verifier that cannot
// answer) 503, so Linq retries for 30 minutes, with nothing stored; otherwise 200. After the verify the event is
// scrubbed, then (texts, photos, reactions, votes, edits) sealed and written to the handle's actor, or (receipts) handed
// scrubbed to the dispatcher's door (hand-off.ts). The trace id opens at receipt, one K-08 `receive` span ends every answer,
// and the answer carries x-trace-id. Never logged: a body, a phone number, the webhook secret. The answer rules it shares
// with the Stripe and calendar doors are answer.ts's.
//
// A number's chat opens at receipt (T-1213; K-05 v1.7 item 46; chat-open.ts): a text or photo a phone handle sends through
// Linq goes to K-05 openChatOnText after the key call and before the actor's door, once per webhook. Its answer decides:
// a result, the text goes on; notFound or notAPhone (or a call the gateway cannot make as K-05 takes it), the text is
// stored all the same, the refusal its receive span's error code; transient, or a port that throws, 503 with nothing
// stored (chatOpenTransient, chatOpenFailed), so Linq's retry, a repeat to K-05, comes again.
//
// The scrub span (K-08 v1 hop `scrub`, T-1096): an event its actor wrote ("Sealed event", 02-contracts section 11) shows
// its scrub as the trace's second hop, after receive, as trace-skeleton.json does. Receive ends only with the answer,
// so the scrub's own start and time are kept and its span is recorded right after receive's: receive is seq 1 and
// starts first, scrub is seq 2 and lies between receive's start and the hand-off (each takes its place before the
// hand-off, T-1108 below). It holds counts only (how many card numbers and Social Security numbers were swapped), never
// a word or a digit. Every other answer ends the trace at receive: a known event id is dropped at receipt with nothing
// after it (trace-duplicate-webhook.json), a receipt goes to the dispatcher's door with no words (its own trace is its
// receive), and a failure (503) or a refusal stores nothing.
//
// One receive span per inbound event, the gateway's, as K-08 states it (T-1108): written to its actor, it says
// `sealedToActor` (trace-skeleton.json); dropped as a known event id, it names the trace the event first arrived under
// (`firstTrace`, trace-duplicate-webhook.json), which the actor's door answers from the stored event. The trace is one run
// by seq whoever writes on it: receive takes place 1 as it starts and the scrub place 2 before the hand-off, which tells
// the actor how many places the gateway took (`seqBefore`), so the actor's writers go on from 3. Where a writer shares
// this isolate (a receipt's hooks), it takes its places from the trace's one count, which opens once the signature has
// passed (`shareSeq`), never for an unsigned request.

import { isLabel, type TraceContext } from "../trace";
import {
  labelFacts,
  logFailure,
  openWebhookTrace,
  readBundleId,
  respond,
  type Answer,
  type WebhookEnvironment,
} from "./answer";
import { LINQ_BODY_LIMIT_BYTES, bodyLimitOf, readCappedText } from "./body";
import { openChatAtReceipt, type ChatAtReceipt } from "./chat-open";
import { HandoffError, prepareHandoff, type Prepared, type ScrubDone } from "./hand-off";
import type { ActorStub, GatewayDeps, SealedHandoff, StoreAnswer, VerifyWebhookResult } from "./types";

// The webhook's headers by Linq's standard names (K-11 README spike row 2). The adapter's wire format is T-413's; these
// three names only fill K-11's request fields, and a missing one becomes "" (the schema's own rule for `signature`).
const HEADER_ID = "webhook-id";
const HEADER_TIMESTAMP = "webhook-timestamp";
const HEADER_SIGNATURE = "webhook-signature";

/**
 * Handles one Linq webhook POST. The unsigned request's own x-trace-id is not kept: a webhook comes from Linq, which
 * knows no Rosie trace, so the id is always new.
 */
export async function handleLinqWebhook(
  request: Request,
  deps: GatewayDeps,
  where: WebhookEnvironment,
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const bundleId = await readBundleId(deps);
  const context = openWebhookTrace(deps, bundleId, where, "textWebhook");
  // Receive takes the trace's first place as it starts (T-1108).
  const timing = context.start("receive");
  const receivedAt = new Date(now()).toISOString();

  let eventId: string | undefined;
  let got: Record<string, string> = {};
  let answer: Answer = { status: 503, error: "unavailable" };
  let outcome: "ok" | "dropped" | "refused" | "failed" = "failed";
  let decided: Record<string, boolean | number | string> = {};
  let errorCode: string | null = null;
  /** The scrub of an event its actor wrote: its span follows receive's. Undefined for every other answer. */
  let scrubbed: ScrubDone | undefined;
  /** The scrub span's place, taken before the hand-off to the actor (the scrub started before the actor's hops). */
  let scrubSeq: number | undefined;

  const fail = (status: 400 | 413 | 503, error: string, code: string): void => {
    answer = { status, error };
    outcome = status === 503 ? "failed" : "refused";
    errorCode = code;
  };

  // The body under its cap (body.ts): one over it is never read whole, and nothing of it is logged.
  const read = await readCappedText(request, bodyLimitOf(deps.linqBodyLimitBytes, LINQ_BODY_LIMIT_BYTES));

  if ("problem" in read) {
    if (read.problem === "tooLarge") {
      fail(413, "payload_too_large", "bodyTooLarge");
    } else {
      logFailure(context.traceId, "readBody", read.error);
      fail(400, "bad_request", "unreadableBody");
    }
  } else {
    const raw = read.text;
    let verified: VerifyWebhookResult | undefined;
    try {
      verified = await deps.linq.verifyWebhook({
        webhookId: request.headers.get(HEADER_ID) ?? "",
        timestamp: request.headers.get(HEADER_TIMESTAMP) ?? "",
        signature: request.headers.get(HEADER_SIGNATURE) ?? "",
        raw,
        receivedAt,
        traceId: context.traceId,
      });
    } catch (error) {
      logFailure(context.traceId, "verify", error);
    }

    if (verified === undefined) {
      fail(503, "unavailable", "verifyUnavailable");
    } else if (verified.result === "rejected") {
      answer = { status: 401, error: "unauthorized" };
      outcome = "refused";
      decided = { signatureValid: false, answered: 401 };
      errorCode = verified.reason;
    } else if (verified.result === "ignored") {
      answer = { status: 200 };
      outcome = "dropped";
      decided = { signatureValid: true, ignoredType: true, answered: 200 };
      got = { eventType: verified.eventType };
    } else if (isNotEvent(verified.result)) {
      // A K-11 minor version that adds a result is not handed on as an event: fail closed, never 200.
      fail(503, "unavailable", "unknownVerifyResult");
    } else if (typeof verified.event.eventId !== "string" || verified.event.eventId === "") {
      fail(503, "unavailable", "badVerifyAnswer");
    } else {
      const { event, partKey } = verified;
      eventId = event.eventId;
      got = { kind: event.kind, service: event.service };
      // Linq's own event: from here on the trace's writers share one count of places, after receive's (T-1108). Only a
      // signed event opens one, so a request anyone can send never takes room in this isolate's memory of counts.
      context.shareSeq();
      let prepared: Prepared | undefined;
      let stored: StoreAnswer | undefined;
      let handed: SealedHandoff | undefined;
      let chat: ChatAtReceipt = { kind: "none" };
      let stage = "prepare";
      let code = "handoffFailed";
      try {
        // Scrub, then seal (actor kinds), then write: the door never gets an unscrubbed or an unsealed body.
        prepared = await prepareHandoff(
          { event, partKey, traceId: context.traceId, bundleId, now },
          deps.keys,
        );
        if (prepared.door === "actor") {
          // The number's chat opens before its actor is reached, with the handle id the key call answered (chat-open.ts).
          stage = "chat";
          chat = await openChatAtReceipt(deps.chats, event, prepared.handleId);
        }
        if (chat.kind === "transient") {
          // Nothing was written: 503, so Linq sends it again, a repeat to K-05 by the text's event id.
          code = "chatOpenTransient";
        } else {
          stage = "handoff";
          if (prepared.door === "actor") {
            // The scrub's place is taken now, and the actor is told how many places the gateway took before it.
            scrubSeq = context.reserve();
            handed = { ...prepared.handoff, seqBefore: scrubSeq };
            stored = await deps.actor.accept(handed);
          } else {
            stored = await deps.receipts.accept(prepared.handoff);
          }
        }
      } catch (error) {
        logFailure(context.traceId, stage, error);
        if (stage === "prepare") code = error instanceof HandoffError ? error.code : "sealFailed";
        else if (stage === "chat") code = "chatOpenFailed";
      }
      // A refusal never keeps a text from its actor: the text was stored, and the refusal is the span's error code.
      const refused = chat.kind === "refused" ? chat.code : null;
      // 200 only for a positive answer of the door: anything else, an unknown word included, is 503.
      if (stored === "duplicate") {
        answer = { status: 200 };
        outcome = "dropped";
        // The trace the event first arrived under, from its actor's stored event (K-08 trace-duplicate-webhook.json).
        const firstTrace =
          handed === undefined ? null : await firstTraceOf(deps.actor, handed, context.traceId);
        decided = {
          signatureValid: true,
          knownEventId: true,
          ...(firstTrace === null ? {} : { firstTrace }),
          answered: 200,
        };
        errorCode = refused;
      } else if (stored === "written") {
        answer = { status: 200 };
        outcome = "ok";
        // Sealed and written to its actor (K-08 trace-skeleton.json); a receipt, which has no words, is not.
        decided =
          prepared?.door === "actor"
            ? { signatureValid: true, knownEventId: false, sealedToActor: true, answered: 200 }
            : { signatureValid: true, knownEventId: false, answered: 200 };
        errorCode = refused;
        if (prepared?.door === "actor") scrubbed = prepared.scrub;
      } else {
        decided = { signatureValid: true, answered: 503 };
        fail(503, "unavailable", code);
      }
    }
  }

  let received = false;
  try {
    timing.finish({
      outcome: outcome,
      provider: "linq",
      ...(eventId !== undefined && isLabel(eventId) ? { eventId } : {}),
      got: labelFacts(got),
      decided,
      errorCode,
    });
    received = true;
  } catch (error) {
    // A span the contract refuses is never logged; the answer does not change for it.
    logFailure(context.traceId, "span", error);
  }
  // Only after a kept receive span: a scrub span alone would stand first in a trace that has no receive.
  if (received && scrubbed !== undefined) recordScrub(context, scrubbed, eventId, scrubSeq);
  return respond(answer, context.traceId);
}

/**
 * The trace a known event first arrived under, as its actor's door answers it (T-1108): null when the door has no such
 * call, cannot answer, or answers something that is no label. The answer to the webhook never changes for it. The email
 * door asks it for a repeated reply too (./email).
 */
export async function firstTraceOf(
  actor: ActorStub,
  handoff: SealedHandoff,
  traceId: string,
): Promise<string | null> {
  if (actor.firstTrace === undefined) return null;
  try {
    const first = await actor.firstTrace(handoff);
    return isLabel(first) ? first : null;
  } catch (error) {
    logFailure(traceId, "firstTrace", error);
    return null;
  }
}

/**
 * Records K-08's scrub span for an event its actor wrote, after receive's: its own start and time, the event id, and
 * how many card numbers and Social Security numbers the scrub swapped (`cardNumbersTagged`, `ssnsTagged`, as
 * trace-skeleton.json names them). `seq` is its place when one was taken before the hand-off (T-1108); the next place
 * when left out. A span the contract refuses is never logged, and the answer does not change for it. The email door
 * writes a reply's scrub span through it too (T-265, ./email).
 */
export function recordScrub(
  context: TraceContext,
  scrub: ScrubDone,
  eventId: string | undefined,
  seq?: number,
): void {
  try {
    context.record({
      hop: "scrub",
      at: new Date(scrub.startedAt).toISOString(),
      ms: scrub.ms,
      outcome: "ok",
      ...(seq === undefined ? {} : { seq }),
      ...(eventId !== undefined && isLabel(eventId) ? { eventId } : {}),
      decided: { cardNumbersTagged: scrub.cards, ssnsTagged: scrub.ssns },
      errorCode: null,
    });
  } catch (error) {
    logFailure(context.traceId, "span", error);
  }
}

/** The positive check: the verify result is an event, by its own word. The type holds three results; a later one reads as not an event. */
function isNotEvent(result: string): boolean {
  return result !== "event";
}
