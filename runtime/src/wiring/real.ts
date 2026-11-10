// The real implementation set (T-552 onwards; build prompt section 10, D-017 'Joins: one hop at a time, in the turn
// order'): what ./picks.ts calls "real", built by the root from what its environment holds. Each join adds its port here,
// in D-017's turn order (./ports.ts):
//
//   linqVerify   T-552: @rosie/adapters' Linq verify and parse (T-413, C-207; K-11 v1 verifyWebhook), fed by the Linq
//                double's signer (T-412): the webhook secret is read at each call from what the root is handed, the
//                Linq double's made-up test secret in a test and LINQ_WEBHOOK_SECRET by name in the Worker (K-11 README
//                default 1; set on staging by name, T-568; until J-08 it must be the secret the test-phone page's Linq
//                double signs with, which K-11 says is the test environment's, never Linq's). Where no secret is set the
//                call fails, so the gateway answers 503, verifies nothing and hands nothing on.
//   sealing      T-553: K-05 v1.2 handleSealingKey (T-220, db/repo/handle-keys.ts; item 29) with its database bound,
//                handed in by the root (RootOptions.handleKey): the K-05 double in a test; nothing in the Worker until
//                T-567 binds its database, so every seal there fails closed and the gateway answers 503. New ids on every
//                call, the wrapping key by its name (SEALING_WRAP_KEY), and the data key as the key object K-05 hands
//                over, never bytes (README default 27).
//   safetyRead   T-554: @rosie/ai's safety read (T-365 createSafetyReader, with T-366's danger-word rules; C-113) for
//                the bundle each text names, handed in by the root (RootOptions.safetyReaders): in a test, over a fake
//                Messages API answered by the recorded-model double (T-004); in the Worker, none until the bundle's
//                manifest (its two models and its safety read prompt) can be read there (the bundle reads join with
//                T-555; staging's BUNDLES binding is T-566) and the model key is set by name (J-02; smoke-size calls only,
//                DL-027), so every read there fails closed and the actor applies its no-verdict rule (T-246). Each read
//                gets the pinned bundle's danger words from the actor's own bundle port, and writes its model-call spans
//                into the text's trace.
//
// Worker code: no double, no fixture, no key, no network call. The secret is never kept, returned or logged: an error
// names the secret by its name only. A text's words go to the safety read only, never into a span, a log or an error.

import {
  createLinqWebhookVerifier,
  type ParseLookups,
  type VerifyWebhookResult as AdapterVerifyResult,
} from "@rosie/adapters/linq/webhook";
import type { SafetyReader } from "@rosie/ai/src/safety/types";
import type { HandleSealingKeyRequest, HandleSealingKeyResult } from "@rosie/db/repo/handle-keys";

import type { HandleRef } from "../gateway/seal";
import type { InboundEvent, LinqPort, VerifyWebhookResult } from "../gateway/types";
import type { DangerWordEntry, SafetyReadPort } from "../safety/types";
import { openTrace, type BundleId, type SpanSink } from "../trace";
import type { Ports } from "./ports";

/** The name the Worker reads the Linq webhook secret by (K-11 README default 1). */
export const LINQ_WEBHOOK_SECRET = "LINQ_WEBHOOK_SECRET";

/** A secret that is not set where it is read. The message names the secret, never a value. */
export class MissingSecretError extends Error {
  constructor(name: string) {
    super(`${name} is not set here`);
    this.name = "MissingSecretError";
  }
}

/**
 * What the real Linq verify is fed: the webhook secret, read at each call ("whsec_" and base64; undefined or "" where none
 * is set), and the adapter's lookups (T-413 ParseLookups): the person a receipt's chat belongs to, and a poll option's
 * words. Left out, a receipt cannot be parsed (the adapter fails it, so the gateway answers 503 and Linq retries) and a
 * vote's words stay "".
 */
export interface LinqVerifyInputs extends ParseLookups {
  readonly webhookSecret: () => string | undefined | Promise<string | undefined>;
}

/**
 * Where the real set reads its inputs: the Linq verify's (left out: no secret is set), K-05's key call (left out: no
 * database is bound) and the root's clock.
 */
