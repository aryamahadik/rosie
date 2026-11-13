// The composition root's bindings (T-550, T-552, T-553, T-554, T-555, T-556, T-557, T-558, T-559, T-560, T-561, T-562,
// T-1213, T-563, T-564), under Node (Vitest project "unit"): the ports the root binds in each environment, each once and
// none left unbound; the check that refuses a port bound twice or left unbound; each bound port handed to the part that
// calls it; and the closed implementation the Worker's environments still bind for every port no join has reached (T-552
// joined the Linq verify on staging, T-553 the sealing, T-554 the safety read, T-555 the turn-row calls, T-556 the bundle
// reads and the guard's targets, T-557 the frontier, T-558 decide, T-559 the gate, T-560 compose input and the composer,
// T-561 finalize, T-562 the outbox and the send state, T-1213 the chat open, T-563 the Linq send and the dispatcher's
// retries, T-564 the clock arming, T-1242 staging's state reads and plan calls; production takes no join yet).
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import joinComposeInput from "@rosie/ai/recordings/composer-inputs/join-s1-02.json";
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import claimInOrderWithPort from "@rosie/contracts/data-access/fixtures/claim-in-order-with-port.json";
import parkTurnJson from "@rosie/contracts/data-access/fixtures/park-turn.json";
import renewClaimReadsPhone from "@rosie/contracts/data-access/fixtures/renew-claim-reads-phone.json";
import sendStateOwner from "@rosie/contracts/data-access/fixtures/send-state-owner.json";
import textImessage from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import planS102 from "@rosie/contracts/message-plan/fixtures/plan-s1-02.json";
import sendText from "@rosie/contracts/port-linq/fixtures/send-text.json";
import buildFrontierS101 from "@rosie/contracts/tool-api/fixtures/build-frontier-s1-01.json";
import commitS101 from "@rosie/contracts/tool-api/fixtures/commit-s1-01.json";
import composeInputS102 from "@rosie/contracts/tool-api/fixtures/compose-input-s1-02.json";
import finalizePass from "@rosie/contracts/tool-api/fixtures/finalize-pass.json";
import type {
  ClaimOutboxV12Outcome,
  ClaimOutboxV114Outcome,
  ClaimOutboxV114Request,
  MarkPartV12Outcome,
  MarkRowV12Outcome,
  RenewClaimOutcome,
} from "@rosie/db/repo/outbox";
import type { SendStateResponse } from "@rosie/db/repo/send-state";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { turnIdOf } from "../actor/lease";
import type { LinqAccepted, LinqSendRequest } from "../dispatch/types";
import { prepareHandoff } from "../gateway/hand-off";
import { fakeKeyStore } from "../gateway/test-support";
import { queueDeps, type JobTry } from "../queues";
import { SafetyOnArrival } from "../safety";
import type { SafetyDeps } from "../safety/types";
import { openTrace, type Span } from "../trace";
import { spansOfLogLines } from "../trace/hop-check";
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
  type ArmingCalls,
  type HandleActors,
  type ImplementationSets,
  type OutboxCalls,
  type PortName,
  type PortPick,
  type Ports,
  type Root,
} from "./index";
import { SendClassNotCarriedError } from "./real";
import { BUNDLE_V0, fakeHandleKeys, skeletonFakes } from "./test-support";

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
    // Each text's safety result is no port of the turn's nor a state read (ADR-015 section 1; T-1264): each run reads it
    // through its leased turn, from the handle's own actor.
    expect(Object.keys(root.turn)).not.toContain("safety");
    expect(Object.keys(root.ports.stateReads.turn)).toEqual(["directory"]);
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

