// The composition root (T-550; C-046, C-044; build prompt section 10, D-017 'Joins: one hop at a time, in the turn order
// of What changes'; ops/plan/02-contracts.md section 11): the one place that builds the Worker's gateway, the handle
// actor's turn and the outbox dispatcher, with each of the twenty-one ports of ./ports.ts bound once to the
// implementation its environment picks (./picks.ts, checked by ./bind.ts). Each join (T-552 to T-564) swaps one port's
// pick for the real package; nothing else here changes for it.
//
// What the root builds from the ports:
//
//   - the gateway's doors (runtime/src/gateway GatewayDeps): the Linq verify port, the sealing key store, the door to the
//     handle's actor (the HandleActor namespace it is handed; closed when it is handed none), the receipt door, and the
//     active bundle id each webhook's trace names (K-08 v1 README default 1);
//   - the Linq webhook route behind the skeleton flag (T-552, ./skeleton.ts): while the flag is on, the gateway's Linq
//     entry with those doors; while it is off (or no flags are bound), 404 with nothing read, verified or reached;
//   - the handle actor's ports, put in place for the isolate by `install()`: the safety read on arrival (T-246), the
//     batch clock (T-247), the bundle pin's reads (T-249; the bundle port, joined by T-556, so the guard's keyword list is
//     the pinned bundle's; where the state reads are real, behind the bundle's safety lines' check, so a bundle they
//     refuse is never pinned: T-1242, DL-341, DL-351), the guard's targets (T-250; the targets port, joined by T-556), the
//     turn loop as the lease's hooks (T-248, T-251 to T-253), each run's pinned bundle kept for its frontier and gate
//     (./pinned-runs.ts, T-557) and its last text's service and chat id for its gate (./turn-chats.ts, T-559), and the
//     turn's ports (`TurnDeps`, its frontier the frontier port, joined by T-557, its gate and commit the gate port, joined
//     by T-559), the Durable Object reading each at use;
//   - the outbox dispatcher (T-257), which the turn wakes once its rows are composed (T-252): one claim-and-send run for
//     the turn's recipient, each claimed row on the turn's trace;
//   - the receipt door: a delivery receipt marks its part delivered and arms its question's clock (T-255) through the
//     arming port (T-564), on the trace its row was sent on when this isolate knows it (./row-traces.ts), else on the
//     receipt's own;
//   - the gateway's page entry (T-266): on staging, when the root is handed their inputs, the test-phone page's two calls
//     (T-1186, ./test-phone), T-565's handlers over the session, roster and phone reads and staging's test-phone line,
//     which posts through the Linq route above; every other page call stays unconfigured (503).
//
// The Worker (runtime/src/index.ts) takes its gateway from `workerRoot(env)`: the real set (./real.ts, what the joins
// have bound: the Linq verify reading LINQ_WEBHOOK_SECRET by name; the ports K-05's calls feed, which no database client
// feeds there until T-1154's parts bind them over T-567's Hyperdrive binding, so every seal, chat open, commit, park,
// pin, targets read, frontier, gate, compose input, finalize, claim, send-state read and arming fails closed; the model
// ports, which no safety reader, decider or composer feeds there until those parts build them from the bundle's
// manifest and the model key (J-02), so every safety read, decide and compose fails closed before any model call; the
// Linq send, which no line feeds there yet; and the state reads and the plan calls (T-1242), which no reader feeds
// there until those parts hand theirs in, so each read fails closed and no bundle is pinned) and the closed set are at
// hand there, so every door not joined fails and a webhook that gets past the verify answers 503, as before. A test
// composes the root with environment "test", the fakes (./test-support.ts), what the joined ports are fed
// (the Linq double's made-up webhook secret, the K-05 double's handleSealingKey, commitTurn, parkTurn, bundle reads,
// handleTargets and the frontier's readTurnState scope, @rosie/ai's deciders over the recorded-model double, and the
// gate's reads over the K-05 doubles), the HandleActor namespace, its flags and its own clock.
// The turn's park goes through the turn-row port (T-555): K-05's parkTurn writes the turn's one row under the turn id the
// lease hashed from its batch's event ids. The turn's pin reads its bundle through the bundle port, and the guard its
// targets through the targets port (T-556). The turn's frontier goes through the frontier port (T-557): @rosie/actions'
// turn face over the frontier's scope, reading the bundle the run pinned. Where that port binds real, its Tool API base
// records the frontier span and the turn records none (TurnFace.recordsFrontierSpan; CQ-159), so the hop is recorded
// once; each later join whose port records its own hop's span sets that hop's flag the same way. The turn's decide and
// its one re-read go through the decide port (T-558): @rosie/ai's decider for the turn's bundle, one per bundle for both,
// which records only its model calls' portCall spans, so the turn keeps recording the decideReads and reread spans and
// no flag is set for them. The turn's gate and commit go through the gate port (T-559): @rosie/actions' turn face over
// the gate's reads (RootOptions.gateReads), the run's pinned bundle and the turn-row port's commitTurn, under the turn id;
// the root puts the service and Linq chat id of the run's last text on the request's turn, copied from its K-06 event
// (./turn-chats.ts; K-09 v1.5 default 135), and the turn keeps recording the gate and commit spans while the Tool API
// base records none (TURN_RECORDS_GATE; DL-376), so no flag is set for them either. Each committed row's compose input
// goes through the compose-input port (T-560): @rosie/actions' turn face over compose input's reads
// (RootOptions.composeReads) and the run's pinned bundle, its inbound text the words the turn's gate request handed in,
// as the gate port's face holds them; and its plan, and its one rewrite, through the composer port (T-560): @rosie/ai's
// composer for the turn's bundle (RootOptions.composers), which records only its model calls' portCall spans. Each plan
// is finalized through the finalize port (T-561): @rosie/actions' turn face over finalize's reads and writes
// (RootOptions.finalizeData) and the run's pinned bundle, which fills its slots, adds its fixed lines, runs the claim
// check and the message checks, and writes the plan and the final parts into the row (T-196's writePlan), or asks for the
// one rewrite, then the step's fallback. The turn records the compose span and every fillAndChecks and rewriteOrFallback
// span while the Tool API base records none (TURN_RECORDS_FILL_AND_CHECKS; DL-376), so no flag is set for them. The
// dispatcher the turn wakes claims and marks through the outbox port (T-562: K-05 v1.2's claimOutboxV12, renewClaim,
// markPartV12 and markRowV12 over RootOptions.outboxCalls), so the committed row is claimed once, in commit order, with the
// final parts finalize wrote, and reads limit 8's send state and the recipient's chat through the send-state port (T-562:
// K-05 v1.2 sendState over RootOptions.sendStateCall) before any send; the receipt door marks a part delivered through the
// same outbox port. The root's Linq door (./linq-door.ts) lets only a row whose claim names the linq port reach the Linq
// port, each send within a time limit far below the claim's 60 s. The dispatcher records the dispatch span itself. A
// number's text opens its chat at receipt through the chat-open port (T-1213: K-05 v1.7 openChatOnText over
// RootOptions.chatOpenCall), the gateway's call after the key call and before the actor, with the handle's K-04 id the
// key call answered, so the phone row limit 8 reads at send holds the chat open. Each part the Linq door lets through goes
// to the Linq line through the Linq send port (T-563: K-11 v1 sendPart over RootOptions.linqSendCall, @rosie/adapters'
// Linq double in a test) under its K-07 key '<row>/<part>/<try>', so a part sent again under its key is one message. A
// row the dispatcher leaves waiting for its next try goes on the retry queue (T-258's retries, joined here: DL-315), as
// T-256's producer puts it on RootOptions.retryQueue (the RETRY_QUEUE binding in the Worker); when the job comes due, the
// queue's consumer hands it to the dispatcher's send door (`install()` sets the queue's ports), which runs the
// recipient's rows again with the same ports, each row on the trace this isolate sent it on, else on its own trace id: no
// answer, the same key under a re-claim about 60 s later; 4001 or 4006, a new key only after a minute with no receipt; no
// new job once 15 minutes of tries have passed (CQ-152). A delivery receipt reaches the receipt door, which marks its
// part delivered through the outbox port and hands each part K-05 newly marked delivered to T-255's clock arming over
// the arming port (T-564: K-05 v1 item 5's armClock and cancelClock, the question's facts and the actor name of a handle,
// over RootOptions.armingCalls): at the row's first delivery its question's clock row arms at step 9's due time (arch 02
// line 127), the handle's actor is told, and the clockArmed span goes on the trace the row was sent on. The question's
// never-delivered row is its commit's own (STATE note 37): the arming only cancels one the commit made. The checked safety
// line the actor sends straight through Linq while PostgreSQL is down is a port of its own (linqDirect), which no hop
// joins. Never logged by the root: a word, a number, a key, a chat id.

