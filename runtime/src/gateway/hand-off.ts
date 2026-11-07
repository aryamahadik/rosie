// From a verified event to the door that stores it (T-243; C-044), in this order and no other:
//   1. check the event's shape and pick its door (K-06 README "Routing");
//   2. scrub the words (T-242, runtime/src/scrub: K-06 v1.1's card number and Social Security number rule);
//   3. for the handle's actor only: seal the scrubbed words under the handle's key.
// Nothing is written here, and nothing is written before the signature is verified (the caller verifies first). The
// actor receives a `SealedHandoff` and so never an unscrubbed or an unsealed body; a receipt, which has no words, goes
// scrubbed to the dispatcher's door.

import { scrubInbound } from "../scrub/scrub";
import { actorNameOf, sealWords, type SealingKeyStore } from "./seal";
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

export type Prepared =
  { door: "actor"; handoff: SealedHandoff } | { door: "receipts"; handoff: ActorHandoff };

export interface PrepareInput {
  event: InboundEvent;
  partKey: string | null;
  traceId: string;
  bundleId: BundleId;
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

/** The event with its words scrubbed and `scrubbed`'s counts raised by what was swapped (a body already tagged keeps its count). */
function scrubbedEvent(event: InboundEvent): InboundEvent {
  const words = wordsOf(event);
  const result = scrubInbound(words);
  const email = event.email ?? null;
  return {
    ...event,
    body: result.body,
    scrubbed: {
      cards: countOf(event.scrubbed, "cards") + result.cards,
      ssns: countOf(event.scrubbed, "ssns") + result.ssns,
    },
    ...(isRecord(email) ? { email: { ...email, subject: result.subject ?? "" } } : {}),
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
 * Builds the hand-off for a verified event. Throws `HandoffError` for an event it cannot route or read, and whatever
 * the key store or WebCrypto throws for a seal that fails; the caller answers 503 for each, with nothing written.
 */
export async function prepareHandoff(input: PrepareInput, keys: SealingKeyStore): Promise<Prepared> {
  const { event, partKey, traceId, bundleId } = input;
  const handle = event.handle as unknown;
  if (!isRecord(handle) || !isText(handle.kind) || !isText(handle.address)) {
    throw new HandoffError("badEvent");
  }
  const toActor = ACTOR_KINDS.includes(event.kind);
  if (!toActor && !RECEIPT_KINDS.includes(event.kind)) throw new HandoffError("unroutable");

  const scrubbed = scrubbedEvent(event);
  if (!toActor) {
    return { door: "receipts", handoff: { event: scrubbed, partKey, traceId, bundleId } };
  }

  const actorName = actorNameOf({ kind: handle.kind, address: handle.address });
  const words = wordsOf(scrubbed);
  let sealed: SealedEvent["sealed"] = null;
  if (words.body !== null || words.subject !== null) {
    const key = await keys.getOrCreateKey({ kind: handle.kind, address: handle.address });
    sealed = await sealWords(words, key, actorName, event.eventId);
  }
  return {
    door: "actor",
    handoff: { event: withoutWords(scrubbed, sealed), partKey, traceId, bundleId, actorName },
  };
}