describe("the dispatcher's port to the recipient actor's one reading (T-1337; DL-656)", () => {
  const ROW = "out-safety-evt-sam-0001-outage";
  const SAM_ACTOR = "phone:+15555550100";
  const [first] = (
    claimInOrderWithPort.outcome as unknown as Extract<ClaimOutboxV12Outcome, { result: "claimed" }>
  ).claimed;
  if (first === undefined) throw new Error("the fixture claims a row");
  const CLAIMED = first;

  /** Which claims a test's K-05 outbox calls bind (T-1356). */
  interface ClaimBinding {
    /**
     * K-05 v1.14's claim beside v1.2's (OutboxCalls.claimOutboxV114), answering as db/repo's claimOutboxV114 does
     * (T-1354): with sendClass safety, item 67's safety-only claim, which takes the row only when its class is safety;
     * without it, v1.13's claim of every class (db/repo default 24), the row with v1.13's emailPurpose and notAfter.
     * Left out, v1.2's claim alone, which cannot carry the field.
     */
    readonly v114?: boolean;
    /** How many of its first claims v1.14's claim answers transient, as its lock wait past its bound (55P03). */
    readonly transient?: number;
  }

  /**
   * K-05 v1.2's outbox calls over one row for Sam: claim-in-order-with-port.json's row as the core writes an outage line's
   * (send class quick_reply, the line's id among its fixed lines, its one words part, no version read), each mark kept,
   * and each claim's recipient (T-1341; null: none named). The row is ROW unless another id is given, on the fixture's
   * trace id unless another is given; a danger line's row (T-1352) gives its own class, fixed lines and words. With
   * `binding.v114`, v1.14's claim is bound beside them (T-1356). Each request either claim gets is kept as it came.
   */
  function outboxCalls(
    row: string = ROW,
    traceId: string = CLAIMED.traceId,
    line: { sendClass: string; fixedLines: string[]; text: string } = {
      sendClass: CLAIMED.sendClass,
      fixedLines: ["outage"],
      text: "Rosie is down for a few minutes. If anyone is in danger, call 911.",
    },
    binding: ClaimBinding = {},
  ): OutboxCalls & {
    readonly rowMarks: string[];
    readonly claims: (string | null)[];
    readonly v12Requests: unknown[];
    readonly v114Requests: unknown[];
  } {
    const rowMarks: string[] = [];
    const claims: (string | null)[] = [];
    const v12Requests: unknown[] = [];
    const v114Requests: unknown[] = [];
    const claimedRow = () => ({
      ...structuredClone(CLAIMED),
      traceId,
      outboxRowId: row,
      recipientHandleId: "handle-sam",
      recipientPersonId: "person-sam",
      bookingId: null,
      sendClass: line.sendClass,
      versionsRead: [],
      finalParts: {
        ...structuredClone(CLAIMED.finalParts),
        row,
        sends: [
          {
            kind: "words",
            text: line.text,
            calendarFile: "none",
            options: [],
            link: null,
          },
        ],
        fixedLines: line.fixedLines,
        slotValues: [],
      },
      parts: [{ partNo: 1, tryNo: 1, idempotencyKey: `${row}/1/1`, attempts: 1, sent: false }],
    });
    const claimOutboxV114 = (request: ClaimOutboxV114Request): Promise<ClaimOutboxV114Outcome> => {
      claims.push(request.recipientHandleId ?? null);
      v114Requests.push(structuredClone(request));
      if (v114Requests.length <= (binding.transient ?? 0)) {
        return Promise.resolve({ error: "transient", sqlstate: "55P03" });
      }
      // Item 67: with sendClass safety, the recipient's safety rows alone; without it, v1.13's claim of every class.
      const taken = request.sendClass === undefined || line.sendClass === "safety";
      return Promise.resolve({
        result: "claimed",
        claimed: taken ? [{ ...claimedRow(), emailPurpose: null, notAfter: null }] : [],
        passedHeld: [],
      } as unknown as ClaimOutboxV114Outcome);
    };
    return {
      rowMarks,
      claims,
      v12Requests,
      v114Requests,
      claimOutboxV12: (request) => {
        claims.push(request.recipientHandleId ?? null);
        v12Requests.push(structuredClone(request));
        return Promise.resolve({
          result: "claimed",
          claimed: [claimedRow()],
          passedHeld: [],
        } as unknown as ClaimOutboxV12Outcome);
      },
      ...(binding.v114 === true ? { claimOutboxV114 } : {}),
      renewClaim: () =>
        Promise.resolve({
          ...structuredClone(renewClaimReadsPhone.outcome),
          outboxRowId: row,
        } as unknown as RenewClaimOutcome),
      markPartV12: (request) =>
        Promise.resolve({
          result: "marked",
          outboxRowId: row,
          partNo: 1,
          tryNo: 1,
          attempts: 1,
          repeated: false,
          firstDelivery: false,
          openQuestionId: null,
          nextKey: null,
          row: { state: request.outcome === "sent" ? "sent" : "sending", version: 5 },
          repeatedDelivery: null,
        } as unknown as MarkPartV12Outcome),
      markRowV12: (request) => {
        rowMarks.push(request.outcome);
        return Promise.resolve({
          result: "marked",
          outboxRowId: row,
          version: request.expectVersion + 1,
          outcome: request.outcome,
        } as unknown as MarkRowV12Outcome);
      },
    };
  }

  /** send-state-owner.json for Sam's row with his Linq chat: not stopped, the chat open, no version read. */
  const sendStateOf = (row: string) => (): Promise<SendStateResponse> =>
    Promise.resolve({
      ...(structuredClone(sendStateOwner.outcome) as unknown as SendStateResponse),
      outboxRowId: row,
      chat: { threadId: "thread-s1-01-sam-1", linqChatId: "linq-chat-demo-sam", version: 1 },
      currentVersions: [],
    });
  const sendState = sendStateOf(ROW);

  /** The arming's calls: only the directory is read here, naming Sam's actor for his K-04 handle id (or none). */
  const armingCalls = (named: string | null): ArmingCalls & { readonly named: string[] } => {
    const asked: string[] = [];
    return {
      named: asked,
      armClock: () => Promise.reject(new Error("not used")),
      cancelClock: () => Promise.reject(new Error("not used")),
      questionFacts: () => Promise.reject(new Error("not used")),
      actorNameOf: (handleId) => {
        asked.push(handleId);
        return Promise.resolve(handleId === "handle-sam" ? named : null);
      },
    };
  };

  /** A HandleActors namespace whose actors answer the reading as `answer` says; each actor asked is kept. */
  function actorsAnswering(
    answer: () => Promise<boolean>,
    withCall = true,
  ): HandleActors<string> & { readonly asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      idFromName: (name) => name,
      get: (id) => ({
        accept: () => Promise.reject(new Error("not used")),
        fireClockRow: () => Promise.reject(new Error("not used")),
        syncClocks: () => Promise.reject(new Error("not used")),
        ...(withCall
          ? {
              mayHaveStoppedNow: () => {
                asked.push(id);
                return answer();
              },
            }
          : {}),
      }),
    };
  }

  /**
   * The root under test with these actors and that directory answer, its claimed row on `traceId` (the fixture's when left
   * out); each part Linq got is kept.
   */
  function rootWith(actors: HandleActors | null, named: string | null = SAM_ACTOR, traceId?: string) {
    const outbox = outboxCalls(ROW, traceId);
    const arming = armingCalls(named);
    const sent: LinqSendRequest[] = [];
    const accepted: LinqAccepted = {
      result: "accepted",
      providerMessageId: "linq-msg-test-0001",
      providerOptionIds: null,
      chatId: "linq-chat-demo-sam",
      service: "imessage",
      acceptedAt: "2026-11-07T15:06:36Z",
    };
    const root = composeRoot({
      environment: "test",
      sets: { fake: skeletonFakes().ports },
      actors,
      vars: VARS,
      outboxCalls: outbox,
      sendStateCall: sendState,
      linqSendCall: (request) => {
        sent.push(request);
        return Promise.resolve(accepted);
      },
      armingCalls: arming,
    });
    const trace = openTrace({ openedBy: "textWebhook", bundleId: BUNDLE_V0, sink: () => undefined });
    return {
      root,
      outbox,
      arming,
      sent,
      wake: () =>
        root.dispatcher.wake({ turnId: "turn-t1337", handleId: "handle-sam", outboxRowIds: [ROW] }, trace),
      retry: () => {
        const job: JobTry = {
          key: `retry-${ROW}/1/1#1`,
          kind: "send",
          businessId: "biz-lees-barbershop",
          traceId: "trace-sam-0001",
          body: {
            outboxRowId: ROW,
            recipientHandleId: "handle-sam",
            failedKey: `${ROW}/1/1`,
            chain: "rerun",
            code: "sameKey",
          },
          try: 2,
          firstTriedAt: "2026-11-07T15:06:35Z",
        };
        return root.queue.sends.retrySend(job);
      },
    };
  }

  it("is joined into every run the root makes: the turn's wake and the retry door's run each ask the actor of the row's recipient, named by the arming port's directory and reached through the HandleActor namespace, right before an outage line's row goes", async () => {
    let says = false;
    const actors = actorsAnswering(() => Promise.resolve(says));
    const run = rootWith(actors);

    // False: the part goes once, under its key.
    await run.wake();
    expect(run.arming.named).toEqual(["handle-sam"]);
    expect(actors.asked).toEqual([SAM_ACTOR]);
    expect(run.sent.map((request) => request.idempotencyKey)).toEqual([`${ROW}/1/1`]);
    expect(run.outbox.rowMarks).toEqual([]);

    // True, on the retry door's run: nothing more goes, and the row is dropped as stopped.
    says = true;
    expect(await run.retry()).toEqual({ result: "done" });
    expect(actors.asked).toEqual([SAM_ACTOR, SAM_ACTOR]);
    expect(run.sent).toHaveLength(1);
    expect(run.outbox.rowMarks).toEqual(["droppedStopped"]);
  });

  const FAILS: { why: string; actors: () => HandleActors | null; named: string | null }[] = [
    {
      why: "no HandleActor namespace is bound (the Worker's root where the environment has none)",
      actors: () => null,
      named: SAM_ACTOR,
    },
    {
      why: "the directory names no actor for the recipient",
      actors: () => actorsAnswering(() => Promise.resolve(false)),
      named: null,
    },
    {
      why: "the actor has no such call",
      actors: () => actorsAnswering(() => Promise.resolve(false), false),
      named: SAM_ACTOR,
    },
    {
      why: "the actor's call rejects",
      actors: () => actorsAnswering(() => Promise.reject(new Error("unreachable"))),
      named: SAM_ACTOR,
    },
  ];

  it.each(FAILS)(
    "fails closed when $why: nothing is sent, and the row is dropped as stopped",
    async ({ actors, named }) => {
      const run = rootWith(actors(), named);

      await run.wake();

      expect(run.sent).toEqual([]);
      expect(run.outbox.rowMarks).toEqual(["droppedStopped"]);
    },
  );

  // ---- T-1341 (DL-669): the outage lines' writers' wake ------------------------------------------------------------

  describe("the outage lines' writers' wake (T-1341; DL-669), joined as SafetyDeps.wake", () => {
    /** The trace id the claimed row carries (one id from the webhook to the receipt), in K-08's form. */
    const ROW_TRACE = "22222222-3333-4444-8555-666666666666";

    /** The root's safety deps' wake, which the root must join: called through them. */
    function writersWake(root: Root): NonNullable<SafetyDeps["wake"]> {
      return (request) => {
        if (root.safety.wake === undefined) throw new Error("the root's safety deps carry no wake");
        return root.safety.wake(request);
      };
    }

    /** The log lines the root's own traces write (logSink), kept from the console for each test here. */
    let log: MockInstance<typeof console.log>;
    beforeEach(() => {
      log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    });
    afterEach(() => {
      log.mockRestore();
    });

    it("the root's safety deps carry the outage lines' writers' wake: one dispatcher run for the recipient the wake names, on the same ports, so T-1337's reading is asked right before the outage part goes; a row this isolate sent on no trace goes on a trace opened under its own trace id", async () => {
      let says = false;
      const actors = actorsAnswering(() => Promise.resolve(says));
      const run = rootWith(actors, SAM_ACTOR, ROW_TRACE);
      const wake = writersWake(run.root);

      // False: the one run's claim names the recipient; the part goes once, under its key, on the row's own trace id.
      await wake({ handleId: "handle-sam", outboxRowIds: [ROW] });
      expect(run.outbox.claims).toEqual(["handle-sam"]);
      expect(run.arming.named).toEqual(["handle-sam"]);
      expect(actors.asked).toEqual([SAM_ACTOR]);
      expect(run.sent.map((request) => request.idempotencyKey)).toEqual([`${ROW}/1/1`]);
      const dispatched = (): unknown[] =>
        spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0]))
          .filter((span) => span.hop === "dispatch")
          .map((span) => [span.trace_id, span.outcome]);
      expect(dispatched()).toEqual([[ROW_TRACE, "ok"]]);

      // True, at a later wake: its run asks again, nothing more goes, and the row is dropped as stopped.
      says = true;
      await wake({ handleId: "handle-sam", outboxRowIds: [ROW] });
      expect(run.outbox.claims).toEqual(["handle-sam", "handle-sam"]);
      expect(actors.asked).toEqual([SAM_ACTOR, SAM_ACTOR]);
      expect(run.sent).toHaveLength(1);
      expect(run.outbox.rowMarks).toEqual(["droppedStopped"]);
      expect(dispatched()).toEqual([
        [ROW_TRACE, "ok"],
        [ROW_TRACE, "dropped"],
      ]);
    });

    it("the writers' wake keeps a row this isolate sent on the trace it was sent on, as the retry door's run does", async () => {
      const actors = actorsAnswering(() => Promise.resolve(false));
      const run = rootWith(actors, SAM_ACTOR, ROW_TRACE);
      const spans: Span[] = [];
      const turnTrace = openTrace({
        openedBy: "textWebhook",
        bundleId: BUNDLE_V0,
        sink: (span) => spans.push(span),
      });

      await run.root.dispatcher.wake(
        { turnId: "turn-t1341", handleId: "handle-sam", outboxRowIds: [ROW] },
        turnTrace,
      );
      await writersWake(run.root)({ handleId: "handle-sam", outboxRowIds: [ROW] });

      expect(run.outbox.claims).toEqual(["handle-sam", "handle-sam"]);
      expect(spans.filter((span) => span.hop === "dispatch").map((span) => span.trace_id)).toEqual([
        turnTrace.traceId,
        turnTrace.traceId,
      ]);
      expect(
        spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0])).filter(
          (span) => span.hop === "dispatch",
        ),
      ).toEqual([]);
    });

    it("install() puts the safety deps carrying the writers' wake in place (setSafetyDeps): a text whose words cannot be read gets the timeout rule's outage line through the core, the writer wakes its row while the host's reading says false, and the root's run claims it for the line's recipient and sends it once", async () => {
      const EVENT = "evt-sam-1341-1";
      const row = `out-fixed-safety:${EVENT}`;
      const fakes = skeletonFakes();
      const outbox = outboxCalls(row);
      const sent: LinqSendRequest[] = [];
      const actors = actorsAnswering(() => Promise.resolve(false));
      const root = composeRoot({
        environment: "test",
        sets: { fake: fakes.ports },
        actors,
        vars: VARS,
        // No deadline ever comes: the text's words cannot be opened (no database is bound for the sealing port), so the
        // timeout rule applies at once.
        clock: {
          now: () => Date.parse("2026-11-07T15:06:35Z"),
          after: () => new Promise<void>(() => undefined),
        },
        outboxCalls: outbox,
        sendStateCall: sendStateOf(row),
        linqSendCall: (request) => {
          sent.push(request);
          return Promise.resolve({
            result: "accepted",
            providerMessageId: "linq-msg-test-1341",
            providerOptionIds: null,
            chatId: "linq-chat-demo-sam",
            service: "imessage",
            acceptedAt: "2026-11-07T15:06:36Z",
          });
        },
        armingCalls: armingCalls(SAM_ACTOR),
      });
      const keys = fakeKeyStore();
      const restore = root.install();
      try {
        const safety = new SafetyOnArrival({
          storage: sqlStorage(),
          spanSink: () => () => undefined,
          storedTexts: () => [],
          returns: { enqueue: () => undefined },
          stopped: () => false,
        });
        const prepared = await prepareHandoff(
          {
            event: {
              ...textImessage,
              eventId: EVENT,
              body: "Test words: is Saturday open?",
              traceId: ROW_TRACE,
            },
            partKey: null,
            traceId: ROW_TRACE,
            bundleId: BUNDLE_V0,
          },
          keys,
        );
        if (prepared.door !== "actor") throw new Error("not an actor event");

        await safety.arrive(prepared.handoff);
        await safety.idle();

        expect(
          fakes.core.fixed.map((call) => [call.request.caller.requestId, call.request.fixedLineId]),
        ).toEqual([[`safety:${EVENT}`, "outage"]]);
        expect(safety.readSafety()).toEqual([
          expect.objectContaining({ eventId: EVENT, state: "done", path: "outbox", lineId: "outage" }),
        ]);
        expect(outbox.claims).toEqual(["handle-sam"]);
        expect(actors.asked).toEqual([SAM_ACTOR]);
        expect(sent.map((request) => request.idempotencyKey)).toEqual([`${row}/1/1`]);
        expect(fakes.direct.sent).toEqual([]);
      } finally {
        restore();
      }
    });
  });

  // ---- T-1352 (DL-687): the danger line's own wake --------------------------------------------------------------------

  describe("the danger line's own wake (T-1352; DL-687; K-05 v1.14 item 67), joined as SafetyDeps.wakeSafety", () => {
    /** The trace id the claimed row carries (one id from the webhook to the receipt), in K-08's form. */
    const ROW_TRACE = "33333333-4444-4555-8666-777777777777";
    /** A danger line's row, as the core writes it for a text's danger (K-09 recordSafetyOutcome's safetyLine). */
    const DANGER_ROW = "out-evt-sam-1352-1";
    const SAFETY_LINE = {
      sendClass: "safety",
      fixedLines: ["safetyEmergency"],
      text: "This sounds like an emergency. If anyone is in danger, get to safety and call 911 now.",
    };
    const OUTAGE_LINE = {
      sendClass: "quick_reply",
      fixedLines: ["outage"],
      text: "Rosie is down for a few minutes. If anyone is in danger, call 911.",
    };

    /** The root's safety deps' danger wake, which the root must join: called through them. */
    function dangerWake(root: Root): NonNullable<SafetyDeps["wakeSafety"]> {
      return (request) => {
        if (root.safety.wakeSafety === undefined)
          throw new Error("the root's safety deps carry no danger wake");
        return root.safety.wakeSafety(request);
      };
    }

    /**
     * A wrapper between the real outbox port and K-05's calls that drops the claim's sendClass (a fault: the real port
     * never drops it, T-1356), so v1.14's claim gets v1.2's request and makes v1.13's claim of every class.
     */
    function droppingSendClass(calls: OutboxCalls): OutboxCalls {
      const { claimOutboxV114 } = calls;
      if (claimOutboxV114 === undefined) throw new Error("no v1.14 claim to wrap");
      return {
        ...calls,
        claimOutboxV114: (request) =>
          claimOutboxV114({
            claimer: request.claimer,
            ...(request.recipientHandleId === undefined
              ? {}
              : { recipientHandleId: request.recipientHandleId }),
            now: request.now,
            limit: request.limit,
          }),
      };
    }

    /**
     * The root under test with the HandleActor namespace given, K-05's outbox calls over one row of `line`'s class for Sam
     * on ROW_TRACE, and each part Linq got kept. The calls bind v1.14's claim beside v1.2's (T-1356), as the real outbox
     * port takes it, unless `binding` says otherwise; with `dropping`, a wrapper drops the claim's sendClass on its way.
     */
    function dangerRoot(
      actors: HandleActors,
      line: typeof SAFETY_LINE,
      options: {
        handleKey?: ReturnType<typeof fakeHandleKeys>["call"];
        row?: string;
        binding?: ClaimBinding;
        dropping?: boolean;
      } = {},
    ) {
      const row = options.row ?? DANGER_ROW;
      const fakes = skeletonFakes();
      const outbox = outboxCalls(row, ROW_TRACE, line, options.binding ?? { v114: true });
      const sent: LinqSendRequest[] = [];
      const root = composeRoot({
        environment: "test",
        sets: { fake: fakes.ports },
        actors,
        vars: VARS,
        // No deadline ever comes: a text's read fails at once (no safety reader is handed in), so its timeout rule applies.
        clock: {
          now: () => Date.parse("2026-11-07T15:06:35Z"),
          after: () => new Promise<void>(() => undefined),
        },
        ...(options.handleKey === undefined ? {} : { handleKey: options.handleKey }),
        outboxCalls: options.dropping === true ? droppingSendClass(outbox) : outbox,
        sendStateCall: sendStateOf(row),
        linqSendCall: (request) => {
          sent.push(request);
          return Promise.resolve({
            result: "accepted",
            providerMessageId: "linq-msg-test-1352",
            providerOptionIds: null,
            chatId: "linq-chat-demo-sam",
            service: "imessage",
            acceptedAt: "2026-11-07T15:06:36Z",
          });
        },
        armingCalls: armingCalls(SAM_ACTOR),
      });
      return { root, fakes, outbox, sent };
    }

    /** The log lines the root's own traces write (logSink), kept from the console for each test here. */
    let log: MockInstance<typeof console.log>;
    beforeEach(() => {
      log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    });
    afterEach(() => {
      log.mockRestore();
    });

    /** The dispatch spans the root's traces wrote: each one's trace id, outcome and error code. */
    const dispatched = (): unknown[] =>
      spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0]))
        .filter((span) => span.hop === "dispatch")
        .map((span) => [span.trace_id, span.outcome, span.error_code ?? null]);

    /**
     * A claim's request as the root's dispatcher makes it for Sam at the root's clock: v1.2's four fields (its claimer the
     * root's own), and `more`. Compared with toStrictEqual, so a field it does not name, even one left undefined, fails.
     */
    function claimRequest(more: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        claimer: expect.stringMatching(/^dispatcher-/),
        recipientHandleId: "handle-sam",
        now: "2026-11-07T15:06:35.000Z",
        limit: 10,
        ...more,
      };
    }

    it("the root's safety deps carry the danger line's own wake, apart from the outage lines' wake: one safety run for the recipient the wake names, on the same ports, its claim reaching K-05 v1.14's claim with sendClass safety through the real outbox port (T-1356); its claimed safety row goes once under its key, past an opt-out only as limit 8 says, with no reading asked (the actor would say stopped), on the row's own trace id", async () => {
      const actors = actorsAnswering(() => Promise.resolve(true));
      const run = dangerRoot(actors, SAFETY_LINE);

      await dangerWake(run.root)({ handleId: "handle-sam", outboxRowIds: [DANGER_ROW] });

      expect(run.outbox.claims).toEqual(["handle-sam"]);
      expect(run.outbox.v114Requests).toStrictEqual([claimRequest({ sendClass: "safety" })]);
      expect(run.outbox.v12Requests).toEqual([]);
      expect(actors.asked).toEqual([]);
      expect(run.sent.map((request) => [request.idempotencyKey, request.overrideOptout])).toEqual([
        [`${DANGER_ROW}/1/1`, false],
      ]);
      expect(run.outbox.rowMarks).toEqual([]);
      expect(dispatched()).toEqual([[ROW_TRACE, "ok", null]]);
    });

    it("fails closed when a wrapper drops the field between the real outbox port and K-05's claim (T-1356: the port itself never drops it): v1.14's claim gets v1.2's request and makes v1.13's claim of every class, and a row of another class it hands back is never sent, read or marked, its claim left to lapse; the outage lines' wake, a run of every class, would send that row", async () => {
      const actors = actorsAnswering(() => Promise.resolve(false));
      const run = dangerRoot(actors, OUTAGE_LINE, { dropping: true });

      await dangerWake(run.root)({ handleId: "handle-sam", outboxRowIds: [DANGER_ROW] });

      expect(run.outbox.claims).toEqual(["handle-sam"]);
      // The field dropped on its way: K-05's claim got v1.2's request.
      expect(run.outbox.v114Requests).toStrictEqual([claimRequest()]);
      expect(run.sent).toEqual([]);
      expect(run.outbox.rowMarks).toEqual([]);
      expect(actors.asked).toEqual([]);
      expect(dispatched()).toEqual([[ROW_TRACE, "refused", "notSafetyClass"]]);

      // The same row, on the outage lines' wake: a run of every class, which asks the reading (false) and sends it.
      if (run.root.safety.wake === undefined) throw new Error("the root's safety deps carry no wake");
      await run.root.safety.wake({ handleId: "handle-sam", outboxRowIds: [DANGER_ROW] });
      expect(actors.asked).toEqual([SAM_ACTOR]);
      expect(run.sent.map((request) => request.idempotencyKey)).toEqual([`${DANGER_ROW}/1/1`]);
    });

    // ---- T-1356 (DL-717, DL-725): the real outbox port's claim with K-05 v1.14's sendClass --------------------------

    it("refuses the danger wake's claim where the bound calls cannot carry the field (K-05 v1.2's claim alone, no v1.14 claim bound): nothing is claimed, read, sent or marked, and no claim of every class is made in its place; the row waits for the recipient's next run, whose claim, with no field, goes to claimOutboxV12 as before", async () => {
      const actors = actorsAnswering(() => Promise.resolve(true));
      const run = dangerRoot(actors, SAFETY_LINE, { binding: {} });

      await expect(
        dangerWake(run.root)({ handleId: "handle-sam", outboxRowIds: [DANGER_ROW] }),
      ).rejects.toThrow(SendClassNotCarriedError);

      expect(run.outbox.claims).toEqual([]);
      expect(run.outbox.v12Requests).toEqual([]);
      expect(run.sent).toEqual([]);
      expect(run.outbox.rowMarks).toEqual([]);
      expect(actors.asked).toEqual([]);
      expect(dispatched()).toEqual([]);

      // The recipient's next run, the outage lines' wake (no field): v1.2's request to claimOutboxV12, and the row goes.
      if (run.root.safety.wake === undefined) throw new Error("the root's safety deps carry no wake");
      await run.root.safety.wake({ handleId: "handle-sam", outboxRowIds: [DANGER_ROW] });
      expect(run.outbox.v12Requests).toStrictEqual([claimRequest()]);
      expect(run.sent.map((request) => [request.idempotencyKey, request.overrideOptout])).toEqual([
        [`${DANGER_ROW}/1/1`, false],
      ]);
      expect(actors.asked).toEqual([]);
    });

    it("hands the danger wake v1.14's transient answer as it is (its lock wait past its bound, 55P03), so the safety run repeats the claim, three tries at most: two transient answers and then the claim send the line once; three transient answers send nothing", async () => {
      const once = dangerRoot(
        actorsAnswering(() => Promise.resolve(false)),
        SAFETY_LINE,
        {
          binding: { v114: true, transient: 2 },
        },
      );
      await dangerWake(once.root)({ handleId: "handle-sam", outboxRowIds: [DANGER_ROW] });
      expect(once.outbox.v114Requests).toStrictEqual([
        claimRequest({ sendClass: "safety" }),
        claimRequest({ sendClass: "safety" }),
        claimRequest({ sendClass: "safety" }),
      ]);
      expect(once.outbox.v12Requests).toEqual([]);
      expect(once.sent.map((request) => request.idempotencyKey)).toEqual([`${DANGER_ROW}/1/1`]);
      expect(dispatched()).toEqual([[ROW_TRACE, "ok", null]]);

      const never = dangerRoot(
        actorsAnswering(() => Promise.resolve(false)),
        SAFETY_LINE,
        {
          binding: { v114: true, transient: 3 },
        },
      );
      await dangerWake(never.root)({ handleId: "handle-sam", outboxRowIds: [DANGER_ROW] });
      expect(never.outbox.v114Requests).toHaveLength(3);
      expect(never.outbox.v12Requests).toEqual([]);
      expect(never.sent).toEqual([]);
      expect(dispatched()).toEqual([[ROW_TRACE, "ok", null]]);
    });

    it("leaves an ordinary run's claim unchanged with v1.14's claim bound: the turn's wake, the outage lines' wake and the retry door's run each make v1.2's request, its four fields and no sendClass, which reaches claimOutboxV114 as v1.13's claim (db/repo default 24) where it reached claimOutboxV12 before, and the row goes the same way", async () => {
      const ordinaryRuns = async (binding: ClaimBinding) => {
        const run = dangerRoot(
          actorsAnswering(() => Promise.resolve(false)),
          OUTAGE_LINE,
          { binding },
        );
        const turnTrace = openTrace({ openedBy: "textWebhook", bundleId: BUNDLE_V0, sink: () => undefined });
        await run.root.dispatcher.wake(
          { turnId: "turn-t1356", handleId: "handle-sam", outboxRowIds: [DANGER_ROW] },
          turnTrace,
        );
        if (run.root.safety.wake === undefined) throw new Error("the root's safety deps carry no wake");
        await run.root.safety.wake({ handleId: "handle-sam", outboxRowIds: [DANGER_ROW] });
        const job: JobTry = {
          key: `retry-${DANGER_ROW}/1/1#1`,
          kind: "send",
          businessId: "biz-lees-barbershop",
          traceId: "trace-sam-0001",
          body: {
            outboxRowId: DANGER_ROW,
            recipientHandleId: "handle-sam",
            failedKey: `${DANGER_ROW}/1/1`,
            chain: "rerun",
            code: "sameKey",
          },
          try: 2,
          firstTriedAt: "2026-11-07T15:06:35Z",
        };
        expect(await run.root.queue.sends.retrySend(job)).toEqual({ result: "done" });
        return run;
      };

      const before = await ordinaryRuns({});
      const after = await ordinaryRuns({ v114: true });

      expect(before.outbox.v12Requests).toStrictEqual([claimRequest(), claimRequest(), claimRequest()]);
      expect(after.outbox.v114Requests).toStrictEqual([claimRequest(), claimRequest(), claimRequest()]);
      expect(after.outbox.v12Requests).toEqual([]);
      expect(after.outbox.claims).toEqual(before.outbox.claims);
      expect(after.sent).toEqual(before.sent);
      expect(after.sent.map((request) => request.idempotencyKey)).toEqual([
        `${DANGER_ROW}/1/1`,
        `${DANGER_ROW}/1/1`,
        `${DANGER_ROW}/1/1`,
      ]);
      expect(after.outbox.rowMarks).toEqual(before.outbox.rowMarks);
    });

    it("install() puts the safety deps carrying the danger wake in place (setSafetyDeps): a text whose words hold a danger word gets no verdict, so its timeout rule records the danger through the core, which names its line's row; the writer wakes it, never gated, and the root's safety run claims it for the line's recipient through the real outbox port, K-05 v1.14's claim with sendClass safety (T-1356), and sends it once, with no reading asked", async () => {
      const EVENT = "evt-sam-1352-1";
      const row = `out-${EVENT}`;
      const keys = fakeHandleKeys();
      const actors = actorsAnswering(() => Promise.resolve(true));
      const run = dangerRoot(actors, SAFETY_LINE, { handleKey: keys.call, row });
      const restore = run.root.install();
      try {
        const safety = new SafetyOnArrival({
          storage: sqlStorage(),
          spanSink: () => () => undefined,
          storedTexts: () => [],
          returns: { enqueue: () => undefined },
          // The actor's reading says stopped: the danger line never asks it.
          stopped: () => true,
        });
        // Sealed with the root's own sealing port, so the actor's read opens the words with the same key.
        const prepared = await prepareHandoff(
          {
            event: {
              ...textImessage,
              eventId: EVENT,
              body: "Test words: my lips are swelling",
              traceId: ROW_TRACE,
            },
            partKey: null,
            traceId: ROW_TRACE,
            bundleId: BUNDLE_V0,
          },
          run.root.gateway.keys,
        );
        if (prepared.door !== "actor") throw new Error("not an actor event");

        await safety.arrive(prepared.handoff);
        await safety.idle();

        expect(
          run.fakes.core.recorded.map((call) => [
            call.request.caller.requestId,
            call.request.safety.outcomes,
            "error" in call.response ? null : call.response.safetyLine,
          ]),
        ).toEqual([[`safety:${EVENT}`, ["Unsure"], { fixedLineId: "safetyEmergency", outboxRowId: row }]]);
        expect(safety.readSafety()).toEqual([
          expect.objectContaining({ eventId: EVENT, state: "done", danger: true, path: "outbox" }),
        ]);
        expect(run.outbox.claims).toEqual(["handle-sam"]);
        expect(run.outbox.v114Requests).toStrictEqual([claimRequest({ sendClass: "safety" })]);
        expect(run.outbox.v12Requests).toEqual([]);
        expect(actors.asked).toEqual([]);
        expect(run.sent.map((request) => request.idempotencyKey)).toEqual([`${row}/1/1`]);
        expect(run.fakes.direct.sent).toEqual([]);
      } finally {
        restore();
      }
    });

    it("install() with outbox calls that cannot carry the field (K-05 v1.2's claim alone): the danger text's line is recorded through the core and its writer wakes the row, but the real port refuses the safety run's claim before any call, so nothing is claimed or sent, no claim of every class is made, nothing goes direct, and the line's result stands (path outbox)", async () => {
      const EVENT = "evt-sam-1356-1";
      const row = `out-${EVENT}`;
      const keys = fakeHandleKeys();
      const actors = actorsAnswering(() => Promise.resolve(true));
      const run = dangerRoot(actors, SAFETY_LINE, { handleKey: keys.call, row, binding: {} });
      const restore = run.root.install();
      try {
        const safety = new SafetyOnArrival({
          storage: sqlStorage(),
          spanSink: () => () => undefined,
          storedTexts: () => [],
          returns: { enqueue: () => undefined },
          stopped: () => true,
        });
        const prepared = await prepareHandoff(
          {
            event: {
              ...textImessage,
              eventId: EVENT,
              body: "Test words: my lips are swelling",
              traceId: ROW_TRACE,
            },
            partKey: null,
            traceId: ROW_TRACE,
            bundleId: BUNDLE_V0,
          },
          run.root.gateway.keys,
        );
        if (prepared.door !== "actor") throw new Error("not an actor event");

        await safety.arrive(prepared.handoff);
        await safety.idle();

        expect(
          run.fakes.core.recorded.map((call) => [
            call.request.caller.requestId,
            "error" in call.response ? null : call.response.safetyLine,
          ]),
        ).toEqual([[`safety:${EVENT}`, { fixedLineId: "safetyEmergency", outboxRowId: row }]]);
        expect(safety.readSafety()).toEqual([
          expect.objectContaining({ eventId: EVENT, state: "done", danger: true, path: "outbox" }),
        ]);
        expect(run.outbox.claims).toEqual([]);
        expect(run.outbox.v12Requests).toEqual([]);
        expect(run.sent).toEqual([]);
        expect(run.outbox.rowMarks).toEqual([]);
        expect(actors.asked).toEqual([]);
        expect(run.fakes.direct.sent).toEqual([]);
        expect(dispatched()).toEqual([]);
      } finally {
        restore();
      }
    });
  });
});

/**
 * The Durable Object's SQL storage for a Node test: an in-memory SQLite database (as ../safety/partial-bundle.test.ts
 * makes it). The actor's safety read uses only `sql.exec(...).toArray()`.
 */
function sqlStorage(): DurableObjectStorage {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: SQLInputValue[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  };
  return { sql } as unknown as DurableObjectStorage;
}
