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
//   frontier     T-557: K-09 buildFrontier through @rosie/actions' turn face (T-315, createTurnFace: the Tool API base
//                with K-09 v1.5's checks, the call's business scope and its one frontier span; the frontier with main's
//                sources, T-1147's sign-up door among them). Its stored state is K-05 v1.2 readTurnState as rosie_job
//                under the call's business scope, set for the transaction only, through the scope the root is handed
//                (RootOptions.frontierScope: pgFrontierScope over a rosie_job client, the scope pgTurnFace builds on; in
//                a test, the K-05 double over test owner 1's seeded rows); nothing in the Worker until T-567, so every
//                frontier there fails closed. Its bundle is the one the turn's run pinned (./pinned-runs.ts), read KV
//                first and PostgreSQL's copy on a miss, and its call's span says where each part it read came from.
//                Inside workerd the Tool API's validator and the frontier's checker are T-1144's prebuilt standalone
//                code (`npm run build:validators`), never a no-op; under Node, Ajv over the frozen schemas.
//   decide       T-558: @rosie/ai's decide (T-369 createDecider: two reads routed by stakes and compared part by part;
//                C-115) and its one Sonnet re-read (T-370; C-116), one decider per bundle for both, handed in by the
//                root (RootOptions.deciders): in a test, over a fake Messages API answered by the recorded-model double
//                (T-004, T-1145's turn 1 recordings); in the Worker, none until the bundle's manifest (its models, routing
//                policy and decide prompt) and flow graphs can be read there and the model key is set by name (J-02;
//                smoke-size calls only, DL-027), so every decide and re-read there fails closed before any model call and
//                no turn commits a decided part. The answers are mapped as T-370's handoff maps them (DL-342), and the
//                re-read is handed back the very result decide gave. Each model call writes its own portCall span into
//                the turn's trace (the AI gateway's); the decideReads and reread spans stay the turn's, labels only.
//   gate         T-559: K-09 gateAndCommit through @rosie/actions' turn face (T-1141, createTurnFace with its calls: the
//                Tool API base with K-09 v1.5's checks and the call's own business scope; T-305's gate with limits 1
//                to 6 as registered, limit 1 given the pinned bundle's step cards; T-1139's walk after the choice;
//                T-1140's runCore with the safety service; one K-05 commitTurn per turn id). Its one commitTurn goes
//                through the root's turn-row port (T-555: K-05's call, refusing a turn id that is not its event ids'
//                hash), its bundle is the one the turn's run pinned (as the frontier's), and its reads are handed in by
//                the root (RootOptions.gateReads: the Tool API's business scope and, on its transaction, K-05 v1.3
//                readOpenHolds and v1.4's safety reads, the read-only sealer; in a test, the K-05 doubles over test owner
//                1's seeded rows); nothing in the Worker until T-567, so every gate there fails closed before anything is
//                read or written. The plug-in's stop words are the barbershop's, named here (PLUGIN_LISTS_NO_STOP_WORDS,
//                DL-344), and nobody is told until T-319 (NOT_TOLD_YET). The turn records the gate's and the commit's
//                spans; the face tells the base so (TURN_RECORDS_GATE), and the base records none (T-1193; DL-376). The
//                face holds each committed turn's words as its request handed them in (held.ts), for compose input.
//   composeInput T-560: K-09 composeInput through @rosie/actions' turn face (T-1141, createTurnFace with its calls: the
//                Tool API base with K-09 v1.6's checks and the call's own business scope; T-309's compose input with
//                T-1174's term facts over T-1141's row binding). Its reads are handed in by the root
//                (RootOptions.composeReads: the Tool API's business scope and K-05 v1.6 readOutboxRow on the runtime
//                side; in a test, a K-05 double over the rows the commit wrote and test owner 1's seeded rows); nothing in
//                the Worker until T-567, so every compose input there fails closed before anything is read. Its bundle is
//                the one the turn's run pinned (as the gate's), and its inbound text the words the turn's gate request
//                handed in, held by the gate port's face (one HeldTurns per root). The turn records the row's
//                fillAndChecks span; the face tells the base so (TURN_RECORDS_FILL_AND_CHECKS), and the base records none.
//   composer     T-560: @rosie/ai's composer (T-373 createComposer, with T-374's one rewrite and T-375's reader checks;
//                C-118), one per bundle for both, handed in by the root (RootOptions.composers): in a test, over a fake
//                Messages API answered by the recorded-model double (T-1175's recording 4 for the JOIN run); in the
//                Worker, none until the bundle's manifest (its models and its composer prompt) can be read there and the
//                model key is set by name (J-02; smoke-size calls only, DL-027), so every compose and rewrite there fails
//                closed before any model call. The answers are mapped as T-374's handoff maps the rewrite (DL-309). Each
//                model call writes its own portCall span into the turn's trace; the compose span stays the turn's.
//   finalize     T-561: K-09 finalizeMessage through @rosie/actions' turn face (T-1141, createTurnFace with its calls: the
//                Tool API base with K-09's checks and the call's own business scope; T-313's finalize with T-314's
//                fixed-line inserter over T-1141's row binding, finalizeDeps). Its reads and writes are handed in by the
//                root (RootOptions.finalizeData: the Tool API's business scope, and on the runtime side K-05 v1.6
//                readOutboxRow, v1.3 readFixedLineFacts, and T-196's writePlan and cancelClock; in a test, K-05 doubles over
//                the rows the commit wrote and test owner 1's seeded rows); nothing in the Worker until T-567, so every
//                finalize there fails closed before anything is read or written. Its bundle is the one the turn's run
//                pinned (as compose input's), whose fixed lines finalize adds word for word (S13-01's opener, Q-30's STOP,
//                HELP and rates line and privacy link), and its reader's language the one the gate port's face holds for
//                the turn. The claim check and the message checks are finalize's own, run as it runs them. The plan and
//                the final parts go into the row together through writePlan, after the commit, or the row gets its one
//                rewrite, then the step's fallback, inside the same calls. The turn records the row's fillAndChecks and
//                rewriteOrFallback spans; the face tells the base so (TURN_RECORDS_FILL_AND_CHECKS), and the base records
//                none (T-1193; DL-376).
//   outbox       T-562: the dispatcher's claim and marks, and the receipt door's mark, over K-05 v1.2's four outbox calls
//                (T-1135, db/repo/outbox.ts: claimOutboxV12, renewClaim, markPartV12 and markRowV12, each called as
//                (sql, request) as rosie_job; never T-196's v1 claimOutbox, markPart or markRow beside them: a v1 claim
//                writes no claim row, so a v1.2 claim would take the row again at once: DL-317), with their database
//                bound, handed in by the root (RootOptions.outboxCalls): in a test, the K-05 double over the rows the
//                commit wrote and the plans finalize wrote into them; nothing in the Worker until T-567, so every claim
//                there fails closed and nothing is sent. Each claimed row is handed on with the final parts finalize
//                wrote, its port (K-05 v1.2 item 30) and its claim; K-03's options ({id, label}) go as their labels.
//                The phone row renewClaim reads with each renewal (K-05 v1.2 item 32) must be there: with none (an email
//                handle, or a number whose first turn wrote none) the renewal is answered notFound (the phone row), so
//                nothing is sent, never read as not stopped (K-05 README's consumer note for T-562).
//   sendState    T-562: limit 8's read of the recipient's send state at send, and the chat the send goes to, over K-05
//                v1.2 sendState (T-220, db/repo/send-state.ts; item 28; NQ-RT-2) with its database bound, handed in by
//                the root (RootOptions.sendStateCall): in a test, the same K-05 double over test owner 1's seeded rows (no
//                phone row) and the rows the commit wrote; nothing in the Worker until T-567, so every read there fails
//                closed and nothing is sent. phone.stopped, phone.stopAt and textsConsent go across unchanged, and the
//                stopped flag is never derived from a consent row (STATE note 10; T-1099). A number with no phone row has
//                no open chat that Rosie knows of, so its rows wait for the chat (limit 8's waitingChat; MC C9).
//
// Worker code: no double, no fixture, no key, no network call. The secret is never kept, returned or logged: an error
// names the secret by its name only. A text's words go to the safety read and decide only, never into a span, a log or
// an error.

