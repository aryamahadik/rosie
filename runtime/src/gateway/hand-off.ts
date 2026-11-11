// From a verified event to the door that stores it (T-243; C-044), in this order and no other:
//   1. check the event's shape and pick its door (K-06 README "Routing");
//   2. scrub the words (T-242, runtime/src/scrub: K-06 v1.1's card number and Social Security number rule), timed and
//      counted for K-08's scrub span (T-1096; the caller writes it, see linq-webhook.ts);
//   3. for the handle's actor only: seal the scrubbed words under the handle's key. A text that opens its number's chat
//      (./chat-open.ts: a text or photo a phone handle sends through Linq) asks the key call for the handle's K-04 id too,
//      where the key store gives one (K-05 v1.2 handleSealingKey's handleId), so the caller can open the chat with it
//      before the actor is reached (T-1213; K-05 v1.7 item 46).
// Nothing is written here, and nothing is written before the signature is verified (the caller verifies first). The
// actor receives a `SealedHandoff` and so never an unscrubbed or an unsealed body; a receipt, which has no words, goes
// scrubbed to the dispatcher's door.

import { scrubInbound } from "../scrub/scrub";
import { opensChat } from "./chat-open";
import { actorNameOf, sealWords, type SealingKey, type SealingKeyStore } from "./seal";
import type { ActorHandoff, InboundEvent, SealedEvent, SealedHandoff } from "./types";
import type { BundleId } from "../trace";

/** K-06 kinds that go to the handle's actor, in order (K-06 README "Routing"). */
export const ACTOR_KINDS: readonly string[] = [
  "text",
  "photo",
  "reaction",
  "pollVote",
  "voteRemoved",
  "edit",
];

/** K-06 kinds that go to the dispatcher and to clock arming. */
export const RECEIPT_KINDS: readonly string[] = ["delivered", "sent", "failed"];

/** A hand-off that cannot be built; `code` is a label for the span, and the message never holds words. */
export class HandoffError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "HandoffError";
    this.code = code;
  }
}

/**
 * What the scrub did to one event, for K-08 v1's scrub span (T-1096): when it started, how long it took, and how many
 * card numbers and Social Security numbers it swapped for a tag in the event's words (its body and an email's subject).
 * Times and counts only: never a word, and never a digit of a number it swapped.
 */
export interface ScrubDone {
  /** When the scrub started, in epoch milliseconds on the caller's clock. */
  readonly startedAt: number;
  /** How long it took, in whole milliseconds. */
  readonly ms: number;
  /** Card numbers this scrub swapped for K-06's tag (a tag already in the words is not counted again). */
  readonly cards: number;
  /** Social Security numbers this scrub swapped for K-06's tag. */
  readonly ssns: number;
}

export type Prepared =
  | {
      door: "actor";
      handoff: SealedHandoff;
      scrub: ScrubDone;
      /**
       * The handle's K-04 id, as the key call answered it for a text that opens its number's chat (./chat-open.ts); null
       * for every other event, and where the key store gives no id.
       */
      handleId: string | null;
    }
  | { door: "receipts"; handoff: ActorHandoff; scrub: ScrubDone };

