// The skeleton's local target through the Worker's own composition root, inside workerd (T-1149; C-148; DL-332). Imported
// only by ./skeleton.worker.test.ts, which the e2e-workers project runs in the Workers runtime.
//
// T-465's local target (../_driver) signs a text with the Linq double's hook and posts it to runtime/src/wiring's
// root.linqWebhook, composed for the test environment as the joins' own Workers tests compose it (runtime/src/wiring
// hop5.worker.test.ts, with the doubles of runtime/src/wiring/test-support.ts): the HandleActor namespace (exports.HandleActor
// in the pool, standing in for env.HANDLE_ACTOR until T-566), the skeleton flag on, the actor's ports installed, and each
// joined port fed its double:
//
//   join 1, linqVerify  the root's real verify, holding the webhook secret made up for this run, which the target signs with;
//   join 2, sealing     K-05 v1.2 handleSealingKey as a double answering as the handle-key-*.json fixtures;
//   join 3, safetyRead  @rosie/ai's safety read over the recorded-model double (each skeleton text reads No);
//   join 4, turnRow     K-05's commitTurn and parkTurn as a double keeping each turn id's one K-04 turns row;
//   join 5, bundles     K-05's bundle reads holding bundle v0 as bundles/v0 publishes it, and targets: K-05 v1.2
//                       handleTargets over test owner 1's seeded rows (T-1148), as targets-first-text.json;
//   join 6, frontier    @rosie/actions' turn face over the frontier's scope: K-05 v1.2 readTurnState as a double over
//                       test owner 1's seeded rows (T-1148), reading the bundle the turn pinned;
//   join 7, decide      @rosie/ai's decider (T-369's createDecider with T-370's re-read), one per bundle, over the
//                       recorded-model double: a fake Messages API answered from ai/recordings (recording 2, DL-347);
//   join 8, gate        @rosie/actions' turn face's gateAndCommit (T-1141), its reads over test owner 1's seeded rows
//                       and what the K-05 commitTurn double wrote, its one commit through the root's turn-row port;
//   join 9, compose     @rosie/actions' turn face's composeInput (T-1141), over a K-05 v1.6 readOutboxRow double over
//                       what the commit wrote and test owner 1's seeded rows, and @rosie/ai's composer over the
//                       recorded-model double's composer models: T-1175's recording 4, the JOIN run's S1-02 row (DL-347);
//   join 10, finalize   @rosie/actions' turn face's finalizeMessage (T-1141: T-313's finalize, T-314's fixed lines), over
//                       K-05 doubles of readOutboxRow, readFixedLineFacts, writePlan and cancelClock over what the commit
//                       wrote and test owner 1's seeded rows, which keep the plan and final parts written into the row.
//
// Every port not joined yet is on its fake (T-550). The turn's gate and finalize calls are watched on their way to the
// root's own (watchGate; the finalize requests kept on the fake face, as its stand-in kept them), which changes nothing
// they are sent or answer. The spans are the log lines the target
// captures; the actor's inbox, safety state, batches and turns are read inside its Durable Object, and the K-05 doubles
// keep the rows they wrote.
//
// Inside workerd, Ajv's compiler cannot run and contracts/ is not on disk, so the trace is checked against K-08 by the code
// T-1144 prebuilds for the Worker (prebuiltTraceCheck). Test values only (rule 9): the master's sample cast, the fictional
// 555-01xx numbers, and a webhook secret made up for the run, never Linq's.

import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";

import { createToolApiValidator } from "../../../actions/src/tool-api/validator";
import type { HandleActor } from "../../../runtime/src/actor";
import { actorNameOf } from "../../../runtime/src/gateway";
import { composeRoot, SKELETON_FLAG, type HandleActors, type Root } from "../../../runtime/src/wiring";
import {
  fakeFlags,
  skeletonFakes,
  watchGate,
  type SkeletonFakes,
  type WatchedGateCall,
} from "../../../runtime/src/wiring/test-support";
import { createLocalTarget, makeTestWebhookSecret, type LocalTarget, type TraceCheck } from "../_driver";

type Namespace = DurableObjectNamespace<HandleActor>;

/** How long a step of the actor's lent work may take before a wait gives up. */
export const WAIT_MS = 15_000;

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

/** The HandleActor namespace as the root takes it. */
function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

const pause = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * K-08 v1's span on every span of a trace (K-08 v1.1's `span`, v1's by $ref: event-trace README "v1.1"), by the code
 * `npm run build:validators` prebuilds for the Worker (T-1144; test:e2e builds it first), each problem naming its hop and
 * seq. The trace's own fields are read from its spans (T-465's traceOf), so its spans are what there is to check.
 */