import type { FlagsReader } from "@rosie/actions/src/domain/flags/reads";
import type { MessagesReader } from "@rosie/actions/src/domain/messages-consent/reads";
import {
  NOT_TOLD_YET,
  PLUGIN_LISTS_NO_STOP_WORDS,
  type WordsSealer,
} from "@rosie/actions/src/domain/safety/ports";
import { createFrontierChecker, type FrontierChecker } from "@rosie/actions/src/frontier/assemble/check";
import type {
  FrontierBundles,
  FrontierRepo,
  FlowLetter as FrontierFlow,
} from "@rosie/actions/src/frontier/assemble/types";
import type { BusinessScope } from "@rosie/actions/src/tool-api/scope";
import type { CallTrace } from "@rosie/actions/src/tool-api/tool-api";
import {
  turnCommitDeps,
  type SafetyReads,
  type TurnCommitBinding,
} from "@rosie/actions/src/tool-api/turn-face/commit";
import type { FinalizeNote } from "@rosie/actions/src/finalize/rewrite/types";
import { HeldTurns } from "@rosie/actions/src/tool-api/turn-face/held";
import {
  composeInputDeps,
  finalizeDeps,
  type RowBinding,
  type RowData,
} from "@rosie/actions/src/tool-api/turn-face/rows";
import { createTurnFace } from "@rosie/actions/src/tool-api/turn-face/turn-face";
import { createToolApiValidator, type ToolApiValidator } from "@rosie/actions/src/tool-api/validator";
import {
  createLinqWebhookVerifier,
  type ParseLookups,
  type VerifyWebhookResult as AdapterVerifyResult,
} from "@rosie/adapters/linq/webhook";
import type {
  ComposeInput as AiComposeInput,
  MessagePlan as AiMessagePlan,
} from "@rosie/ai/src/composer/prompt";
import type { CheckName, RewriteAnswer, Told } from "@rosie/ai/src/composer/rewrite/types";
import type { ComposeAnswer, Composer } from "@rosie/ai/src/composer/types";
import { RereadRefusedError } from "@rosie/ai/src/decide/errors";
import type {
  DecideContext as AiDecideContext,
  Decider,
  RereadAfterReads,
  RereadAnswer,
} from "@rosie/ai/src/decide/types";
import type { SafetyReader } from "@rosie/ai/src/safety/types";
import type {
  ReadActiveBundleResult,
  ReadBundleValueRequest,
  ReadBundleValueResult,
} from "@rosie/db/repo/bundles";
import type { CommitTurnOutcome, CommitTurnRequest } from "@rosie/db/repo/commit-turn";
import type { HandleSealingKeyRequest, HandleSealingKeyResult } from "@rosie/db/repo/handle-keys";
import type {
  ClaimedRowV12,
  ClaimOutboxRequest as K05ClaimOutboxRequest,
  ClaimOutboxV12Outcome,
  MarkPartV12Outcome,
  MarkPartV12Request,
  MarkRowV12Outcome,
  MarkRowV12Request,
  RenewClaimOutcome,
  RenewClaimRequest as K05RenewClaimRequest,
} from "@rosie/db/repo/outbox";
import type { SendStateOutcome, SendStateRequest, SendStateResponse } from "@rosie/db/repo/send-state";
import type { ParkTurnOutcome, ParkTurnRequest as K05ParkTurnRequest } from "@rosie/db/repo/park";
import type {
  HandleTargetsOutcome,
  HandleTargetsRequest as K05HandleTargetsRequest,
} from "@rosie/db/repo/targets";

import { turnIdOf } from "../actor/lease";
import {
  BundleError,
  type BundleDeps,
  type Manifest,
  type PartRead,
  type PinnedBundle,
} from "../bundle/types";
import { asListed, BundleReader, flowOf, keyOf, readManifest, sameBundle } from "../bundle/values";
import type {
  ChatTarget,
  ClaimedRow,
  FinalParts as DispatchFinalParts,
  MarkPartResponse,
  OutboxStore,
  PlannedSend,
  RecipientDirectory,
  SendState,
  SendStateReader,
} from "../dispatch/types";
import type { HandleRef } from "../gateway/seal";
import type { InboundEvent, LinqPort, VerifyWebhookResult } from "../gateway/types";
import type { HandleTargetsAnswer, HandleTargetsPort } from "../guard/types";
import { MODELS_DOWN } from "../outage/ai";
import type { DangerWordEntry, SafetyReadPort } from "../safety/types";
import { openTrace, type BundleId, type SpanSink, type TraceContext } from "../trace";
import type {
  BuildFrontierAnswer,
  ComposeInputAnswer,
  ComposerAnswer,
  DecideAnswer,
  DecideResult,
  FinalizeMessageAnswer,
  GateAndCommitAnswer,
  MessagePlan,
  ParkTurnAnswer,
  RewriteRequest,
  TurnComposer,
  TurnDecide,
} from "../turn/types";
import type {
  ComposeInputPort,
  FinalizePort,
  FrontierPort,
  GatePort,
  Ports,
  SendStatePort,
  TurnRowPort,
} from "./ports";

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
  /**
   * What the frontier reads through besides its scope (T-557): the bound bundle port, for a bundle the turn did not pin,
   * and the bundle each run of a turn pinned, by the run's trace. Left out, the frontier reads every bundle through its
   * own bundle port (realBundles over `bundleReads`).
   */
  readonly frontierBundles?: Omit<FrontierInputs, "scope"> | undefined;
  /**
   * The frontier's business scope (T-557): K-05 v1.2 readTurnState as rosie_job under each call's business, set for the
   * transaction only; null or left out where no database is bound (the Worker until T-567), so every frontier fails closed.
   */
  readonly frontierScope?: FrontierScope | null | undefined;
  /**
   * @rosie/ai's decide for each bundle (T-558): null or left out where none can be built (the Worker, until its bundle's
   * manifest and flows and the model key can be read there), so every decide and re-read fails closed.
   */
  readonly deciders?: Deciders | null | undefined;
  /**
   * What the gate and commit reads and commits through (T-559): its reads with their database bound (null where none is
   * bound: the Worker until T-567), the root's turn-row port's commitTurn, and the bundles it reads (as the frontier's).
   * Left out, every gate fails closed.
   */
  readonly gate?: Omit<GateInputs, "held"> | undefined;
  /**
   * What compose input reads (T-560): its reads with their database bound (null where none is bound: the Worker until
   * T-567) and the bundles it reads (as the gate's). Left out, every compose input fails closed.
   */
  readonly composeInput?: Omit<ComposeInputInputs, "held"> | undefined;
  /**
   * @rosie/ai's composer for each bundle (T-560): null or left out where none can be built (the Worker, until its bundle's
   * manifest and the model key can be read there), so every compose and rewrite fails closed.
   */
  readonly composers?: Composers | null | undefined;
  /**
   * What finalize reads and writes (T-561): its calls with their database bound (null where none is bound: the Worker
   * until T-567) and the bundles it reads (as compose input's). Left out, every finalize fails closed.
   */
  readonly finalize?: Omit<FinalizeInputs, "held" | "now"> | undefined;
  /**
   * K-05 v1.2's four outbox calls with their database bound (T-562): null or left out where none is bound (the Worker
   * until T-567), so every claim and mark fails closed and nothing is sent.
   */
  readonly outbox?: OutboxCalls | null | undefined;
  /**
   * K-05 v1.2 sendState with its database bound (T-562): null or left out where none is bound (the Worker until T-567),
   * so every send-state read fails closed and nothing is sent.
   */
  readonly sendState?: SendStateCall | null | undefined;
}

