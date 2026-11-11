// The composition root in the Workers runtime (T-550; C-046, C-044; build prompt section 10, D-017: "the trace shows every
// hop once, in order"; "a repeated webhook sends nothing twice"). The root is composed for the test environment, every
// port not joined yet on its fake (./test-support.ts) and the joined sealing port fed the K-05 double (T-553), with the
// HandleActor namespace and one test clock; `install()` puts
// the actor's ports in place; the webhooks go in through the Worker's own route under BASE_PATH (runtime/src/index.ts
// createWorker), with the root's gateway. Since T-552 joined the Linq verify, each webhook is signed by the Linq double
// (T-412) under the run's made-up secret and verified by the root's real verify (T-413), which is fed the same secret.
// Since T-554 joined the safety read, each text's read on arrival goes through @rosie/ai's safety read over the
// recorded-model double (./test-support.ts fakeSafetyModels, which holds each text these tests send); its model-call span
// (a portCall to provider anthropic, one per try) sits in the text's trace beside the hops, is set aside from the hop
// count as the actor's own receive span is, and is checked on its own. Since T-556 joined the bundle reads and the
// guard's targets, the turn pins bundle v0 as bundles/v0 publishes it (./test-support.ts fakeBundleReads, a K-05
// double), and the guard reads test owner 1's seeded targets (fakeHandleTargets, as targets-first-text.json answers).
// Since T-557 joined the frontier, the turn's frontier is @rosie/actions' turn face over the bundle the turn pinned and
// test owner 1's seeded stored state (fakeFrontierScope), whose Tool API base records the frontier span. Since T-558
// joined decide, the turn's two reads go through @rosie/ai's decider over the recorded-model double (fakeDecideModels,
// which holds the reads this test records for its turn), whose model-call spans sit in the trace beside the safety read's.
// Since T-559 joined the gate, the turn's gate and one commit go through @rosie/actions' turn face over the gate's reads'
// doubles (fakeGateReads), its commit through the turn-row port to the K-05 double (fakeTurnRows), whose rows the turn
// then composes. Since T-560 joined compose input and the composer, each row's composer input comes from @rosie/actions'
// turn face over a K-05 readOutboxRow double (fakeComposeReads), and its plan from @rosie/ai's composer over the
// recorded-model double (fakeComposerModels, which holds the plan of the turn this test records), whose model-call span
// sits in the trace beside decide's. Since T-561 joined finalize, each row's plan is finalized by @rosie/actions' turn
// face over K-05 doubles of its row calls (fakeFinalizeData), which keep the plan and final parts written into the row.
// Nothing else is wired by the test: the lease runs the turn loop, the turn wakes the root's dispatcher, and the root's
// receipt door marks the part delivered and arms its clock.
//
// The trace is judged as T-260's runtime trace test judges it (runtime/test/trace-e2e.worker.test.ts, which passes
// unchanged beside this file), with T-260's hop check (runtime/src/trace/hop-check.ts) against K-08 v1's
// trace-skeleton.json and trace-duplicate-webhook.json: every hop the merged runtime writes, once, in K-08's order, under
// one trace id and one bundle id. T-260's open gaps are the runtime's, not the root's: the scrub and batch hops have no
// writer yet (T-1096, T-1108), so each may be absent and is judged like any other once it is written; the handle actor's
// own receive span (T-1108) is set aside. No span may carry a raw phone number or a message's words. Test values only
// (rule 9).
import traceDuplicate from "@rosie/contracts/event-trace/fixtures/trace-duplicate-webhook.json";
import traceSkeleton from "@rosie/contracts/event-trace/fixtures/trace-skeleton.json";
import deliveredFixture from "@rosie/contracts/inbound-event/fixtures/delivered.json";
import duplicateFixture from "@rosie/contracts/inbound-event/fixtures/duplicate-event.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import composeInputS102 from "@rosie/contracts/tool-api/fixtures/compose-input-s1-02.json";
import finalizePass from "@rosie/contracts/tool-api/fixtures/finalize-pass.json";
import { createExecutionContext, reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { HandleActor } from "../actor";
import { A7_03_DELIVERED } from "../clocks/arming-support";
import { actorNameOf } from "../gateway";
import { createWorker } from "../index";
import { spanProblems, type Hop, type Span, type Trace } from "../trace";
import { checkHops, hopsOfTrace, leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { SAM, until } from "../turn/test-support";
import { composeRoot, type HandleActors, type Root } from "./index";
import {
  BUNDLE_V0,
  SAM_CHAT,
  SAM_TRADES_TEXT,
  SKELETON_ROW,
  skeletonFakes,
  watchGate,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
  type WatchedGateCall,
} from "./test-support";

type Json = Record<string, unknown>;

const SKELETON = traceSkeleton as unknown as Trace;
const DUPLICATE = traceDuplicate as unknown as Trace;

/**
 * Hops of a text's trace (trace-skeleton.json) that the merged runtime has no writer for yet (T-260's gaps a and b): the
 * gateway's scrub (T-1096) and the batch window's batch (T-1108). Each may be absent; once written, it is judged.
 */
const NO_WRITER_YET: readonly Hop[] = ["scrub", "batch"];

/** The handle actor's own receive span beside the gateway's (T-260's gap c, T-1108), set aside from the count. */
const actorReceive = (span: Span): boolean => span.hop === "receive" && span.got?.door === "handleActor";

/** A model call's own span beside the hops: a portCall to provider anthropic, one per try of the safety read (T-554). */
const modelCall = (span: Span): boolean => span.hop === "portCall" && span.provider === "anthropic";

/** The fictional numbers of the sample cast, in each form a number could leak in. */
const CAST_NUMBERS = [
  "+15555550100",
  "15555550100",
  "5555550100",
  "+15555550101",
  "15555550101",
  "5555550101",
];

/** The words that must never reach a span: the composer's master line, Sam's words it quotes, and the parts sent. */
const FIXTURE_WORDS: string[] = [
  composeInputS102.outcome.input.masterText.text,
  composeInputS102.outcome.input.inbound.text,
  ...finalizePass.outcome.finalParts.sends.map((send) => send.text),
];

/** A run through the Workers runtime's own steps: a resource guard above Vitest's 5 s default, as T-260's. */
const TEST_MS = 30_000;

// ---- the actor ------------------------------------------------------------------------------------------------------

type Namespace = DurableObjectNamespace<HandleActor>;

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

/** The HandleActor namespace as the root takes it (exports.HandleActor in the pool until T-566 binds env's). */
function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

function stubOf(actorName: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorName));
}

