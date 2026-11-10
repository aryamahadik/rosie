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
//                manifest (its two models and its safety read prompt) can be read there (the bundle reads are joined by
//                T-556 but fed no database there until T-567; staging's BUNDLES binding is T-566) and the model key is
//                set by name (J-02; smoke-size calls only, DL-027), so every read there fails closed and the actor
//                applies its no-verdict rule (T-246). Each read gets the pinned bundle's danger words from the actor's
//                own bundle port, and writes its model-call spans into the text's trace.
//   turnRow      T-555: K-05 v1.1 commitTurn (T-195, db/repo/commit-turn.ts) and K-05 v1 parkTurn (T-197, db/repo/park.ts),
//                the two calls that write a turn's one row (K-04 turns), with their database bound, handed in by the root
//                (RootOptions.turnRows): the K-05 double in a test; nothing in the Worker until T-567 binds its database,
//                so every commit and park there fails closed (the turn's commit is not taken, and its park is tried again,
//                as the lease's rules say). Each request's turn id must be T-248's hash of its own event ids (CQ-09;
//                ADR-013), the id the lease took the batch under, so one batch is one turn row. The park is the turn's
//                own (T-253); the commit is the Tool API's gate and commit's, behind the lease (C-087; T-559).
//   bundles      T-556: K-05 v1 item 7's readActiveBundle and readBundleValue (T-185, db/repo/bundles.ts), PostgreSQL's
//                bundle registry and copy, with their database bound, handed in by the root (RootOptions.bundleReads):
//                in a test, the K-05 double holding bundle v0 as bundles/v0 publishes it; nothing in the Worker until
//                T-567 binds its database, so every pin there fails closed and no turn's work starts. The pin (T-249)
//                reads the active id at each turn's start and the bundle's manifest under it, KV first from the actor's
//                own BUNDLES binding (none on staging until T-566) and PostgreSQL's copy on a miss; the guard's keyword
//                list is that pinned manifest's (K-01 v1 lists.keywords: START, HELP and the 16 opt-out words).
//   targets      T-556: K-05 v1.2 handleTargets (T-220, db/repo/targets.ts; NQ-RT-2), the guard's targets across every
//                business, with its database bound, handed in by the root (RootOptions.handleTargets): in a test, the
//                K-05 double answering for test owner 1's seeded rows (T-1148) as targets-first-text.json; nothing in the
//                Worker until T-567, so every read there fails closed and no text reaches the frontier or decide.
//
// Worker code: no double, no fixture, no key, no network call. The secret is never kept, returned or logged: an error
// names the secret by its name only. A text's words go to the safety read only, never into a span, a log or an error.

import {
  createLinqWebhookVerifier,
  type ParseLookups,
  type VerifyWebhookResult as AdapterVerifyResult,
} from "@rosie/adapters/linq/webhook";
import type { SafetyReader } from "@rosie/ai/src/safety/types";
import type {
  ReadActiveBundleResult,
  ReadBundleValueRequest,
  ReadBundleValueResult,
} from "@rosie/db/repo/bundles";
import type { CommitTurnOutcome, CommitTurnRequest } from "@rosie/db/repo/commit-turn";
import type { HandleSealingKeyRequest, HandleSealingKeyResult } from "@rosie/db/repo/handle-keys";
import type { ParkTurnOutcome, ParkTurnRequest as K05ParkTurnRequest } from "@rosie/db/repo/park";
import type {
  HandleTargetsOutcome,
  HandleTargetsRequest as K05HandleTargetsRequest,
} from "@rosie/db/repo/targets";