/** The real implementation of each port joined so far. */
export function realPorts(inputs: RealInputs): Partial<Ports> {
  const bundles = realBundles({ calls: inputs.bundleReads ?? null });
  // The words and language of each turn the gate committed, as its request handed them in (T-1141's held.ts): one memory
  // per root, the isolate's own and bounded, shared by the gate port, the compose-input port (the rows' inbound text) and
  // the finalize port (the reader's language).
  const held = new HeldTurns();
  return {
    linqVerify: linqVerify(inputs),
    sealing: realSealing({ handleKey: inputs.handleKey ?? null }),
    safetyRead: realSafetyRead(
      inputs.safetyRead === undefined
        ? { readers: null, dangerWords: () => [], sink: () => undefined, now: inputs.now }
        : { ...inputs.safetyRead, now: inputs.now },
    ),
    turnRow: realTurnRow({ calls: inputs.turnRows ?? null }),
    bundles,
    targets: realTargets({ call: inputs.handleTargets ?? null }),
    frontier: realFrontier({
      scope: inputs.frontierScope ?? null,
      bundles: inputs.frontierBundles?.bundles ?? (() => bundles),
      pinnedOf: inputs.frontierBundles?.pinnedOf ?? (() => null),
    }),
    decide: realDecide({ deciders: inputs.deciders ?? null }),
    gate: realGate({
      ...(inputs.gate ?? {
        reads: null,
        commitTurn: () => Promise.reject(new NoDatabaseError("commitTurn")),
        bundles: () => bundles,
        pinnedOf: () => null,
      }),
      held,
    }),
    composeInput: realComposeInput({
      reads: inputs.composeInput?.reads ?? null,
      bundles: inputs.composeInput?.bundles ?? (() => bundles),
      pinnedOf: inputs.composeInput?.pinnedOf ?? (() => null),
      held,
    }),
    composer: realComposer({ composers: inputs.composers ?? null }),
    finalize: realFinalize({
      data: inputs.finalize?.data ?? null,
      bundles: inputs.finalize?.bundles ?? (() => bundles),
      pinnedOf: inputs.finalize?.pinnedOf ?? (() => null),
      held,
      now: inputs.now,
    }),
    outbox: realOutbox({ calls: inputs.outbox ?? null }),
    sendState: realSendState({ call: inputs.sendState ?? null }),
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

// ---- frontier: K-09 buildFrontier through @rosie/actions' turn face (T-557; C-074, C-075, C-050) -----------------------

/**
 * The frontier's business scope (K-05 v1.2 item 26 and its default 25; @rosie/actions' tool-api/scope.ts): one read-only
 * transaction per call, as rosie_job, whose row-level security scope is the call's business, set for the transaction
 * only and checked again before it ends, with the frontier's repo (readTurnState) inside it. On PostgreSQL it is
 * pgFrontierScope over a client whose connections run as rosie_job (@rosie/actions' turn-face/pg/frontier.ts: the scope
 * pgTurnFace builds its turn face on), the primary, uncached.
 */
export type FrontierScope = BusinessScope<FrontierRepo>;

/** What the real frontier port is fed. */
export interface FrontierInputs {
  /** The frontier's scope with its database bound; null where none is bound, so every frontier fails closed. */
  readonly scope: FrontierScope | null;
  /**
   * The bound bundle port (K-05 v1 item 7's reads, and the bundle KV when the port carries one), read at each call: for a
   * bundle the turn did not pin (an open question asked under an earlier bundle), read by its id.
   */
  readonly bundles: () => BundleDeps;
  /** The bundle the run whose trace this is pinned (./pinned-runs.ts), or null for a trace that is no pinned run's. */
  readonly pinnedOf: (trace: TraceContext) => PinnedBundle | null;
}

/** The scope where no database is bound: each call fails closed before anything is read, inside the Tool API base. */
const NO_FRONTIER_SCOPE: FrontierScope = {
  withBusiness: () => Promise.reject(new NoDatabaseError("readTurnState")),
};

/**
 * The frontier port (T-557): K-09 buildFrontier through @rosie/actions' turn face (createTurnFace, the face pgTurnFace
 * makes over pgFrontierScope): the Tool API base checks the request against K-09 v1.5 and that it names the trace it runs
 * in, refuses a call naming no business before anything is read, runs the frontier inside the call's scope, holds its
 * answer to K-09 v1.5's response or errors, and records the call's one frontier span on the turn's trace, under the
 * turn's pinned bundle id (CQ-159). The frontier reads the turn's stored state through the scope (K-05 v1.2
 * readTurnState as rosie_job) and its bundle through the bundle the turn's run pinned (FrontierBundleReads), so turn 1's
 * closed list (the sign-up door to S1-01, T-1147) comes from stored state. With no database bound every call goes to the
 * base all the same and fails closed there, its span failed, before anything is read: a frontier never runs unscoped.
 * The Tool API's validator and the frontier's checker are made at the first call and kept: inside workerd, T-1144's
 * prebuilt standalone code, which throws rather than check against other schemas (never a no-op); under Node, Ajv over
 * the frozen schemas from disk. K-09's answer comes back as it is (the context, one of buildFrontier's errors, or the
 * base's refusal); a frontier that cannot answer within K-09 throws, its span failed, and the turn takes it as no answer.
 * Nothing here logs: the frontier's own log lines are labels only (@rosie/actions' frontier/assemble/log.ts).
 */
export function realFrontier(inputs: FrontierInputs): FrontierPort {
  let checks: { readonly validator: ToolApiValidator; readonly checker: FrontierChecker } | null = null;
  return {
    async buildFrontier(request, trace) {
      checks ??= { validator: createToolApiValidator(), checker: createFrontierChecker() };
      const bundles = new FrontierBundleReads(inputs.pinnedOf(trace), inputs.bundles());
      const face = createTurnFace<FrontierRepo>({
        scope: inputs.scope ?? NO_FRONTIER_SCOPE,
        bundles,
        validator: checks.validator,
        checker: checks.checker,
      });
      const answer = await face.buildFrontier(request, spanNamingReads(trace, bundles));
      // The same K-09 buildFrontier answer in two hand-written forms: @rosie/actions' generated one, and the turn's
      // (../turn/types.ts), which reads the context's turn id and choices and checks them itself (turn.ts isContextOf).
      return answer as unknown as BuildFrontierAnswer;
    },
  };
}

/**
 * The turn's trace as the Tool API base takes it (its CallTrace: the trace id and `start`), the call's own frontier span
 * naming each bundle part the frontier read on this call, in order, and where it came from (K-01 v1 parts; KV, or
 * PostgreSQL's copy on a miss): `got.bundleParts` (flow/A, ...) and `got.bundleFrom` (kv or postgres), labels only. A part
 * the turn read before this call (its manifest, at the pin: the lease span's manifestFrom) is not named again.
 */
function spanNamingReads(trace: TraceContext, bundles: FrontierBundleReads): CallTrace {
  return {
    traceId: trace.traceId,
    start(hop) {
      const timer = trace.start(hop);
      return {
        finish(rest) {
          if (hop !== "frontier") return timer.finish(rest);
          const reads = bundles.reads();
          return timer.finish({
            ...rest,
            got: {
              ...rest.got,
              bundleParts: reads.map((read) => read.part),
              bundleFrom: reads.map((read) => read.from),
            },
          });
        },
      };
    },
  };
}

/** One bundle part the frontier read on a call: its K-01 part (manifest, flow/A, trade/<id>) and where it came from. */
interface FrontierRead {
  readonly part: string;
  readonly from: PartRead["from"];
}

/** A K-01 v1 key's part: what follows bundle/<hash>/<build>/. */
function partOf(key: string): string {
  return key.split("/").slice(3).join("/");
}

/** A value a bundle does not hold (K-01 v1: the manifest lists no such value) reads as null; any other failure throws. */
async function nullWhenNotIn<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof BundleError && error.code === "notInBundle") return null;
    throw error;
  }
}

/**
 * The bundles one frontier call reads (K-01 v1; @rosie/actions' FrontierBundles): the turn's pinned bundle as its run
 * pinned it (its manifest as checked at the pin; each flow graph once per run, KV first and PostgreSQL's copy on a miss,
 * checked against the manifest's size and sha256: runtime/src/bundle/pin.ts), and any other bundle by its id, through
 * the bundle port (KV first when the port carries one, else PostgreSQL's copy), each value checked the same way. A bundle
 * in neither copy, or a flow its manifest does not list, is null (the frontier offers nothing from it); a value no copy
 * holds as the bundle's own, or a read that gets no answer, throws, so the call fails closed. Never logged: a value.
 */
class FrontierBundleReads implements FrontierBundles {
  private readonly before: number;
  private readonly reader: BundleReader;
  private readonly manifests = new Map<string, Promise<Manifest | null>>();
  private readonly flows = new Map<string, Promise<unknown>>();

  constructor(
    private readonly pinned: PinnedBundle | null,
    deps: BundleDeps,
  ) {
    this.before = pinned?.reads().length ?? 0;
    this.reader = new BundleReader(deps.registry, deps.kv ?? null);
  }

  manifest(bundleId: BundleId): Promise<unknown> {
    const pinned = this.pinned;
    if (pinned !== null && sameBundle(bundleId, pinned.bundleId)) return Promise.resolve(pinned.manifest);
    return this.otherManifest(bundleId);
  }

  async flow(bundleId: BundleId, flow: FrontierFlow): Promise<unknown> {
    const pinned = this.pinned;
    if (pinned !== null && sameBundle(bundleId, pinned.bundleId)) {
      return nullWhenNotIn(() => pinned.flow(flow));
    }
    const key = keyOf(bundleId, `flow/${flow}`);
    const known = this.flows.get(key);
    if (known !== undefined) return known;
    const loading = this.otherFlow(bundleId, flow, key);
    this.flows.set(key, loading);
    return loading;
  }

  /** Every part this call read, in order, with where it came from: the pinned bundle's first, then the others'. */
  reads(): FrontierRead[] {
    const pinned = this.pinned?.reads().slice(this.before) ?? [];
    return [...pinned, ...this.reader.reads()].map((read) => ({ part: partOf(read.key), from: read.from }));
  }

  /** Another bundle's manifest, read once per call and checked against its id; null when no copy holds it. */
  private otherManifest(bundleId: BundleId): Promise<Manifest | null> {
    const key = keyOf(bundleId, "manifest");
    const known = this.manifests.get(key);
    if (known !== undefined) return known;
    const loading = readManifest(this.reader, bundleId).catch((error: unknown) => {
      if (error instanceof BundleError && error.code === "notFound") return null;
      throw error;
    });
    this.manifests.set(key, loading);
    return loading;
  }

  /** Another bundle's flow graph, when its manifest lists it, checked against the listing. */
  private async otherFlow(bundleId: BundleId, flow: FrontierFlow, key: string): Promise<unknown> {
    const manifest = await this.otherManifest(bundleId);
    const listed = manifest?.storage.values.find((value) => value.key === key && value.kind === "flow");
    if (listed === undefined) return null;
    return this.reader.read(key, "flow", (value) =>
      Promise.resolve(asListed(value, listed) ? flowOf(value.text, flow) : null),
    );
  }
}

// ---- decide: @rosie/ai's two reads and the one Sonnet re-read (T-558; C-115, C-116) -----------------------------------

/**
 * @rosie/ai's decide for one bundle (T-369 `createDecider`, with T-370's one Sonnet re-read), built over that bundle's
 * K-01 v1 manifest (its id, its two models, its routing policy and its decide prompt) and flow graphs (the always-on
 * rules and the step cards the prompt layout reads), the model key read by name at each call. A throw (or a rejection)
 * means no decider can be built for that bundle: the call fails before any model call.
 */
export type Deciders = (bundleId: BundleId) => Decider | Promise<Decider>;

/** A decide asked for where none is bound (the Worker, until it can build one). The message names nothing else. */
export class NoDeciderError extends Error {
  constructor() {
    super("no decide is bound here");
    this.name = "NoDeciderError";
  }
}

/** A decider handed in for a bundle that answers as another bundle's: nothing is read on it. */
export class DeciderBundleError extends Error {
  constructor() {
    super("the decider handed in is of another bundle than the one asked for");
    this.name = "DeciderBundleError";
  }
}

