// The composition root's bindings (T-550, T-552, T-553, T-554, T-555, T-556, T-557, T-558, T-559, T-560, T-561, T-562,
// T-1213, T-563, T-564), under Node (Vitest project "unit"): the ports the root binds in each environment, each once and
// none left unbound; the check that refuses a port bound twice or left unbound; each bound port handed to the part that
// calls it; and the closed implementation the Worker's environments still bind for every port no join has reached (T-552
// joined the Linq verify on staging, T-553 the sealing, T-554 the safety read, T-555 the turn-row calls, T-556 the bundle
// reads and the guard's targets, T-557 the frontier, T-558 decide, T-559 the gate, T-560 compose input and the composer,
// T-561 finalize, T-562 the outbox and the send state, T-1213 the chat open, T-563 the Linq send and the dispatcher's
// retries, T-564 the clock arming, T-1242 staging's state reads and plan calls; production takes no join yet).
import joinComposeInput from "@rosie/ai/recordings/composer-inputs/join-s1-02.json";
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import parkTurnJson from "@rosie/contracts/data-access/fixtures/park-turn.json";
import planS102 from "@rosie/contracts/message-plan/fixtures/plan-s1-02.json";
import sendText from "@rosie/contracts/port-linq/fixtures/send-text.json";
import buildFrontierS101 from "@rosie/contracts/tool-api/fixtures/build-frontier-s1-01.json";
import commitS101 from "@rosie/contracts/tool-api/fixtures/commit-s1-01.json";
import composeInputS102 from "@rosie/contracts/tool-api/fixtures/compose-input-s1-02.json";
import finalizePass from "@rosie/contracts/tool-api/fixtures/finalize-pass.json";
import { describe, expect, it, vi } from "vitest";

import { turnIdOf } from "../actor/lease";
import type { LinqSendRequest } from "../dispatch/types";
import { queueDeps } from "../queues";
import { openTrace, type Span } from "../trace";
import type {
  BuildFrontierRequest,
  ComposeInput,
  ComposeInputRequest,
  DecideContext,
  DecideResult,
  FinalizeMessageRequest,
  GateAndCommitRequest,
  MessagePlan,
  ParkTurnRequest,
} from "../turn/types";
import {
  bindPorts,
  closedPorts,
  composeRoot,
  environmentOf,
  LINQ_WEBHOOK_SECRET,
  MissingSecretError,
  NO_DEAD_LETTERS,
  NoComposerError,
  NoDatabaseError,
  NoDeciderError,
  NoLinqLineError,
  NotJoinedError,
  PICKS,
  PORTS,
  realPorts,
  WiringError,
  workerRoot,
  type ImplementationSets,
  type PortName,
  type PortPick,
  type Ports,
} from "./index";
import { BUNDLE_V0, skeletonFakes } from "./test-support";

const VARS = { ENVIRONMENT: "staging", GIT_SHA: "test-sha" };

/** A Worker's env as wrangler.jsonc's vars give it, for one environment. */
function workerEnv(environment: string): Cloudflare.Env {
  return { ENVIRONMENT: environment, BASE_PATH: "", DB_SCHEMA: "" };
}

/**
 * The ports joined so far in each environment (./picks.ts): their real package; every other port on its fake under test,
 * and closed on the Worker's environments. On staging the state reads and the plan calls are real too (T-1242), each
 * read failing closed until the part of T-1154 that binds it (./state-reads.worker.test.ts).
 */
const JOINED: Readonly<Record<"test" | "staging" | "production", readonly PortName[]>> = {
  test: [
    "linqVerify",
    "sealing",
    "chatOpen",
    "safetyRead",
    "turnRow",
    "bundles",
    "targets",
    "frontier",
    "decide",
    "gate",
    "composeInput",
    "composer",
    "finalize",
    "outbox",
    "sendState",
    "linqSend",
    "arming",
  ],
  staging: [
    "linqVerify",
    "sealing",
    "chatOpen",
    "safetyRead",
    "turnRow",
    "bundles",
    "targets",
    "frontier",
    "stateReads",
    "decide",
    "gate",
    "composeInput",
    "composer",
    "finalize",
    "outbox",
    "sendState",
    "dataAccess",
    "linqSend",
    "arming",
  ],
  production: [],
};

