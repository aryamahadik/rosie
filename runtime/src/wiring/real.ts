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
//                over, never bytes (README default 27). The same call answers the handle's K-04 id beside its key
//                (getOrCreateHandleKey), which the gateway hands to the chat-open port (T-1213).
//   chatOpen     T-1213: K-05 v1.7 openChatOnText (T-1212, db/repo/chat-open.ts; item 46), a number's text opening its
//                chat at receipt, with its database bound, handed in by the root (RootOptions.chatOpenCall): in a test,
//                the K-05 double over test owner 1's seeded handle and the handles the key call made, writing the phone
//                row the sendState and renewClaim doubles read; nothing in the Worker until T-567 binds its database, so
//                every call there fails closed and the gateway answers 503, as every seal there already does. The
//                gateway's request goes to K-05 as it is (the event id, the handle's K-04 id, the service, the receipt
//                time and the trace; never the number), and K-05's answer comes back as its result or its error's name.
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
//   stateReads   T-1242 (T-1154's part P1b): the safety read's bundle lines (BundleSafety: fixedLine, outcomeLine and
//                dangerWords) with the pin's check of each bundle a turn would pin (DL-341, DL-351), the handle's ids
//                (idsOf) and stopped flag (isStopped) and the turn's directory (partyOf), each read over its own input,
//                handed in by the root (RootOptions.bundleSafety, handleDirectory, stoppedFlags, turnDirectory; the
//                seams' table below says how): on staging none is handed in until the part of T-1154 that binds it, so
//                every read there fails closed (NoStateReadError) and no bundle is pinned. The test environment binds the
//                fake set's state reads. Each text's safety result is no state read: the turn reads it from its leased
//                turn, which the handle's own actor answers from the result its read on arrival kept (ADR-015, T-1264).
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
//                nothing is sent, never read as not stopped (K-05 README's consumer note for T-562). T-1356: K-05 v1.14's
//                claim beside them (T-1354, db/repo/outbox.ts claimOutboxV114, OutboxCalls.claimOutboxV114), the one
//                call that carries the claim's sendClass (item 67: a danger line's safety run, T-1352). Bound, every claim
//                goes to it, the field as the dispatcher sent it and never dropped, and a claim without it is v1.13's,
//                unchanged (db/repo default 24). Where it is not bound, a claim with the field is refused before any call
//                (SendClassNotCarriedError), so nothing is claimed, never a claim of every class in its place (RULES 7.2;
//                T-1352's rulings, condition 3; K-05 README "What the new tasks must hold to", v1.14).
//   sendState    T-562: limit 8's read of the recipient's send state at send, and the chat the send goes to, over K-05
//                v1.2 sendState (T-220, db/repo/send-state.ts; item 28; NQ-RT-2), which since v1.8 also says who gave the
//                texts yes and for which booking (T-1216; item 47), with its database bound, handed in by the root
//                (RootOptions.sendStateCall): in a test, the same K-05 double over test owner 1's seeded rows (no phone
//                row) and the rows the commit wrote; nothing in the Worker until T-567, so every read there fails closed
//                and nothing is sent. phone.stopped, phone.stopAt and textsConsent go across unchanged, v1.8's
//                fromContact and bookingId with it (T-1217; left out when the answer has none, so limit 8 reads them as
//                not known), and the stopped flag is never derived from a consent row (STATE note 10; T-1099). A number
//                with no phone row has no open chat that Rosie knows of, so its rows wait for the chat (limit 8's
//                waitingChat; MC C9).
//   dataAccess   T-1242 (T-1154's part P1b): the turn's plan calls, K-05 v1's unplannedRows and writePlan (T-196,
//                db/repo/outbox.ts, each called as (sql, request) as rosie_job), with their database bound, handed in by
//                the root (RootOptions.planCalls): on staging nothing until the part of T-1154 that binds them, so every
//                call there fails closed (NoDatabaseError) and no row is listed or planned. The test environment binds
//                the fake set's rows.
//   linqSend     T-563: K-11 v1 sendPart (C-206; C-211), each part the dispatcher sends through the root's Linq door
//                (./linq-door.ts), under its K-07 key '<row>/<part>/<try>', with its Linq line bound, handed in by the root
//                (RootOptions.linqSendCall): in a test, @rosie/adapters' Linq double (T-411), which records each part once
//                per key and answers a repeated key with its first answer, as Linq does (K-11 'Repeating it'); nothing in
//                the Worker until a line is handed in (staging's test-phone line, ./test-phone lineLinqSend, or J-08's real
//                line), so every send there fails closed before anything leaves. The request goes to the line field for
//                field, and its answer comes back as K-11's: accepted with its message id, or failed with its kind,
//                status, code and Retry-After, which the dispatcher's retry rules read (T-258); an answer K-11 does not
//                name is no answer, so the part waits under its own key.
//   arming       T-564: the clock arming at a part's first delivery receipt (T-255's clockArming, which the root's
//                receipt door hands each part K-05 markPart newly marked delivered), over K-05 v1 item 5's armClock and
//                cancelClock (T-197, db/repo/clocks.ts, each called as (sql, request) as rosie_job), the question's facts
//                the due rule reads (no K-05 call returns them yet: K-05 open gap 25) and the actor name of a K-04 handle,
//                with their database bound, handed in by the root (RootOptions.armingCalls): in a test, K-05 doubles over
//                the rows the commit wrote (the question's clock row, waiting until its first receipt) and test owner 1's
//                seeded rows; nothing in the Worker until T-567, so every arming there fails closed and nothing is armed.
//                Each answer goes to the arming as K-05 gives it: the arming checks it field by field (T-255).
//
// Worker code: no double, no fixture, no key, no network call. The secret is never kept, returned or logged: an error
// names the secret by its name only. A text's words go to the safety read and decide only, never into a span, a log or
// an error.