/** What the real decide port is fed: @rosie/ai's decide for each bundle, or null where none is bound. */
export interface DecideInputs {
  readonly deciders: Deciders | null;
}

/**
 * The decide port (T-558): the turn loop's decide and its one re-read (T-251's `TurnDecide`) through @rosie/ai's
 * decider for the context's bundle, which the turn pinned. One decider per bundle serves both, built at its bundle's first
 * call and kept, so the once-per-run ledger of the re-read, which lives in the decider, sees every call of a turn (T-370
 * handoff; the security reviewer's note b); a decider that could not be built is not kept, so the next call asks again.
 * Each call's model calls write their portCall spans into the turn's trace (the AI gateway's, one per attempt: labels and
 * counts only); the turn records the decideReads and reread spans itself, so each hop is recorded once (CQ-159's rule:
 * the AI layer records no hop span of its own). The answers, as T-370's handoff maps them (DL-342):
 *
 *   decide   decided      {result: "decided", decide: K-02's result (the re-read not run), modelCalls}: the turn asks for
 *                         the re-read when the reads disagree or a part holds one question
 *            modelsDown   {error: "modelsDown"}: T-271's AI-down path follows
 *            unmapped     a read was refused: the AI layer's own re-read of the turn runs here (why unmapped, CQ-162 (a)),
 *                         then {error: "modelsDown"} when it got neither model, else {error: "unmapped"}: K-02 v1's
 *                         result cannot hold a refused read, so the run ends with nothing committed (T-1157, T-1158)
 *   reread   decided      {result: "decided", decide: K-02's result with the re-read run, modelCalls}
 *            modelsDown   {error: "modelsDown"}
 *            unmapped     {error: "unmapped"}: the re-read is refused too, so the turn ends in one question, unasked
 *            refused      {error: "rereadDone"}: the turn's one re-read has run (RereadRefusedError, before any call)
 *
 * The re-read is handed the request as the turn gives it, so its `decide` is the very result decide gave: the re-read
 * checks it is exactly its two reads' own. A re-read after meaning search (why noneFits) is refused by the AI layer before
 * any call (DecideRequestError, until T-1159), and the refusal goes back as it came. No decider bound, a decider that
 * cannot be built or one of another bundle: the call fails before any model call. Nothing here logs or writes a span: a
 * part's quote and fields go to the gate only, never into a span, a log or an error.
 */
export function realDecide(inputs: DecideInputs): TurnDecide {
  const built = new Map<string, Promise<Decider>>();

  const deciderOf = (bundleId: BundleId): Promise<Decider> => {
    const deciders = inputs.deciders;
    if (deciders === null) return Promise.reject(new NoDeciderError());
    const key = `${bundleId.hash}/${String(bundleId.build)}`;
    const known = built.get(key);
    if (known !== undefined) return known;
    // Kept from this call on, so a call made while the decider is still being built waits for the same one; the factory
    // runs after it is kept, so even one that throws at once is not kept.
    const building = Promise.resolve()
      .then(() => deciders(bundleId))
      .then((decider) => {
        if (!sameBundle(decider.bundleId, bundleId)) throw new DeciderBundleError();
        return decider;
      });
    built.set(key, building);
    void building.catch(() => {
      if (built.get(key) === building) built.delete(key);
    });
    return building;
  };

  return {
    async decide(context, trace): Promise<DecideAnswer> {
      const decider = await deciderOf(context.bundleId);
      const asked = context as unknown as AiDecideContext;
      const answer = await decider.decide(asked, { trace });
      switch (answer.status) {
        case "decided":
          return {
            result: "decided",
            // The same K-02 v1 decideResult in two hand-written forms: @rosie/ai's, and the turn's (../turn/types.ts),
            // which reads the result's turn, parts and flags and checks them itself (turn.ts isResultOf).
            decide: answer.result as unknown as DecideResult,
            modelCalls: answer.modelCalls,
          };
        case "modelsDown":
          return { error: MODELS_DOWN };
        case "unmapped": {
          const again = await decider.reread(
            { why: "unmapped", context: asked, unmapped: answer },
            { trace },
          );
          return { error: again.status === "modelsDown" ? MODELS_DOWN : "unmapped" };
        }
      }
    },
    async reread(request, trace): Promise<DecideAnswer> {
      const decider = await deciderOf(request.context.bundleId);
      let answer: RereadAnswer;
      try {
        // The turn's request as it gives it (T-251's RereadRequest is @rosie/ai's RereadAfterReads, with noneFits beside
        // it), so the result decide gave goes back unchanged.
        answer = await decider.reread(request as unknown as RereadAfterReads, { trace });
      } catch (error) {
        if (error instanceof RereadRefusedError) return { error: "rereadDone" };
        throw error;
      }
      switch (answer.status) {
        case "decided":
          return {
            result: "decided",
            decide: answer.result as unknown as DecideResult,
            modelCalls: answer.modelCalls,
          };
        case "modelsDown":
          return { error: MODELS_DOWN };
        case "unmapped":
          return { error: "unmapped" };
      }
    },
  };
}

// ---- gate: K-09 gateAndCommit through @rosie/actions' turn face (T-559; C-074, C-087) ----------------------------------

/**
 * What the gate and commit reads with its database bound (T-559; @rosie/actions' turn-face/pg/calls.ts names each one on
 * PostgreSQL): the Tool API's own business scope, one transaction per call whose row-level security scope is the call's
 * business (rosie_app: pgCallScope, never the frontier's rosie_job scope), and on that call's transaction K-05 v1.3
 * readOpenHolds (readOpenHoldsIn) and K-05 v1.4's seven safety reads (pgSafetyReads: six on the call's transaction, the
 * business owner's on the runtime side in its own); the safety record's words are sealed by a sealer that only reads the
 * person's key, which the gateway made at first sight (pgReadOnlySealer). T-317's and T-307's reads (the flags and the
 * checked line's rows), left out, are the safety service's own on the call's transaction, a database's.
 */
export interface GateReads<Repo = unknown> {
  readonly scope: BusinessScope<Repo>;
  readonly readOpenHolds: TurnCommitBinding<Repo>["readOpenHolds"];
  readonly safetyReads: SafetyReads<Repo>;
  readonly sealer: WordsSealer;
  readonly flagsReader?: (repo: Repo) => FlagsReader;
  readonly messagesReader?: (repo: Repo) => MessagesReader;
}

/** What the real gate port is fed. */
export interface GateInputs {
  /** The gate's reads with their database bound; null where none is bound, so every gate fails closed. */
  readonly reads: GateReads | null;
  /**
   * K-05 v1.1 commitTurn as the root's turn-row port sends it (T-555): refused before K-05 when the turn id is not the hash
   * of its event ids; failing closed where no database is bound.
   */
  readonly commitTurn: CommitTurnCall;
  /** The bound bundle port, read at each call: for a bundle the turn did not pin. */
  readonly bundles: () => BundleDeps;
  /** The bundle the run whose trace this is pinned (./pinned-runs.ts), or null for a trace that is no pinned run's. */
  readonly pinnedOf: (trace: TraceContext) => PinnedBundle | null;
  /**
   * Where the face holds each committed turn's words and language, as its request handed them in (decided.context.texts;
   * T-1141's held.ts), for its rows' inbound text: the compose-input port reads the same memory (realPorts shares one).
   * Left out, nothing is held, so no row is given an inbound text.
   */
  readonly held?: HeldTurns;
}

/** The scope where no database is bound: each gate fails closed before anything is read or written, inside the base. */
const NO_GATE_SCOPE: BusinessScope<unknown> = {
  withBusiness: () => Promise.reject(new NoDatabaseError("gateAndCommit")),
};

/**
 * The gate port (T-559): K-09 gateAndCommit through @rosie/actions' turn face (createTurnFace with its calls, the face
 * pgTurnCalls builds on PostgreSQL): the Tool API base checks the request against K-09 v1.5 (its turn may carry the service
 * and chat id of the turn's last text, which the root puts there: K-09 v1.5 default 135) and that it names the trace it
 * runs in, refuses a call naming no business before anything is read, and runs the gate and the commit inside the call's
 * business scope (GateReads.scope), holding the answer to K-09 v1.5's response or errors. The commit is T-1141's
 * binding of T-305's (turnCommitDeps): the flags, then limits 1 to 6 as registered, limit 1 given the turn's pinned
 * bundle's step cards; what is open at commit time (K-05 readOpenHolds joined with the lease's CommitContext, `at`, handed
 * on unchanged); each core action through T-1140's runCore and the safety service (its reads, the read-only sealer, the
 * pinned bundle's checked lines, the barbershop plug-in's stop words, PLUGIN_LISTS_NO_STOP_WORDS (DL-344), and nobody told
 * until T-319, NOT_TOLD_YET); each passed part's writes from T-1139's walk on the pinned bundle's flow graphs, its row ids
 * built from the turn's own id (K-09 v1.5 default 131); and one K-05 commitTurn through the root's turn-row port, under
 * the turn id, its turn row K-05's seven fields alone. A repeat of a committed turn id answers the first commit and writes
 * nothing (K-05 v1 item 1). The turn's bundle is the one its run pinned, read KV first and PostgreSQL's copy on a miss (as
 * the frontier reads it). The base records no span: the turn records the gate (one span per part, with its limits) and
 * the commit itself (TURN_RECORDS_GATE; DL-376), so no flag is set for this hop. With no reads bound every call goes to
 * the base all the same and fails closed there, before anything is read or written. The validator is made at the first
 * call and kept: inside workerd, T-1144's prebuilt standalone code; under Node, Ajv over the frozen schemas. Nothing here
 * logs: the chat id goes to the walk only, never into a span, a log line, an error or an event-log entry's values.
 */