/** finalize-pass.json's request (S1-02's row of turn 1 and its plan) on a trace of its own: its caller's trace id that trace's. */
function finalizeOneOn(traceId: string): FinalizeMessageRequest {
  const request = structuredClone(finalizePass.request) as unknown as FinalizeMessageRequest;
  return { ...request, caller: { ...request.caller, traceId } };
}

/** compose-input-s1-02.json's request (S1-02's row of turn 1) on a trace of its own: its caller's trace id that trace's. */
function composeOneOn(traceId: string): ComposeInputRequest {
  const request = structuredClone(composeInputS102.request) as unknown as ComposeInputRequest;
  return { ...request, caller: { ...request.caller, traceId } };
}

/**
 * commit-s1-01.json's request (turn 1's gateAndCommit, its turn carrying the service and chat id of Sam's text) on a
 * trace of its own: its caller's and its turn's trace id that trace's.
 */
function commitOneOn(traceId: string): GateAndCommitRequest {
  const request = structuredClone(commitS101.request) as unknown as GateAndCommitRequest;
  return { ...request, caller: { ...request.caller, traceId }, turn: { ...request.turn, traceId } };
}

/** build-frontier-s1-01.json's request (turn 1, Sam's first text) on a trace of its own, under bundle v0. */
function turnOneOn(traceId: string): BuildFrontierRequest {
  const request = structuredClone(buildFrontierS101.request) as unknown as BuildFrontierRequest;
  return {
    ...request,
    caller: { ...request.caller, traceId },
    turn: { ...request.turn, traceId, bundleId: { ...BUNDLE_V0 } },
  };
}

/** park-turn.json's request under the turn id the lease hashes from its event ids (CQ-09), as a lapsed turn's park sends it. */
async function leasePark(): Promise<ParkTurnRequest> {
  const request = structuredClone(parkTurnJson.request) as unknown as ParkTurnRequest;
  return { ...request, turn: { ...request.turn, id: await turnIdOf(request.turn.eventIds) } };
}