import { turnIdOf } from "../actor/lease";
import type { BundleDeps } from "../bundle/types";
import type { HandleRef } from "../gateway/seal";
import type { InboundEvent, LinqPort, VerifyWebhookResult } from "../gateway/types";
import type { HandleTargetsAnswer, HandleTargetsPort } from "../guard/types";
import type { DangerWordEntry, SafetyReadPort } from "../safety/types";
import { openTrace, type BundleId, type SpanSink } from "../trace";
import type { ParkTurnAnswer } from "../turn/types";
import type { Ports, TurnRowPort } from "./ports";

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
  /**
   * K-05's commitTurn and parkTurn with their database bound (T-555); null or left out where no database is bound (the
   * Worker until T-567), so every commit and park fails closed.
   */
  readonly turnRows?: TurnRowCalls | null | undefined;
  /**
   * K-05 v1 item 7's readActiveBundle and readBundleValue with their database bound (T-556); null or left out where no
   * database is bound (the Worker until T-567), so every pin and every active-id read fails closed.
   */
  readonly bundleReads?: BundleReadCalls | null | undefined;
  /**
   * K-05 v1.2 handleTargets with its database bound (T-556); null or left out where no database is bound (the Worker until
   * T-567), so every targets read fails closed.
   */
  readonly handleTargets?: HandleTargetsCall | null | undefined;
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
    turnRow: realTurnRow({ calls: inputs.turnRows ?? null }),
    bundles: realBundles({ calls: inputs.bundleReads ?? null }),
    targets: realTargets({ call: inputs.handleTargets ?? null }),
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

// ---- turnRow: K-05's commitTurn and parkTurn, a turn's one row (T-555; C-048, C-049) -----------------------------------

/** K-05 v1.1 commitTurn (T-195, db/repo/commit-turn.ts) with its database bound (the primary, as rosie_job). */
export type CommitTurnCall = (request: CommitTurnRequest) => Promise<CommitTurnOutcome>;

/** K-05 v1 parkTurn (T-197, db/repo/park.ts) with its database bound (the primary, as rosie_job). */
export type ParkTurnCall = (request: K05ParkTurnRequest) => Promise<ParkTurnOutcome>;

/** K-05's two calls that write a turn's one row, with their database bound: what the root is handed (RootOptions.turnRows). */
export interface TurnRowCalls {
  readonly commitTurn: CommitTurnCall;
  readonly parkTurn: ParkTurnCall;
}

/**
 * A commit or a park whose turn id is not T-248's hash of the turn's own event ids (CQ-09; ADR-013), or that names no event
 * id: nothing is sent, so no turn row is written under any id but the one its batch hashes to. The message names the call.
 */
export class TurnIdError extends Error {
  constructor(call: string) {
    super(`${call}: the turn id is not the hash of its event ids`);
    this.name = "TurnIdError";
  }
}

/** Refuses a turn whose id is not the hash of its event ids, as T-248's lease takes a batch under it. */
async function checkTurnId(
  call: string,
  turn: { readonly id: string; readonly eventIds: readonly string[] },
): Promise<void> {
  if (turn.eventIds.length === 0 || turn.id !== (await turnIdOf(turn.eventIds))) throw new TurnIdError(call);
}

/**
 * The turn-row port (T-555): K-05's commitTurn and parkTurn, the two calls that write a turn's one row in PostgreSQL (K-04
 * turns), each once per turn id (QUESTIONS.md NQ-RT-3's default: the lease lives in the actor; the row is written once, as
 * committed or parked). A request's turn id must be T-248's hash of its own event ids, the id the lease took its batch
 * under (CQ-09; ADR-013): any other is refused before K-05 is reached, so one batch is one turn row. With no database
 * bound (the Worker until T-567) every call fails closed: the commit is not taken, and the park is tried again later.
 * K-05's answer comes back as it is (committed, first or repeated; parked; or its refusal, nothing written): the turn's
 * park reads it (T-253), and the Tool API's gate and commit reads the commit's (C-087; T-559). Nothing here logs.
 */
export function realTurnRow(inputs: { readonly calls: TurnRowCalls | null }): TurnRowPort {
  return {
    async commitTurn(request) {
      const calls = inputs.calls;
      if (calls === null) throw new NoDatabaseError("commitTurn");
      await checkTurnId("commitTurn", request.turn);
      return calls.commitTurn(request);
    },
    async parkTurn(request) {
      const calls = inputs.calls;
      if (calls === null) throw new NoDatabaseError("parkTurn");
      await checkTurnId("parkTurn", request.turn);
      // The same K-05 v1 parkTurn exchange in two hand-written forms: the runtime's (../turn/types.ts, which the park
      // builds and reads) and the generated one db/repo/park.ts takes and answers.
      const answer = await calls.parkTurn(request as unknown as K05ParkTurnRequest);
      return answer as unknown as ParkTurnAnswer;
    },
  };
}