/** Waits until the actor has read every text and handed on what its batch window can. */
async function settle(actorName: string): Promise<void> {
  await stubOf(actorName).safetyIdle();
  await stubOf(actorName).batchIdle();
}

const SAM_ACTOR = actorNameOf(SAM.handle);

// ---- the texts ------------------------------------------------------------------------------------------------------

/** A text of Sam's: K-06's text-imessage.json with his handle, this event id and these words. */
function samText(eventId: string, body: string): LinqInboundEvent {
  return {
    ...(structuredClone(textFixture) as Json),
    eventId,
    handle: { ...SAM.handle },
    body,
    chatId: SAM_CHAT,
    messageId: `linq-msg-demo-in-${eventId}`,
  } as unknown as LinqInboundEvent;
}

/** The webhook request as it reaches the Worker's Linq route under BASE_PATH. */
function webhookRequest(webhook: SignedWebhook): Request {
  return new Request(`https://rosie.test${env.BASE_PATH}/webhooks/linq`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhook.webhookId,
      "webhook-timestamp": webhook.timestamp,
      "webhook-signature": webhook.signature,
    },
    body: webhook.raw,
  });
}

// ---- the rig: the root, composed for the test environment -----------------------------------------------------------

interface Run {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  /** Each gateAndCommit the turn handed the root, as the turn made it. */
  readonly gateCalls: readonly WatchedGateCall[];
  /** Signs one K-06 event with the Linq double and posts it to the Worker's route; answers the trace id the gateway opened. */
  post(event: LinqInboundEvent, partKey?: string | null): Promise<string>;
  /** The spans logged so far. */
  spans(): Span[];
  /** Waits until the trace shows this hop; on a timeout, says which hops it shows and which calls the turn made. */
  untilHop(traceId: string, hop: Hop): Promise<void>;
  restore(): void;
}