describe("the ports the root binds", () => {
  it("names D-017's twenty-one ports in its turn order, the direct line last", () => {
    expect(PORTS).toEqual([
      "linqVerify",
      "sealing",
      "chatOpen",
      "safetyRead",
      "turnRow",
      "bundles",
      "targets",
      "frontier",
      "stateReads",
      "turnFace",
      "decide",
      "gate",
      "composeInput",
      "composer",
      "finalize",
      "outbox",
      "sendState",
      "dataAccess",
      "linqSend",
      "arming",
      "linqDirect",
    ]);
  });

  it("picks each port once, in turn order: no port is picked twice and none is left out", () => {
    expect(PICKS.map((pick) => pick.port)).toEqual([...PORTS]);
  });

  it("binds every port once under test: the joined Linq verify, sealing, chat open, safety read, turn-row calls, bundle reads, targets read, frontier, decide, gate, compose input, composer, finalize, outbox, send state, Linq send and clock arming to their real packages, every other port to its fake", () => {
    const root = composeRoot({
      environment: "test",
      sets: { fake: skeletonFakes().ports },
      actors: null,
      vars: VARS,
    });

    expect(root.bindings).toEqual(
      PORTS.map((port) => ({ port, implementation: JOINED.test.includes(port) ? "real" : "fake" })),
    );
    // CQ-159: the real frontier port's Tool API base records the frontier span, so the turn records none of its own.
    expect(root.turn.toolApi.recordsFrontierSpan).toBe(true);
  });

  it.each(["staging", "production"] as const)(
    "binds every port once on the Worker's %s: each port joined there to its real package, every other still closed",
    (environment) => {
      const root = workerRoot(workerEnv(environment));
      const joined = JOINED[environment];

      expect(root.environment).toBe(environment);
      expect(root.bindings).toEqual(
        PORTS.map((port) => ({ port, implementation: joined.includes(port) ? "real" : "closed" })),
      );
      // CQ-159: the turn leaves the frontier span to the port only where the real frontier port (its Tool API base)
      // records it; where the port is closed, the turn records the failed frontier itself.
      expect(root.turn.toolApi.recordsFrontierSpan).toBe(joined.includes("frontier"));
    },
  );

  it("hands each bound port to the part that calls it", async () => {
    const fakes = skeletonFakes();
    const root = composeRoot({
      environment: "test",
      sets: { fake: fakes.ports },
      actors: null,
      vars: VARS,
      turnRows: fakes.turnRows.calls,
    });
    const fakeSet: Partial<Ports> = fakes.ports;

    for (const port of PORTS) {
      if (!JOINED.test.includes(port)) {
        expect(root.ports[port]).toBe(fakeSet[port]);
      }
    }
    expect(root.gateway.linq).toBe(root.ports.linqVerify);
    expect(root.gateway.keys).toBe(root.ports.sealing);
    // The gateway opens a number's chat at receipt through the chat-open port (T-1213), never a fake.
    expect(root.gateway.chats).toBe(root.ports.chatOpen);
    expect(root.safety.keys).toBe(root.ports.sealing);
    expect(root.turn.keys).toBe(root.ports.sealing);
    expect(root.safety.read).toBe(root.ports.safetyRead);
    expect(root.safety.bundle).toBe(fakes.ports.stateReads.safety.bundle);
    expect(root.safety.directory).toBe(fakes.ports.stateReads.safety.directory);
    expect(root.safety.core).toBe(fakes.ports.turnFace.safetyCore);
    expect(root.safety.direct).toBe(fakes.ports.linqDirect);
    expect(root.turn.directory).toBe(fakes.ports.stateReads.turn.directory);
    expect(root.turn.safety).toBe(fakes.ports.stateReads.turn.safety);
    // The turn's decide and its one re-read go to the joined decide port (T-558), never to a fake; its composer and the
    // one rewrite to the joined composer port (T-560).
    expect(root.turn.ai).toBe(root.ports.decide);
    expect(root.turn.composer).toBe(root.ports.composer);
    // The turn's plan calls go to the data-access port; its park writes the turn's one row through the turn-row port
    // (T-555), never through the data-access port's fake.
    const park = await leasePark();
    await root.turn.rows.unplannedRows({ turnId: park.turn.id });
    expect(await root.turn.rows.parkTurn(park)).toMatchObject({ result: "parked", turnId: park.turn.id });
    expect(fakes.face.log).toEqual(["unplannedRows"]);
    expect(fakes.turnRows.parks.map((request) => request.turn.id)).toEqual([park.turn.id]);
    expect(root.turn.dispatcher).toBe(root.dispatcher);
  });

  it("puts compose input and finalize together as the turn's Tool API, each call to its own joined port: with no reads or writes handed in, each fails closed inside the Tool API base, with no span, and no double is reached", async () => {
    const fakes = skeletonFakes();
    const root = composeRoot({ environment: "test", sets: { fake: fakes.ports }, actors: null, vars: VARS });
    const spans: Span[] = [];
    const trace = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE_V0,
      sink: (span) => spans.push(span),
    });
    const compose = composeOneOn(trace.traceId);
    trace.setTurn(compose.caller.turnId);

    await expect(root.turn.toolApi.composeInput(compose, trace)).rejects.toThrow(
      new NoDatabaseError("composeInput"),
    );
    await expect(root.turn.toolApi.finalizeMessage(finalizeOneOn(trace.traceId), trace)).rejects.toThrow(
      new NoDatabaseError("finalizeMessage"),
    );
    expect(spans).toEqual([]);
    expect(fakes.compose.scopes).toEqual([]);
    expect(fakes.finalize.scopes).toEqual([]);
    expect(fakes.finalize.writes).toEqual([]);
    expect(fakes.face.log).toEqual([]);
  });
});