export function realGate(inputs: GateInputs): GatePort {
  let validator: ToolApiValidator | null = null;
  return {
    async gateAndCommit(request, at, trace) {
      validator ??= createToolApiValidator();
      const reads = inputs.reads;
      const bundles = new FrontierBundleReads(inputs.pinnedOf(trace), inputs.bundles());
      const binding: TurnCommitBinding<unknown> = {
        bundles,
        commitTurn: (commit) => inputs.commitTurn(commit),
        readOpenHolds: (repo, asked) =>
          reads === null
            ? Promise.reject(new NoDatabaseError("readOpenHolds"))
            : reads.readOpenHolds(repo, asked),
        safetyReads: reads?.safetyReads ?? NO_SAFETY_READS,
        sealer: reads?.sealer ?? NO_SEALER,
        stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
        telling: NOT_TOLD_YET,
        safetyExtra: {
          ...(reads?.flagsReader === undefined ? {} : { flagsReader: reads.flagsReader }),
          ...(reads?.messagesReader === undefined ? {} : { messagesReader: reads.messagesReader }),
        },
      };
      const face = createTurnFace<FrontierRepo>({
        // The frontier is its own port's: this face's frontier is never called.
        scope: NO_FRONTIER_SCOPE,
        bundles,
        validator,
        calls: {
          scope: reads?.scope ?? NO_GATE_SCOPE,
          commit: turnCommitDeps(binding),
          // A committed turn's texts and language, as the request hands them in, held for its rows (compose input).
          ...(inputs.held === undefined ? {} : { held: inputs.held }),
        },
      });
      const answer = await face.gateAndCommit(request, at, trace);
      // The same K-09 gateAndCommit answer in two hand-written forms: @rosie/actions' generated one, and the turn's
      // (../turn/types.ts), which reads the committed answer's turn id, parts, core and rows and checks them itself
      // (turn.ts committedOf).
      return answer as unknown as GateAndCommitAnswer;
    },
  };
}

/** A safety read where no database is bound: refused, so the call fails closed. */
const noRead = (read: string) => (): Promise<never> => Promise.reject(new NoDatabaseError(read));

/** K-05 v1.4's safety reads where no database is bound: each fails closed (never reached: the scope fails first). */
const NO_SAFETY_READS: SafetyReads<unknown> = {
  outcomeOfEvent: noRead("readSafetyOutcomeOfEvent"),
  outcome: noRead("readSafetyOutcome"),
  hold: noRead("readSafetyHold"),
  holdOfOutcome: noRead("readSafetyHoldOfOutcome"),
  outboxRowWritten: noRead("readOutboxRowWritten"),
  businessZone: noRead("readBusinessZone"),
  businessOwner: noRead("readBusinessOwner"),
};

/** The sealer where no database is bound: it seals nothing (never reached: the scope fails first). */
const NO_SEALER: WordsSealer = { seal: noRead("sealingKey") };

// ---- composeInput: K-09 composeInput through @rosie/actions' turn face (T-560; C-074, C-090) ---------------------------

/**
 * What compose input reads with its database bound (T-560; @rosie/actions' turn-face/pg/calls.ts names each one on
 * PostgreSQL): the Tool API's own business scope, one transaction per call whose row-level security scope is the call's
 * business (rosie_app: pgCallScope, as the gate's), and K-05 v1.6 readOutboxRow on the runtime side, a read-only
 * transaction of its own under the call's business (rosie_job: pgRowData's readOutboxRow, never readOutboxRowIn).
 */
export interface ComposeReads<Repo = unknown> {
  readonly scope: BusinessScope<Repo>;
  readonly readOutboxRow: RowData["readOutboxRow"];
}

/** What the real compose-input port is fed. */
export interface ComposeInputInputs {
  /** Compose input's reads with their database bound; null where none is bound, so every compose input fails closed. */
  readonly reads: ComposeReads | null;
  /** The bound bundle port, read at each call: for a row committed under a bundle the turn did not pin. */
  readonly bundles: () => BundleDeps;
  /** The bundle the run whose trace this is pinned (./pinned-runs.ts), or null for a trace that is no pinned run's. */
  readonly pinnedOf: (trace: TraceContext) => PinnedBundle | null;
  /**
   * The turns the gate port's face holds the words of, as each gate request handed them in (T-1141's held.ts; realPorts
   * shares one): a committed turn's row gets the words of the text it replies to as its inbound text, sent as they are.
   */
  readonly held: HeldTurns;
}

/** The scope where no database is bound: each compose input fails closed before anything is read, inside the base. */
const NO_COMPOSE_SCOPE: BusinessScope<unknown> = {
  withBusiness: () => Promise.reject(new NoDatabaseError("composeInput")),
};

/** A call the compose-input port never makes (the gate's commit, finalize's reads and writes): the message names it. */
export class NotComposeInputError extends Error {
  constructor(call: string) {
    super(`${call} is never made through the compose-input port`);
    this.name = "NotComposeInputError";
  }
}

/** The compose-input face makes no commit: gateAndCommit is the gate port's, so its commit is never asked for. */
const NO_COMMIT = (): never => {
  throw new NotComposeInputError("gateAndCommit");
};

/**
 * K-05's row data as compose input reads it (@rosie/actions' RowBinding.data): readOutboxRow alone, with its database
 * bound, or failing closed where none is. Finalize's read and writes (readFixedLineFacts, writePlan, cancelClock) are the
 * finalize port's (T-561): compose input never makes them, and here each is refused.
 */
function composeRowData(reads: ComposeReads | null): RowData {
  const notHere = (call: string) => (): Promise<never> => Promise.reject(new NotComposeInputError(call));
  return {
    readOutboxRow: (request) =>
      reads === null ? Promise.reject(new NoDatabaseError("readOutboxRow")) : reads.readOutboxRow(request),
    readFixedLineFacts: notHere("readFixedLineFacts"),
    writePlan: notHere("writePlan"),
    cancelClock: notHere("cancelClock"),
  };
}

/**
 * The compose-input port (T-560): K-09 composeInput through @rosie/actions' turn face (createTurnFace with its calls: the
 * Tool API base with K-09 v1.6's checks for this call and the call's own business scope, ComposeReads.scope; T-309's
 * compose input with T-1174's term facts over T-1141's row binding, composeInputDeps). For one committed outbox row it
 * reads the row through K-05 v1.6 readOutboxRow (its reader by K-05 v1.5's rowReader, its sensitive switch by v1.6 item
 * 45), the step's master line and card from the bundle the row was committed under (the run's pinned bundle, read KV
 * first and PostgreSQL's copy on a miss, as the gate reads it), and answers K-03 v1.1's composer input: only what limit 7
 * lets its reader see, never the frontier (an input K-03 refuses is thrown, never sent), its inbound text the words of the
 * text it replies to as the turn's gateAndCommit request handed them in (decided.context.texts, held by the gate port's
 * face: `held`), only to their own sender. An email copy answers emailCopy; a fixed line's, closed or planned row its
 * K-09 error. The base records no span: the turn records the row's fillAndChecks span itself
 * (TURN_RECORDS_FILL_AND_CHECKS; DL-376), so no flag is set for this hop. With no reads bound every call goes to the base
 * all the same and fails closed there, before anything is read. The validator is made at the first call and kept: inside
 * workerd, T-1144's prebuilt standalone code (composeInput by K-09 v1.6: T-1189); under Node, Ajv over the frozen
 * schemas. Nothing here logs: the input holds a person's words, which go to the composer only.
 */
export function realComposeInput(inputs: ComposeInputInputs): ComposeInputPort {
  let validator: ToolApiValidator | null = null;
  return {
    async composeInput(request, trace) {
      validator ??= createToolApiValidator();
      const reads = inputs.reads;
      const bundles = new FrontierBundleReads(inputs.pinnedOf(trace), inputs.bundles());
      const rows: RowBinding = { data: composeRowData(reads), bundles, held: inputs.held };
      const face = createTurnFace<FrontierRepo>({
        // The frontier is its own port's: this face's frontier is never called.
        scope: NO_FRONTIER_SCOPE,
        bundles,
        validator,
        calls: {
          scope: reads?.scope ?? NO_COMPOSE_SCOPE,
          commit: NO_COMMIT,
          compose: composeInputDeps(rows),
        },
      });
      const answer = await face.composeInput(request, trace);
      // The same K-09 composeInput answer in two hand-written forms: @rosie/actions' generated one, and the turn's
      // (../turn/types.ts), which reads the input's row and turn, or the email copy's text row, and checks them itself
      // (compose.ts composeInputOf).
      return answer as unknown as ComposeInputAnswer;
    },
  };
}

// ---- composer: @rosie/ai's composer and its one rewrite (T-560; C-118) -------------------------------------------------

