// The composition root (T-550; C-046, C-044; build prompt section 10, D-017 'Joins: one hop at a time, in the turn order
// of What changes'; ops/plan/02-contracts.md section 11): the one place that builds the Worker's gateway, the handle
// actor's turn and the outbox dispatcher, with each of the fifteen ports of ./ports.ts bound once to the implementation
// its environment picks (./picks.ts, checked by ./bind.ts). Each join (T-552 to T-564) swaps one port's pick for the real
// package; nothing else here changes for it.
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
//     the pinned bundle's), the guard's targets (T-250; the targets port, joined by T-556), the turn loop as the lease's
//     hooks (T-248, T-251 to T-253), each run's pinned bundle kept for its frontier and gate (./pinned-runs.ts, T-557)
//     and its last text's service and chat id for its gate (./turn-chats.ts, T-559), and the turn's ports (`TurnDeps`,
//     its frontier the frontier port, joined by T-557, its gate and commit the gate port, joined by T-559), the Durable
//     Object reading each at use;
//   - the outbox dispatcher (T-257), which the turn wakes once its rows are composed (T-252): one claim-and-send run for
//     the turn's recipient, each claimed row on the turn's trace;
//   - the receipt door: a delivery receipt marks its part delivered and arms its question's clock (T-255), on the trace
//     its row was sent on when this isolate knows it (./row-traces.ts), else on the receipt's own;
//   - the gateway's page entry (T-266): on staging, when the root is handed their inputs, the test-phone page's two calls
//     (T-1186, ./test-phone), T-565's handlers over the session, roster and phone reads and staging's test-phone line,
//     which posts through the Linq route above; every other page call stays unconfigured (503).
//
// The Worker (runtime/src/index.ts) takes its gateway from `workerRoot(env)`: the real set (./real.ts, what the joins
// have bound: the Linq verify reading LINQ_WEBHOOK_SECRET by name, and the sealing, turn-row, bundle, targets, frontier
// and gate ports, which no database feeds there until T-567, so every seal, commit, park, pin, targets read, frontier and
// gate fails closed, and the decide port, which no decider feeds there until J-02, so every decide fails closed) and the
// closed set are at hand there, so every door not joined fails and a webhook that gets past the verify answers 503, as
// before. A test composes the root with environment "test", the fakes (./test-support.ts), what the joined ports are fed
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
// composer for the turn's bundle (RootOptions.composers), which records only its model calls' portCall spans. The turn
// records the compose span and every fillAndChecks span while the Tool API base records none
// (TURN_RECORDS_FILL_AND_CHECKS; DL-376), so no flag is set for them. Never logged by the root: a word, a number, a key,
// a chat id.