describe("a port bound twice or left unbound is refused, naming the port", () => {
  const fakes = skeletonFakes();
  const sets: ImplementationSets = {
    fake: fakes.ports,
    real: realPorts({ linq: fakes.linqInputs, now: () => fakes.clock.now() }),
  };

  it("refuses a port picked twice", () => {
    const twice: PortPick[] = [
      ...PICKS,
      { port: "decide", test: "fake", staging: "closed", production: "closed" },
    ];

    expect(() => bindPorts(twice, "test", sets)).toThrow(
      new WiringError("port decide is bound twice in test"),
    );
  });

  it("refuses a port no pick names", () => {
    const without = PICKS.filter((pick) => pick.port !== "finalize");

    expect(() => bindPorts(without, "test", sets)).toThrow(
      new WiringError("left unbound in test: finalize (no pick)"),
    );
  });

  it("refuses a port whose picked implementation is not at hand", () => {
    // The data-access port: one no join has reached yet (T-562, T-564), so the test environment picks its fake (finalize
    // is joined, T-561).
    const partial = Object.fromEntries(
      Object.entries(skeletonFakes().ports).filter(([port]) => port !== "dataAccess"),
    ) as Partial<Ports>;

    expect(() => bindPorts(PICKS, "test", { ...sets, fake: partial })).toThrow(
      new WiringError("left unbound in test: dataAccess (no fake implementation)"),
    );
  });

  it("leaves every port unbound where the environment picks a set the root was not handed: no Worker takes the fakes", () => {
    const unbound = PORTS.filter((port) => !JOINED.test.includes(port))
      .map((port) => `${port} (no fake implementation)`)
      .join(", ");

    expect(() => composeRoot({ environment: "test", actors: null, vars: VARS })).toThrow(
      new WiringError(`left unbound in test: ${unbound}`),
    );
  });
});