/**
 * @rosie/ai's composer for one bundle (T-373 `createComposer`, with T-374's one rewrite and T-375's reader checks), built
 * over that bundle's K-01 v1 manifest (its id, its two models and its composer prompt), the model key read by name at
 * each call. A throw (or a rejection) means no composer can be built for that bundle: the call fails before any model
 * call.
 */
export type Composers = (bundleId: BundleId) => Composer | Promise<Composer>;

/** A compose or rewrite asked for where no composer is bound (the Worker, until it can build one). Names nothing else. */
export class NoComposerError extends Error {
  constructor() {
    super("no composer is bound here");
    this.name = "NoComposerError";
  }
}

/** What the real composer port is fed: @rosie/ai's composer for each bundle, or null where none is bound. */
export interface ComposerInputs {
  readonly composers: Composers | null;
}

/**
 * The rewrite's 'use the fallback' (T-374: the one rewrite failed too, or its answer was refused) as the turn takes it: a
 * label. The turn leaves the row unsent on it until it treats it as it treats modelsDown (T-374's handoff 1; DL-309).
 */
export const USE_FALLBACK = "useFallback";

/** A refused input, plan or request goes back as the first check that refused it: a K-08 label, never a place or a word. */
function refusedCode(problems: readonly { readonly check: string }[]): string {
  return problems[0]?.check ?? "refused";
}

/** @rosie/ai's compose or rewrite answer as the turn takes it (../turn/types.ts ComposerAnswer), with every model call. */
function composerAnswerOf(answer: ComposeAnswer | RewriteAnswer): ComposerAnswer {
  switch (answer.status) {
    case "ok":
      // The same K-03 v1 plan in two hand-written forms: @rosie/ai's, and the turn's (../turn/types.ts), which checks
      // its formats, lines, question, page type and thread target itself (compose.ts isPlan).
      return {
        result: "planned",
        plan: answer.plan as unknown as MessagePlan,
        modelCalls: answer.modelCalls,
      };
    case "modelsDown":
      return { error: MODELS_DOWN, modelCalls: answer.modelCalls };
    case "refused":
      return { error: refusedCode(answer.problems), modelCalls: answer.modelCalls };
    case "useFallback":
      return { error: USE_FALLBACK, modelCalls: answer.modelCalls };
  }
}

/**
 * What the one rewrite is told (T-374's handoff 1; DL-309): rewriteTold of the attempt the composer wrote, which the turn
 * reads off finalize's answer as each failed check with its detail (compose.ts failedChecksOf), every filled value
 * already written as its {{slot}} there (K-09 README default 32; DL-158 ruling c). A failed check with no detail tells
 * nothing, as rewriteTold leaves it out; the AI layer checks the rest (each a K-03 check name, once, in words).
 */
function toldOf(failed: RewriteRequest["failed"]): Told[] {
  return failed.flatMap((check) =>
    check.detail === null ? [] : [{ check: check.check as CheckName, detail: check.detail }],
  );
}

/**
 * The composer port (T-560): the turn's composer call per outbox row and its one rewrite (T-252's `TurnComposer`) through
 * @rosie/ai's composer for the turn's pinned bundle (the trace's bundle id, the one the row was committed under). One
 * composer per bundle serves both, built at its bundle's first call and kept; one that could not be built is not kept,
 * so the next call asks again. A composer of another bundle than the trace's is refused by the AI gateway before any
 * model call (GatewayConfigError), so nothing is composed on it. The answers:
 *
 *   compose  ok           {result: "planned", plan, modelCalls}: K-03's plan, checked against its input by the AI layer
 *            refused      {error: the first refusing check (frontier, input, literalValue, ...), modelCalls}: an input
 *                         carrying the frontier is refused before any call (refuse-frontier-in-input.json)
 *            modelsDown   {error: "modelsDown", modelCalls}
 *   rewrite  the request as T-374's handoff maps it: {input, plan, attempt: "composed", told: the failed checks with their
 *            details}, the plan the composer gave, never the final parts; its answers as compose's, and 'use the fallback'
 *            {error: "useFallback", modelCalls}, never a second rewrite
 *
 * Each model call writes its own portCall span into the turn's trace (the AI gateway's, one per attempt: labels and
 * counts only); the turn records the compose and rewriteOrFallback spans with the model calls each answer carries (DL-357:
 * a sum of cost or tokens counts the portCall spans only). No composer bound, or one that cannot be built: the call fails
 * before any model call. Nothing here logs or writes a span: an input's and a plan's words go to the model only, never
 * into a span, a log or an error.
 */
export function realComposer(inputs: ComposerInputs): TurnComposer {
  const built = new Map<string, Promise<Composer>>();

  const composerOf = (bundleId: BundleId): Promise<Composer> => {
    const composers = inputs.composers;
    if (composers === null) return Promise.reject(new NoComposerError());
    const key = `${bundleId.hash}/${String(bundleId.build)}`;
    const known = built.get(key);
    if (known !== undefined) return known;
    // Kept from this call on, so a call made while the composer is still being built waits for the same one; the
    // factory runs after it is kept, so even one that throws at once is not kept.
    const building = Promise.resolve().then(() => composers(bundleId));
    built.set(key, building);
    void building.catch(() => {
      if (built.get(key) === building) built.delete(key);
    });
    return building;
  };

  return {
    async compose(input, trace) {
      const composer = await composerOf(trace.bundleId);
      // The same K-03 v1.1 composer input in two hand-written forms: the turn's, which rides through untouched, and
      // @rosie/ai's, which the composer checks again before any call (check.ts inputProblems).
      return composerAnswerOf(await composer.compose(input as unknown as AiComposeInput, { trace }));
    },
    async rewrite(request, trace) {
      const composer = await composerOf(trace.bundleId);
      const answer = await composer.rewrite(
        {
          input: request.input as unknown as AiComposeInput,
          plan: request.plan as unknown as AiMessagePlan,
          attempt: "composed",
          told: toldOf(request.failed),
        },
        { trace },
      );
      return composerAnswerOf(answer);
    },
  };
}

// ---- finalize: K-09 finalizeMessage through @rosie/actions' turn face (T-561; C-074, C-093, C-089) ---------------------

/**
 * What finalize reads and writes with its database bound (T-561; @rosie/actions' turn-face/pg/calls.ts names each one on
 * PostgreSQL): the Tool API's own business scope, one transaction per call whose row-level security scope is the call's
 * business (rosie_app: pgCallScope, as compose input's), and pgRowData's four calls on the runtime side (rosie_job), each a
 * transaction of its own: K-05 v1.6 readOutboxRow and v1.3 readFixedLineFacts under the call's business, and K-05 v1's
 * writePlan (T-196: the plan and the final parts written into the row together, after the commit) and cancelClock (the
 * passed-on path's withdrawal).
 */
export interface FinalizeData<Repo = unknown> {
  readonly scope: BusinessScope<Repo>;
  readonly readOutboxRow: RowData["readOutboxRow"];
  readonly readFixedLineFacts: RowData["readFixedLineFacts"];
  readonly writePlan: RowData["writePlan"];
  readonly cancelClock: RowData["cancelClock"];
}

/** What the real finalize port is fed. */
export interface FinalizeInputs {
  /** Finalize's reads and writes with their database bound; null where none is bound, so every finalize fails closed. */
  readonly data: FinalizeData | null;
  /** The bound bundle port, read at each call: for a row committed under a bundle the turn did not pin. */
  readonly bundles: () => BundleDeps;
  /** The bundle the run whose trace this is pinned (./pinned-runs.ts), or null for a trace that is no pinned run's. */
  readonly pinnedOf: (trace: TraceContext) => PinnedBundle | null;
  /**
   * The turns the gate port's face holds, as each gate request handed them in (T-1141's held.ts; realPorts shares one):
   * the reader's language is the turn's, else the stored one (T-1141's default 5).
   */
  readonly held: HeldTurns;
  /** Epoch milliseconds: the root's clock, for when a passed-on message's question is withdrawn (cancelClock's `at`). */
  readonly now: () => number;
}

/** The scope where no database is bound: each finalize fails closed before anything is read or written, inside the base. */
const NO_FINALIZE_SCOPE: BusinessScope<unknown> = {
  withBusiness: () => Promise.reject(new NoDatabaseError("finalizeMessage")),
};

/** A call the finalize port never makes (the gate's commit): the message names it. */
export class NotFinalizeError extends Error {
  constructor(call: string) {
    super(`${call} is never made through the finalize port`);
    this.name = "NotFinalizeError";
  }
}

/** The finalize face makes no commit: gateAndCommit is the gate port's, so its commit is never asked for. */
const NO_FINALIZE_COMMIT = (): never => {
  throw new NotFinalizeError("gateAndCommit");
};

/** K-05's row data as finalize reads and writes it (@rosie/actions' RowBinding.data), each failing closed with no database. */
function finalizeRowData(data: FinalizeData | null): RowData {
  const none = (call: string): Promise<never> => Promise.reject(new NoDatabaseError(call));
  return {
    readOutboxRow: (request) => (data === null ? none("readOutboxRow") : data.readOutboxRow(request)),
    readFixedLineFacts: (request) =>
      data === null ? none("readFixedLineFacts") : data.readFixedLineFacts(request),
    writePlan: (request) => (data === null ? none("writePlan") : data.writePlan(request)),
    cancelClock: (request) => (data === null ? none("cancelClock") : data.cancelClock(request)),
  };
}