function rig(log: MockInstance): Run {
  const fakes = skeletonFakes();
  const root = composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors: handleActors(),
    vars: env,
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    safetyReaders: fakes.models.readers,
    // The bundle and targets ports (T-556) on their K-05 doubles: bundle v0 as bundles/v0 publishes it is active.
    bundleReads: fakes.bundleReads.calls,
    handleTargets: fakes.handleTargets.call,
    // The frontier port (T-557) over its K-05 double: test owner 1's seeded rows, so the frontier's answer is turn 1's.
    frontierScope: fakes.frontier.scope,
    // The decide port (T-558): @rosie/ai's deciders over the recorded-model double, each test recording its turn's reads.
    deciders: fakes.decide.deciders,
    // The gate port (T-559) over its reads' doubles, its one commit through the turn-row port to the K-05 double.
    turnRows: fakes.turnRows.calls,
    gateReads: fakes.gate.reads,
    // The compose-input and composer ports (T-560): compose input over its K-05 double, the composer over the
    // recorded-model double, which holds the plan of the turn this test records.
    composeReads: fakes.compose.reads,
    composers: fakes.composer.composers,
    // The finalize port (T-561) over its K-05 doubles: the row the commit wrote, and the plan written into it.
    finalizeData: fakes.finalize.data,
  });
  const restoreRoot = root.install();
  const watched = watchGate(root);
  const restore = (): void => {
    watched.restore();
    restoreRoot();
  };
  const worker = createWorker(() => root.gateway);
  const spans = (): Span[] => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0]));
  return {
    fakes,
    root,
    gateCalls: watched.calls,
    async post(event, partKey = null) {
      const response = await worker.fetch(
        webhookRequest(await fakes.sign(event, partKey)),
        env,
        createExecutionContext(),
      );
      if (response.status !== 200) {
        // The gateway's failure lines name the stage and the error's name only (never a body or a number).
        const failed = log.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes("_failed"));
        throw new Error(`the gateway answered ${String(response.status)}: ${failed.join(" ")}`);
      }
      const traceId = response.headers.get("x-trace-id");
      if (traceId === null) throw new Error("the gateway answered with no trace id");
      return traceId;
    },
    spans,
    async untilHop(traceId, hop) {
      try {
        await until(() => spans().some((span) => span.trace_id === traceId && span.hop === hop), hop, 15_000);
      } catch {
        const seen = spansOfTrace(spans(), traceId).map((span) => `${span.hop}:${span.outcome}`);
        throw new Error(
          `no ${hop} span: the trace shows ${seen.join(", ")}; the turn called ${fakes.face.log.join(", ")}`,
        );
      }
    },
    restore,
  };
}

/** Every span is K-08's (labels and counts only), and none holds a raw phone number or a message's words. */
function expectNoWords(spans: readonly Span[], words: readonly string[]): void {
  expect(spans.flatMap((span) => spanProblems(span))).toEqual([]);
  expect(leaks(spans, [...CAST_NUMBERS, ...words])).toEqual([]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("through the composition root, every port on its fake: a text's webhook to its delivery receipt", () => {
  it(
    "Sam's text goes through the root's gateway, the actor, the turn and the dispatcher, and the receipt arms its clock: every runtime hop of trace-skeleton.json once, in order, under one trace id",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const words = SAM_TRADES_TEXT;
        run.fakes.known("evt-sam-0001");
        run.fakes.decide.recordTurn(["evt-sam-0001"]);
        const traceId = await run.post(samText("evt-sam-0001", words));
        await settle(SAM_ACTOR);

        // Three seconds quiet: the batch window closes, the lease opens the turn and the turn replies through the dispatcher.
        await run.fakes.clock.advance(3000);
        await runDurableObjectAlarm(stubOf(SAM_ACTOR));
        await run.untilHop(traceId, "providerAccepted");
        const parts = finalizePass.outcome.finalParts.sends.map(
          (_send, index) => `${SKELETON_ROW}/${String(index + 1)}/1`,
        );
        expect(run.fakes.linq.keysInOrder).toEqual(parts);
        const accepted = run.fakes.linq.accepted.get(`${SKELETON_ROW}/1/1`);
        if (accepted?.providerMessageId == null) throw new Error("Linq accepted no part");

        // Linq's delivery receipt for that part: K-06 delivered.json with the part's message id, echoing its key.
        const receipt = {
          ...(structuredClone(deliveredFixture) as Json),
          eventId: "evt-linq-delivered-sam-0001",
          handle: { ...SAM.handle },
          chatId: SAM_CHAT,
          status: { messageId: accepted.providerMessageId, at: A7_03_DELIVERED.deliveredAt, failure: null },
        } as unknown as LinqInboundEvent;
        const receiptTraceId = await run.post(receipt, `${SKELETON_ROW}/1/1`);

        const spans = run.spans();
        const trace = spansOfTrace(spans, traceId);
        const unwritten = NO_WRITER_YET.filter((hop) => !trace.some((span) => span.hop === hop));
        const report = checkHops(trace, {
          traceId,
          expected: hopsOfTrace(SKELETON),
          notWritten: unwritten,
          extra: (span) => actorReceive(span) || modelCall(span),
        });
        expect(report.problems).toEqual([]);
        expect(report.ok).toBe(true);
        expect(report.judged).toEqual(hopsOfTrace(SKELETON).filter((hop) => !unwritten.includes(hop)));
        expect(report.judged).toEqual(
          expect.arrayContaining([
            "receive",
            "safetyRead",
            "lease",
            "guard",
            "frontier",
            "decideReads",
            "gate",
            "commit",
            "compose",
            "fillAndChecks",
            "dispatch",
            "providerAccepted",
            "delivered",
            "clockArmed",
          ]),
        );
        expect(report.extra.filter(actorReceive).length).toBeLessThanOrEqual(1);
        // The text's safety read on arrival (T-554): one Haiku call, answered by the recorded-model double.
        const calls = report.extra
          .filter(modelCall)
          .map((span) => [span.attempt, span.outcome, span.model_calls?.[0]?.purpose]);
        expect(calls.filter((call) => call[2] === "safetyRead")).toEqual([[1, "ok", "safetyRead"]]);
        expect(run.fakes.models.calls).toEqual([{ model: "claude-haiku-5-5", text: words }]);
        // The turn's decide (T-558): two Haiku reads, each its step 1 and its one part's step 2, each call answered at
        // its first attempt by the recorded-model double; then the composer's one Haiku call for the turn's row (T-560),
        // answered by the same double; no other model call.
        expect(
          calls
            .filter((call) => call[2] !== "safetyRead")
            .map((call) => call.join())
            .sort(),
        ).toEqual([
          "1,ok,compose",
          "1,ok,decideCheck",
          "1,ok,decideCheck",
          "1,ok,decideFirst",
          "1,ok,decideFirst",
        ]);
        expect(run.fakes.decide.misses).toEqual([]);
        expect(run.fakes.composer.misses).toEqual([]);

        // One bundle id: the root's active id at receipt is the one the turn pinned, on every span (bundle v0's).
        expect(new Set(trace.map((span) => JSON.stringify(span.bundle_id)))).toEqual(
          new Set([JSON.stringify(BUNDLE_V0)]),
        );
        // The gate request carries the text's trace id (one id from the webhook to the receipt).
        expect(run.gateCalls.map((call) => call.request.turn.traceId)).toEqual([traceId]);
        // The receipt marked the part delivered once and armed A7-03's clock once (K-05 armClock).
        expect(run.fakes.store.marks.filter((mark) => mark.outcome === "delivered")).toHaveLength(1);
        expect(run.fakes.arming.data.armAnswers).toMatchObject([{ result: "armed", repeated: false }]);
        // The receipt's own webhook opened its own trace id: its receive hop alone.
        expect(receiptTraceId).not.toBe(traceId);
        const receiptReport = checkHops(spansOfTrace(spans, receiptTraceId), {
          traceId: receiptTraceId,
          expected: ["receive"],
        });
        expect(receiptReport.problems).toEqual([]);
        expectNoWords(spans, [words, ...FIXTURE_WORDS]);
      } finally {
        run.restore();
      }
    },
  );
});