import { setBatchHooks } from "../actor/batch";
import { setLeaseHooks } from "../actor/lease";
import { setBundleDeps } from "../bundle/pin";
import type { BundleRegistry } from "../bundle/types";
import { ArmingMemory, clockArming } from "../clocks/arming";
import type { ClockActorRpc } from "../clocks/types";
import { handleDeliveryReceipt, runDispatch } from "../dispatch/dispatcher";
import { durableObjectActor, type HandleActorRpc } from "../gateway/actor-door";
import type { WebhookEnvironment } from "../gateway/answer";
import { unconfiguredPages } from "../gateway/pages";
import type { ActorHandoff, ActorStub, GatewayDeps, ReceiptSink } from "../gateway/types";
import { setGuardDeps } from "../guard/targets";
import { setSafetyDeps } from "../safety";
import type { SafetyDeps } from "../safety/types";
import { logSink, openTrace, type BundleId, type LogContext, type TraceContext } from "../trace";
import { setTurnDeps, turnHooks } from "../turn/turn";
import type { TurnDeps, TurnDispatcher } from "../turn/types";
import { bindPorts, WiringError, type Binding, type ImplementationSets } from "./bind";
import { closedPorts } from "./closed";
import { environmentOf, PICKS, type Environment } from "./picks";
import type { PortName, Ports } from "./ports";
import { PinnedRuns } from "./pinned-runs";
import {
  realPorts,
  type BundleReadCalls,
  type ComposeReads,
  type Composers,
  type Deciders,
  type FrontierScope,
  type GateReads,
  type HandleSealingKeyCall,
  type HandleTargetsCall,
  type LinqVerifyInputs,
  type SafetyReaders,
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
   * @rosie/ai's safety read for each bundle (T-554; ./real.ts SafetyReaders): in a test, over the recorded-model double;
   * null or left out where none can be built (the Worker, until its bundle's manifest and model key can be read there),
   * so every read fails closed and the actor applies its no-verdict rule (T-246).
   */
  readonly safetyReaders?: SafetyReaders | null;
  /**
   * K-05's commitTurn (T-195) and parkTurn (T-197) with their database bound, the two calls that write a turn's one row
   * (T-555; ./real.ts realTurnRow): in a test, the K-05 double; null or left out where no database is bound (the Worker
   * until T-567), so every commit and park fails closed.
   */
  readonly turnRows?: TurnRowCalls | null;
  /**
   * K-05 v1 item 7's readActiveBundle and readBundleValue (T-185) with their database bound, the reads the actor's pin
   * makes at each turn's start and the gateway at each webhook (T-556; ./real.ts realBundles): in a test, the K-05 double
   * holding bundle v0 as bundles/v0 publishes it; null or left out where no database is bound (the Worker until T-567), so
   * no turn's bundle is pinned and the gateway names bundle v0's stand-in.
   */
  readonly bundleReads?: BundleReadCalls | null;
  /**
   * K-05 v1.2 handleTargets (T-220) with its database bound, the guard's targets read (T-556; ./real.ts realTargets): in a
   * test, the K-05 double answering for test owner 1's seeded rows as targets-first-text.json; null or left out where no
   * database is bound (the Worker until T-567), so every targets read fails closed and no text reaches decide.
   */
  readonly handleTargets?: HandleTargetsCall | null;
  /**
   * The frontier's business scope with its database bound (T-557; ./real.ts FrontierScope): K-05 v1.2 readTurnState as
   * rosie_job under each call's business, set for the transaction only. On local PostgreSQL, @rosie/actions'
   * pgFrontierScope over a client whose connections run as rosie_job (the scope pgTurnFace builds on); in a test, the
   * K-05 double over test owner 1's seeded rows (T-1148); null or left out where no database is bound (the Worker until
   * T-567), so every frontier fails closed and no text reaches decide.
   */
  readonly frontierScope?: FrontierScope | null;
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
   * doubles over test owner 1's seeded rows; null or left out where no database is bound (the Worker until T-567), so every
   * gate fails closed and nothing commits. Its one commitTurn is the turn-row port's (`turnRows`).
   */
  readonly gateReads?: GateReads | null;
  /**
   * What compose input reads with its database bound (T-560; ./real.ts ComposeReads): the Tool API's own business scope
   * (rosie_app) and K-05 v1.6 readOutboxRow on the runtime side (rosie_job). On local PostgreSQL, @rosie/actions'
   * pgCallScope over a rosie_app client and pgRowData's readOutboxRow over a rosie_job client (turn-face/pg/calls.ts); in a
   * test, a K-05 double over the rows the commit wrote and test owner 1's seeded rows; null or left out where no database
   * is bound (the Worker until T-567), so every compose input fails closed and no row is composed.
   */
  readonly composeReads?: ComposeReads | null;
  /**
   * @rosie/ai's composer for each bundle (T-560; ./real.ts Composers): each row's plan and its one rewrite. In a test, over
   * a fake Messages API answered by the recorded-model double; null or left out where none can be built (the Worker, until
   * its bundle's manifest can be read there and the model key is set by name: J-02), so every compose and rewrite fails
   * closed before any model call and no row gets a plan.
   */
  readonly composers?: Composers | null;
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
  /** The outbox dispatcher, as the turn wakes it. */
  readonly dispatcher: TurnDispatcher;
  /** Puts the actor's ports in place for this isolate; returns the function that puts the earlier ones back. */
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

  const dispatcher: TurnDispatcher = {
    async wake(request, trace) {
      await runDispatch(
        {
          store: ports.dataAccess.outbox,
          linq: ports.linqSend.parts,
          recipients: ports.stateReads.dispatch.recipients,
          sendState: ports.stateReads.dispatch.sendState,
          environment: options.vars.ENVIRONMENT,
          traceFor: (row) => {
            rowTraces.keep(row.outboxRowId, trace);
            return trace;
          },
          now: utc,
          claimer: claimerOf(),
        },
        { recipientHandleId: request.handleId },
      );
    },
  };

  const turn: TurnDeps = {
    directory: ports.stateReads.turn.directory,
    keys: ports.sealing,
    safety: ports.stateReads.turn.safety,
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
    direct: ports.linqSend.direct,
    clock: { now, after: (ms) => clock.after(ms) },
    isStopped: (actorName) => ports.stateReads.safety.isStopped(actorName),
  };

  const receipts: ReceiptSink = {
    async accept(handoff) {
      const status = deliveredStatusOf(handoff);
      const trace = rowTraces.forPart(handoff.partKey) ?? receiptTraceOf(handoff, log, now);
      const result = await handleDeliveryReceipt(
        {
          store: ports.dataAccess.outbox,
          clockArming: clockArming({
            data: ports.dataAccess.clocks,
            facts: ports.stateReads.arming.facts,
            // No geo port is joined: a flow B visit's zone falls back to the business's (CQ-05, CQ-08).
            geo: null,
            directory: ports.stateReads.arming.directory,
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
    dispatcher,
    install() {
      const restores = [
        setBatchHooks({ clock: { now } }),
        setSafetyDeps(safety),
        setBundleDeps(ports.bundles),
        setGuardDeps({ targets: ports.targets }),
        setTurnDeps(turn),
        setLeaseHooks(turnChats.around(pinnedRuns.around(turnHooks))),
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

const workerRoots = new WeakMap<Cloudflare.Env, Root>();

/** The Worker's secrets the root reads, by name: none is in a file here; staging's are set by name (T-568). */
export interface WorkerSecrets {
  /** K-11's webhook secret (K-11 README default 1), read at each verify; missing until it is set. */
  readonly LINQ_WEBHOOK_SECRET?: string;
}

/**
 * The Worker's root for its environment (ENVIRONMENT; ./picks.ts). The real set (./real.ts) and the closed set are the
 * ones at hand in a Worker: the Linq verify reads LINQ_WEBHOOK_SECRET by name at each call (missing, every verify fails,
 * so the gateway answers 503), and the sealing, turn-row, bundle, targets, frontier and gate ports are handed no K-05
 * call, scope or read, since no database is bound to the Worker until T-567 (Hyperdrive), so every seal fails closed and
 * the gateway answers 503 with nothing written, no turn's bundle can be pinned, no frontier runs and nothing commits; the
 * decide port is handed no decider until J-02, so no decide runs. The gateway's door to the handle's actor is the
 * HANDLE_ACTOR binding where the environment has one (T-553; env.staging has none until T-566, so there the door stays
 * closed), and
 * no release flags are handed in until staging has its database and the flag's deploy step (T-567, T-569), so the
 * skeleton flag reads off and `linqWebhook` answers 404. One root per env object, so its memories (rows' traces, armed
 * parts) last as long as the isolate does.
 */
export function workerRoot(env: Cloudflare.Env & WorkerSecrets): Root {
  const known = workerRoots.get(env);
  if (known !== undefined) return known;
  const root = composeRoot({
    environment: environmentOf(env),
    actors: handleActorsOf(env),
    vars: env,
    linq: { webhookSecret: () => env.LINQ_WEBHOOK_SECRET },
    // No database is bound until T-567: the sealing port fails closed (./real.ts NoDatabaseError).
    handleKey: null,
    // No safety read until the bundle's manifest (T-555's bundle reads, T-566's BUNDLES on staging) and the model key
    // (J-02; DL-027) can be read in the Worker: every read fails closed (./real.ts NoSafetyReaderError), so the actor
    // applies its no-verdict rule.
    safetyReaders: null,
    // No database is bound until T-567: every commit and park fails closed (./real.ts NoDatabaseError), so no turn row is
    // written; a turn whose commit is not taken lapses and is parked, and its park is tried again (T-248, T-253).
    turnRows: null,
    // No database is bound until T-567 (nor BUNDLES until T-566; T-1154 binds both): every bundle read fails closed
    // (./real.ts NoDatabaseError), so no turn's bundle is pinned and no turn's work starts, and the gateway's trace names
    // bundle v0's stand-in (answer.ts).
    bundleReads: null,
    // No database is bound until T-567: every targets read fails closed, so the guard hands no text to the frontier.
    handleTargets: null,
    // No database is bound until T-567 (its rosie_job client gives pgFrontierScope): every frontier fails closed inside
    // the Tool API base, before anything is read, so no text reaches decide.
    frontierScope: null,
    // No decide until the bundle's manifest and flows (T-566's BUNDLES, T-567's database) and the model key (J-02;
    // smoke-size calls only, DL-027) can be read in the Worker: every decide and re-read fails closed before any model
    // call (./real.ts NoDeciderError), so no decided part reaches the gate.
    deciders: null,
    // No database is bound until T-567 (its rosie_app and rosie_job clients give pgCallScope and the gate's reads): every
    // gate fails closed inside the Tool API base, before anything is read or written, so nothing commits.
    gateReads: null,
    // No database is bound until T-567 (its rosie_app and rosie_job clients give pgCallScope and readOutboxRow): every
    // compose input fails closed inside the Tool API base, before anything is read, so no row is composed.
    composeReads: null,
    // No composer until the bundle's manifest (T-566's BUNDLES, T-567's database) and the model key (J-02; smoke-size
    // calls only, DL-027) can be read in the Worker: every compose and rewrite fails closed before any model call
    // (./real.ts NoComposerError), so no row gets a plan and nothing is sent for it.
    composers: null,
    // The test-phone page's calls (T-1186) have nothing to read until T-567 binds the database (the session, roster and
    // phone reads), so the Worker leaves them unconfigured: both answer 503 (notConnected), as every page call does until
    // its handler is joined. T-567 hands RootOptions.testPhone, with staging's test-phone line as
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

/**
 * Wires the Worker's actor ports for this isolate (the root's `install()`), once, on its first request (DL-313 ruling 2):
 * only where the HandleActor namespace is bound, and never at global scope. Where none is bound (the Workers test pool,
 * and staging until T-566) nothing is wired, so the actor keeps its unwired defaults. Answers the root wired, or null.
 */
export function wireWorker(env: Cloudflare.Env & WorkerSecrets): Root | null {
  if (wired !== null) return wired.root;
  if (env.HANDLE_ACTOR === undefined) return null;
  const root = workerRoot(env);
  wired = { root, restore: root.install() };
  return root;
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
