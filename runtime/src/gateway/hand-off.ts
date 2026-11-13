// From a verified event to the door that stores it (T-243; C-044), in this order and no other:
//   1. check the event's shape and pick its door (K-06 README "Routing");
//   2. scrub the words (T-242, runtime/src/scrub: K-06 v1.1's card number and Social Security number rule; K-06 v1.2's
//      `scrubbedV1dot2` reads a poll's option words as the body, T-1297), timed and counted for K-08's scrub span (T-1096;
//      the caller writes it, see linq-webhook.ts);
//   3. for the handle's actor only: seal the scrubbed words, the body, an email's subject and a poll's option words, in
//      one box of form 2 under the handle's key, and take them out of the event (K-06 v1.2 "The sealed hand-off", items 1
//      to 3: the actor is handed `#/$defs/sealedEvent`). A text that opens its number's chat (./chat-open.ts: a text or
//      photo a phone handle sends through Linq) asks the key call for the handle's K-04 id too, where the key store gives
//      one (K-05 v1.2 handleSealingKey's handleId), so the caller can open the chat with it before the actor is reached
//      (T-1213; K-05 v1.7 item 46).
// Nothing is written here, and nothing is written before the signature is verified (the caller verifies first). The
// actor receives a `SealedHandoff` and so never an unscrubbed or an unsealed word: no body, no subject and no option
// words in the clear (CQ-58; RULES 4.5 line 199). A receipt, which has no words, goes scrubbed to the dispatcher's door.

import { scrub as scrubText, scrubInbound } from "../scrub/scrub";
import { opensChat } from "./chat-open";
import { actorNameOf, sealEventWords, type EventWords, type SealingKey, type SealingKeyStore } from "./seal";
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
 * card numbers and Social Security numbers it swapped for a tag in the event's words (its body, an email's subject and a
 * poll's option words: K-06 v1.2 default 5). Times and counts only: never a word, and never a digit of a number it
 * swapped.
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

/** A text field of a K-06 object (`body`, `subject`, `optionWords`): null where there is none; a wrong type is refused. */
function wordsAt(holder: Record<string, unknown>, field: string): string | null {
  const value = holder[field] ?? null;
  if (value !== null && typeof value !== "string") throw new HandoffError("badEvent");
  return value;
}

/** A K-06 object field that holds words (`email`, `poll`): null where there is none; one that is not an object is refused. */
function holderOf(event: InboundEvent, field: "email" | "poll"): Record<string, unknown> | null {
  const value = event[field] ?? null;
  if (value === null) return null;
  if (!isRecord(value)) throw new HandoffError("badEvent");
  return value;
}

/**
 * The words of an event: its body, an email's subject and a poll's option words (a vote's or a vote taken back's, Rosie's
 * option or one someone added: K-06 v1.2 default 1); null where there are none. A wrong type is refused.
 */
function wordsOf(event: InboundEvent): EventWords {
  const email = holderOf(event, "email");
  const poll = holderOf(event, "poll");
  return {
    body: wordsAt(event, "body"),
    subject: email === null ? null : wordsAt(email, "subject"),
    optionWords: poll === null ? null : wordsAt(poll, "optionWords"),
  };
}

function countOf(scrubbed: unknown, field: "cards" | "ssns"): number {
  if (!isRecord(scrubbed)) return 0;
  const value = scrubbed[field];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * The event with its words scrubbed (the option's words read as the body is: K-06 v1.2 `scrubbedV1dot2`) and `scrubbed`'s
 * counts raised by what was swapped in all three (a word already tagged keeps its count; v1.2 default 5), with how many of
 * each this scrub swapped.
 */
function scrubbedEvent(event: InboundEvent): { event: InboundEvent; cards: number; ssns: number } {
  const words = wordsOf(event);
  const result = scrubInbound({ body: words.body, subject: words.subject });
  const option = words.optionWords === null ? null : scrubText(words.optionWords);
  const cards = result.cards + (option?.cards ?? 0);
  const ssns = result.ssns + (option?.ssns ?? 0);
  const email = event.email ?? null;
  const poll = event.poll ?? null;
  return {
    event: {
      ...event,
      body: result.body,
      scrubbed: {
        cards: countOf(event.scrubbed, "cards") + cards,
        ssns: countOf(event.scrubbed, "ssns") + ssns,
      },
      ...(isRecord(email) ? { email: { ...email, subject: result.subject ?? "" } } : {}),
      ...(isRecord(poll) && option !== null ? { poll: { ...poll, optionWords: option.text } } : {}),
    },
    cards,
    ssns,
  };
}

/** A copy of a K-06 object without one field. */
function without(holder: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(holder).filter(([name]) => name !== field));
}

/**
 * The scrubbed event with every word taken out and `sealed` where they went (K-06 v1.2 sealedEvent): no `body`, an
 * email's `email` without its `subject` (sealedEmailReply), a vote's `poll` without its `optionWords` (sealedPoll).
 */
function withoutWords(event: InboundEvent, sealed: SealedEvent["sealed"]): SealedEvent {
  const email = event.email ?? null;
  const poll = event.poll ?? null;
  return {
    ...without(event, "body"),
    ...(isRecord(email) ? { email: without(email, "subject") } : {}),
    ...(isRecord(poll) ? { poll: without(poll, "optionWords") } : {}),
    sealed,
  } as SealedEvent;
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
  // Every kind with words gets a box: a text, a photo, an edit, an email reply, a vote and a vote taken back (item 2).
  const hasWords = words.body !== null || words.subject !== null || words.optionWords !== null;
  const { key, handleId } = await keyOf(
    keys,
    { kind: handle.kind, address: handle.address },
    opensChat(event),
    hasWords,
  );
  let sealed: SealedEvent["sealed"] = null;
  if (hasWords && key !== null) {
    sealed = await sealEventWords(words, key, actorName, event.eventId);
  }
  return {
    door: "actor",
    handoff: { event: withoutWords(scrubbed, sealed), partKey, traceId, bundleId, actorName },
    scrub,
    handleId,
  };
}