export interface PrepareInput {
  event: InboundEvent;
  partKey: string | null;
  traceId: string;
  bundleId: BundleId;
  /** Epoch milliseconds, for the scrub's timing; Date.now when left out. */
  now?: () => number;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The words of an event: its body and an email's subject; null where there are none. A wrong type is refused. */
function wordsOf(event: InboundEvent): { body: string | null; subject: string | null } {
  const body = event.body ?? null;
  if (body !== null && typeof body !== "string") throw new HandoffError("badEvent");
  const email = event.email ?? null;
  if (email === null) return { body, subject: null };
  if (!isRecord(email)) throw new HandoffError("badEvent");
  const subject = email.subject ?? null;
  if (subject !== null && typeof subject !== "string") throw new HandoffError("badEvent");
  return { body, subject };
}

function countOf(scrubbed: unknown, field: "cards" | "ssns"): number {
  if (!isRecord(scrubbed)) return 0;
  const value = scrubbed[field];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * The event with its words scrubbed and `scrubbed`'s counts raised by what was swapped (a body already tagged keeps its
 * count), with how many of each this scrub swapped.
 */
function scrubbedEvent(event: InboundEvent): { event: InboundEvent; cards: number; ssns: number } {
  const words = wordsOf(event);
  const result = scrubInbound(words);
  const email = event.email ?? null;
  return {
    event: {
      ...event,
      body: result.body,
      scrubbed: {
        cards: countOf(event.scrubbed, "cards") + result.cards,
        ssns: countOf(event.scrubbed, "ssns") + result.ssns,
      },
      ...(isRecord(email) ? { email: { ...email, subject: result.subject ?? "" } } : {}),
    },
    cards: result.cards,
    ssns: result.ssns,
  };
}

/** The scrubbed event with the words taken out: no `body`, no `email.subject`, and `sealed` where they went. */
function withoutWords(event: InboundEvent, sealed: SealedEvent["sealed"]): SealedEvent {
  const kept = Object.fromEntries(Object.entries(event).filter(([field]) => field !== "body"));
  const email = event.email ?? null;
  const rest = isRecord(email)
    ? { email: Object.fromEntries(Object.entries(email).filter(([field]) => field !== "subject")) }
    : {};
  return { ...kept, ...rest, sealed } as SealedEvent;
}

/**
 * The handle's key, and its K-04 id when the event opens its number's chat and the store gives one (one key call either
 * way); no key call for an event with no words that opens no chat.
 */
async function keyOf(
  keys: SealingKeyStore,
  handle: { kind: string; address: string },
  opens: boolean,
  hasWords: boolean,
): Promise<{ key: SealingKey | null; handleId: string | null }> {
  if (opens && keys.getOrCreateHandleKey !== undefined) {
    const found = await keys.getOrCreateHandleKey(handle);
    return { key: found.key, handleId: found.handleId };
  }
  if (!hasWords) return { key: null, handleId: null };
  return { key: await keys.getOrCreateKey(handle), handleId: null };
}

/**
 * Builds the hand-off for a verified event, with what its scrub did (`scrub`, for K-08's scrub span) and, for a text that
 * opens its number's chat, the handle's K-04 id the key call answered. Throws `HandoffError` for an event it cannot route
 * or read, and whatever the key store or WebCrypto throws for a seal that fails; the caller answers 503 for each, with
 * nothing written.
 */
export async function prepareHandoff(input: PrepareInput, keys: SealingKeyStore): Promise<Prepared> {
  const { event, partKey, traceId, bundleId } = input;
  const now = input.now ?? Date.now;
  const handle = event.handle as unknown;
  if (!isRecord(handle) || !isText(handle.kind) || !isText(handle.address)) {
    throw new HandoffError("badEvent");
  }
  const toActor = ACTOR_KINDS.includes(event.kind);
  if (!toActor && !RECEIPT_KINDS.includes(event.kind)) throw new HandoffError("unroutable");

  const startedAt = now();
  const swapped = scrubbedEvent(event);
  const scrub: ScrubDone = {
    startedAt,
    ms: Math.max(0, Math.round(now() - startedAt)),
    cards: swapped.cards,
    ssns: swapped.ssns,
  };
  const scrubbed = swapped.event;
  if (!toActor) {
    return { door: "receipts", handoff: { event: scrubbed, partKey, traceId, bundleId }, scrub };
  }

  const actorName = actorNameOf({ kind: handle.kind, address: handle.address });
  const words = wordsOf(scrubbed);
  const hasWords = words.body !== null || words.subject !== null;
  const { key, handleId } = await keyOf(
    keys,
    { kind: handle.kind, address: handle.address },
    opensChat(event),
    hasWords,
  );
  let sealed: SealedEvent["sealed"] = null;
  if (hasWords && key !== null) {
    sealed = await sealWords(words, key, actorName, event.eventId);
  }
  return {
    door: "actor",
    handoff: { event: withoutWords(scrubbed, sealed), partKey, traceId, bundleId, actorName },
    scrub,
    handleId,
  };
}