export interface RealInputs {
  readonly linq?: LinqVerifyInputs | undefined;
  /**
   * K-05 v1.2 handleSealingKey with its database bound, which the sealing port asks for each handle's key; null or left
   * out where no database is bound (the Worker until T-567), so every seal fails closed.
   */
  readonly handleKey?: HandleSealingKeyCall | null | undefined;
  /** Epoch milliseconds: the adapter's clock for a request whose receipt time is not a time (the gateway always gives one). */
  readonly now: () => number;
  /**
   * What the safety read is fed (T-554): @rosie/ai's safety read for each bundle, the bundle's danger words and where its
   * spans go. Left out, no safety read is bound, so every read fails closed.
   */
  readonly safetyRead?: Omit<SafetyReadInputs, "now"> | undefined;
}

/** The real implementation of each port joined so far. */
export function realPorts(inputs: RealInputs): Partial<Ports> {
  return {
    linqVerify: linqVerify(inputs),
    sealing: realSealing({ handleKey: inputs.handleKey ?? null }),
    safetyRead: realSafetyRead(
      inputs.safetyRead === undefined
        ? { readers: null, dangerWords: () => [], sink: () => undefined, now: inputs.now }
        : { ...inputs.safetyRead, now: inputs.now },
    ),
  };
}

/**
 * K-11 v1 verifyWebhook through the Linq adapter (T-413): the signature over id.timestamp.raw under the secret, within
 * 300 s of the gateway's receipt time, then the body parsed into one K-06 v1 event with the part key beside it, or ignored,
 * or rejected (badTimestamp, staleTimestamp, badSignature), which the gateway answers 401.
 */
function linqVerify(inputs: RealInputs): LinqPort {
  const linq = inputs.linq;
  const verifier = createLinqWebhookVerifier({
    ...(linq?.chatHandle === undefined ? {} : { chatHandle: linq.chatHandle }),
    ...(linq?.optionWords === undefined ? {} : { optionWords: linq.optionWords }),
    now: inputs.now,
    secret: async () => {
      const secret = linq === undefined ? undefined : await linq.webhookSecret();
      if (secret === undefined || secret === "") throw new MissingSecretError(LINQ_WEBHOOK_SECRET);
      return secret;
    },
  });
  return {
    async verifyWebhook(request) {
      return gatewayResultOf(await verifier.verifyWebhook(request));
    },
  };
}

// ---- sealing: K-05 v1.2 handleSealingKey (T-553; DL-313 ruling 4) ------------------------------------------------------

/** The name the wrapping key is read by (NQ-DB-1's default: one environment key wraps every data key). A name, never a value. */
export const SEALING_WRAP_KEY = "SEALING_WRAP_KEY";

/**
 * K-05 v1.2 `handleSealingKey` (T-220, db/repo/handle-keys.ts) with its database bound (the primary, as rosie_job) and
 * its resolver reading the wrapping key by name: the answer, with the data key beside it as a key object that cannot be
 * exported.
 */
export type HandleSealingKeyCall = (request: HandleSealingKeyRequest) => Promise<HandleSealingKeyResult>;

/** A call that needs a database where none is bound (the Worker until T-567's Hyperdrive). The message names the call only. */
export class NoDatabaseError extends Error {
  constructor(call: string) {
    super(`no database is bound here for ${call}`);
    this.name = "NoDatabaseError";
  }
}

/** The key call gave no key (K-05's constraint or transient, or a handle K-04 cannot hold): nothing is sealed. */
export class SealingKeyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`no sealing key: ${code}`);
    this.name = "SealingKeyError";
    this.code = code;
  }
}

/** What the real sealing port is fed: K-05's call with its database bound, or null where none is bound. */
export interface SealingInputs {
  readonly handleKey: HandleSealingKeyCall | null;
  /** A new id for each call, never built from the address (K-05 v1.2 consumer note); crypto.randomUUID when left out. */
  readonly newId?: () => string;
}

/** The handle's key as K-05 hands it over. A throw means no key, so the gateway answers 503 and writes nothing. */
export interface KeyObjectStore {
  getOrCreateKey(handle: HandleRef): Promise<CryptoKey>;
}

/**
 * The handle's sealing key from K-05 v1.2 item 29 (get or create a handle's sealing key): new handle and person ids on
 * every call, never built from the address (an id built from it would meet 23505 on every retry once a number's keys were
 * erased twice); the wrapping key by its name; the data key as the key object K-05 hands over, never bytes. With no
 * database bound, a constraint or transient answer, or a handle kind K-04 does not hold, it throws: fails closed.
 */