describe("the Worker's environments", () => {
  it("is staging under env.staging and production anywhere else", () => {
    expect(environmentOf({ ENVIRONMENT: "staging" })).toBe("staging");
    expect(environmentOf({ ENVIRONMENT: "production" })).toBe("production");
    expect(environmentOf({ ENVIRONMENT: "" })).toBe("production");
  });

  it("keeps one root per Worker env object", () => {
    const env = workerEnv("staging");

    expect(workerRoot(env)).toBe(workerRoot(env));
  });

  it("keeps the gateway's doors closed: with no Linq webhook secret set the joined verify fails, the joined seal and active bundle read fail with no database bound (until T-567), and the actor fails", async () => {
    const { gateway } = workerRoot(workerEnv("staging"));
    const handle = { kind: "phone", address: "+15555550100" };

    await expect(
      gateway.linq.verifyWebhook({
        webhookId: "msg_1",
        timestamp: "1760286001",
        signature: "v1,x",
        raw: "{}",
        receivedAt: "2026-10-12T16:20:01.000Z",
        traceId: "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69",
      }),
    ).rejects.toThrow(new MissingSecretError(LINQ_WEBHOOK_SECRET));
    await expect(gateway.keys.getOrCreateKey(handle)).rejects.toThrow(
      new NoDatabaseError("handleSealingKey"),
    );
    // No HandleActor namespace is handed to the Worker's root yet (T-553): the door to the actor is closed.
    await expect(gateway.actor.accept({} as never)).rejects.toThrow(
      new WiringError("no HandleActor namespace is bound here"),
    );
    // The active bundle id cannot be read: the bundle port is joined (T-556) but fed no database until T-567, so the
    // gateway's answer rules use bundle v0's stand-in (answer.ts).
    await expect(Promise.resolve(gateway.bundleId())).rejects.toThrow(
      new NoDatabaseError("readActiveBundle"),
    );
  });

  it("fails the frontier closed with no database bound (until T-567): inside the Tool API base, its span failed, nothing read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = workerRoot(workerEnv("staging"));
    const spans: Span[] = [];
    const trace = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE_V0,
      sink: (span) => spans.push(span),
    });
    const request = turnOneOn(trace.traceId);
    trace.setTurn(request.turn.id);

    await expect(root.turn.toolApi.buildFrontier(request, trace)).rejects.toThrow(
      new NoDatabaseError("readTurnState"),
    );
    expect(spans).toMatchObject([
      {
        hop: "frontier",
        outcome: "failed",
        error_code: "NoDatabaseError",
        business_id: request.caller.businessId,
        got: { toolCall: "buildFrontier", callerKind: "turn", bundleParts: [], bundleFrom: [] },
        decided: { answered: "thrown" },
      },
    ]);
  });

  it("fails decide and its re-read closed with no decider bound (until J-02): before any model call, with no span", async () => {
    const root = workerRoot(workerEnv("staging"));
    const spans: Span[] = [];
    const trace = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE_V0,
      sink: (span) => spans.push(span),
    });
    // The JOIN run's own context (K-02 README "v1.1", recording 2): what the frontier gives turn 1 on bundle v0.
    const context = structuredClone(joinRunContext) as unknown as DecideContext;
    trace.setTurn(context.turnId);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(root.turn.ai.decide(context, trace)).rejects.toThrow(new NoDeciderError());
      await expect(
        root.turn.ai.reread({ context, decide: {} as DecideResult, why: "disagreed", failing: [] }, trace),
      ).rejects.toThrow(new NoDeciderError());
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(spans).toEqual([]);
  });

  it("fails the gate closed with no database bound (until T-567): inside the Tool API base, before anything is read or written, with no span", async () => {
    const root = workerRoot(workerEnv("staging"));
    const spans: Span[] = [];
    const trace = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE_V0,
      sink: (span) => spans.push(span),
    });
    const request = commitOneOn(trace.traceId);
    trace.setTurn(request.turn.id);

    await expect(root.turn.toolApi.gateAndCommit(request, { holds: [], unread: [] }, trace)).rejects.toThrow(
      new NoDatabaseError("gateAndCommit"),
    );
    // The turn records the gate and commit spans around the call; the base records none for it (DL-376).
    expect(spans).toEqual([]);
  });

  it("fails compose input closed with no database bound (until T-567): inside the Tool API base, before anything is read, with no span", async () => {
    const root = workerRoot(workerEnv("staging"));
    const spans: Span[] = [];
    const trace = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE_V0,
      sink: (span) => spans.push(span),
    });
    const request = composeOneOn(trace.traceId);
    trace.setTurn(request.caller.turnId);

    await expect(root.turn.toolApi.composeInput(request, trace)).rejects.toThrow(
      new NoDatabaseError("composeInput"),
    );
    // The turn records the row's fillAndChecks span; the base records none for compose input (DL-376).
    expect(spans).toEqual([]);
  });

  it("fails finalize closed with no database bound (until T-567): inside the Tool API base, before anything is read or written, with no span", async () => {
    const root = workerRoot(workerEnv("staging"));
    const spans: Span[] = [];
    const trace = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE_V0,
      sink: (span) => spans.push(span),
    });
    const request = finalizeOneOn(trace.traceId);
    trace.setTurn(request.caller.turnId);

    await expect(root.turn.toolApi.finalizeMessage(request, trace)).rejects.toThrow(
      new NoDatabaseError("finalizeMessage"),
    );
    // The turn records the row's fillAndChecks and rewriteOrFallback spans; the base records none for finalize (DL-376).
    expect(spans).toEqual([]);
  });

  it("fails the composer and its rewrite closed with no composer bound (until J-02): before any model call, with no span", async () => {
    const root = workerRoot(workerEnv("staging"));
    const spans: Span[] = [];
    const trace = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE_V0,
      sink: (span) => spans.push(span),
    });
    // Recording 4's request (K-02 README "v1.1"): the JOIN run's S1-02 row, as compose input gives it on bundle v0.
    const input = structuredClone(joinComposeInput) as unknown as ComposeInput;
    trace.setTurn(input.turn);
    const plan = structuredClone(planS102) as unknown as MessagePlan;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(root.turn.composer.compose(input, trace)).rejects.toThrow(new NoComposerError());
      await expect(
        root.turn.composer.rewrite(
          { input, plan, failed: [{ check: "oneQuestion", detail: "two questions" }] },
          trace,
        ),
      ).rejects.toThrow(new NoComposerError());
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(spans).toEqual([]);
  });

  it("fails the outbox and send-state ports closed with no database bound (until T-567): the dispatcher claims nothing, reads nothing and sends nothing", async () => {
    const root = workerRoot(workerEnv("staging"));
    const spans: Span[] = [];
    const trace = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE_V0,
      sink: (span) => spans.push(span),
    });
    await expect(
      root.ports.outbox.claimOutbox({ claimer: "dispatcher-1", now: "2026-11-07T15:06:35Z", limit: 10 }),
    ).rejects.toThrow(new NoDatabaseError("claimOutbox"));
    await expect(
      root.ports.outbox.markPart({
        outcome: "delivered",
        providerMessageId: "linq-msg-1",
        at: "2026-11-07T15:06:36Z",
      }),
    ).rejects.toThrow(new NoDatabaseError("markPart"));
    await expect(
      root.ports.sendState.sendState.sendStateFor({ outboxRowId: "outbox-s1-02-sam-1" } as never),
    ).rejects.toThrow(new NoDatabaseError("sendState"));
    // The turn's wake of the dispatcher: its claim fails closed before any row's span, so nothing is read or sent.
    await expect(
      root.dispatcher.wake({ turnId: "turn-s1-01-sam", handleId: "handle-sam", outboxRowIds: [] }, trace),
    ).rejects.toThrow(new NoDatabaseError("claimOutbox"));
    expect(spans).toEqual([]);
  });

  it("fails the Linq send port closed with no Linq line bound (T-563): on staging the joined port refuses every send before anything leaves, and production keeps the port closed", async () => {
    const request = structuredClone(sendText.request) as unknown as LinqSendRequest;

    await expect(workerRoot(workerEnv("staging")).ports.linqSend.parts.sendPart(request)).rejects.toThrow(
      new NoLinqLineError(),
    );
    await expect(workerRoot(workerEnv("production")).ports.linqSend.parts.sendPart(request)).rejects.toThrow(
      new NotJoinedError("linqSend"),
    );
  });

  it("fails the arming port closed with no database bound (until T-567, T-564): on staging each of the clock arming's calls and reads refuses before anything is read or armed, and production keeps the port closed", async () => {
    const arm = {
      openQuestionId: "oq-s1-02-sam-1",
      deliveredAt: "2026-10-19T14:02:01Z",
      dueAt: "2026-10-21T00:00:00Z",
      dueZone: "America/New_York",
    };
    const cancel = {
      clockRowId: "clock-oq-s1-02-sam-1",
      expectVersion: 1,
      withdrawQuestion: null,
      at: "2026-10-19T14:02:01Z",
    };
    const staging = workerRoot(workerEnv("staging")).ports.arming;
    await expect(staging.data.armClock(arm)).rejects.toThrow(new NoDatabaseError("armClock"));
    await expect(staging.data.cancelClock(cancel)).rejects.toThrow(new NoDatabaseError("cancelClock"));
    await expect(staging.facts.questionFacts(arm.openQuestionId)).rejects.toThrow(
      new NoDatabaseError("questionFacts"),
    );
    await expect(staging.directory.actorNameOf("handle-sam")).rejects.toThrow(
      new NoDatabaseError("actorNameOf"),
    );
    const production = workerRoot(workerEnv("production")).ports.arming;
    await expect(production.data.armClock(arm)).rejects.toThrow(new NotJoinedError("arming"));
    await expect(production.facts.questionFacts(arm.openQuestionId)).rejects.toThrow(
      new NotJoinedError("arming"),
    );
  });

  it("puts the retry queue's ports in place with the actor's (T-563, DL-315): its send jobs reach the dispatcher's door, no job kind or dead-letter writer is joined, and the earlier ports come back", async () => {
    const root = composeRoot({
      environment: "test",
      sets: { fake: skeletonFakes().ports },
      actors: null,
      vars: VARS,
    });
    const before = queueDeps();
    const restore = root.install();
    try {
      expect(queueDeps()).toBe(root.queue);
      expect(root.queue.jobs.size).toBe(0);
      expect(root.queue.deadLetters).toBe(NO_DEAD_LETTERS);
      // A job's dead letter is refused, never written and never lost: its message comes back (T-256's handOn).
      await expect(NO_DEAD_LETTERS.put({} as never)).resolves.toEqual({ error: "noDeadLetterStore" });
    } finally {
      restore();
    }
    expect(queueDeps()).toBe(before);
  });

  it("fails the chat-open port closed with no database bound (until T-567): the gateway's chat open, and the key call that gives its handle id, reach nothing", async () => {
    const { gateway, ports } = workerRoot(workerEnv("staging"));
    const request = {
      eventId: "evt-sam-s1-01",
      handleId: "handle-sam",
      service: "imessage",
      receivedAt: "2026-10-19T18:05:01Z",
      traceId: "trace-sam-0000",
    };

    expect(gateway.chats).toBe(ports.chatOpen);
    await expect(ports.chatOpen.openChatOnText(request)).rejects.toThrow(
      new NoDatabaseError("openChatOnText"),
    );
    await expect(
      ports.sealing.getOrCreateHandleKey?.({ kind: "phone", address: "+15555550100" }),
    ).rejects.toThrow(new NoDatabaseError("handleSealingKey"));
  });
});