describe("through the composition root, a repeated webhook (trace-duplicate-webhook.json)", () => {
  it("is dropped at receipt on its own trace, with nothing after it, while the first arrival goes on to its safety read", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = rig(log);
    try {
      const first = structuredClone(textFixture) as unknown as LinqInboundEvent;
      const again = structuredClone(duplicateFixture) as unknown as LinqInboundEvent;
      expect(again.eventId).toBe(first.eventId);
      run.fakes.known(first.eventId);
      const firstTrace = await run.post(first);
      await settle(actorNameOf(first.handle));
      const repeatTrace = await run.post(again);
      await settle(actorNameOf(first.handle));

      const spans = run.spans();
      expect(repeatTrace).not.toBe(firstTrace);
      const repeat = spansOfTrace(spans, repeatTrace);
      const report = checkHops(repeat, {
        traceId: repeatTrace,
        expected: hopsOfTrace(DUPLICATE),
        extra: actorReceive,
      });
      expect(report.problems).toEqual([]);
      const dropped = repeat.find((span) => !actorReceive(span));
      expect(dropped?.outcome).toBe(DUPLICATE.spans[0]?.outcome);
      expect(dropped?.decided).toMatchObject({ signatureValid: true, knownEventId: true, answered: 200 });

      const firstSpans = spansOfTrace(spans, firstTrace).filter((span) => !actorReceive(span));
      const firstHops = firstSpans.filter((span) => !modelCall(span)).map((span) => span.hop);
      expect(firstHops.filter((hop) => !NO_WRITER_YET.includes(hop))).toEqual(["receive", "safetyRead"]);
      // The first arrival's safety read made one model call (T-554); the repeat, dropped at receipt, made none.
      expect(firstSpans.filter(modelCall)).toHaveLength(1);
      expect(repeat.filter(modelCall)).toEqual([]);
      expectNoWords(spans, [String((textFixture as Json).body)]);
    } finally {
      run.restore();
    }
  });
});
