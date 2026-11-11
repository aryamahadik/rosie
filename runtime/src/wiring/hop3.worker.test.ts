// T-554's join, hop 3 of D-017 (C-047; build prompt section 10, D-017: "the safety read joins before batching and the
// turn lease"; 02-contracts section 11, 'Safety read on each raw text, on arrival, before batching'), in the Workers
// runtime. The composition root is composed for the test environment as hop 2's tests compose it (the HandleActor
// namespace, the skeleton flag on), with the actor's ports installed, so each text goes in through root.linqWebhook to its
// handle's actor, whose safety read on arrival (T-246) goes through the joined port (./real.ts realSafetyRead) to
// @rosie/ai's safety read (T-365, T-366) over a fake Messages API answered by the recorded-model double (T-004;
// ./test-support.ts fakeSafetyModels). No model is called (J-02).
//
//   - Sam's JOIN, the skeleton's first text, reads No (safety-no.json) from one Haiku call, whose model-call span is in
//     the text's trace, and the text's safety span ends before any batch span and before the turn's lease.
//   - With the double delaying past 4 s, each 2 s try is cut off, and the actor's 4 s deadline applies T-246's rule:
//     safety-timeout-danger-word.json's text (its danger words, in words made up here) takes the safety-line path, with
//     that fixture as the record the core is given; a plain text takes the outage line and keeps its unread hold.
//
// The Durable Objects' storage is not cleared between this file's tests, so each test's texts go to handles no other
// test uses. Test values only (rule 9): the master's sample cast, the fictional 555-01xx numbers and made-up words.
import { HAIKU_MODEL, SONNET_MODEL } from "@rosie/ai/src/gateway/index";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import safetyTimeoutDangerWord from "@rosie/contracts/model/fixtures/safety-timeout-danger-word.json";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { HandleActor, HoldEntry, SafetyEntry } from "../actor";
import { actorNameOf } from "../gateway";
import { OUTCOME_LABEL } from "../safety/rules";
import type { Span } from "../trace";
import { leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { SAM, until } from "../turn/test-support";
import { composeRoot, SKELETON_FLAG, type HandleActors } from "./index";
import {
  fakeFlags,
  JOIN_TEXT,
  SAM_CHAT,
  skeletonFakes,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
} from "./test-support";

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;

/** A run through the Workers runtime's own steps, with real 2 s tries: a resource guard above Vitest's 5 s default. */
const TEST_MS = 30_000;
/** How long the double waits before it answers in the timeout case: past each 2 s try and the actor's 4 s deadline. */
const DELAY_MS = 4500;

/** The fictional numbers of the sample cast, in each form a number could leak in. */
const CAST_NUMBERS = [
  "+15555550100",
  "15555550100",
  "5555550100",
  "+15555550101",
  "15555550101",
  "5555550101",
  "+15555550102",
  "15555550102",
  "5555550102",
];

/** Sam's JOIN's event id (K-08 trace-skeleton.json's, as the e2e skeleton sends it). */
const JOIN_EVENT = "evt-sam-0000";
/** A second handle of the sample cast: Alex, the fictional 555-0101. */
const ALEX = { kind: "phone", address: "+15555550101" };
/** A third handle, fictional (555-0102), whose actor no other test of this file has used. */
const PLAIN = { kind: "phone", address: "+15555550102" };
/** Made-up words holding safety-timeout-danger-word.json's danger words ("cut won't stop bleeding"). */
const DANGER_TEXT = "my cut won't stop bleeding";

const SAM_ACTOR = actorNameOf(SAM.handle);
const ALEX_ACTOR = actorNameOf(ALEX);
const PLAIN_ACTOR = actorNameOf(PLAIN);

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

/** The actor's safety calls over RPC. */
interface SafetyRpc {
  readSafety(): Promise<SafetyEntry[]>;
  readHolds(): Promise<HoldEntry[]>;
  safetyIdle(): Promise<void>;
}

function actorOf(actorName: string): SafetyRpc {
  return stubOf(actorName);
}

/** A text of K-06's text-imessage.json form from this handle, with this event id and these words. */
function textOf(eventId: string, handle: { kind: string; address: string }, body: string): LinqInboundEvent {
  return {
    ...(structuredClone(textFixture) as Json),
    eventId,
    handle: { ...handle },
    body,
    chatId: handle.address === SAM.handle.address ? SAM_CHAT : "linq-chat-demo-alex",
    messageId: `linq-msg-demo-in-${eventId}`,
  } as unknown as LinqInboundEvent;
}

/** The webhook as Linq posts it to {BASE_PATH}/webhooks/linq: the three headers and the raw body. */
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

/** A model call's own span beside the hops: a portCall to provider anthropic, one per try (T-365). */
const modelCall = (span: Span): boolean => span.hop === "portCall" && span.provider === "anthropic";

/** The safety read's own model-call spans; the turn's decide (joined by T-558) writes its own beside them. */
const safetyCall = (span: Span): boolean =>
  modelCall(span) && (span.model_calls ?? []).every((call) => call.purpose === "safetyRead");

interface Rig {
  readonly fakes: SkeletonFakes;
  /** Signs one K-06 event with the Linq double, posts it through root.linqWebhook, and answers its trace id. */
  post(event: LinqInboundEvent): Promise<string>;
  /** The spans logged so far, of one trace, by when each started. */
  traceOf(traceId: string): Span[];
  spans(): Span[];
  restore(): void;
}

/**
 * The root for "test" with the HandleActor namespace and the skeleton flag on, its actor ports installed; the bundle and
 * targets ports (joined by T-556) fed their K-05 doubles, so the turn after the read pins its bundle and guards, the
 * frontier's scope (joined by T-557) fed its K-05 double, so the turn's frontier answers, decide (joined by T-558) fed
 * @rosie/ai's deciders over the recorded-model double, and the gate (joined by T-559) fed its reads and the turn-row
 * port's K-05 double, so the turn goes on.
 */
function rig(log: MockInstance): Rig {
  const fakes = skeletonFakes();
  const root = composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors: handleActors(),
    vars: env,
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    // The chat-open port (T-1213) over its K-05 double: each text opens its number's chat before the actor is reached.
    chatOpenCall: fakes.dispatch.openChat,
    safetyReaders: fakes.models.readers,
    turnRows: fakes.turnRows.calls,
    bundleReads: fakes.bundleReads.calls,
    handleTargets: fakes.handleTargets.call,
    frontierScope: fakes.frontier.scope,
    deciders: fakes.decide.deciders,
    gateReads: fakes.gate.reads,
    flags: fakeFlags([SKELETON_FLAG]),
  });
  const restore = root.install();
  const spans = (): Span[] => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0]));
  return {
    fakes,
    async post(event) {
      const response = await root.linqWebhook(webhookRequest(await fakes.sign(event)));
      if (response.status !== 200) throw new Error(`the gateway answered ${String(response.status)}`);
      const traceId = response.headers.get("x-trace-id");
      if (traceId === null) throw new Error("the gateway answered with no trace id");
      return traceId;
    },
    traceOf: (traceId) => spansOfTrace(spans(), traceId),
    spans,
    restore,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("hop 3 joined: each raw text is read for danger through @rosie/ai's safety read, on arrival, before batching", () => {
  it(
    "Sam's JOIN reads No (safety-no.json) from one Haiku call, its model-call span in the text's trace, and its safety span ends before any batch span and the turn's lease",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        run.fakes.known(JOIN_EVENT);
        // Its turn's two decide reads, recorded for this text as recording 2 holds the e2e JOIN's (T-558).
        run.fakes.decide.recordTurn([JOIN_EVENT]);
        const traceId = await run.post(textOf(JOIN_EVENT, SAM.handle, JOIN_TEXT));
        await actorOf(SAM_ACTOR).safetyIdle();

        // The read on arrival went to @rosie/ai's safety read: one call, Haiku, given the JOIN's words.
        expect(run.fakes.models.calls).toEqual([{ model: HAIKU_MODEL, text: JOIN_TEXT }]);
        expect(await actorOf(SAM_ACTOR).readSafety()).toEqual([
          {
            eventId: JOIN_EVENT,
            state: "done",
            danger: false,
            path: "none",
            lineId: null,
            handedAfterMs: null,
          },
        ]);
        expect(await actorOf(SAM_ACTOR).readHolds()).toEqual([]);
        expect(run.fakes.core.recorded).toEqual([]);
        expect(run.fakes.core.fixed).toEqual([]);

        // Three seconds quiet: the batch closes, the lease opens the turn, decide reads it and the gate commits it. Since
        // T-562 joined the outbox, the dispatcher sends only the rows the commit wrote once composed, and this rig composes
        // none (no compose input is fed), so the turn's commit, after decide's reads, is what this test waits for.
        await run.fakes.clock.advance(3000);
        await runDurableObjectAlarm(stubOf(SAM_ACTOR));
        await until(() => run.traceOf(traceId).some((span) => span.hop === "commit"), "commit", 15_000);

        const trace = run.traceOf(traceId);
        const [safety, ...again] = trace.filter((span) => span.hop === "safetyRead");
        if (safety === undefined) throw new Error("no safetyRead span");
        expect(again).toEqual([]);
        expect(safety).toMatchObject({
          outcome: "ok",
          event_id: JOIN_EVENT,
          got: { via: "verdict", outcomes: [OUTCOME_LABEL.No], dangerWords: 0 },
          decided: { danger: false, path: "none" },
        });
        const calls = trace.filter(safetyCall);
        expect(calls).toHaveLength(1);
        // Every other model call of the trace is the turn's decide's (T-558), after the read: its two reads, each its
        // step 1 and its one part's step 2; none is a safety read's.
        expect(
          trace
            .filter((span) => modelCall(span) && !safetyCall(span))
            .flatMap((span) => span.model_calls?.map((call) => call.purpose) ?? [])
            .sort(),
        ).toEqual(["decideCheck", "decideCheck", "decideFirst", "decideFirst"]);
        expect(calls[0]).toMatchObject({
          call: "messages",
          attempt: 1,
          outcome: "ok",
          event_id: JOIN_EVENT,
          bundle_id: safety.bundle_id,
          decided: { role: "haiku", fallback: false, verdict: true },
        });
        expect(calls[0]?.model_calls).toMatchObject([
          { model: HAIKU_MODEL, role: "haiku", purpose: "safetyRead", outcome: "ok" },
        ]);

        // Read before batching: the safety span ends before any batch span starts, and before the turn's lease.
        const safetyEnd = Date.parse(safety.at) + safety.ms;
        const later = trace.filter((span) => span.hop === "batch" || span.hop === "lease");
        expect(later.map((span) => span.hop)).toContain("lease");
        for (const span of later) expect(Date.parse(span.at)).toBeGreaterThanOrEqual(safetyEnd);
        expect(leaks(run.spans(), CAST_NUMBERS)).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "with the double delaying past 4 s, each 2 s try is cut off: safety-timeout-danger-word.json's text takes the safety-line path and a plain text the outage line (T-246's rule)",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        run.fakes.models.delayMs = DELAY_MS;
        const danger = safetyTimeoutDangerWord.eventId;
        const plain = "evt-sam-0003";
        const dangerTrace = await run.post(textOf(danger, ALEX, DANGER_TEXT));
        const plainTrace = await run.post(textOf(plain, PLAIN, JOIN_TEXT));

        // The actor's 4 s deadline passes, on the root's clock, while every try still waits on the double.
        await run.fakes.clock.advance(4000);
        await actorOf(ALEX_ACTOR).safetyIdle();
        await actorOf(PLAIN_ACTOR).safetyIdle();

        // The danger word's text: Unsure by the timeout rule, its record safety-timeout-danger-word.json, and its
        // checked line (911) handed on through the core's outbox row.
        expect(await actorOf(ALEX_ACTOR).readSafety()).toEqual([
          {
            eventId: danger,
            state: "done",
            danger: true,
            path: "outbox",
            lineId: "safetyEmergency",
            handedAfterMs: expect.any(Number) as unknown,
          },
        ]);
        expect(run.fakes.core.recorded.map((entry) => entry.request.safety)).toEqual([
          safetyTimeoutDangerWord,
        ]);
        // The plain text: the outage line, through the core, and routine work held until a verdict lands.
        expect(await actorOf(PLAIN_ACTOR).readSafety()).toEqual([
          {
            eventId: plain,
            state: "done",
            danger: false,
            path: "outbox",
            lineId: "outage",
            handedAfterMs: expect.any(Number) as unknown,
          },
        ]);
        expect(run.fakes.core.fixed.map((entry) => entry.request.fixedLineId)).toEqual(["outage"]);
        expect(await actorOf(PLAIN_ACTOR).readHolds()).toMatchObject([
          { eventId: plain, rule: "unread", released: false },
        ]);
        expect(run.fakes.direct.sent).toEqual([]);

        // Each read tried Haiku, then Sonnet, and each try was cut off at 2 s: the read's own spans say so.
        await until(
          () => [dangerTrace, plainTrace].every((id) => run.traceOf(id).filter(modelCall).length === 2),
          "both tries of each read",
          15_000,
        );
        for (const id of [dangerTrace, plainTrace]) {
          expect(
            run
              .traceOf(id)
              .filter(modelCall)
              .map((span) => [span.attempt, span.outcome, span.model_calls?.[0]?.model]),
          ).toEqual([
            [1, "timedOut", HAIKU_MODEL],
            [2, "timedOut", SONNET_MODEL],
          ]);
        }
        for (const text of [DANGER_TEXT, JOIN_TEXT]) {
          expect(
            run.fakes.models.calls.filter((call) => call.text === text).map((call) => call.model),
          ).toEqual([HAIKU_MODEL, SONNET_MODEL]);
        }

        // The plain text's late answer is the read's own no-verdict marker: its unread hold stays, read again in 30 s.
        await until(
          () =>
            run.traceOf(plainTrace).some((span) => span.hop === "safetyRead" && span.got?.via === "reread"),
          "the plain text's late answer",
          15_000,
        );
        expect(await actorOf(PLAIN_ACTOR).readHolds()).toMatchObject([
          { eventId: plain, rule: "unread", released: false },
        ]);
        expect(leaks(run.spans(), [...CAST_NUMBERS, DANGER_TEXT])).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );
});