import { setBatchHooks } from "../actor/batch";
import { setLeaseHooks } from "../actor/lease";
import { setBundleDeps } from "../bundle/pin";
import type { BundleDeps, BundleRegistry } from "../bundle/types";
import { actorOf } from "../clocks/actors";
import { ArmingMemory, clockArming } from "../clocks/arming";
import type { ClockActorRpc, ClockActors, ClockDirectory } from "../clocks/types";
import { handleDeliveryReceipt, runDispatch, type DispatchDeps } from "../dispatch/dispatcher";
import { dispatchSendDoor, queueRetries, retryBodyOf } from "../dispatch/retry";
import type { ClaimedRow } from "../dispatch/types";
import { durableObjectActor, type HandleActorRpc } from "../gateway/actor-door";
import { readBundleId, type WebhookEnvironment } from "../gateway/answer";
import { unconfiguredPages } from "../gateway/pages";
import type { ActorHandoff, ActorStub, GatewayDeps, ReceiptSink } from "../gateway/types";
import { setGuardDeps } from "../guard/targets";
import {
  JobMemory,
  retryQueueOf,
  setQueueDeps,
  type DeadLetterStore,
  type QueueDeps,
  type RetryQueue,
  type SendDoor,
} from "../queues";
import { setSafetyDeps } from "../safety";
import type { HandleDirectory, SafetyDeps } from "../safety/types";
import { isLabel, logSink, openTrace, type BundleId, type LogContext, type TraceContext } from "../trace";
import { setTurnDeps, turnHooks } from "../turn/turn";
import type { TurnDeps, TurnDirectory, TurnDispatcher } from "../turn/types";
import { bindPorts, WiringError, type Binding, type ImplementationSets } from "./bind";
import { closedPorts } from "./closed";
import { LinqDoor } from "./linq-door";
import { environmentOf, PICKS, type Environment } from "./picks";
import type { PortName, Ports } from "./ports";
import { PinnedRuns } from "./pinned-runs";
import {
  checkedPin,
  realPorts,
  type ArmingCalls,
  type BundleReadCalls,
  type BundleSafetyLines,
  type ComposeReads,
  type Composers,
  type Deciders,
  type FinalizeData,
  type FrontierScope,
  type GateReads,
  type HandleSealingKeyCall,
  type HandleTargetsCall,
  type LinqSendCall,
  type LinqVerifyInputs,
  type OpenChatOnTextCall,
  type OutboxCalls,
  type PlanCalls,
  type SafetyReaders,
  type SendStateCall,
  type StoppedFlagRead,
  type TurnRowCalls,
} from "./real";
import { RowTraces } from "./row-traces";
import { skeletonLinqRoute, type ReleaseFlags } from "./skeleton";
import { testPhonePages, type TestPhoneInputs } from "./test-phone";
import { TurnChats } from "./turn-chats";

/** The HandleActor namespace as the root uses it: the gateway's door to each handle's actor, and the clock arming's way to it. */
export interface HandleActors<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): HandleActorRpc & ClockActorRpc;
}

/** The one clock behind every port that keeps time: epoch milliseconds, and a wait. */
export interface RootClock {
  now(): number;
  after(ms: number): Promise<void>;
}

