// The composition root (T-550; C-046, C-044; build prompt section 10, D-017 'Joins: one hop at a time, in the turn order
// of What changes'; ops/plan/02-contracts.md section 11): the one place that builds the Worker's gateway, the handle
// actor's turn and the outbox dispatcher, with each of the ten ports of ./ports.ts bound once to the implementation its
// environment picks (./picks.ts, checked by ./bind.ts). Each join (T-552 to T-564) swaps one port's pick for the real
// package; nothing else here changes for it.
//
// What the root builds from the ports:
//
//   - the gateway's doors (runtime/src/gateway GatewayDeps): the Linq verify port, the sealing key store, the door to the
//     handle's actor (the HandleActor namespace it is handed; closed when it is handed none), the receipt door, and the
//     active bundle id each webhook's trace names (K-08 v1 README default 1);
//   - the handle actor's ports, put in place for the isolate by `install()`: the safety read on arrival (T-246), the
//     batch clock (T-247), the bundle pin's reads (T-249), the guard's targets (T-250), the turn loop as the lease's hooks
//     (T-248, T-251 to T-253) and the turn's ports (`TurnDeps`), the Durable Object reading each of them at use;
//   - the outbox dispatcher (T-257), which the turn wakes once its rows are composed (T-252): one claim-and-send run for
//     the turn's recipient, each claimed row on the turn's trace;
//   - the receipt door: a delivery receipt marks its part delivered and arms its question's clock (T-255), on the trace
//     its row was sent on when this isolate knows it (./row-traces.ts), else on the receipt's own.
//
// The Worker (runtime/src/index.ts) takes its gateway from `workerRoot(env)`: only the closed set is at hand there, so
// until a join lands every door fails and each webhook route answers 503, as before. A test composes the root with
// environment "test" and the fakes (./test-support.ts), the HandleActor namespace and its own clock. Never logged by the
// root: a word, a number, a key.

import { setBatchHooks } from "../actor/batch";
import { setLeaseHooks } from "../actor/lease";
import { setBundleDeps } from "../bundle/pin";
import type { BundleRegistry } from "../bundle/types";
import { ArmingMemory, clockArming } from "../clocks/arming";
import type { ClockActorRpc } from "../clocks/types";
import { handleDeliveryReceipt, runDispatch } from "../dispatch/dispatcher";
import { durableObjectActor, type HandleActorRpc } from "../gateway/actor-door";
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
import type { Ports } from "./ports";
import { RowTraces } from "./row-traces";

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
  /** The implementation sets the picks may name besides the root's own closed set: a test's fakes. */
  readonly sets?: ImplementationSets;
  /** The HandleActor namespace; null where none is bound, so the gateway's door to the actor is closed. */
  readonly actors: HandleActors | null;
  /** The Worker's ENVIRONMENT and GIT_SHA: every log line carries them, and limit 8 honours the test phone's override on staging only. */
  readonly vars: { readonly ENVIRONMENT: string; readonly GIT_SHA?: string | undefined };
  /** The clock; the Workers clock when left out. */
  readonly clock?: RootClock;
}

export interface Root {
  readonly environment: Environment;
  /** Each port and the implementation it took, in D-017's turn order. */
  readonly bindings: readonly Binding[];
  readonly ports: Ports;
  /** The gateway's doors, for the Worker's webhook routes. */
  readonly gateway: GatewayDeps;
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
  const { ports, bindings } = bindPorts(PICKS, options.environment, {
    ...options.sets,
    closed: closedPorts(),
  });
  const clock = options.clock ?? WORKER_CLOCK;
  const now = (): number => clock.now();
  const utc = (): string => new Date(clock.now()).toISOString();
  const log: LogContext = {
    environment: options.vars.ENVIRONMENT,
    version: options.vars.GIT_SHA ?? "unknown",
  };
  const rowTraces = new RowTraces();
  const armings = new ArmingMemory();
  const claimer = `dispatcher-${crypto.randomUUID()}`;

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
          claimer,
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
      buildFrontier: (request, trace) => ports.turnFace.buildFrontier(request, trace),
      closestEntries: (request, trace) => ports.turnFace.closestEntries(request, trace),
      gateAndCommit: (request, at, trace) => ports.turnFace.gateAndCommit(request, at, trace),
      composeInput: (request, trace) => ports.turnFace.composeInput(request, trace),
      finalizeMessage: (request, trace) => ports.finalize.finalizeMessage(request, trace),
    },
    ai: ports.decide,
    composer: ports.composer,
    rows: ports.dataAccess.rows,
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

  const gateway: GatewayDeps = {
    linq: ports.linqVerify,
    actor: options.actors === null ? closedActorDoor() : durableObjectActor(options.actors),
    receipts,
    keys: ports.sealing,
    bundleId: () => activeBundleId(ports.stateReads.bundles.registry),
    now,
  };

  return {
    environment: options.environment,
    bindings,
    ports,
    gateway,
    turn,
    safety,
    dispatcher,
    install() {
      const restores = [
        setBatchHooks({ clock: { now } }),
        setSafetyDeps(safety),
        setBundleDeps(ports.stateReads.bundles),
        setGuardDeps({ targets: ports.stateReads.targets }),
        setTurnDeps(turn),
        setLeaseHooks(turnHooks),
      ];
      return () => {
        for (const restore of restores.reverse()) restore();
      };
    },
  };
}

const workerRoots = new WeakMap<Cloudflare.Env, Root>();

/**
 * The Worker's root for its environment (ENVIRONMENT; ./picks.ts): the closed set is the only one at hand in a Worker, and
 * no HandleActor namespace is handed to the gateway until its join (T-553, with env.staging's binding from T-566). One
 * root per env object, so its memories (rows' traces, armed parts) last as long as the isolate does.
 */
export function workerRoot(env: Cloudflare.Env): Root {
  const known = workerRoots.get(env);
  if (known !== undefined) return known;
  const root = composeRoot({ environment: environmentOf(env), actors: null, vars: env });
  workerRoots.set(env, root);
  return root;
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