describe("a closed port", () => {
  it("fails every call at once, naming its port and no value", async () => {
    const closed = closedPorts();

    await expect(closed.sealing.getOrCreateHandleKey?.({ kind: "phone", address: "x" })).rejects.toThrow(
      new NotJoinedError("sealing"),
    );
    await expect(closed.chatOpen.openChatOnText({} as never)).rejects.toThrow(new NotJoinedError("chatOpen"));
    await expect(closed.safetyRead.read({} as never)).rejects.toThrow(new NotJoinedError("safetyRead"));
    await expect(closed.turnRow.commitTurn({} as never)).rejects.toThrow(new NotJoinedError("turnRow"));
    await expect(closed.turnRow.parkTurn({} as never)).rejects.toThrow(new NotJoinedError("turnRow"));
    await expect(closed.bundles.registry.readActiveBundle({})).rejects.toThrow(new NotJoinedError("bundles"));
    await expect(closed.bundles.registry.readBundleValue({ key: "bundle/x/1/manifest" })).rejects.toThrow(
      new NotJoinedError("bundles"),
    );
    await expect(closed.targets.handleTargets({ handleId: "handle-sam" })).rejects.toThrow(
      new NotJoinedError("targets"),
    );
    await expect(closed.frontier.buildFrontier({} as never, {} as never)).rejects.toThrow(
      new NotJoinedError("frontier"),
    );
    await expect(closed.decide.decide({} as never, {} as never)).rejects.toThrow(
      new NotJoinedError("decide"),
    );
    await expect(closed.gate.gateAndCommit({} as never, {} as never, {} as never)).rejects.toThrow(
      new NotJoinedError("gate"),
    );
    await expect(closed.composeInput.composeInput({} as never, {} as never)).rejects.toThrow(
      new NotJoinedError("composeInput"),
    );
    await expect(closed.composer.compose({} as never, {} as never)).rejects.toThrow(
      new NotJoinedError("composer"),
    );
    await expect(closed.composer.rewrite({} as never, {} as never)).rejects.toThrow(
      new NotJoinedError("composer"),
    );
    await expect(closed.finalize.finalizeMessage({} as never, {} as never)).rejects.toThrow(
      new NotJoinedError("finalize"),
    );
    await expect(closed.outbox.claimOutbox({} as never)).rejects.toThrow(new NotJoinedError("outbox"));
    await expect(closed.outbox.markPart({} as never)).rejects.toThrow(new NotJoinedError("outbox"));
    await expect(closed.sendState.sendState.sendStateFor({} as never)).rejects.toThrow(
      new NotJoinedError("sendState"),
    );
    await expect(closed.sendState.recipients.chatFor("handle-sam")).rejects.toThrow(
      new NotJoinedError("sendState"),
    );
    await expect(closed.dataAccess.rows.unplannedRows({} as never)).rejects.toThrow(
      new NotJoinedError("dataAccess"),
    );
    await expect(closed.linqSend.parts.sendPart({} as never)).rejects.toThrow(new NotJoinedError("linqSend"));
    await expect(closed.arming.data.armClock({} as never)).rejects.toThrow(new NotJoinedError("arming"));
    await expect(closed.arming.data.cancelClock({} as never)).rejects.toThrow(new NotJoinedError("arming"));
    await expect(closed.arming.facts.questionFacts("oq-s1-02-sam-1")).rejects.toThrow(
      new NotJoinedError("arming"),
    );
    await expect(closed.arming.directory.actorNameOf("handle-sam")).rejects.toThrow(
      new NotJoinedError("arming"),
    );
    await expect(closed.linqDirect.send({} as never)).rejects.toThrow(new NotJoinedError("linqDirect"));
    expect(() => closed.stateReads.safety.bundle.dangerWords()).toThrow(new NotJoinedError("stateReads"));
  });
});