export function prebuiltTraceCheck(): TraceCheck {
  const validator = createToolApiValidator();
  return (trace) =>
    trace.spans.flatMap((span) =>
      validator.checkSpan(span).map((line) => `hop ${span.hop} (seq ${String(span.seq)}): ${line}`),
    );
}

/** One handle's actor, read inside its Durable Object, and waited on over its RPC. */
export interface ActorReader {
  readonly stub: DurableObjectStub<HandleActor>;
  /** Its ordered inbox (HandleActor.readInbox). */
  inbox(): Promise<ReturnType<HandleActor["readInbox"]>>;
  /** Each stored text's safety state (HandleActor.readSafety). */
  safety(): Promise<ReturnType<HandleActor["readSafety"]>>;
  /** Its batches (HandleActor.readBatches). */
  batches(): Promise<ReturnType<HandleActor["readBatches"]>>;
  /** Waits until it has read every text and handed on, and run, what its batch window and lease can. */
  settle(): Promise<void>;
  /** Waits until this turn has committed, its reply has ended and its lease is released (T-253). */
  untilReplied(turnId: string): Promise<void>;
}

/** The actor of the handle `handle`. */
export function actorOf(handle: { readonly kind: string; readonly address: string }): ActorReader {
  const stub = namespace().get(namespace().idFromName(actorNameOf(handle)));
  return {
    stub,
    inbox: () => runInDurableObject(stub, (actor: HandleActor) => actor.readInbox()),
    safety: () => runInDurableObject(stub, (actor: HandleActor) => actor.readSafety()),
    batches: () => runInDurableObject(stub, (actor: HandleActor) => actor.readBatches()),
    async settle() {
      await stub.safetyIdle();
      await stub.batchIdle();
    },
    async untilReplied(turnId) {
      const started = Date.now();
      for (;;) {
        const turn = (await stub.readTurns()).find((entry) => entry.turnId === turnId);
        if (turn?.state === "committed" && turn.leaseUntil === null) return;
        if (Date.now() - started > WAIT_MS) {
          throw new Error(
            `gave up waiting for turn ${turnId}'s reply to end (state ${turn?.state ?? "none"})`,
          );
        }
        await pause(5);
      }
    },
  };
}

export interface RootRun {
  /** T-465's local target, posting through root.linqWebhook. */
  readonly target: LocalTarget;
  /** The doubles every port is fed, and the rows they keep. */
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  /** Each gateAndCommit the turn handed the root, as the turn made it, with the gate port's answer (watchGate). */
  readonly gateCalls: readonly WatchedGateCall[];
  /** Puts the actor's earlier ports back and stops the target's log capture. */
  close(): void;
}

/** The composition root for "test", with every joined port fed its double, and T-465's local target posting to it. */
export function startRootRun(): RootRun {
  const fakes = skeletonFakes();
  const secret = makeTestWebhookSecret();
  // The target first: its log capture is in place before the root binds its span sinks to console.log.
  const target = createLocalTarget({
    gateway: (request) => root.linqWebhook(request),
    basePath: env.BASE_PATH,
    webhookSecret: secret,
    now: () => fakes.clock.now(),
    traceCheck: prebuiltTraceCheck(),
  });
  let root: Root;
  let restore: () => void;
  let watched: ReturnType<typeof watchGate>;
  try {
    root = composeRoot({
      environment: "test",
      sets: { fake: fakes.ports },
      actors: handleActors(),
      vars: env,
      clock: fakes.clock,
      linq: { ...fakes.linqInputs, webhookSecret: () => secret },
      handleKey: fakes.handleKeys.call,
      safetyReaders: fakes.models.readers,
      turnRows: fakes.turnRows.calls,
      bundleReads: fakes.bundleReads.calls,
      handleTargets: fakes.handleTargets.call,
      frontierScope: fakes.frontier.scope,
      deciders: fakes.decide.deciders,
      gateReads: fakes.gate.reads,
      composeReads: fakes.compose.reads,
      composers: fakes.composer.composers,
      finalizeData: fakes.finalize.data,
      flags: fakeFlags([SKELETON_FLAG]),
    });
    restore = root.install();
    // After the install: the watch goes on the root's own turn deps, and comes off before them.
    watched = watchGate(root, fakes.face);
  } catch (error) {
    // Nothing is left capturing console.log when the root cannot be composed.
    target.close();
    throw error;
  }
  return {
    target,
    fakes,
    root,
    gateCalls: watched.calls,
    close() {
      target.close();
      watched.restore();
      restore();
    },
  };
}