/** An instant as K-05 takes it: UTC, whole seconds, ending in Z. */
function utcSecondsOf(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/**
 * Finalize's note of one attempt as one JSON line (BP 5.5): the action layer's labels (the row, the attempt, its outcome,
 * the checks it missed; @rosie/actions' logNote), with the turn's trace id beside them. Never a value, a detail or a word.
 */
function finalizeNoteOn(trace: TraceContext): (note: FinalizeNote) => void {
  return (note) => {
    console.info(
      JSON.stringify({
        level: "info",
        msg: "finalize_attempt",
        trace_id: trace.traceId,
        row: note.row,
        attempt: note.attempt,
        outcome: note.outcome,
        missed: note.missed,
      }),
    );
  };
}

/**
 * The finalize port (T-561): K-09 finalizeMessage through @rosie/actions' turn face (createTurnFace with its calls: the
 * Tool API base with K-09's checks and the call's own business scope, FinalizeData.scope; T-313's finalize with T-314's
 * fixed-line inserter over T-1141's row binding, finalizeDeps). For one committed outbox row and its plan, it reads the
 * row through K-05 v1.6 readOutboxRow (its reader by K-05 v1.5's rowReader, its sensitive switch by v1.6 item 45), the
 * step's master line, card terms and fallback text from the bundle the row was committed under (the run's pinned bundle,
 * read KV first and PostgreSQL's copy on a miss, as compose input reads it), and the fixed lines' facts through K-05 v1.3
 * readFixedLineFacts; then, as finalize runs them and never here: limit 7 on each slot and the fill, the parts, the fixed
 * lines word for word as the bundle writes them (Rosie's first text to a handle about a business: S13-01's opener first,
 * then Q-30's STOP, HELP and rates line, and the privacy link alone on the last line), and the seven message checks. Every
 * check passed, the plan and the final parts go into the row together through T-196's writePlan, after the commit; a miss
 * on the composed plan answers the one rewrite, nothing written; a blocking miss on the rewrite takes the step's fallback
 * text through the same checks, then the passed-on line (K-09 README default 11). The base records no span: the turn
 * records the row's fillAndChecks and rewriteOrFallback spans itself (TURN_RECORDS_FILL_AND_CHECKS; DL-376), so no flag
 * is set for this hop. With no data bound every call goes to the base all the same and fails closed there, before
 * anything is read or written. The validator is made at the first call and kept: inside workerd, T-1144's prebuilt
 * standalone code; under Node, Ajv over the frozen schemas. Nothing here logs a value: the plan and the final parts hold
 * a person's words, which go to the row only; finalize's notes are labels, with the turn's trace id.
 */
export function realFinalize(inputs: FinalizeInputs): FinalizePort {
  let validator: ToolApiValidator | null = null;
  return {
    async finalizeMessage(request, trace) {
      validator ??= createToolApiValidator();
      const data = inputs.data;
      const bundles = new FrontierBundleReads(inputs.pinnedOf(trace), inputs.bundles());
      const rows: RowBinding = {
        data: finalizeRowData(data),
        bundles,
        held: inputs.held,
        now: () => utcSecondsOf(inputs.now()),
        log: finalizeNoteOn(trace),
      };
      const face = createTurnFace<FrontierRepo>({
        // The frontier is its own port's: this face's frontier is never called.
        scope: NO_FRONTIER_SCOPE,
        bundles,
        validator,
        calls: {
          scope: data?.scope ?? NO_FINALIZE_SCOPE,
          commit: NO_FINALIZE_COMMIT,
          finalize: finalizeDeps(rows),
        },
      });
      const answer = await face.finalizeMessage(request, trace);
      // The same K-09 finalizeMessage answer in two hand-written forms: @rosie/actions' generated one, and the turn's
      // (../turn/types.ts), which reads the outcome, the checks and the final parts and checks them itself (compose.ts
      // finalizedOf).
      return answer as unknown as FinalizeMessageAnswer;
    },
  };
}

// ---- outbox: K-05 v1.2 claimOutbox, renewClaim, markPart and markRow (T-562; C-124, C-125; DL-317) ---------------------

/**
 * K-05 v1.2's four outbox calls (T-1135, db/repo/outbox.ts) with their database bound, each one transaction on the primary
 * as rosie_job with no business scope: `(request) => claimOutboxV12(sql, request)`, and so on, `sql` a rosie_job client
 * (T-567 binds them). Only these four: T-196's v1 claimOutbox, markPart and markRow write no claim row and answer v1's
 * shapes, so a v1 call beside them would let a v1.2 claim take a row again at once (K-05 default 20; DL-317). Each call's
 * answer type is the v1.2 call's own, so a v1 call cannot be bound here.
 */
export interface OutboxCalls {
  readonly claimOutboxV12: (request: K05ClaimOutboxRequest) => Promise<ClaimOutboxV12Outcome>;
  readonly renewClaim: (request: K05RenewClaimRequest) => Promise<RenewClaimOutcome>;
  readonly markPartV12: (request: MarkPartV12Request) => Promise<MarkPartV12Outcome>;
  readonly markRowV12: (request: MarkRowV12Request) => Promise<MarkRowV12Outcome>;
}

/** What the real outbox port is fed: K-05's four calls with their database bound, or null where none is bound. */
export interface OutboxInputs {
  readonly calls: OutboxCalls | null;
}

/** A claimed row the dispatcher cannot be handed as K-05 gave it (a send option it cannot read). Names no value. */
export class ClaimedRowError extends Error {
  constructor(what: string) {
    super(`a claimed row cannot go to the dispatcher: ${what}`);
    this.name = "ClaimedRowError";
  }
}

/** A K-03 send option as Linq takes it: its words (K-03 v1 option {id, label}: the label is what the person sees). */
function optionWordsOf(option: unknown): string {
  if (typeof option === "string") return option;
  if (typeof option === "object" && option !== null && "label" in option) {
    const { label } = option as { readonly label: unknown };
    if (typeof label === "string") return label;
  }
  throw new ClaimedRowError("a send option is neither a label nor K-03's {id, label}");
}

/** One K-03 send of a claimed row's final parts, as the dispatcher reads it (dispatch/types.ts PlannedSend). */
function plannedSendOf(send: ClaimedRowV12["finalParts"]["sends"][number]): PlannedSend {
  const options: readonly unknown[] = Array.isArray(send.options) ? send.options : [];
  return {
    kind: send.kind,
    text: send.text,
    calendarFile: send.calendarFile,
    options: options.map(optionWordsOf),
    link: send.link,
  };
}

/** The final parts finalize wrote into the row (K-03 v1 finalParts), as the dispatcher reads them: the words never logged. */
function finalPartsOf(parts: ClaimedRowV12["finalParts"]): DispatchFinalParts {
  return {
    row: parts.row,
    channel: parts.channel,
    sends: parts.sends.map(plannedSendOf),
    fixedLines: [...parts.fixedLines],
    threadReplyTo: parts.threadReplyTo,
  };
}

/** K-05 v1.2's claimedRow (v1's fields, v1.1's claim and claimedFrom, v1.2's port) as the dispatcher reads it. */
export function claimedRowOf(row: ClaimedRowV12): ClaimedRow {
  return {
    outboxRowId: row.outboxRowId,
    version: row.version,
    commitSeq: row.commitSeq,
    recipientHandleId: row.recipientHandleId,
    recipientPersonId: row.recipientPersonId,
    businessId: row.businessId,
    bookingId: row.bookingId,
    openQuestionId: row.openQuestionId,
    channel: row.channel,
    port: row.port,
    sendClass: row.sendClass,
    versionsRead: row.versionsRead.map((read) => ({
      table: read.table,
      rowId: read.rowId,
      version: read.version,
    })),
    finalParts: finalPartsOf(row.finalParts),
    parts: row.parts.map((part) => ({
      partNo: part.partNo,
      tryNo: part.tryNo,
      idempotencyKey: part.idempotencyKey,
      attempts: part.attempts,
      sent: part.sent,
    })),
    traceId: row.traceId,
    claim: { ...row.claim },
    claimedFrom: row.claimedFrom,
  };
}

/** The dispatcher's markPart request as K-05 v1.2 takes it: each outcome's own fields, nothing added. */
function markPartRequestOf(request: Parameters<OutboxStore["markPart"]>[0]): MarkPartV12Request {
  switch (request.outcome) {
    case "sent":
      return {
        outcome: "sent",
        idempotencyKey: request.idempotencyKey,
        providerMessageId: request.providerMessageId,
        providerOptionIds: request.providerOptionIds === null ? null : [...request.providerOptionIds],
        at: request.at,
      };
    case "delivered":
      return {
        outcome: "delivered",
        providerMessageId: request.providerMessageId,
        at: request.at,
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      };
    case "failed":
      return {
        outcome: "failed",
        idempotencyKey: request.idempotencyKey,
        errorCode: request.errorCode,
        retry: request.retry,
        at: request.at,
        ...(request.providerMessageId === undefined ? {} : { providerMessageId: request.providerMessageId }),
        ...(request.nextTryNotBefore === undefined ? {} : { nextTryNotBefore: request.nextTryNotBefore }),
      };
  }
}

/**
 * The outbox port (T-562): the dispatcher's OutboxStore (runtime/src/dispatch) over K-05 v1.2's four outbox calls. Each
 * request goes to its v1.2 call as it is; each answer comes back in the dispatcher's shapes:
 *   - claimOutbox: claimOutboxV12. Each claimed row is handed on with its claim, the state it was claimed from, its port
 *     (linq or email: v1.2 item 30), and the final parts finalize wrote into it (K-03's options as their labels);
 *   - renewClaim: renewClaim, whose answer also holds the recipient's phone row as the renewal read it, FOR SHARE (v1.2
 *     item 32). A renewal that read no phone row (an email handle, or a number whose first turn wrote none) is answered
 *     notFound for the phone row: the dispatcher sends nothing and keeps no part out, never reading it as not stopped
 *     (the K-05 README's consumer note for T-562; DL-317);
 *   - markPart: markPartV12, its answer with the row after the mark (v1.1 item 15), which the dispatcher compares;
 *   - markRow: markRowV12, limit 8's outcome, waitingChat among them (v1.1 item 16).
 * Errors pass through as K-05 gives them. With no calls bound every call fails closed (NoDatabaseError), so the dispatcher
 * claims nothing and sends nothing. Nothing here logs: a row's final parts hold a person's words.
 */
export function realOutbox(inputs: OutboxInputs): OutboxStore {
  const { calls } = inputs;
  const none = (call: string): Promise<never> => Promise.reject(new NoDatabaseError(call));
  return {
    async claimOutbox(request) {
      if (calls === null) return none("claimOutbox");
      const answer = await calls.claimOutboxV12({
        claimer: request.claimer,
        ...(request.recipientHandleId === undefined ? {} : { recipientHandleId: request.recipientHandleId }),
        now: request.now,
        limit: request.limit,
      });
      if ("error" in answer) return answer;
      return {
        result: "claimed",
        claimed: answer.claimed.map(claimedRowOf),
        passedHeld: answer.passedHeld.map((held) => ({
          outboxRowId: held.outboxRowId,
          heldUntil: held.heldUntil,
        })),
      };
    },
    async renewClaim(request) {
      if (calls === null) return none("renewClaim");
      const answer = await calls.renewClaim({
        outboxRowId: request.outboxRowId,
        claimer: request.claimer,
        claimNo: request.claimNo,
        idempotencyKey: request.idempotencyKey,
        at: request.at,
      });
      if ("error" in answer) return answer;
      // No phone row read with the renewal (null, or no recipient at all, as a v1.1 answer has none): unreadable, so
      // nothing is sent, never "not stopped" (the K-05 README's consumer note for T-562).
      const phone: unknown = (answer as { readonly recipient?: unknown }).recipient;
      if (phone === null || phone === undefined) {
        return { error: "notFound", table: "phones", rowId: answer.outboxRowId };
      }
      return { result: "renewed", outboxRowId: answer.outboxRowId, claim: { ...answer.claim } };
    },
    async markPart(request) {
      if (calls === null) return none("markPart");
      const answer = await calls.markPartV12(markPartRequestOf(request));
      if ("error" in answer) return answer;
      const marked: MarkPartResponse = {
        result: "marked",
        outboxRowId: answer.outboxRowId,
        partNo: answer.partNo,
        tryNo: answer.tryNo,
        attempts: answer.attempts,
        repeated: answer.repeated,
        firstDelivery: answer.firstDelivery,
        openQuestionId: answer.openQuestionId,
        nextKey: answer.nextKey,
        row: { state: answer.row.state, version: answer.row.version },
      };
      return marked;
    },
    async markRow(request) {
      if (calls === null) return none("markRow");
      const answer = await calls.markRowV12({
        outboxRowId: request.outboxRowId,
        expectVersion: request.expectVersion,
        outcome: request.outcome,
        heldUntil: request.heldUntil,
        at: request.at,
      });
      if ("error" in answer) return answer;
      return {
        result: "marked",
        outboxRowId: answer.outboxRowId,
        version: answer.version,
        outcome: answer.outcome,
      };
    },
  };
}

// ---- sendState: K-05 v1.2 sendState, limit 8's read at send and the chat a send goes to (T-562; C-125; NQ-RT-2) ---------

/** K-05 v1.2 sendState (T-220, db/repo/send-state.ts) with its database bound, as rosie_job on the runtime side. */
export type SendStateCall = (request: SendStateRequest) => Promise<SendStateOutcome>;

/** What the real send-state port is fed: K-05's call with its database bound, or null where none is bound. */
export interface SendStateInputs {
  readonly call: SendStateCall | null;
}

/** A send-state read K-05 answered with no row (notFound) for a row the dispatcher holds: nothing is sent. Names no value. */
export class SendStateError extends Error {
  constructor(error: string) {
    super(`no send state for the claimed row: ${error}`);
    this.name = "SendStateError";
  }
}

/** How many recipients' chats one isolate keeps between a send-state read and the dispatcher's chat lookup. */
export const CHAT_MEMORY = 512;

/** An instant K-05 gives no zone or text hours for (a row with no business): an empty value, which limit 8 cannot read. */
const NOT_STORED = "";

/**
 * K-05 v1.2's send state as limit 8 reads it (dispatch/types.ts SendState). The phone row's stopped flag and stop time
 * and the texts consent row go across unchanged: the stopped flag is the phone's alone, never derived from a consent row
 * (STATE note 10; T-1099), and K-05 v1.2's consent row says neither who gave a yes nor for which booking, so no yes lifts
 * a stop (limit 8's notKnown). With no phone row (an email handle, or a number whose first turn wrote none) no open chat
 * is known: the row waits for the chat (MC C9), whatever its class, since a phone with no open chat lets nothing out.
 * With no business K-05 gives no zone and no text hours: each goes as an empty value, which limit 8 cannot read, so a
 * routine row is unreadable and nothing is sent (fail closed).
 */
export function sendStateOf(answer: SendStateResponse): SendState {
  const { phone } = answer;
  return {
    stopped: phone?.stopped ?? false,
    stopAt: phone?.stopAt ?? null,
    textsConsent:
      answer.textsConsent === null
        ? null
        : {
            consentId: answer.textsConsent.consentId,
            businessId: answer.textsConsent.businessId,
            revoked: answer.textsConsent.revoked,
            at: answer.textsConsent.at,
          },
    chatOpen: phone?.chatOpen ?? false,
    audience: answer.audience,
    visitZone: answer.visitZone,
    businessZone: answer.businessZone ?? NOT_STORED,
    textHours: answer.textHours ?? { start: NOT_STORED, end: NOT_STORED },
    textHoursOverride: answer.textHoursOverride,
    currentVersions: answer.currentVersions.map((current) => ({
      table: current.table,
      rowId: current.rowId,
      version: current.version,
    })),
    closed: { booking: answer.closed.booking, question: answer.closed.question },
  };
}

/**
 * The chat a send goes to, from the same read (K-05 v1.2 item 28: the phone row and the handle's chat thread "together
 * give the chat a send goes to"): the phone's number, the thread's Linq chat id and the service Linq reports for it.
 * None for an email handle, a number with no phone row or no service yet, or a handle with no Linq chat: noChat.
 */
export function chatTargetOf(answer: SendStateResponse): ChatTarget | null {
  const { recipient, phone, chat } = answer;
  const service = phone?.chatWay ?? null;
  const chatId = chat?.linqChatId ?? null;
  if (recipient.kind !== "phone" || service === null || chatId === null) return null;
  return { to: recipient.address, chatId, service };
}

/**
 * The send-state port (T-562): limit 8's SendStateReader and the dispatcher's RecipientDirectory over K-05 v1.2 sendState,
 * one primary read per call. The dispatcher reads a row's send state before each send (limit 8) and then asks for the
 * recipient's chat, so the chat is the one that read gave, kept for the recipient in this isolate (bounded, the oldest
 * forgotten first; a chat asked for with no read before it is none, so nothing is sent). A transient answer goes back as
 * it is (the dispatcher tries again, then sends nothing); notFound for a row it holds is thrown (SendStateError): nothing
 * is sent. With no call bound every read fails closed (NoDatabaseError). Nothing here logs: the number and the chat id
 * are personal data.
 */
export function realSendState(inputs: SendStateInputs): SendStatePort {
  const { call } = inputs;
  const chats = new Map<string, ChatTarget | null>();
  const keep = (handleId: string, chat: ChatTarget | null): void => {
    chats.delete(handleId);
    chats.set(handleId, chat);
    while (chats.size > CHAT_MEMORY) {
      const oldest = chats.keys().next().value;
      if (oldest === undefined) break;
      chats.delete(oldest);
    }
  };
  const sendState: SendStateReader = {
    async sendStateFor(row) {
      if (call === null) return Promise.reject(new NoDatabaseError("sendState"));
      const answer = await call({ outboxRowId: row.outboxRowId });
      if ("error" in answer) {
        if (answer.error === "transient") return { error: "transient", sqlstate: answer.sqlstate };
        throw new SendStateError(answer.error);
      }
      // The chat is the claimed row's recipient's only when K-05 read that same recipient: else none (fail closed).
      keep(
        row.recipientHandleId,
        answer.recipient.handleId === row.recipientHandleId ? chatTargetOf(answer) : null,
      );
      return sendStateOf(answer);
    },
  };
  const recipients: RecipientDirectory = {
    chatFor(recipientHandleId) {
      return Promise.resolve(chats.get(recipientHandleId) ?? null);
    },
  };
  return { sendState, recipients };
}