export function realSealing(inputs: SealingInputs): KeyObjectStore {
  const newId = inputs.newId ?? ((): string => crypto.randomUUID());
  return {
    async getOrCreateKey(handle) {
      const call = inputs.handleKey;
      if (call === null) throw new NoDatabaseError("handleSealingKey");
      if (handle.kind !== "phone" && handle.kind !== "email") throw new SealingKeyError("badHandle");
      const answer = await call({
        handle: { kind: handle.kind, address: handle.address },
        newHandleId: `handle-${newId()}`,
        newPersonId: `person-${newId()}`,
        wrappingKeyName: SEALING_WRAP_KEY,
      });
      if (answer.dataKey === null) throw new SealingKeyError(answer.outcome.error);
      return answer.dataKey;
    },
  };
}

/** The adapter's answer as the gateway's port type writes it: the same result, status, event, part key, type and reason. */
function gatewayResultOf(answer: AdapterVerifyResult): VerifyWebhookResult {
  switch (answer.result) {
    case "event":
      // The same K-06 v1 event, field for field. The two hand-written types differ only where K-06 is wider than the
      // gateway's: K-06 lets a receipt's service be null where Linq names none (the adapter's parse), while the gateway's
      // InboundEvent says text and reads the service only as a span label, which leaves a null out (labelFacts).
      return {
        result: "event",
        httpStatus: 200,
        event: answer.event as unknown as InboundEvent,
        partKey: answer.partKey,
      };
    case "ignored":
      return { result: "ignored", httpStatus: 200, eventType: answer.eventType };
    case "rejected":
      return { result: "rejected", httpStatus: 401, reason: answer.reason };
  }
}

// ---- safetyRead: @rosie/ai's safety read (T-554; C-047, C-113) ---------------------------------------------------------

/**
 * @rosie/ai's safety read (T-365 `createSafetyReader`, with T-366's danger-word rules) for one bundle, built over that
 * bundle's two models and its safety read prompt (K-01 v1 manifest), the model key read by name at each call. A throw (or
 * a rejection) means no read can be made for that bundle: the read fails, and the actor applies its no-verdict rule.
 */
export type SafetyReaders = (bundleId: BundleId) => SafetyReader | Promise<SafetyReader>;

/** A safety read asked for where none is bound (the Worker, until it can build one). The message names nothing else. */
export class NoSafetyReaderError extends Error {
  constructor() {
    super("no safety read is bound here");
    this.name = "NoSafetyReaderError";
  }
}

/** What the real safety-read port is fed. */
export interface SafetyReadInputs {
  /** @rosie/ai's safety read for a text's bundle; null where none is bound, so every read fails closed. */
  readonly readers: SafetyReaders | null;
  /**
   * The pinned bundle's danger words (K-01 shared lists), as the actor's own bundle port gives them
   * (`BundleSafety.dangerWords`), read at each read: the same list the actor's no-verdict rule matches.
   */
  readonly dangerWords: () => readonly DangerWordEntry[];
  /** Where the read's model-call spans go (the log sink): into the text's own trace. */
  readonly sink: SpanSink;
  /** Epoch milliseconds: the root's clock, for those spans. */
  readonly now: () => number;
}

/**
 * The actor's safety-read port (T-246's `SafetyReadPort`) bound to @rosie/ai's safety read: each raw text, as the actor
 * opened it on arrival, is read for danger by meaning (Haiku, then Sonnet, 2 s each) with the bundle's danger words, and
 * the K-02 v1 answer goes back to the actor as it is. The read's model-call spans (a portCall to provider anthropic per
 * try) go into the text's trace, under its trace id and bundle id. No reader bound, a danger-word list that cannot be
 * read, or a reader that cannot be built: the read fails before any model call, so the actor applies its no-verdict rule
 * (a danger word gets the safety line, any other text the outage line and its unread hold), and no verdict ever skips the
 * bundle's danger words. The words go to the read only: never into a span, a log or an error.
 */
export function realSafetyRead(inputs: SafetyReadInputs): SafetyReadPort {
  return {
    async read(request) {
      const readers = inputs.readers;
      if (readers === null) throw new NoSafetyReaderError();
      const dangerWords = inputs.dangerWords();
      const reader = await readers(request.bundleId);
      const trace = openTrace({
        openedBy: "textWebhook",
        bundleId: request.bundleId,
        incomingTraceId: request.traceId,
        sink: inputs.sink,
        now: inputs.now,
      });
      // The text's own trace id (the gateway's, always valid). One the trace could not take would open another id, so
      // the spans are then left out rather than written on a trace of their own.
      return reader.read(
        {
          eventId: request.eventId,
          source: request.source,
          text: request.words.body ?? "",
          subject: request.words.subject,
        },
        trace.reusedIncoming ? { trace, dangerWords } : { dangerWords },
      );
    },
  };
}