import type { FlagsReader } from "@rosie/actions/src/domain/flags/reads";
import type { MessagesReader } from "@rosie/actions/src/domain/messages-consent/reads";
import {
  NOT_TOLD_YET,
  PLUGIN_LISTS_NO_STOP_WORDS,
  type SafetyWords,
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
import type { OpenChatOnTextOutcome, OpenChatOnTextRequest, TextService } from "@rosie/db/repo/chat-open";
import type {
  ArmClockOutcome as K05ArmClockOutcome,
  ArmClockRequest as K05ArmClockRequest,
  CancelClockOutcome as K05CancelClockOutcome,
  CancelClockRequest as K05CancelClockRequest,
} from "@rosie/db/repo/clocks";
import type { CommitTurnOutcome, CommitTurnRequest } from "@rosie/db/repo/commit-turn";
import type { HandleSealingKeyRequest, HandleSealingKeyResult } from "@rosie/db/repo/handle-keys";
import type {
  ClaimedRowV12,
  ClaimOutboxRequest as K05ClaimOutboxRequest,
  ClaimOutboxV12Outcome,
  ClaimOutboxV114Outcome,
  ClaimOutboxV114Request,
  MarkPartV12Outcome,
  MarkPartV12Request,
  MarkRowV12Outcome,
  MarkRowV12Request,
  RenewClaimOutcome,
  RenewClaimRequest as K05RenewClaimRequest,
  UnplannedRowsOutcome,
  UnplannedRowsRequest,
  WritePlanOutcome,
  WritePlanRequest as K05WritePlanRequest,
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
import {
  asListed,
  BundleReader,
  bundleIdOf,
  flowOf,
  keyOf,
  readManifest,
  sameBundle,
} from "../bundle/values";
import type {
  ArmClockAnswer,
  CancelClockAnswer,
  NotFoundError as ClockNotFoundError,
  QuestionFacts,
  TransientError as ClockTransientError,
} from "../clocks/types";
import type {
  ChatTarget,
  ClaimedRow,
  FinalParts as DispatchFinalParts,
  LinqAccepted,
  LinqFailed,
  LinqSendRequest,
  MarkPartResponse,
  OutboxStore,
  PlannedSend,
  RecipientDirectory,
  SendState,
  SendStateReader,
  TextsConsentRead,
} from "../dispatch/types";
import type { HandleRef } from "../gateway/seal";
import type { ChatOpenPort, InboundEvent, LinqPort, VerifyWebhookResult } from "../gateway/types";
import type { HandleTargetsAnswer, HandleTargetsPort } from "../guard/types";
import { MODELS_DOWN } from "../outage/ai";
import type {
  BundleSafety,
  DangerWordEntry,
  HandleDirectory,
  HandleIds,
  SafetyDeps,
  SafetyReadPort,
} from "../safety/types";
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
  RowsAnswer,
  TurnComposer,
  TurnDecide,
  TurnDirectory,
  TurnParty,
  WriteRowPlanAnswer,
} from "../turn/types";
import type {
  ArmingPort,
  ComposeInputPort,
  DataAccess,
  FinalizePort,
  FrontierPort,
  GatePort,
  LinqSend,
  Ports,
  SendStatePort,
  StateReads,
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
  /**
   * K-05 v1.7 openChatOnText with its database bound (T-1213), which the chat-open port sends each text's request to;
   * null or left out where no database is bound (the Worker until T-567), so every call fails closed and the gateway
   * answers 503 for a text that opens a chat.
   */
  readonly chatOpen?: OpenChatOnTextCall | null | undefined;
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
   * The state reads' inputs (T-1242; realStateReads): the bundle's safety lines, the handle's ids and stopped flag, the
   * turn's directory and each text's safety result, each null where none is bound (the Worker until the part of T-1154
   * that binds it), so each of its reads fails closed. Left out, every one is null.
   */
  readonly stateReads?: StateReadInputs | undefined;
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
   * K-05 v1.2's four outbox calls with their database bound (T-562), and v1.14's claim beside them where it is bound
   * (T-1356): null or left out where none is bound (the Worker until T-567), so every claim and mark fails closed and
   * nothing is sent.
   */
  readonly outbox?: OutboxCalls | null | undefined;
  /**
   * K-05 v1.2 sendState with its database bound (T-562): null or left out where none is bound (the Worker until T-567),
   * so every send-state read fails closed and nothing is sent.
   */
  readonly sendState?: SendStateCall | null | undefined;
  /**
   * K-05 v1's plan calls, unplannedRows and writePlan, with their database bound (T-1242; realDataAccess): null or left out
   * where none is bound (the Worker until the part of T-1154 that binds them), so every call fails closed.
   */
  readonly planCalls?: PlanCalls | null | undefined;
  /**
   * K-11 v1 sendPart with its Linq line bound (T-563): null or left out where no line is bound (the Worker until one is
   * handed in), so every send fails closed and nothing leaves.
   */
  readonly linqSend?: LinqSendCall | null | undefined;
  /**
   * What the clock arming reads and writes with its database bound (T-564): null or left out where none is bound (the
   * Worker until T-567), so every arming fails closed and nothing is armed.
   */
  readonly arming?: ArmingCalls | null | undefined;
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
    chatOpen: realChatOpen({ call: inputs.chatOpen ?? null }),
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
    stateReads: realStateReads(inputs.stateReads ?? NO_STATE_READ_INPUTS),
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
    dataAccess: realDataAccess({ calls: inputs.planCalls ?? null }),
    linqSend: realLinqSend({ call: inputs.linqSend ?? null }),
    arming: realArming({ calls: inputs.arming ?? null }),
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
  /** The same one call, with the handle's K-04 id its answer names (K-05 v1.2 item 29: handleId), for the chat open. */
  getOrCreateHandleKey(handle: HandleRef): Promise<{ key: CryptoKey; handleId: string }>;
}

/**
 * The handle's sealing key from K-05 v1.2 item 29 (get or create a handle's sealing key): new handle and person ids on
 * every call, never built from the address (an id built from it would meet 23505 on every retry once a number's keys were
 * erased twice); the wrapping key by its name; the data key as the key object K-05 hands over, never bytes, with the
 * handle's K-04 id the answer names where the caller asks for it (the gateway's chat open, T-1213). With no database
 * bound, a constraint or transient answer, or a handle kind K-04 does not hold, it throws: fails closed.
 */
export function realSealing(inputs: SealingInputs): KeyObjectStore {
  const newId = inputs.newId ?? ((): string => crypto.randomUUID());
  const handleKey = async (handle: HandleRef): Promise<{ key: CryptoKey; handleId: string }> => {
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
    return { key: answer.dataKey, handleId: answer.outcome.handleId };
  };
  return {
    async getOrCreateKey(handle) {
      return (await handleKey(handle)).key;
    },
    getOrCreateHandleKey: handleKey,
  };
}

// ---- chatOpen: K-05 v1.7 openChatOnText, a number's text opens its chat at receipt (T-1213; C-044; item 46) -----------

/** K-05 v1.7 openChatOnText (T-1212, db/repo/chat-open.ts) with its database bound, as rosie_job on the runtime side. */
export type OpenChatOnTextCall = (request: OpenChatOnTextRequest) => Promise<OpenChatOnTextOutcome>;

/** What the real chat-open port is fed: K-05's call with its database bound, or null where none is bound. */
export interface ChatOpenInputs {
  readonly call: OpenChatOnTextCall | null;
}

/** A service the gateway would never send (it sends none but Linq's three: ../gateway/chat-open.ts). Names no value. */
export class ChatOpenRequestError extends Error {
  constructor(what: string) {
    super(`openChatOnText takes no such request: ${what}`);
    this.name = "ChatOpenRequestError";
  }
}

/** Linq's three services, the ones K-05 v1.7 textService takes. */
function textServiceOf(service: string): TextService {
  if (service === "imessage" || service === "rcs" || service === "sms") return service;
  throw new ChatOpenRequestError("a service that is not imessage, rcs or sms");
}

/**
 * The chat-open port (T-1213): the gateway's ChatOpenPort over K-05 v1.7 openChatOnText (T-1212's db/repo call, bound as
 * (sql, request) over a rosie_job client by T-567). The gateway's request goes to K-05 field for field: the text's event
 * id, its handle's K-04 id (the key call's), the service, the receipt time and the trace, never the number, which K-05
 * reads from the handle's row. K-05's answer comes back as the gateway reads it: its result (inserted, opened,
 * alreadyOpen, stopped, repeated), or its error's name (notFound, notAPhone, transient), never the phone row, its entry or
 * a SQLSTATE. A throw passes through unchanged (db/repo throws a database error it names no answer for with its SQLSTATE,
 * table and constraint alone: T-1212's handoff; CQ-196), and the gateway answers 503 for it. With no call bound every call
 * fails closed (NoDatabaseError), so the gateway answers 503 and stores nothing. Nothing here logs.
 */
export function realChatOpen(inputs: ChatOpenInputs): ChatOpenPort {
  const { call } = inputs;
  return {
    async openChatOnText(request) {
      if (call === null) throw new NoDatabaseError("openChatOnText");
      const answer = await call({
        eventId: request.eventId,
        handleId: request.handleId,
        service: textServiceOf(request.service),
        receivedAt: request.receivedAt,
        traceId: request.traceId,
      });
      if ("error" in answer) return { error: answer.error };
      return { result: answer.result };
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

// ---- stateReads and dataAccess: the seams on staging (T-1242; T-1154's part P1b, DL-492) ---------------------------
//
// On staging the state reads and the plan calls are real ports (./picks.ts), each read over its own RootOptions input.
// The part of T-1154 that binds a reader hands it in as that one field of workerRoot's composeRoot call (./root.ts, on
// staging) and changes nothing else here or there; production keeps both ports closed, whatever it is handed. Until
// then workerRoot hands null, and null (or left out) fails closed at once, as every other staging input does: a named
// error that names the read and never a value (no number, no words, no id), with nothing read or written.
//
//   field              type               feeds; and what null does
//   bundleSafety       BundleSafetyLines  SafetyDeps.bundle (fixedLine, outcomeLine, dangerWords: synchronous), so the
//                                         safety read's danger words too, and the pin's check (checkPin, through
//                                         Root.pin: checkedPin). Null: each line read throws NoStateReadError, so the
//                                         safety read fails before any model call, and the pin refuses every bundle.
//   handleDirectory    HandleDirectory    SafetyDeps.directory.idsOf. Null: NoStateReadError("idsOf").
//   stoppedFlags       StoppedFlagRead    SafetyDeps.isStopped. Null: NoStateReadError("isStopped").
//   turnDirectory      TurnDirectory      TurnDeps.directory.partyOf. Null: NoStateReadError("partyOf"), so the run ends
//                                         noDirectory before anything is opened, read or written.
//   planCalls          PlanCalls          TurnDeps.rows.unplannedRows and writePlan: db/repo/outbox.ts's K-05 v1 calls,
//                                         `(request) => unplannedRows(sql, request)` and `(request) => writePlan(sql,
//                                         request)` over a rosie_job client. Null: NoDatabaseError("unplannedRows" or
//                                         "writePlan"), so no row of the turn is listed, composed or planned.
//
// The state reads are typed as the ports they feed (../safety/types.ts, ../turn/types.ts), since no K-05 call names them
// yet (T-1240 freezes the party read); the plan calls as db/repo's K-05 calls, as every K-05 call the root is handed.
// Each text's safety result is none of them: T-1241's record (ADR-015) keeps it in the handle's own actor, and the turn
// reads it from its leased turn (T-1264). The test environment binds the fake set's state reads and rows
// (./test-support.ts), so it never asks the pin's check.

/**
 * A state read asked for where none is bound (staging, until the part of T-1154 that binds it hands its reader in). The
 * message names the read only: never a number, a word or an id.
 */
export class NoStateReadError extends Error {
  constructor(read: string) {
    super(`no ${read} read is bound here`);
    this.name = "NoStateReadError";
  }
}

/** What the pin's check is asked about: the bundle a turn would pin, and the bound bundle port the pin reads it through. */
export interface PinCheckRequest {
  /** The active bundle id K-05 readActiveBundle answered, of K-01's form, its manifest key K-01's for it. */
  readonly bundleId: BundleId;
  /**
   * The bound bundle port (K-05 v1 item 7's reads; T-556): the reads the pin itself makes, for the bundle's manifest and
   * flow graphs. Its KV is left out, as the pin's is: the pin reads the actor's own BUNDLES binding first.
   */
  readonly bundles: BundleDeps;
}

/**
 * The bundle's safety lines (DL-341, DL-351): the safety read's BundleSafety over the pinned bundle's K-01 v1 lines (its
 * fixed lines by id, each outcome step's checked line, its shared lists' danger words; synchronous: ../safety/types.ts),
 * bundle-backed, and the pin's check of each bundle a turn would pin.
 */
export interface BundleSafetyLines extends BundleSafety {
  /**
   * The pin's check (../bundle/pin.ts, through Root.pin): asked once at each turn's pin that reads the active bundle id
   * (a turn's first run; a rerun keeps the id its turn stored, which this check let through), after K-05's answer and
   * before the pin stores the id for the turn. Resolves: the pin goes on. Rejects: the bundle is refused (one whose
   * safetyEmergency, safetyCrisis or safetyAsk line has no words, or whose A3-49 line holds no hotline), so nothing is
   * pinned or stored for the turn, its work does not start, and the lease's next run asks again.
   */
  checkPin(request: PinCheckRequest): Promise<void>;
}

/** The handle's stopped flag, as the outage line asks it (SafetyDeps.isStopped; arch 11 line 566), by actor name. */
export type StoppedFlagRead = SafetyDeps["isStopped"];

/** What the real state-reads port is fed: each input, or null where none is bound, so each of its reads fails closed. */
export interface StateReadInputs {
  readonly bundleSafety: BundleSafetyLines | null;
  readonly handleDirectory: HandleDirectory | null;
  readonly stoppedFlags: StoppedFlagRead | null;
  readonly turnDirectory: TurnDirectory | null;
}

/** Every state read with none bound: each fails closed. */
const NO_STATE_READ_INPUTS: StateReadInputs = {
  bundleSafety: null,
  handleDirectory: null,
  stoppedFlags: null,
  turnDirectory: null,
};

/** The handle's party as the turn reads it, field for field: its K-04 id, business, person and zone, nothing more. */
function turnPartyOf(party: TurnParty): TurnParty {
  return {
    handleId: party.handleId,
    businessId: party.businessId,
    personId: party.personId,
    zone: party.zone,
  };
}

/** The handle's ids as K-09's calls name them, field for field: nothing more. */
function handleIdsOf(ids: HandleIds): HandleIds {
  return {
    handleId: ids.handleId,
    businessId: ids.businessId,
    personId: ids.personId,
    bookingId: ids.bookingId,
  };
}

/**
 * The state-reads port (T-1242): each read through the input the root is handed for it (StateReadInputs; the table above).
 * The bundle's lines and the stopped flag go back as their input gives them; the party and the handle's ids go back field
 * for field, so a reader that answers a row with more in it hands the turn and the safety read nothing more. With an input
 * null, its reads fail closed at once (NoStateReadError naming the read): a bundle line's read throws, being synchronous,
 * and every other read rejects. Nothing here logs: a request names a handle's number.
 */
export function realStateReads(inputs: StateReadInputs): StateReads {
  const { bundleSafety, handleDirectory, stoppedFlags, turnDirectory } = inputs;
  const none = (read: string): Promise<never> => Promise.reject(new NoStateReadError(read));
  const noneNow = (read: string): never => {
    throw new NoStateReadError(read);
  };
  return {
    safety: {
      directory: {
        async idsOf(actorName) {
          if (handleDirectory === null) throw new NoStateReadError("idsOf");
          const ids = await handleDirectory.idsOf(actorName);
          return ids === null ? null : handleIdsOf(ids);
        },
      },
      bundle: {
        fixedLine: (id) => (bundleSafety === null ? noneNow("fixedLine") : bundleSafety.fixedLine(id)),
        outcomeLine: (outcome) =>
          bundleSafety === null ? noneNow("outcomeLine") : bundleSafety.outcomeLine(outcome),
        dangerWords: () => (bundleSafety === null ? noneNow("dangerWords") : bundleSafety.dangerWords()),
      },
      isStopped: (actorName) => (stoppedFlags === null ? none("isStopped") : stoppedFlags(actorName)),
    },
    turn: {
      directory: {
        async partyOf(request) {
          if (turnDirectory === null) throw new NoStateReadError("partyOf");
          const party = await turnDirectory.partyOf(request);
          return party === null ? null : turnPartyOf(party);
        },
      },
    },
  };
}

/**
 * The active bundle id the pin itself would take from K-05's answer (pin.ts readActive: K-01's form, its manifest under
 * K-01's key), or null for an answer the pin refuses on its own.
 */
function activeIdOf(answer: unknown): BundleId | null {
  if (typeof answer !== "object" || answer === null) return null;
  const fields = answer as Record<string, unknown>;
  if (fields.result !== "active") return null;
  const bundleId = bundleIdOf(fields.bundleId);
  if (bundleId === null || fields.manifestKey !== keyOf(bundleId, "manifest")) return null;
  return bundleId;
}

/**
 * What the turn's pin reads through where the state reads are real (Root.pin; DL-341, DL-351): the bound bundle port, with
 * the bundle's safety lines' check (BundleSafetyLines.checkPin) asked for each active bundle id the pin would take, after
 * K-05 answers it and before the pin stores it for the turn. A bundle the check refuses (it rejects), or any bundle while
 * no safety lines are bound (NoStateReadError "checkPin"), is never pinned: the read rejects, so the pin fails as for any
 * read that fails (its lease span's code is noAnswer, ../bundle/pin.ts), nothing is stored for the turn, its work does not
 * start, and the lease's next run pins again. An answer the pin would refuse itself (no active bundle, transient, or not
 * K-05's form) goes back as it came, so the pin's own code stands; every value read goes to the bundle port as it is.
 */
export function checkedPin(bundles: BundleDeps, lines: BundleSafetyLines | null): BundleDeps {
  const { registry } = bundles;
  return {
    ...(bundles.kv === undefined ? {} : { kv: bundles.kv }),
    registry: {
      async readActiveBundle(request) {
        const answer = await registry.readActiveBundle(request);
        const bundleId = activeIdOf(answer);
        if (bundleId === null) return answer;
        if (lines === null) throw new NoStateReadError("checkPin");
        await lines.checkPin({ bundleId, bundles });
        return answer;
      },
      readBundleValue: (request) => registry.readBundleValue(request),
    },
  };
}

/** K-05 v1 unplannedRows (T-196, db/repo/outbox.ts) with its database bound (the primary, as rosie_job). */
export type UnplannedRowsCall = (request: UnplannedRowsRequest) => Promise<UnplannedRowsOutcome>;

/** K-05 v1 writePlan (T-196, db/repo/outbox.ts) with its database bound (the primary, as rosie_job). */
export type WritePlanCall = (request: K05WritePlanRequest) => Promise<WritePlanOutcome>;

/** K-05 v1's plan calls with their database bound: what the root is handed (RootOptions.planCalls). */
export interface PlanCalls {
  readonly unplannedRows: UnplannedRowsCall;
  readonly writePlan: WritePlanCall;
}

/**
 * The data-access port (T-1242): the turn's plan calls (../turn/types.ts TurnRows, less its park, which is the turn-row
 * port's) over K-05 v1's unplannedRows and writePlan, the calls the root is handed (RootOptions.planCalls). Each request
 * goes to K-05 field for field, and each answer comes back as K-05 gives it, which the turn checks itself (compose.ts).
 * With no calls bound every call fails closed (NoDatabaseError) before anything is read or written. Nothing here logs: a
 * plan holds a person's words.
 */
export function realDataAccess(inputs: { readonly calls: PlanCalls | null }): DataAccess {
  const { calls } = inputs;
  return {
    rows: {
      async unplannedRows(request) {
        if (calls === null) throw new NoDatabaseError("unplannedRows");
        // The same K-05 v1 unplannedRows answer in two hand-written forms: db/repo's, and the turn's (../turn/types.ts),
        // which reads each row's fields and checks them itself (compose.ts listedOf).
        const answer: unknown = await calls.unplannedRows({ turnId: request.turnId });
        return answer as RowsAnswer;
      },
      async writePlan(request) {
        if (calls === null) throw new NoDatabaseError("writePlan");
        // The same K-05 v1 writePlan exchange in two hand-written forms: the turn's (../turn/types.ts, which builds the
        // request and reads the answer) and the generated one db/repo/outbox.ts takes, checks and answers.
        const answer: unknown = await calls.writePlan({
          outboxRowId: request.outboxRowId,
          expectVersion: request.expectVersion,
          plan: request.plan,
          finalParts: request.finalParts,
        } as unknown as K05WritePlanRequest);
        return answer as WriteRowPlanAnswer;
      },
    },
  };
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
  /**
   * The safety service's SafetyDeps.words (T-1242; T-1176): K-01 v1's fixed lines word for word from the pinned bundle,
   * for the danger question a record's line carries (safetyAsk's). A later part of T-1154 fills it; left out, as in the
   * test environment, the service has none, so a record whose line asks it answers notBuilt and one that asks nothing
   * never reads it.
   */
  readonly words?: SafetyWords;
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
          ...(reads?.words === undefined ? {} : { words: reads.words }),
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
 * (T-567 binds them). Only these four, and v1.14's claim beside them: T-196's v1 claimOutbox, markPart and markRow write no
 * claim row and answer v1's shapes, so a v1 call beside them would let a v1.2 claim take a row again at once (K-05 default
 * 20; DL-317). Each call's answer type is the v1.2 call's own, so a v1 call cannot be bound here.
 *
 * claimOutboxV114 is K-05 v1.14's claim (T-1354, db/repo/outbox.ts; README item 67), bound as `(request) =>
 * claimOutboxV114(sql, request)` on the same client (T-1356): the one call that carries the claim's sendClass, the
 * safety-only claim of a danger line's own wake (T-1352). It writes what claimOutboxV12 writes (the same moves, part keys
 * and claim rows), so it is no v1 call. Bound, the port makes every claim through it, and a claim without the field is
 * v1.13's, which is claimOutboxV12's claim with each row's emailPurpose and notAfter added (db/repo default 24: it runs
 * claimOutboxV113 as it is); claimOutboxV12 is then not called. Left out, a claim without the field goes to
 * claimOutboxV12 as before, and a claim with it is refused, since claimOutboxV12 cannot carry it (realOutbox).
 */
export interface OutboxCalls {
  readonly claimOutboxV12: (request: K05ClaimOutboxRequest) => Promise<ClaimOutboxV12Outcome>;
  readonly claimOutboxV114?:
    ((request: ClaimOutboxV114Request) => Promise<ClaimOutboxV114Outcome>) | undefined;
  readonly renewClaim: (request: K05RenewClaimRequest) => Promise<RenewClaimOutcome>;
  readonly markPartV12: (request: MarkPartV12Request) => Promise<MarkPartV12Outcome>;
  readonly markRowV12: (request: MarkRowV12Request) => Promise<MarkRowV12Outcome>;
}

/**
 * What the real outbox port is fed: K-05's four calls, and v1.14's claim where it is bound, with their database bound, or
 * null where none is bound.
 */
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

/**
 * A claim that names a send class (K-05 v1.14 item 67's sendClass: a danger line's safety run, T-1352) where the bound
 * calls cannot carry it: no v1.14 claim is bound (OutboxCalls.claimOutboxV114). It is refused before any call, so nothing
 * is claimed; it is never made without the field, as a claim of every class (RULES 7.2; T-1352's rulings, condition 3).
 * Names the field, never a value.
 */
export class SendClassNotCarriedError extends Error {
  constructor() {
    super(
      "the bound outbox calls cannot carry the claim's sendClass (no K-05 v1.14 claim): nothing is claimed",
    );
    this.name = "SendClassNotCarriedError";
  }
}

/**
 * The bound claim a dispatcher's claim goes to (T-562, T-1356), its four v1.2 fields as they came: claimOutboxV114 where
 * it is bound, with the request's sendClass as it came whenever the request carries one (any value: db/repo refuses one
 * that is not safety, default 133), so the field is never dropped; else claimOutboxV12, for a claim without the field
 * alone. A claim with the field and no v1.14 claim bound is refused (SendClassNotCarriedError) before any call. v1.13's
 * answer is v1.2's with two fields added to each row, so it is read as v1.2's here.
 */
function claimThrough(
  calls: OutboxCalls,
  request: Parameters<OutboxStore["claimOutbox"]>[0],
): Promise<ClaimOutboxV12Outcome> {
  const v12: K05ClaimOutboxRequest = {
    claimer: request.claimer,
    ...(request.recipientHandleId === undefined ? {} : { recipientHandleId: request.recipientHandleId }),
    now: request.now,
    limit: request.limit,
  };
  const { sendClass } = request;
  if (calls.claimOutboxV114 !== undefined) {
    return calls.claimOutboxV114(sendClass === undefined ? v12 : { ...v12, sendClass });
  }
  if (sendClass === undefined) return calls.claimOutboxV12(v12);
  return Promise.reject(new SendClassNotCarriedError());
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
 * The outbox port (T-562): the dispatcher's OutboxStore (runtime/src/dispatch) over K-05 v1.2's four outbox calls, and
 * v1.14's claim where it is bound (T-1356). Each request goes to its call as it is; each answer comes back in the
 * dispatcher's shapes:
 *   - claimOutbox: claimOutboxV114 where it is bound, else claimOutboxV12 (claimThrough). A claim with K-05 v1.14's
 *     sendClass (item 67: a danger line's safety run, T-1352) goes to claimOutboxV114 with the field as it came, never
 *     without it; where no v1.14 claim is bound it is refused before any call (SendClassNotCarriedError), so nothing is
 *     claimed, never a claim of every class in its place (RULES 7.2; T-1352's rulings, condition 3). A claim without the
 *     field goes as v1.2's request, its four fields as they came: through claimOutboxV114 it is v1.13's claim, unchanged
 *     (db/repo default 24). A transient answer comes back as it is, the safety claim's lock wait past its bound (55P03,
 *     db/repo default 22) among them, so the danger wake repeats it (the dispatcher's untilNotTransient). Each claimed row
 *     is handed on with its claim, the state it was claimed from, its port (linq or email: v1.2 item 30), and the final
 *     parts finalize wrote into it (K-03's options as their labels); a v1.13 row's emailPurpose and notAfter are not
 *     mapped here (T-1288 maps them), so the dispatcher reads both as missing, no purpose and no end, as from
 *     claimOutboxV12;
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
      const answer = await claimThrough(calls, request);
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
      // A throw of markPartV12 (a delivered part try with no delivery time: db/repo outbox.ts default 21) is not caught
      // here: it is no answer, so it reaches the dispatcher's caller as it is and the receipt is not answered as done.
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
        // K-05 v1.9 item 48, as the store gives it: what a repeated delivery receipt repeats, null on every other
        // answer. Nothing is derived here; the dispatcher reads it (T-1228).
        repeatedDelivery: answer.repeatedDelivery,
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

/**
 * K-05 v1.2 sendState (T-220, db/repo/send-state.ts), answered since v1.8 with item 47's fromContact and bookingId
 * (T-1216), with its database bound, as rosie_job on the runtime side. Typed as any version's answer (SendStateOutcome),
 * so one of v1.2 to v1.7, with neither field, is read too: as not known.
 */
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
 * K-05's covering texts row as limit 8 reads it (dispatch/types.ts TextsConsentRead; item 28, default 35), field for
 * field. v1.8's fromContact and bookingId (item 47; T-1216) go across unchanged when the answer holds them, and are left
 * out when it does not (an answer of v1.2 to v1.7), so limit 8 reads them as not known and no yes lifts a stop (its
 * notKnown). A value of neither field's type is no K-05 answer at all, so it is left out too: never read as a yes. Nothing
 * is derived here: not who gave the yes, not its booking, and never the stop or its end (STATE note 10; default 84).
 */
function textsConsentOf(row: NonNullable<SendStateResponse["textsConsent"]>): TextsConsentRead {
  const { fromContact, bookingId } = row;
  return {
    consentId: row.consentId,
    businessId: row.businessId,
    revoked: row.revoked,
    at: row.at,
    ...(typeof fromContact === "boolean" ? { fromContact } : {}),
    ...(bookingId === null || typeof bookingId === "string" ? { bookingId } : {}),
  };
}

/**
 * K-05's send state as limit 8 reads it (dispatch/types.ts SendState). The phone row's stopped flag and stop time and the
 * texts consent row go across unchanged, v1.8's fromContact and bookingId with it (item 47; T-1217), left out when the
 * answer has none: the stopped flag is the phone's alone, never derived from a consent row (STATE note 10; T-1099; K-05
 * default 84). Limit 8 then lifts a stop only on the person's own yes (fromContact true) newer than the stop: for a row
 * about the booking it names, or for every row on START's yes for every business (yesAfterStop, T-1099); a yes whose
 * record does not say who gave it or for which booking lifts nothing (notKnown). With no phone row (an email handle, or
 * a number whose first turn wrote none) no open chat is known: the row waits for the chat (MC C9), whatever its class,
 * since a phone with no open chat lets nothing out. With no business K-05 gives no zone and no text hours: each goes as
 * an empty value, which limit 8 cannot read, so a routine row is unreadable and nothing is sent (fail closed).
 */
export function sendStateOf(answer: SendStateResponse): SendState {
  const { phone } = answer;
  return {
    stopped: phone?.stopped ?? false,
    stopAt: phone?.stopAt ?? null,
    textsConsent: answer.textsConsent === null ? null : textsConsentOf(answer.textsConsent),
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

// ---- linqSend: K-11 v1 sendPart, each part the dispatcher sends (T-563; C-124; C-206, C-211) ---------------------------

/**
 * K-11 v1 sendPart with its Linq line bound (T-563): one part into an existing chat, in K-11's request and answer shapes as
 * the dispatcher writes and reads them (../dispatch/types.ts). The Linq adapter's send on a real line (C-206; J-08), or,
 * in a test, @rosie/adapters' Linq double (T-411; C-211), which records each part once per idempotency key.
 */
export type LinqSendCall = (request: LinqSendRequest) => Promise<LinqAccepted | LinqFailed>;

/** What the real Linq send port is fed: the Linq line, or null where none is bound. */
export interface LinqSendInputs {
  readonly call: LinqSendCall | null;
}

/** A send where no Linq line is bound (the Worker until one is handed in). The message names the call only. */
export class NoLinqLineError extends Error {
  constructor() {
    super("no Linq line is bound here for sendPart");
    this.name = "NoLinqLineError";
  }
}

/** The request as K-11 v1 sendPart takes it: its fourteen fields, each copied, nothing added. */
function linqRequestOf(request: LinqSendRequest): LinqSendRequest {
  return {
    idempotencyKey: request.idempotencyKey,
    to: request.to,
    chatId: request.chatId,
    service: request.service,
    kind: request.kind,
    text: request.text,
    calendarFile:
      request.calendarFile === null
        ? null
        : {
            action: request.calendarFile.action,
            fileName: request.calendarFile.fileName,
            ics: request.calendarFile.ics,
          },
    options: [...request.options],
    link: request.link,
    photo: null,
    tapback: null,
    threadedReplyTo:
      request.threadedReplyTo === null ? null : { messageId: request.threadedReplyTo.messageId },
    typing: null,
    overrideOptout: request.overrideOptout,
  };
}

/**
 * An answer K-11 does not name, read as no answer (K-11 transient with no status): the dispatcher keeps the part pending
 * under its own key (K-07 rule 1), and Linq answers a repeat of the key with the first message, so nothing goes twice.
 */
const NO_ANSWER: LinqFailed = {
  result: "failed",
  kind: "transient",
  httpStatus: null,
  code: "noAnswer",
  reason: "the Linq line gave no answer K-11 names",
  retryAfterSeconds: null,
  providerMessageId: null,
};

const FAILURE_KINDS: readonly LinqFailed["kind"][] = [
  "optedOut",
  "mayStillDeliver",
  "rateLimited",
  "refused",
  "transient",
];

const SERVICES: readonly string[] = ["imessage", "rcs", "sms"];

const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const numberOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const isFailureKind = (value: unknown): value is LinqFailed["kind"] =>
  typeof value === "string" && (FAILURE_KINDS as readonly string[]).includes(value);
const isService = (value: unknown): value is LinqAccepted["service"] =>
  value === null || (typeof value === "string" && SERVICES.includes(value));
const isTextList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * The line's answer as K-11 v1 gives it, field for field: accepted with its message id, chat, service and time, or failed
 * with its kind, status, code, reason, Retry-After and message id. Anything else is no answer (NO_ANSWER).
 */
function linqAnswerOf(answer: unknown): LinqAccepted | LinqFailed {
  if (typeof answer !== "object" || answer === null) return NO_ANSWER;
  const given = answer as Record<string, unknown>;
  if (
    given.result === "accepted" &&
    textOrNull(given.providerMessageId) &&
    (given.providerOptionIds === null || isTextList(given.providerOptionIds)) &&
    typeof given.chatId === "string" &&
    isService(given.service) &&
    typeof given.acceptedAt === "string"
  ) {
    return {
      result: "accepted",
      providerMessageId: given.providerMessageId,
      providerOptionIds: given.providerOptionIds === null ? null : [...given.providerOptionIds],
      chatId: given.chatId,
      service: given.service,
      acceptedAt: given.acceptedAt,
    };
  }
  if (
    given.result === "failed" &&
    isFailureKind(given.kind) &&
    numberOrNull(given.httpStatus) &&
    textOrNull(given.code) &&
    typeof given.reason === "string" &&
    numberOrNull(given.retryAfterSeconds) &&
    textOrNull(given.providerMessageId)
  ) {
    return {
      result: "failed",
      kind: given.kind,
      httpStatus: given.httpStatus,
      code: given.code,
      reason: given.reason,
      retryAfterSeconds: given.retryAfterSeconds,
      providerMessageId: given.providerMessageId,
    };
  }
  return NO_ANSWER;
}

/**
 * The Linq send port (T-563): the dispatcher's LinqPort over the Linq line (RootOptions.linqSendCall). Each part the
 * root's Linq door lets through (a row whose claim names the linq port, within the send's time limit: ./linq-door.ts)
 * goes to the line as K-11 v1 sendPart, field for field, under its K-07 key '<row>/<part>/<try>', so the line answers a
 * repeated key with its first answer and the person gets one message (K-11 'Repeating it'). The answer comes back as K-11
 * gives it, which the dispatcher marks and its retry rules read (T-258): no answer, the same key; a reported failure, a
 * new key; 4001 or 4006, a new key only after a minute with no receipt; 403 2024, never again on Linq. An answer K-11 does
 * not name is no answer (the same key). With no line bound every send fails closed (NoLinqLineError) before anything
 * leaves. Nothing here logs: a request holds a number and a person's words.
 */
export function realLinqSend(inputs: LinqSendInputs): LinqSend {
  const { call } = inputs;
  return {
    parts: {
      async sendPart(request) {
        if (call === null) throw new NoLinqLineError();
        const answer: unknown = await call(linqRequestOf(request));
        return linqAnswerOf(answer);
      },
    },
  };
}

// ---- arming: the clock arming at a part's first delivery receipt (T-564; C-055; K-05 v1 item 5) ------------------------

/**
 * What the clock arming reads and writes with its database bound (T-564), on the runtime side, as rosie_job:
 *   - K-05 v1 item 5's armClock and cancelClock (T-197, db/repo/clocks.ts, each called as (sql, request));
 *   - the question's facts the due rule reads (T-255's QuestionFacts: the Clock line as it applies, its business's zone,
 *     its visit, its never-delivered row), which no K-05 call returns yet (K-05 open gap 25), read here as one call;
 *   - the actor name of a K-04 handle (actorNameOf over its kind and address, as the gateway names the handle's actor),
 *     or null when K-04 holds no such handle.
 */
export interface ArmingCalls {
  readonly armClock: (request: K05ArmClockRequest) => Promise<K05ArmClockOutcome>;
  readonly cancelClock: (request: K05CancelClockRequest) => Promise<K05CancelClockOutcome>;
  readonly questionFacts: (
    openQuestionId: string,
  ) => Promise<QuestionFacts | ClockNotFoundError | ClockTransientError>;
  readonly actorNameOf: (handleId: string) => Promise<string | null>;
}

/** What the real arming port is fed: the arming's calls with their database bound, or null where none is bound. */
export interface ArmingInputs {
  readonly calls: ArmingCalls | null;
}

/**
 * The arming port (T-564): what T-255's clock arming reads and writes (ArmingOptions' data, facts and directory) over the
 * calls the root is handed (RootOptions.armingCalls). armClock arms the question's clock row with the due time the due
 * rule gave and opens its question in one transaction, a repeat answering its first arming (a later receipt never moves
 * the row); cancelClock cancels the question's never-delivered row once it is delivered. Each request goes to K-05 as the
 * arming made it, and each answer comes back as K-05 gives it, which the arming checks field by field. With no database
 * bound every call fails closed (NoDatabaseError) before anything is read or written: the arming reports that it failed,
 * and nothing is armed. Nothing here logs: a question's facts can hold a visit's address.
 */
export function realArming(inputs: ArmingInputs): ArmingPort {
  const { calls } = inputs;
  const none = (call: string): Promise<never> => Promise.reject(new NoDatabaseError(call));
  return {
    data: {
      armClock: (request): Promise<ArmClockAnswer> =>
        calls === null ? none("armClock") : calls.armClock(request),
      cancelClock: (request): Promise<CancelClockAnswer> =>
        calls === null ? none("cancelClock") : calls.cancelClock(request),
    },
    facts: {
      questionFacts: (openQuestionId) =>
        calls === null ? none("questionFacts") : calls.questionFacts(openQuestionId),
    },
    directory: {
      actorNameOf: (handleId) => (calls === null ? none("actorNameOf") : calls.actorNameOf(handleId)),
    },
  };
}