/** The Workers clock. */
export const WORKER_CLOCK: RootClock = {
  now: () => Date.now(),
  after: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export interface RootOptions {
  /** Picks each port's implementation (./picks.ts). */
  readonly environment: Environment;
  /** The implementation sets the picks may name besides the root's own real and closed sets: a test's fakes. */
  readonly sets?: ImplementationSets;
  /** The HandleActor namespace; null where none is bound, so the gateway's door to the actor is closed. */
  readonly actors: HandleActors | null;
  /** The Worker's ENVIRONMENT and GIT_SHA: every log line carries them, and limit 8 honours the test phone's override on staging only. */
  readonly vars: { readonly ENVIRONMENT: string; readonly GIT_SHA?: string | undefined };
  /** The clock; the Workers clock when left out. */
  readonly clock?: RootClock;
  /** What the real Linq verify is fed (./real.ts): its webhook secret and lookups. Left out, no secret is set. */
  readonly linq?: LinqVerifyInputs;
  /**
   * K-05 v1.2 handleSealingKey with its database bound, which the real sealing port asks for each handle's key
   * (./real.ts); null or left out where no database is bound, so every seal fails closed and the gateway answers 503.
   */
  readonly handleKey?: HandleSealingKeyCall | null;
  /**
   * K-05 v1.7 openChatOnText with its database bound (T-1213; ./real.ts OpenChatOnTextCall): db/repo/chat-open.ts's
   * openChatOnText over a rosie_job client, the gateway's call at receipt for each text or photo a phone handle sends
   * through Linq. In a test, the K-05 double over test owner 1's seeded handle and the handles the key call made, which
   * writes the phone row the outbox and send-state doubles read; null or left out where no database is bound (the Worker
   * until the part of T-1154 that binds it), so every call fails closed and the gateway answers 503 for such a text, with
   * nothing stored.
   */
  readonly chatOpenCall?: OpenChatOnTextCall | null;
  /**
   * @rosie/ai's safety read for each bundle (T-554; ./real.ts SafetyReaders): in a test, over the recorded-model double;
   * null or left out where none can be built (the Worker, until its bundle's manifest and model key can be read there),
   * so every read fails closed and the actor applies its no-verdict rule (T-246).
   */
  readonly safetyReaders?: SafetyReaders | null;
  /**
   * K-05's commitTurn (T-195) and parkTurn (T-197) with their database bound, the two calls that write a turn's one row
   * (T-555; ./real.ts realTurnRow): in a test, the K-05 double; null or left out where no database is bound (the Worker
   * until the part of T-1154 that binds it), so every commit and park fails closed.
   */
  readonly turnRows?: TurnRowCalls | null;
  /**
   * K-05 v1 item 7's readActiveBundle and readBundleValue (T-185) with their database bound, the reads the actor's pin
   * makes at each turn's start and the gateway at each webhook (T-556; ./real.ts realBundles): in a test, the K-05 double
   * holding bundle v0 as bundles/v0 publishes it; null or left out where no database is bound (the Worker until the part
   * of T-1154 that binds it), so no turn's bundle is pinned and the gateway names bundle v0's stand-in.
   */
  readonly bundleReads?: BundleReadCalls | null;
  /**
   * K-05 v1.2 handleTargets (T-220) with its database bound, the guard's targets read (T-556; ./real.ts realTargets): in a
   * test, the K-05 double answering for test owner 1's seeded rows as targets-first-text.json; null or left out where no
   * database is bound (the Worker until the part of T-1154 that binds it), so every targets read fails closed and no text
   * reaches decide.
   */
  readonly handleTargets?: HandleTargetsCall | null;
  /**
   * The frontier's business scope with its database bound (T-557; ./real.ts FrontierScope): K-05 v1.2 readTurnState as
   * rosie_job under each call's business, set for the transaction only. On local PostgreSQL, @rosie/actions'
   * pgFrontierScope over a client whose connections run as rosie_job (the scope pgTurnFace builds on); in a test, the
   * K-05 double over test owner 1's seeded rows (T-1148); null or left out where no database is bound (the Worker until
   * the part of T-1154 that binds it), so every frontier fails closed and no text reaches decide.
   */
  readonly frontierScope?: FrontierScope | null;
  /**
   * The bundle's safety lines (T-1242; DL-341, DL-351; ./real.ts BundleSafetyLines): the safety read's BundleSafety over
   * the pinned bundle's K-01 v1 lines (fixedLine, outcomeLine, dangerWords; synchronous), bundle-backed, and the pin's
   * check (checkPin), asked at each turn's pin that reads the active bundle id, which refuses a bundle whose safety lines
   * have no words or whose A3-49 line holds no hotline. Bound where the state-reads port binds real (staging). Null or left
   * out (the Worker until the part of T-1154 that binds it), each line read throws NoStateReadError, so the safety read
   * fails before any model call and the actor applies its no-verdict rule, and the pin refuses every bundle, so no turn's
   * work starts. In a test, the fake set's fixture bundle stands in (./test-support.ts), and no pin is checked.
   */
  readonly bundleSafety?: BundleSafetyLines | null;
  /**
   * The safety read's directory (T-1242; ../safety/types.ts HandleDirectory.idsOf): the ids K-09's calls name for a handle,
   * by actor name, for the outage and danger lines' calls. Null or left out (the Worker until the part of T-1154 that
   * binds it), every read fails closed (NoStateReadError), which the safety read takes as ids not known.
   */
  readonly handleDirectory?: HandleDirectory | null;
  /**
   * The handle's stopped flag as the outage line asks it (T-1242; SafetyDeps.isStopped; ./real.ts StoppedFlagRead), by
   * actor name. Null or left out (the Worker until the part of T-1154 that binds it), every read fails closed
   * (NoStateReadError), so the outage line, which never goes to a stopped number, does not go.
   */
  readonly stoppedFlags?: StoppedFlagRead | null;
  /**
   * The turn's directory (T-1242; ../turn/types.ts TurnDirectory.partyOf): who a handle is (its K-04 id, business, person
   * and zone), which every run of a turn reads first. Null or left out (the Worker until the part of T-1154 that binds it,
   * over the party read T-1240 names), every read fails closed (NoStateReadError), so each run ends noDirectory before
   * anything is opened, read or written.
   */
  readonly turnDirectory?: TurnDirectory | null;
  /**
   * @rosie/ai's decide for each bundle (T-558; ./real.ts Deciders): the turn's two reads and its one Sonnet re-read, one
   * decider per bundle for both. In a test, over a fake Messages API answered by the recorded-model double; null or left
   * out where none can be built (the Worker, until its bundle's manifest and flows can be read there and the model key is
   * set by name: J-02), so every decide and re-read fails closed before any model call and nothing decided commits.
   */
  readonly deciders?: Deciders | null;
  /**
   * What the gate and commit reads with its database bound (T-559; ./real.ts GateReads): the Tool API's own business
   * scope (rosie_app) and, on its transaction, K-05 v1.3 readOpenHolds and K-05 v1.4's safety reads, and the read-only
   * sealer. On local PostgreSQL, @rosie/actions' pgCallScope over a client whose connections run as rosie_app, with
   * readOpenHoldsIn, pgSafetyReads and pgReadOnlySealer over a rosie_job client (turn-face/pg/calls.ts); in a test, the K-05
   * doubles over test owner 1's seeded rows; null or left out where no database is bound (the Worker until the part of
   * T-1154 that binds it), so every gate fails closed and nothing commits. Its one commitTurn is the turn-row port's
   * (`turnRows`). Its optional `words` (T-1242) are the safety service's SafetyDeps.words, which a later part fills.
   */
  readonly gateReads?: GateReads | null;
  /**
   * What compose input reads with its database bound (T-560; ./real.ts ComposeReads): the Tool API's own business scope
   * (rosie_app) and K-05 v1.6 readOutboxRow on the runtime side (rosie_job). On local PostgreSQL, @rosie/actions'
   * pgCallScope over a rosie_app client and pgRowData's readOutboxRow over a rosie_job client (turn-face/pg/calls.ts); in a
   * test, a K-05 double over the rows the commit wrote and test owner 1's seeded rows; null or left out where no database
   * is bound (the Worker until the part of T-1154 that binds it), so every compose input fails closed and no row is
   * composed.
   */
  readonly composeReads?: ComposeReads | null;
  /**
   * @rosie/ai's composer for each bundle (T-560; ./real.ts Composers): each row's plan and its one rewrite. In a test, over
   * a fake Messages API answered by the recorded-model double; null or left out where none can be built (the Worker, until
   * its bundle's manifest can be read there and the model key is set by name: J-02), so every compose and rewrite fails
   * closed before any model call and no row gets a plan.
   */
  readonly composers?: Composers | null;
  /**
   * What finalize reads and writes with its database bound (T-561; ./real.ts FinalizeData): the Tool API's own business
   * scope (rosie_app), and on the runtime side (rosie_job) K-05 v1.6 readOutboxRow, v1.3 readFixedLineFacts, and T-196's
   * writePlan and cancelClock. On local PostgreSQL, @rosie/actions' pgCallScope over a rosie_app client and pgRowData's four
   * calls over a rosie_job client (turn-face/pg/calls.ts); in a test, K-05 doubles over the rows the commit wrote and test
   * owner 1's seeded rows; null or left out where no database is bound (the Worker until the part of T-1154 that binds
   * it), so every finalize fails closed and no row gets its final parts.
   */
  readonly finalizeData?: FinalizeData | null;
  /**
   * K-05 v1.2's four outbox calls with their database bound (T-562; ./real.ts OutboxCalls): db/repo/outbox.ts's
   * claimOutboxV12, renewClaim, markPartV12 and markRowV12, each called as (sql, request) over a rosie_job client, never
   * T-196's v1 calls beside them (DL-317). In a test, the K-05 double over the rows the commit wrote and the plans finalize
   * wrote into them; null or left out where no database is bound (the Worker until the part of T-1154 that binds them), so
   * every claim fails closed and nothing is sent.
   */
  readonly outboxCalls?: OutboxCalls | null;
  /**
   * K-05 v1.2 sendState with its database bound (T-562; ./real.ts SendStateCall): db/repo/send-state.ts's sendState over a
   * rosie_job client, limit 8's read at send and the chat the send goes to. In a test, the same K-05 double over test
   * owner 1's seeded rows (no phone row) and the rows the commit wrote; null or left out where no database is bound (the
   * Worker until the part of T-1154 that binds it), so every read fails closed and nothing is sent.
   */
  readonly sendStateCall?: SendStateCall | null;
  /**
   * K-05 v1's plan calls with their database bound (T-1242; ./real.ts PlanCalls): db/repo/outbox.ts's unplannedRows and
   * writePlan, each called as (sql, request) over a rosie_job client, the turn's rows with no plan yet after its commit
   * and an email copy's plan. Bound where the data-access port binds real (staging). Null or left out (the Worker until
   * the part of T-1154 that binds them), every call fails closed (NoDatabaseError), so no row of the turn is listed,
   * composed or planned. In a test, the fake set's rows stand in (./test-support.ts).
   */
  readonly planCalls?: PlanCalls | null;
  /**
   * K-11 v1 sendPart with its Linq line bound (T-563; ./real.ts LinqSendCall): each part the dispatcher sends, through the
   * root's Linq door. In a test, @rosie/adapters' Linq double (T-411), which records each part once per idempotency key;
   * null or left out where no line is bound (the Worker until one is handed in: staging's test-phone line, or J-08's real
   * line), so every send fails closed (NoLinqLineError) and nothing leaves.
   */
  readonly linqSendCall?: LinqSendCall | null;
  /**
   * The retry queue's producer (runtime/src/queues RetryQueue: the RETRY_QUEUE binding, retryQueueOf(env), in the Worker),
   * where a row the dispatcher leaves waiting for its next try is put (T-258; DL-315), and where the queue's consumer puts
   * each next try of a job. In a test, a double that keeps each message with its delay; null or left out where none is
   * bound (a Worker environment with no RETRY_QUEUE: env.staging has it since T-566), so each wait reports noQueue and
   * the row waits for the next run that claims it.
   */
  readonly retryQueue?: RetryQueue | null;
  /**
   * What the clock arming reads and writes with its database bound (T-564; ./real.ts ArmingCalls): db/repo/clocks.ts's
   * armClock and cancelClock, each called as (sql, request) over a rosie_job client, the question's facts the due rule
   * reads and the actor name of a K-04 handle. In a test, K-05 doubles over the rows the commit wrote and test owner 1's
   * seeded rows; null or left out where no database is bound (the Worker until the part of T-1154 that binds them), so
   * every arming fails closed and nothing is armed.
   */
  readonly armingCalls?: ArmingCalls | null;
  /** T-185's release-flag read (./skeleton.ts); null or left out where none is bound, so every flag reads off. */
  readonly flags?: ReleaseFlags | null;
  /**
   * What the test-phone page's two calls reach (T-1186; ./test-phone): the session, roster and phone reads with their
   * database bound, and staging's test-phone line. Bound into the gateway's page entry only where ENVIRONMENT is staging,
   * as {...unconfiguredPages(), testPhoneSend, testPhoneParts}; left out or null, every page call stays unconfigured.
   */
  readonly testPhone?: TestPhoneInputs | null;
}

export interface Root {
  readonly environment: Environment;
  /** Each port and the implementation it took, in D-017's turn order. */
  readonly bindings: readonly Binding[];
  readonly ports: Ports;
  /** The gateway's doors, for the Worker's webhook routes. */
  readonly gateway: GatewayDeps;
  /**
   * The Linq webhook route behind the skeleton flag (./skeleton.ts): one POST to {BASE_PATH}/webhooks/linq, answered by
   * the gateway's Linq entry with the doors above while the flag is on, and 404 while it is off.
   */
  linqWebhook(request: Request): Promise<Response>;
  /** What the turn reaches outside the actor (`setTurnDeps`). */
  readonly turn: TurnDeps;
  /** What the safety read on arrival reaches (`setSafetyDeps`). */
  readonly safety: SafetyDeps;
  /**
   * What the bundle pin at each turn's start reads through (`setBundleDeps`): where the state-reads port binds real
   * (staging), the bundle port behind the bundle's safety lines' check (./real.ts checkedPin; T-1242, DL-341, DL-351), so a
   * bundle they refuse, or any bundle while none are bound, is never pinned; elsewhere the bundle port itself.
   */
  readonly pin: BundleDeps;
  /** The outbox dispatcher, as the turn wakes it. */
  readonly dispatcher: TurnDispatcher;
  /**
   * The retry queue's ports (runtime/src/queues QueueDeps), as `install()` sets them for the isolate: each send job goes
   * through the dispatcher's send door (T-258), which runs the job's recipient's rows again; no job kind and no dead-letter
   * writer is joined yet.
   */
  readonly queue: QueueDeps;
  /** Puts the actor's ports and the retry queue's in place for this isolate; returns the function that puts the earlier ones back. */
  install(): () => void;
}

/** Builds the gateway, the actor's ports and the dispatcher, each port bound once in the environment. */
export function composeRoot(options: RootOptions): Root {
  const clock = options.clock ?? WORKER_CLOCK;
  const now = (): number => clock.now();
  const log: LogContext = {
    environment: options.vars.ENVIRONMENT,
    version: options.vars.GIT_SHA ?? "unknown",
  };
  // Each run's pinned bundle, kept by the lease's hooks (`install`) for the frontier and gate ports to read the turn's
  // bundle through; and each run's last text's service and chat id, for the gateAndCommit request's turn (T-559).
  const pinnedRuns = new PinnedRuns();
  const turnChats = new TurnChats();
  const { ports, bindings } = bindPorts(PICKS, options.environment, {
    ...options.sets,
    real: realPorts({
      linq: options.linq,
      handleKey: options.handleKey,
      chatOpen: options.chatOpenCall ?? null,
      now,
      safetyRead: {
        readers: options.safetyReaders ?? null,
        // The bound bundle port's danger words, read at each read: the list the actor's no-verdict rule matches too.
        dangerWords: () => ports.stateReads.safety.bundle.dangerWords(),
        sink: logSink(log),
      },
      turnRows: options.turnRows,
      bundleReads: options.bundleReads,
      handleTargets: options.handleTargets,
      frontierScope: options.frontierScope,
      // The bound bundle port, read at each call, for a bundle the turn did not pin; and the bundle each run pinned.
      frontierBundles: { bundles: () => ports.bundles, pinnedOf: (trace) => pinnedRuns.of(trace) },
      // The state reads (T-1242), each over its own input: each read fails closed while its input is null.
      stateReads: {
        bundleSafety: options.bundleSafety ?? null,
        handleDirectory: options.handleDirectory ?? null,
        stoppedFlags: options.stoppedFlags ?? null,
        turnDirectory: options.turnDirectory ?? null,
      },
      deciders: options.deciders,
      // The gate's reads, its one commit through the bound turn-row port (the turn id checked there), and the run's bundle.
      gate: {
        reads: options.gateReads ?? null,
        commitTurn: (request) => ports.turnRow.commitTurn(request),
        bundles: () => ports.bundles,
        pinnedOf: (trace) => pinnedRuns.of(trace),
      },
      // Compose input's reads, and the bundle the row was committed under: the run's pinned one, else the bundle port.
      composeInput: {
        reads: options.composeReads ?? null,
        bundles: () => ports.bundles,
        pinnedOf: (trace) => pinnedRuns.of(trace),
      },
      composers: options.composers,
      // Finalize's reads and writes, and the bundle the row was committed under: the run's pinned one, else the bundle port.
      finalize: {
        data: options.finalizeData ?? null,
        bundles: () => ports.bundles,
        pinnedOf: (trace) => pinnedRuns.of(trace),
      },
      // The dispatcher's claim and marks, and limit 8's send state, each with its database bound (T-562).
      outbox: options.outboxCalls ?? null,
      sendState: options.sendStateCall ?? null,
      // The turn's plan calls, with their database bound (T-1242).
      planCalls: options.planCalls ?? null,
      // Each part the dispatcher sends, to the Linq line (T-563).
      linqSend: options.linqSendCall ?? null,
      // The clock arming's calls and reads at a part's first delivery receipt (T-564).
      arming: options.armingCalls ?? null,
    }),
    closed: closedPorts(),
  });
  const utc = (): string => new Date(clock.now()).toISOString();
  const where: WebhookEnvironment = { environment: log.environment, version: log.version };
  const rowTraces = new RowTraces();
  const armings = new ArmingMemory();
  // Made at the first wake, never when the root is built: Workers refuse crypto.randomUUID() at global scope (DL-313).
  let claimer: string | null = null;
  const claimerOf = (): string => (claimer ??= `dispatcher-${crypto.randomUUID()}`);
  // Only a row whose claim names the linq port reaches the Linq port, each send within its time limit (./linq-door.ts).
  const door = new LinqDoor();
  const dispatchStore = door.watch(ports.outbox);
  const dispatchLinq = door.door(ports.linqSend.parts);
  // Where a row left waiting for its next try is put (T-258; DL-315): the retry queue, through T-256's producer.
  const retries = queueRetries(options.retryQueue ?? null, now);
  // The recipient actor's one reading, asked right before an outage line's row goes (T-1337): every run's, the wake's and
  // the retry door's alike, through the arming port's directory and the HandleActor namespace.
  const mayHaveStopped = actorReadingPort(ports.arming.directory, options.actors);
  /** The dispatcher's ports for one run, each claimed row sent on the trace `traceFor` gives it. */
  const dispatchDeps = (traceFor: DispatchDeps["traceFor"]): DispatchDeps => ({
    store: dispatchStore,
    linq: dispatchLinq,
    recipients: ports.sendState.recipients,
    sendState: ports.sendState.sendState,
    environment: options.vars.ENVIRONMENT,
    traceFor,
    now: utc,
    claimer: claimerOf(),
    retries,
    mayHaveStopped,
  });

  const dispatcher: TurnDispatcher = {
    async wake(request, trace) {
      await runDispatch(
        dispatchDeps((row) => {
          rowTraces.keep(row.outboxRowId, trace);
          return trace;
        }),
        { recipientHandleId: request.handleId },
      );
    },
  };

  // The retry queue's door to the dispatcher (T-258's dispatchSendDoor; DL-315): a due send job runs its recipient's rows
  // again with the same ports, each claimed row on the trace this isolate sent it on, else on a trace opened under the
  // row's own trace id (one trace id from the webhook to the delivery receipt), with the active bundle id read once for
  // the try (bundle v0's stand-in when it cannot be read, as at receipt).
  const sends: SendDoor = {
    async retrySend(send) {
      const body = retryBodyOf(send.body);
      const known = body === null ? null : rowTraces.forRow(body.outboxRowId);
      const bundleId =
        known?.bundleId ?? (await readBundleId({ bundleId: () => activeBundleId(ports.bundles.registry) }));
      const traceFor = (row: ClaimedRow): TraceContext => {
        const trace = rowTraces.forRow(row.outboxRowId) ?? rowTraceOf(row, bundleId, log, now);
        rowTraces.keep(row.outboxRowId, trace);
        return trace;
      };
      return dispatchSendDoor(dispatchDeps(traceFor)).retrySend(send);
    },
  };
  // The retry queue's ports for this isolate: send jobs through the door, this root's own ledger (one root per isolate's
  // env), and no job kind or dead-letter writer joined yet (NO_DEAD_LETTERS).
  const queue: QueueDeps = {
    sends,
    jobs: new Map(),
    deadLetters: NO_DEAD_LETTERS,
    ledger: new JobMemory(),
  };

  // Each text's safety result is not among the turn's deps: each run reads it through its leased turn, from the handle's
  // own actor (ADR-015 section 3; T-1264).
  const turn: TurnDeps = {
    directory: ports.stateReads.turn.directory,
    keys: ports.sealing,
    toolApi: {
      // CQ-159: the real frontier port's Tool API base records the call's one frontier span, so the turn records none.
      recordsFrontierSpan: bindsReal(bindings, "frontier"),
      buildFrontier: (request, trace) => ports.frontier.buildFrontier(request, trace),
      closestEntries: (request, trace) => ports.turnFace.closestEntries(request, trace),
      // The runtime caller copies the service and Linq chat id of the run's last text onto the request's turn, both or
      // neither (K-09 v1.5 default 135). The turn records the gate and commit spans; the real gate port's base records none.
      gateAndCommit: (request, at, trace) =>
        ports.gate.gateAndCommit(turnChats.onTurn(request, trace), at, trace),
      // The turn records the row's fillAndChecks span; the real compose-input port's base records none (DL-376).
      composeInput: (request, trace) => ports.composeInput.composeInput(request, trace),
      // And its fillAndChecks and rewriteOrFallback spans around finalize; the real finalize port's base records none.
      finalizeMessage: (request, trace) => ports.finalize.finalizeMessage(request, trace),
    },
    ai: ports.decide,
    composer: ports.composer,
    // The plan calls are the data-access port's; the park writes the turn's one row through the turn-row port (T-555).
    rows: {
      unplannedRows: (request) => ports.dataAccess.rows.unplannedRows(request),
      writePlan: (request) => ports.dataAccess.rows.writePlan(request),
      parkTurn: (request) => ports.turnRow.parkTurn(request),
    },
    dispatcher,
    now: utc,
  };

  const safety: SafetyDeps = {
    read: ports.safetyRead,
    bundle: ports.stateReads.safety.bundle,
    core: ports.turnFace.safetyCore,
    directory: ports.stateReads.safety.directory,
    keys: ports.sealing,
    direct: ports.linqDirect,
    clock: { now, after: (ms) => clock.after(ms) },
    isStopped: (actorName) => ports.stateReads.safety.isStopped(actorName),
  };

  // What the turn's pin reads through: where the state reads are real, behind the bundle's safety lines' check, so a bundle
  // they refuse (or any bundle while none are bound) is never pinned (DL-341, DL-351); elsewhere the bundle port itself,
  // so a test's fake state reads leave the pin as it was.
  const pin = bindsReal(bindings, "stateReads")
    ? checkedPin(ports.bundles, options.bundleSafety ?? null)
    : ports.bundles;

  const receipts: ReceiptSink = {
    async accept(handoff) {
      const status = deliveredStatusOf(handoff);
      const trace = rowTraces.forPart(handoff.partKey) ?? receiptTraceOf(handoff, log, now);
      const result = await handleDeliveryReceipt(
        {
          // The store the dispatcher's parts were marked sent in: a receipt finds its part there (T-562).
          store: ports.outbox,
          // The arming port (T-564): K-05 armClock and cancelClock, the question's facts, the actor name of a handle.
          clockArming: clockArming({
            data: ports.arming.data,
            facts: ports.arming.facts,
            // No geo port is joined: a flow B visit's zone falls back to the business's (CQ-05, CQ-08).
            geo: null,
            directory: ports.arming.directory,
            actors: options.actors,
            log,
            trace,
            memory: armings,
          }),
          trace,
        },
        { providerMessageId: status.messageId, partKey: handoff.partKey, at: status.at },
      );
      // Not marked: answered 503, so Linq sends the receipt again (K-05: the receipt is not lost).
      if (result.result === "storeError")
        throw new WiringError("the outbox store gave no answer to the receipt");
      return result.result === "repeated" ? "duplicate" : "written";
    },
  };

  const flags = options.flags ?? null;
  const linqWebhook = (request: Request): Promise<Response> =>
    skeletonLinqRoute(request, { gateway, flags, where });
  const testPhone = options.testPhone ?? null;

  const gateway: GatewayDeps = {
    linq: ports.linqVerify,
    actor: options.actors === null ? closedActorDoor() : durableObjectActor(options.actors),
    receipts,
    keys: ports.sealing,
    // A number's text opens its chat after the key call and before the actor (T-1213; K-05 v1.7 item 46).
    chats: ports.chatOpen,
    bundleId: () => activeBundleId(ports.bundles.registry),
    now,
    // The test-phone page's two calls, on staging only (T-1186): anywhere else the page entry refuses them first.
    ...(testPhone !== null && options.vars.ENVIRONMENT === "staging"
      ? {
          pages: {
            ...unconfiguredPages(),
            ...testPhonePages({
              inputs: testPhone,
              webhookSecret: () => options.linq?.webhookSecret(),
              linqWebhook,
              now,
            }),
          },
        }
      : {}),
  };

  return {
    environment: options.environment,
    bindings,
    ports,
    gateway,
    linqWebhook,
    turn,
    safety,
    pin,
    dispatcher,
    queue,
    install() {
      const restores = [
        setBatchHooks({ clock: { now } }),
        setSafetyDeps(safety),
        setBundleDeps(pin),
        setGuardDeps({ targets: ports.targets }),
        setTurnDeps(turn),
        setLeaseHooks(turnChats.around(pinnedRuns.around(turnHooks))),
        // The retry queue's ports (T-256): its send jobs reach the dispatcher's door (T-258; DL-315).
        setQueueDeps(queue),
      ];
      return () => {
        for (const restore of restores.reverse()) restore();
      };
    },
  };
}

/** True when the port took its real implementation (./real.ts) in the root's environment. */
function bindsReal(bindings: readonly Binding[], port: PortName): boolean {
  return bindings.some((binding) => binding.port === port && binding.implementation === "real");
}

/**
 * The dispatcher's port to the recipient actor's one reading (T-1337; DL-656; DispatchDeps.mayHaveStopped): the handle
 * actor of the row's recipient K-04 id, named by `directory` and reached through the HandleActor namespace (the route the
 * clocks take: ../clocks/actors.ts actorOf), answering through HandleActor.mayHaveStoppedNow, the same function the safety
 * read's outage line and the AI-down path ask. An actor that cannot be named (no namespace bound, a directory that cannot
 * say) or that has no such call rejects; the dispatcher counts that, a throw and any answer that is not exactly false as a
 * stop. Nothing is read here: no outage_texts, inbox, lease or stopped flag (DL-596).
 */
export function actorReadingPort(
  directory: ClockDirectory,
  actors: ClockActors | null,
): NonNullable<DispatchDeps["mayHaveStopped"]> {
  return async (recipientHandleId) => {
    const actor = await actorOf({ directory }, actors, recipientHandleId);
    if (actor?.mayHaveStoppedNow === undefined) {
      throw new WiringError("no handle actor can be named for the row's recipient");
    }
    return actor.mayHaveStoppedNow();
  };
}

const workerRoots = new WeakMap<Cloudflare.Env, Root>();

/** The Worker's secrets the root reads, by name: none is in a file here; staging's are set by name (T-568). */
export interface WorkerSecrets {
  /** K-11's webhook secret (K-11 README default 1), read at each verify; missing until it is set. */
  readonly LINQ_WEBHOOK_SECRET?: string;
}

/**
 * The Worker's root for its environment (ENVIRONMENT; ./picks.ts). The real set (./real.ts) and the closed set are the
 * ones at hand in a Worker: the Linq verify reads LINQ_WEBHOOK_SECRET by name at each call (missing, every verify fails,
 * so the gateway answers 503); every other joined port, and on staging the state reads and the plan calls (T-1242), is
 * handed no K-05 call, scope, reader or line yet (T-567 gives staging its Hyperdrive binding; T-1154's parts hand each
 * port its calls and readers), so every seal fails closed and the gateway answers 503 with nothing written, no turn's
 * bundle is pinned, no frontier runs, no safety read, decide or compose reaches a model, nothing commits, no row is
 * composed, finalized or sent, and nothing is armed. The gateway's door to the handle's actor is the HANDLE_ACTOR binding
 * where the environment has one (T-553; env.staging has it since T-566), and no release flags are handed in until the
 * part of T-1154 that binds T-185's flag read over the staging database (DL-356), so the skeleton flag reads off and
 * `linqWebhook` answers 404. One root per env object, so its memories (rows' traces, armed parts) last as long as the
 * isolate does.
 */
export function workerRoot(env: Cloudflare.Env & WorkerSecrets): Root {
  const known = workerRoots.get(env);
  if (known !== undefined) return known;
  const root = composeRoot({
    environment: environmentOf(env),
    actors: handleActorsOf(env),
    vars: env,
    linq: { webhookSecret: () => env.LINQ_WEBHOOK_SECRET },
    // No database client is handed in yet (a part of T-1154 binds handleSealingKey over T-567's Hyperdrive): the sealing
    // port fails closed (./real.ts NoDatabaseError).
    handleKey: null,
    // No database client is handed in yet (its rosie_job client gives db/repo/chat-open.ts's openChatOnText): every call
    // fails closed (./real.ts NoDatabaseError), so a text that opens a chat is answered 503 with nothing stored, as its
    // seal already is.
    chatOpenCall: null,
    // No safety read until a part of T-1154 builds one from the bundle's manifest (the bundle reads; staging's BUNDLES,
    // bound since T-566) and the model key (J-02; DL-027): every read fails closed (./real.ts NoSafetyReaderError), so the
    // actor applies its no-verdict rule.
    safetyReaders: null,
    // No database client is handed in yet: every commit and park fails closed (./real.ts NoDatabaseError), so no turn row
    // is written; a turn whose commit is not taken lapses and is parked, and its park is tried again (T-248, T-253).
    turnRows: null,
    // No database client is handed in yet (staging's BUNDLES is bound since T-566; a part of T-1154 binds the K-05 reads):
    // every bundle read fails closed (./real.ts NoDatabaseError), so no turn's bundle is pinned and no turn's work starts,
    // and the gateway's trace names bundle v0's stand-in (answer.ts).
    bundleReads: null,
    // No database client is handed in yet: every targets read fails closed, so the guard hands no text to the frontier.
    handleTargets: null,
    // No database client is handed in yet (its rosie_job client gives pgFrontierScope): every frontier fails closed inside
    // the Tool API base, before anything is read, so no text reaches decide.
    frontierScope: null,
    // The state reads (T-1242): no reader is handed in yet. The part of T-1154 that binds each read hands it in here as
    // its own field, typed as the seams' table in ./real.ts says, with no other change to this file: until then
    // each read fails closed (./real.ts NoStateReadError), so no safety read reaches a model and the actor applies its
    // no-verdict rule, the pin refuses every bundle, and a run of a turn ends noDirectory with nothing read or written.
    bundleSafety: null,
    handleDirectory: null,
    stoppedFlags: null,
    turnDirectory: null,
    // No decide until a part of T-1154 builds one from the bundle's manifest and flows (the bundle reads; staging's
    // BUNDLES) and the model key (J-02; smoke-size calls only, DL-027): every decide and re-read fails closed before any
    // model call (./real.ts NoDeciderError), so no decided part reaches the gate.
    deciders: null,
    // No database client is handed in yet (its rosie_app and rosie_job clients give pgCallScope and the gate's reads):
    // every gate fails closed inside the Tool API base, before anything is read or written, so nothing commits.
    gateReads: null,
    // No database client is handed in yet (its rosie_app and rosie_job clients give pgCallScope and readOutboxRow): every
    // compose input fails closed inside the Tool API base, before anything is read, so no row is composed.
    composeReads: null,
    // No composer until a part of T-1154 builds one from the bundle's manifest (the bundle reads; staging's BUNDLES) and
    // the model key (J-02; smoke-size calls only, DL-027): every compose and rewrite fails closed before any model call
    // (./real.ts NoComposerError), so no row gets a plan and nothing is sent for it.
    composers: null,
    // No database client is handed in yet (its rosie_app and rosie_job clients give pgCallScope and pgRowData's four
    // calls): every finalize fails closed inside the Tool API base, before anything is read or written, so no row gets its
    // final parts and nothing is sent for it.
    finalizeData: null,
    // No database client is handed in yet (its rosie_job client gives db/repo/outbox.ts's four v1.2 calls and
    // send-state.ts's sendState): every claim, mark and send-state read fails closed (./real.ts NoDatabaseError), so the
    // dispatcher claims nothing and nothing is sent, and a receipt is not marked (answered 503, so Linq sends it again).
    outboxCalls: null,
    sendStateCall: null,
    // The turn's plan calls (T-1242): no database client is handed in yet (a part of T-1154 binds db/repo/outbox.ts's
    // unplannedRows and writePlan over a rosie_job client, as this field): every call fails closed (./real.ts
    // NoDatabaseError), so no row of the turn is listed, composed or planned.
    planCalls: null,
    // No Linq line is handed in yet (T-563): every send fails closed (./real.ts NoLinqLineError) and nothing leaves. On
    // staging the line is the test-phone line's Linq double (./test-phone lineLinqSend over testPhoneLineOf(env
    // .TEST_PHONE_LINE)), which a part of T-1154 binds with the outbox calls; the real Linq line is J-08's. No row is
    // claimed before then.
    linqSendCall: null,
    // The RETRY_QUEUE binding where the environment has one (T-279; env.staging has it since T-566; with none, each wait
    // reports noQueue): a row the dispatcher leaves waiting goes on it, and its consumer runs it through the door.
    retryQueue: retryQueueOf(env),
    // No database client is handed in yet (its rosie_job client gives db/repo/clocks.ts's armClock and cancelClock): every
    // arming fails closed (./real.ts NoDatabaseError), so nothing is armed; and no receipt reaches it there yet, since
    // the outbox port marks no part delivered with no database bound (the receipt is answered 503, and Linq sends it
    // again).
    armingCalls: null,
    // The test-phone page's calls (T-1186) have nothing to read until a part of T-1154 binds the session, roster and phone
    // reads, so the Worker leaves them unconfigured: both answer 503 (notConnected), as every page call does until its
    // handler is joined. That part hands RootOptions.testPhone, with staging's test-phone line as
    // testPhoneLineOf(env.TEST_PHONE_LINE), and the root binds both calls on staging.
    testPhone: null,
  });
  workerRoots.set(env, root);
  return root;
}

/** The HANDLE_ACTOR binding as the root takes it (wrangler.jsonc, T-276); null where the environment has none. */
function handleActorsOf(env: Cloudflare.Env): HandleActors<DurableObjectId> | null {
  const namespace = env.HANDLE_ACTOR;
  if (namespace === undefined) return null;
  return {
    idFromName: (name) => namespace.idFromName(name),
    // The stub's own type cannot carry the actor's RPC methods (the class is the actor module's), so it is typed here.
    get: (id) => namespace.get(id) as unknown as HandleActorRpc & ClockActorRpc,
  };
}

/** The root this isolate's actor ports are wired to, and the function that puts the earlier ones back. */
let wired: { readonly root: Root; readonly restore: () => void } | null = null;

/** Who asks `wireWorker` to wire the isolate: one of the Worker's entries (fetch, queue), or a HandleActor as it is built. */
export type WiringCaller = "entry" | "actor";

/**
 * Whether a HandleActor built in this isolate wires it (T-1243): "auto" wherever the Worker runs; "held" only where a test
 * says so (`setActorWiring`). The fetch and queue entries wire either way.
 */
export type ActorWiring = "auto" | "held";

let actorWiring: ActorWiring = "auto";

/**
 * Wires the Worker's actor ports for this isolate (the root's `install()`), once, on its first event (DL-313 ruling 2):
 * the first request or retry batch (`caller` "entry"), or the first HandleActor built here (`caller` "actor", T-1243),
 * which calls it before its constructor reads a port, so a stub call or an alarm that lands in an isolate no request or
 * retry batch reached still runs the turn (Cloudflare does not say the actor and the fetch handler share an isolate;
 * ./test-phone/line.ts treats them as two). Only where the HandleActor namespace is bound, and never at global scope.
 * env.staging binds it since T-566, and so does the Workers test pool, which runs env.staging; where none is bound (an env
 * a test builds without it) nothing is wired, so the actor keeps its unwired defaults. Once wired, it never installs
 * again, whoever calls: ports a test installs after that stay the test's. While a test holds the actor's wiring
 * (`setActorWiring("held")`: the Workers test projects' setup does, since the pool's one isolate runs every test's actors),
 * an actor's call wires nothing, so an actor a test builds keeps the ports that test installed, or its unwired defaults
 * where it installed none. Answers the root wired, or null.
 */
export function wireWorker(env: Cloudflare.Env & WorkerSecrets, caller: WiringCaller = "entry"): Root | null {
  if (wired !== null) return wired.root;
  if (caller === "actor" && actorWiring === "held") return null;
  if (env.HANDLE_ACTOR === undefined) return null;
  const root = workerRoot(env);
  wired = { root, restore: root.install() };
  return root;
}

/**
 * Holds or lets go a HandleActor's own wiring of this isolate (T-1243): a test's switch, and the Workers test projects'
 * setup, which holds it for every test (an actor a test builds keeps the test's ports). Returns the function that puts
 * the earlier setting back. The Worker never calls it, so every deployed actor wires its isolate.
 */
export function setActorWiring(next: ActorWiring): () => void {
  const before = actorWiring;
  actorWiring = next;
  return () => {
    actorWiring = before;
  };
}

/** The root this isolate's actor ports are wired to by `wireWorker`, or null while none is. */
export function wiredRoot(): Root | null {
  return wired?.root ?? null;
}

/** Puts back the actor ports that were in place before `wireWorker` (a test's clean-up; the Worker never calls it). */
export function unwireWorker(): void {
  const done = wired;
  wired = null;
  done?.restore();
}

/** The door to the handle's actor where no HandleActor namespace is bound: every hand-off fails, so the gateway answers 503. */
function closedActorDoor(): ActorStub {
  return { accept: () => Promise.reject(new WiringError("no HandleActor namespace is bound here")) };
}

/** The active bundle id (K-05 v1 readActiveBundle); a throw leaves the gateway to bundle v0's stand-in (answer.ts). */
async function activeBundleId(registry: Pick<BundleRegistry, "readActiveBundle">): Promise<BundleId> {
  const answer = await registry.readActiveBundle({});
  if ("result" in answer) return { hash: answer.bundleId.hash, build: answer.bundleId.build };
  throw new WiringError(`no active bundle id: ${answer.error}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A delivery receipt's K-06 status: Linq's message id and when it was delivered. A sent or failed receipt has no door yet
 * (T-258's retry keys and Linq's error kinds): it is refused, so the gateway answers 503 and Linq sends it again.
 */
function deliveredStatusOf(handoff: ActorHandoff): { messageId: string; at: string } {
  if (handoff.event.kind !== "delivered") throw new WiringError("only a delivered receipt has a door yet");
  const status = handoff.event.status;
  if (!isRecord(status) || typeof status.messageId !== "string" || typeof status.at !== "string") {
    throw new WiringError("a delivered receipt with no status");
  }
  return { messageId: status.messageId, at: status.at };
}

/**
 * The retry queue's dead-letter writer while none is joined (K-37 v1 dead_letters on the runtime side; no D-017 hop joins
 * it): every insert is refused, so a job's fifth failed try is never lost but comes back after a minute (T-256's handOn).
 * No job kind is joined either: only the dispatcher's send jobs run, and a send never becomes a dead letter.
 */
export const NO_DEAD_LETTERS: DeadLetterStore = {
  put: () => Promise.resolve({ error: "noDeadLetterStore" }),
};

/**
 * A retried row's own trace, where this isolate did not send it (T-563): opened under the trace id the row carries (one
 * trace id from the webhook to the delivery receipt; K-08), as a receipt's is, with the bundle id the retry read and the
 * row's recipient as its handle (never a number).
 */
function rowTraceOf(row: ClaimedRow, bundleId: BundleId, log: LogContext, now: () => number): TraceContext {
  return openTrace({
    openedBy: "textWebhook",
    bundleId,
    incomingTraceId: row.traceId,
    ...(isLabel(row.recipientHandleId) ? { handleRef: row.recipientHandleId } : {}),
    sink: logSink(log),
    now,
  });
}

/** The receipt's own trace, under the id and bundle id the gateway opened it with (CQ-102: no row's trace is known). */
function receiptTraceOf(handoff: ActorHandoff, log: LogContext, now: () => number): TraceContext {
  return openTrace({
    openedBy: "textWebhook",
    bundleId: handoff.bundleId,
    incomingTraceId: handoff.traceId,
    sink: logSink(log),
    now,
  });
}