// ---- bundles: K-05 v1 item 7's bundle reads, the turn's pin (T-556; C-050, C-033) --------------------------------------

/** K-05 v1 readActiveBundle (T-185, db/repo/bundles.ts) with its database bound (the primary, uncached). */
export type ReadActiveBundleCall = () => Promise<ReadActiveBundleResult>;

/** K-05 v1 readBundleValue (T-185, db/repo/bundles.ts) with its database bound (the primary, uncached). */
export type ReadBundleValueCall = (request: ReadBundleValueRequest) => Promise<ReadBundleValueResult>;

/** K-05 v1 item 7's two bundle reads with their database bound: what the root is handed (RootOptions.bundleReads). */
export interface BundleReadCalls {
  readonly readActiveBundle: ReadActiveBundleCall;
  readonly readBundleValue: ReadBundleValueCall;
}

/**
 * The bundle port (T-556): K-05 v1 item 7's readActiveBundle and readBundleValue, PostgreSQL's registry and its copy of
 * every published bundle (arch 10 line 536), the reads the actor's pin makes at each turn's start (T-249) and the gateway
 * makes for each webhook's trace (K-08 v1 README default 1). The port carries no KV of its own: the pin reads KV first
 * from the actor's own BUNDLES binding (none on staging until T-566) and PostgreSQL's copy on a miss. With no database
 * bound (the Worker until T-567) every read fails closed before any call: no turn's bundle is pinned, so no turn's work
 * starts (the lease lapses into a rerun), and the gateway's trace names bundle v0's stand-in. K-05's answer comes back as
 * it is; the pin checks it (the active id's form, each value's key, size and sha256, the manifest against its id), and
 * the guard reads its keyword list from the manifest so pinned (K-01 v1 lists.keywords). Nothing here logs.
 */
export function realBundles(inputs: { readonly calls: BundleReadCalls | null }): BundleDeps {
  return {
    registry: {
      readActiveBundle() {
        const calls = inputs.calls;
        if (calls === null) return Promise.reject(new NoDatabaseError("readActiveBundle"));
        return calls.readActiveBundle();
      },
      readBundleValue(request) {
        const calls = inputs.calls;
        if (calls === null) return Promise.reject(new NoDatabaseError("readBundleValue"));
        return calls.readBundleValue({ key: request.key });
      },
    },
  };
}

// ---- targets: K-05 v1.2 handleTargets, the guard's targets (T-556; C-051) ----------------------------------------------

/**
 * K-05 v1.2 handleTargets (item 27; T-220, db/repo/targets.ts) with its database bound: the primary, as rosie_job, with no
 * business scope (the runtime side, across every business: K-04 v1 rule 4).
 */
export type HandleTargetsCall = (request: K05HandleTargetsRequest) => Promise<HandleTargetsOutcome>;

/**
 * The targets port (T-556): K-05 v1.2 handleTargets (QUESTIONS.md NQ-RT-2's default, "a handle's targets"), the guard's
 * read of the handle's people and their live roles, every live open question sent to it and the bookings its people
 * booked or are served by, across every business, primary and uncached (arch 02 line 115). It is asked only for a turn
 * with a text that is not a keyword: a keyword text alone reads nothing (T-250). With no database bound (the Worker until
 * T-567) every read fails closed before any call: the guard's span says so (noAnswer), and none of the turn's texts
 * reaches the frontier or decide on that run, while its keyword texts still take their path. K-05's answer comes back as
 * it is; the guard checks it (`targetsOf`: K-05's shape, for the handle asked about, or `badAnswer`). Nothing here logs.
 */
export function realTargets(inputs: { readonly call: HandleTargetsCall | null }): HandleTargetsPort {
  return {
    handleTargets(request) {
      const call = inputs.call;
      if (call === null) return Promise.reject(new NoDatabaseError("handleTargets"));
      // The same K-05 v1.2 handleTargets answer in two hand-written forms: db/repo/targets.ts's, and the guard's
      // (../guard/types.ts), which names only the fields it reads and checks each of them (../guard/targets.ts).
      return call({ handleId: request.handleId }) as unknown as Promise<HandleTargetsAnswer>;
    },
  };
}
