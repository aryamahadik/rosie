// T-557's join, hop 6 of D-017 (C-050, C-046; build prompt section 10, D-017; 02-contracts section 11, 'Frontier from the
// Tool API': K-09 buildFrontier, K-02 context, K-01 bundle v0; ADR-013 sections 2, 3 and 6), in the Workers runtime. The
// composition root is composed for the test environment as hop 5's tests compose it (the HandleActor namespace, the
// skeleton flag on, the actor's ports installed, the joined ports fed their K-05 doubles, the gate among them since T-559),
// now with the frontier port this hop joins: @rosie/actions' turn face (the Tool API base with K-09 v1.5's checks, the
// call's business scope and its one frontier span; the frontier with main's sources, T-1147's sign-up door among them),
// fed the frontier's scope over a K-05 v1.2 readTurnState double holding test owner 1's seeded rows (T-1148; T-315's
// integration test shows the real readTurnState gives that answer on those rows on local PostgreSQL), and reading the
// bundle the turn's run pinned (bundle v0 as bundles/v0 publishes it).
//
//   - JOIN from the seeded test owner: hops 1 to 5 once each, in order, under one trace id; then the frontier from the
//     Tool API: its span carries bundle v0's id, its one read of the stored state is test owner 1's under Lee's
//     Barbershop's scope (no role, open question, booking or phone row: an empty read), and the JOIN turn's choices equal
//     build-frontier-s1-01.json's: one choice, c-01, the sign-up door to S1-01 (kind door, door signUp, label 'Business
//     onboarding', low stakes, target Lee's Barbershop). The pool's BUNDLES namespace is empty, so the bundle part the
//     frontier reads (flow/A) comes from PostgreSQL's copy, and the frontier span says so (got.bundleFrom).
//   - With bundle v0 in KV, the same turn reads its parts from KV, and the span says so.
//   - With no frontier scope handed in (the Worker until T-567): the frontier fails closed inside the Tool API base,
//     before anything is read; nothing reaches decide or a commit.
//   - Inside workerd the frontier port's checks are the prebuilt ones (T-1144): a call checks its request (a request K-09
//     refuses is answered invalidRequest) and makes no code from strings (Function and eval trapped, no call).
//
// One frontier span per turn (CQ-159): the Tool API base's span is the one kept, and each test judges that last. The
// root tells the turn that the real frontier port records it (TurnFace.recordsFrontierSpan), so the turn records none.
// The spans after hop 6 belong to later hops (decide, joined by T-558 over the recorded-model double and judged in
// ./hop7.worker.test.ts; the gate and commit, joined by T-559 and judged in ./hop8.worker.test.ts; the composer onward, on
// the fakes) and are not judged. The Durable
// Objects' storage is not cleared between this file's tests, so each test's texts go to a handle no other test uses.
// Test values only (rule 9): the master's sample cast, the fictional 555-01xx numbers and made-up words.
import traceSkeleton from "@rosie/contracts/event-trace/fixtures/trace-skeleton.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import buildFrontierS101 from "@rosie/contracts/tool-api/fixtures/build-frontier-s1-01.json";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import bundleV0Kv from "../../../bundles/v0/bundle.kv.json";
import { QUIET_MS, turnIdOf, type HandleActor } from "../actor";
import { actorNameOf } from "../gateway";
import { openTrace, type Hop, type Span, type Trace } from "../trace";
import { checkHops, hopsOfTrace, leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { flush, until } from "../turn/test-support";
import type { BuildFrontierRequest, DecideContext } from "../turn/types";
import { composeRoot, SKELETON_FLAG, type HandleActors, type Root } from "./index";
import {
  BUNDLE_V0,
  fakeFlags,
  JOIN_TEXT,
  SAM_CHAT,
  skeletonFakes,
  TEST_OWNER_1,
  withSamPhoneRow,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
} from "./test-support";

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;

/** A run through the Workers runtime's own steps: a resource guard above Vitest's 5 s default. */
const TEST_MS = 30_000;
/** How long a step of the actor's lent work may take before a wait gives up. */
const WAIT_MS = 15_000;

const SKELETON = traceSkeleton as unknown as Trace;
/** Hops 1 to 5 of a text's trace (K-08 trace-skeleton.json), in D-017's turn order: receive to the guard. */
const HOPS_1_TO_5: readonly Hop[] = hopsOfTrace(SKELETON).slice(
  0,
  hopsOfTrace(SKELETON).indexOf("guard") + 1,
);
/** Hops of those with no writer yet (T-260's gap b): the batch window writes no span until T-1108. Judged once written. */
const NO_WRITER_YET: readonly Hop[] = ["scrub", "batch"];

/** build-frontier-s1-01.json: turn 1's frontier (K-09 v1.5), its one choice the sign-up door to S1-01. */
const TURN_ONE = buildFrontierS101 as unknown as {
  readonly request: BuildFrontierRequest;
  readonly outcome: { readonly context: Json & { readonly choices: readonly Json[] } };
};
/** The fixture's choices: c-01, the sign-up door to S1-01, about Lee's Barbershop, low stakes. */
const TURN_ONE_CHOICES = TURN_ONE.outcome.context.choices;

/** The fictional numbers this file's texts come from, in each form a number could leak in. */
const CAST_NUMBERS = ["0100", "0104", "0105"].flatMap((line) => [
  `+1555555${line}`,
  `1555555${line}`,
  `555555${line}`,
]);

/** Sam's JOIN's event id (K-08 trace-skeleton.json's, as the e2e skeleton sends it). */
const JOIN_EVENT = "evt-sam-0000";
/** Two more fictional handles no other test of this file uses (the seeded test owner's is Sam's). */
const UNSCOPED = { kind: "phone", address: "+15555550104" };
const FROM_KV = { kind: "phone", address: "+15555550105" };

const OWNER_ACTOR = actorNameOf(TEST_OWNER_1.handle);
const UNSCOPED_ACTOR = actorNameOf(UNSCOPED);

/** Bundle v0's flow graph key (K-01 v1): the part the frontier reads through the turn's pinned bundle. */
const FLOW_A_KEY = `bundle/${BUNDLE_V0.hash}/${String(BUNDLE_V0.build)}/flow/A`;

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

/** The HandleActor namespace as the root takes it (exports.HandleActor in the pool). */
function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

function stubOf(actorName: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorName));
}

/** Waits until the actor has read every text and handed on, and run, what its batch window and lease can. */
async function settle(actorName: string): Promise<void> {
  await stubOf(actorName).safetyIdle();
  await stubOf(actorName).batchIdle();
}

/** Waits until a committed turn's reply has ended and its lease is released (T-253). */
async function untilReplied(actorName: string, turnId: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const turn = (await stubOf(actorName).readTurns()).find((entry) => entry.turnId === turnId);
    if (turn?.state === "committed" && turn.leaseUntil === null) return;
    if (Date.now() - started > WAIT_MS) throw new Error("gave up waiting for the turn's reply to end");
    await flush(5);
  }
}

/** A text of K-06's text-imessage.json form from this handle, with this event id and these words. */
function textOf(eventId: string, handle: { kind: string; address: string }, body: string): LinqInboundEvent {
  return {
    ...(structuredClone(textFixture) as Json),
    eventId,
    handle: { ...handle },
    body,
    chatId: handle.address === TEST_OWNER_1.handle.address ? SAM_CHAT : "linq-chat-demo-alex",
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

/** The handle actor's own receive span, beside the gateway's (T-1108). */
const actorReceive = (span: Span): boolean => span.hop === "receive" && span.got?.door === "handleActor";

/** A model call's own span beside the hops: a portCall to provider anthropic, one per try of the safety read (T-554). */
const modelCall = (span: Span): boolean => span.hop === "portCall" && span.provider === "anthropic";

/** The Tool API base's span of the frontier call: the one CQ-159 keeps. */
const baseFrontier = (span: Span): boolean =>
  span.hop === "frontier" && span.got?.toolCall === "buildFrontier";

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  /** Signs one K-06 event with the Linq double, posts it through root.linqWebhook, and answers its trace id. */
  post(event: LinqInboundEvent): Promise<string>;
  spans(): Span[];
  traceOf(traceId: string): Span[];
  /** Waits until the trace shows this hop; on a timeout, says which hops it shows. */
  untilHop(traceId: string, hop: Hop): Promise<void>;
  restore(): void;
}

/**
 * The root for "test" with the HandleActor namespace, the skeleton flag on, every joined port fed its K-05 double, the
 * frontier's scope among them unless a test leaves it out (as the Worker does until T-567); its actor ports installed;
 * the gate (joined by T-559) fed its reads' doubles, its one commit through the root's turn-row port.
 */
function rig(log: MockInstance, fed: { frontier?: boolean } = {}): Rig {
  // Sam's phone row, so the turn's reply this test waits for is sent (limit 8 at send, joined by T-562).
  const fakes = withSamPhoneRow(skeletonFakes());
  const root = composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors: handleActors(),
    vars: env,
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    // The chat-open port (T-1213) over the dispatch double: each text opens its number's chat before the actor.
    chatOpenCall: fakes.dispatch.openChat,
    safetyReaders: fakes.models.readers,
    turnRows: fakes.turnRows.calls,
    bundleReads: fakes.bundleReads.calls,
    handleTargets: fakes.handleTargets.call,
    frontierScope: fed.frontier === false ? null : fakes.frontier.scope,
    deciders: fakes.decide.deciders,
    gateReads: fakes.gate.reads,
    composeReads: fakes.compose.reads,
    composers: fakes.composer.composers,
    finalizeData: fakes.finalize.data,
    outboxCalls: fakes.dispatch.outbox,
    sendStateCall: fakes.dispatch.sendState,
    // The Linq send port (T-563) over @rosie/adapters' Linq double.
    linqSendCall: fakes.linq.call,
    flags: fakeFlags([SKELETON_FLAG]),
  });
  const restore = root.install();
  const spans = (): Span[] => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0]));
  return {
    fakes,
    root,
    async post(event) {
      const response = await root.linqWebhook(webhookRequest(await fakes.sign(event)));
      if (response.status !== 200) throw new Error(`the gateway answered ${String(response.status)}`);
      const traceId = response.headers.get("x-trace-id");
      if (traceId === null) throw new Error("the gateway answered with no trace id");
      return traceId;
    },
    spans,
    traceOf: (traceId) => spansOfTrace(spans(), traceId),
    async untilHop(traceId, hop) {
      try {
        await until(
          () => spans().some((span) => span.trace_id === traceId && span.hop === hop),
          hop,
          WAIT_MS,
        );
      } catch {
        const seen = spansOfTrace(spans(), traceId).map((span) => `${span.hop}:${span.outcome}`);
        throw new Error(`no ${hop} span: the trace shows ${seen.join(", ")}`);
      }
    },
    restore,
  };
}

/** Hops 1 to 5 once each, in turn order, under the trace id and one bundle id; the frontier spans set aside. */
function expectHopsOneToFive(spans: readonly Span[], traceId: string): void {
  const unwritten = NO_WRITER_YET.filter((hop) => !spans.some((span) => span.hop === hop));
  const report = checkHops(spans, {
    traceId,
    expected: HOPS_1_TO_5,
    notWritten: unwritten,
    extra: (span) => actorReceive(span) || modelCall(span) || !HOPS_1_TO_5.includes(span.hop),
  });
  expect(report.problems).toEqual([]);
  expect(report.judged).toEqual(expect.arrayContaining(["receive", "scrub", "safetyRead", "lease", "guard"]));
}

/** The Tool API base's frontier span, the one CQ-159 keeps: exactly one in the trace. */
function frontierSpanOf(spans: readonly Span[]): Span {
  const kept = spans.filter(baseFrontier);
  expect(kept).toHaveLength(1);
  const [span] = kept;
  if (span === undefined) throw new Error("no frontier span of the Tool API base");
  return span;
}

/**
 * One frontier span per turn (CQ-159; K-08: every hop once): the Tool API base's, and no other, since the turn records
 * none of its own where the root binds the real frontier port (TurnFace.recordsFrontierSpan). Judged last in each test.
 */
function expectOneFrontierSpan(spans: readonly Span[]): void {
  expect(
    spans
      .filter((span) => span.hop === "frontier")
      .map((span) => [span.got?.toolCall ?? "the turn's own span", span.outcome]),
  ).toEqual([["buildFrontier", expect.any(String) as unknown]]);
}

/** The one span of a hop in a trace. */
function onlySpan(spans: readonly Span[], hop: Hop): Span {
  const found = spans.filter((span) => span.hop === hop);
  expect(found).toHaveLength(1);
  const [span] = found;
  if (span === undefined) throw new Error(`no ${hop} span`);
  return span;
}

/** The context decide was given for the turn: the frontier's answer, as the turn handed it on. */
function contextOf(fakes: SkeletonFakes): DecideContext {
  expect(fakes.decide.decideCalls).toHaveLength(1);
  const [context] = fakes.decide.decideCalls;
  if (context === undefined) throw new Error("decide was given no context");
  return context;
}

/** Traps Function and eval until the test ends, as T-1144's worker tests do: each call is counted, then made. */
function trapCodeFromStrings(): { readonly calls: string[] } {
  const calls: string[] = [];
  const realFunction = globalThis.Function;
  const realEval = globalThis.eval;
  vi.stubGlobal(
    "Function",
    new Proxy(realFunction, {
      construct(target, args, newTarget) {
        calls.push("new Function");
        return Reflect.construct(target, args, newTarget) as object;
      },
      apply(target, self, args) {
        calls.push("Function()");
        return Reflect.apply(target, self, args) as unknown;
      },
    }),
  );
  vi.stubGlobal(
    "eval",
    new Proxy(realEval, {
      apply(target, self, args) {
        calls.push("eval()");
        return Reflect.apply(target, self, args) as unknown;
      },
    }),
  );
  return { calls };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("hop 6 joined: the frontier from the Tool API, over the bundle the turn pinned and its stored state", () => {
  it(
    "JOIN from the seeded test owner: hops 1 to 5 once each, then the frontier span under bundle v0's id, one read of test owner 1's stored state under Lee's Barbershop, and the JOIN turn's choices those of build-frontier-s1-01.json; with KV empty, the bundle part comes from PostgreSQL and the span says so",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        // KV is empty: the pool's BUNDLES namespace holds no part of bundle v0.
        expect(await env.BUNDLES?.get(FLOW_A_KEY)).toBeNull();
        run.fakes.known(JOIN_EVENT);
        // Its turn's two decide reads (decide, joined by T-558, runs on the recorded-model double).
        run.fakes.decide.recordTurn([JOIN_EVENT]);
        const joinTrace = await run.post(textOf(JOIN_EVENT, TEST_OWNER_1.handle, JOIN_TEXT));
        await settle(OWNER_ACTOR);
        await run.fakes.clock.advance(QUIET_MS);
        await runDurableObjectAlarm(stubOf(OWNER_ACTOR));
        await run.untilHop(joinTrace, "providerAccepted");
        const joinTurn = await turnIdOf([JOIN_EVENT]);
        await untilReplied(OWNER_ACTOR, joinTurn);
        await settle(OWNER_ACTOR);

        const join = run.traceOf(joinTrace);
        expectHopsOneToFive(join, joinTrace);
        // One bundle id on every span: bundle v0's, as bundles/v0 publishes it (…/2, its id read from its manifest).
        expect(new Set(join.map((span) => JSON.stringify(span.bundle_id)))).toEqual(
          new Set([JSON.stringify(BUNDLE_V0)]),
        );
        // The pin read the manifest from PostgreSQL's copy at the turn's start: KV holds none of it.
        expect(onlySpan(join, "lease")).toMatchObject({
          outcome: "ok",
          turn_id: joinTurn,
          got: { texts: 1, manifestFrom: "postgres" },
        });

        // The frontier from the Tool API: the base's span, after the guard's, on the turn's trace under bundle v0's id,
        // for Lee's Barbershop; its one bundle part, flow A, read through the turn's pinned bundle from PostgreSQL's copy
        // on KV's miss, and the span says so.
        const frontier = frontierSpanOf(join);
        expect(frontier).toMatchObject({
          outcome: "ok",
          error_code: null,
          turn_id: joinTurn,
          bundle_id: BUNDLE_V0,
          business_id: TEST_OWNER_1.businessId,
          got: {
            toolCall: "buildFrontier",
            callerKind: "turn",
            bundleParts: ["flow/A"],
            bundleFrom: ["postgres"],
          },
          decided: { answered: "response" },
        });
        expect(Date.parse(frontier.at)).toBeGreaterThanOrEqual(Date.parse(onlySpan(join, "guard").at));
        expect(run.fakes.bundleReads.reads).toContainEqual({ call: "readBundleValue", key: FLOW_A_KEY });

        // The stored state: one read, K-05 v1.2 readTurnState under Lee's Barbershop's scope, for the seeded handle, with
        // the business's name and zone and Sam's name as facts (the guard listed no role, so no other person's).
        expect(run.fakes.frontier.reads).toEqual([
          {
            scope: TEST_OWNER_1.businessId,
            call: "readTurnState",
            request: {
              handleId: TEST_OWNER_1.handleId,
              businessId: TEST_OWNER_1.businessId,
              bookingIds: [],
              facts: [
                { key: "biz.name", table: "businesses", rowId: TEST_OWNER_1.businessId, column: "name" },
                {
                  key: "biz.zone",
                  table: "businesses",
                  rowId: TEST_OWNER_1.businessId,
                  column: "time_zone",
                },
                {
                  key: `person.name/${TEST_OWNER_1.personId}`,
                  table: "persons",
                  rowId: TEST_OWNER_1.personId,
                  column: "name",
                },
              ],
            },
          },
        ]);

        // The JOIN turn's choices are build-frontier-s1-01.json's: one choice, c-01, the sign-up door to S1-01 (kind
        // door, door signUp, label 'Business onboarding', low stakes, target Lee's Barbershop), the context decide got.
        const context = contextOf(run.fakes);
        expect(context.choices).toEqual(TURN_ONE_CHOICES);
        expect(context.choices).toEqual([
          expect.objectContaining({
            choiceId: "c-01",
            kind: "door",
            door: "signUp",
            label: "Business onboarding",
            step: "S1-01",
            stakes: "low",
            target: {
              businessId: TEST_OWNER_1.businessId,
              businessName: "Lee's Barbershop",
              bookingId: null,
              visitAt: null,
            },
          }),
        ]);
        // The rest of the context is the JOIN turn's own, on bundle v0: its turn, its text and Sam as the writer, with
        // nothing else held (no open question, card, fact or earlier message).
        expect(context).toMatchObject({
          turnId: joinTurn,
          bundleId: BUNDLE_V0,
          flow: "A",
          writer: TURN_ONE.outcome.context.writer,
          businessLanguage: "en",
          openQuestions: [],
          cards: [],
          facts: [],
          recentMessages: [],
          meaningSearch: null,
        });
        expect(
          (context.texts as { eventId: string; words: string }[]).map((text) => [text.eventId, text.words]),
        ).toEqual([[JOIN_EVENT, JOIN_TEXT]]);

        // The turn went on through the stood-in hops and committed its one row, under the pinned bundle v0.
        expect([...run.fakes.turnRows.turns.values()].map((row) => [row.id, row.bundleId])).toEqual([
          [joinTurn, BUNDLE_V0],
        ]);
        expect(leaks(run.spans(), [...CAST_NUMBERS, JOIN_TEXT])).toEqual([]);
        expectOneFrontierSpan(join);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "with no frontier scope handed in (the Worker until T-567): the frontier fails closed inside the Tool API base, before anything is read, and nothing reaches decide or a commit",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log, { frontier: false });
      try {
        const eventId = "evt-unscoped-0601";
        run.fakes.known(eventId);
        const traceId = await run.post(textOf(eventId, UNSCOPED, JOIN_TEXT));
        await settle(UNSCOPED_ACTOR);
        await run.fakes.clock.advance(QUIET_MS);
        await runDurableObjectAlarm(stubOf(UNSCOPED_ACTOR));
        await run.untilHop(traceId, "frontier");
        await settle(UNSCOPED_ACTOR);

        const trace = run.traceOf(traceId);
        expectHopsOneToFive(trace, traceId);
        expect(frontierSpanOf(trace)).toMatchObject({
          outcome: "failed",
          error_code: "NoDatabaseError",
          bundle_id: BUNDLE_V0,
          got: { toolCall: "buildFrontier", callerKind: "turn", bundleParts: [], bundleFrom: [] },
          decided: { answered: "thrown" },
        });
        expect(run.fakes.frontier.reads).toEqual([]);
        expect(run.fakes.decide.decideCalls).toEqual([]);
        expect(run.fakes.face.log.filter((entry) => ["decide", "gate"].includes(entry))).toEqual([]);
        // No gateAndCommit reached the joined gate (T-559): it opened no scope and read nothing.
        expect(run.fakes.gate.scopes).toEqual([]);
        expect(run.fakes.turnRows.commits).toEqual([]);
        expect(leaks(run.spans(), CAST_NUMBERS)).toEqual([]);
        expectOneFrontierSpan(trace);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "with bundle v0 in KV, the turn's pin and its frontier read their parts from KV, and the frontier span says so",
    { timeout: TEST_MS },
    async () => {
      const bundles = env.BUNDLES;
      if (bundles === undefined) throw new Error("the pool's staging environment binds BUNDLES (T-566)");
      for (const part of bundleV0Kv) await bundles.put(part.key, part.value);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const eventId = "evt-kv-0601";
        run.fakes.known(eventId);
        run.fakes.decide.recordTurn([eventId]);
        // A handle no other test uses, whose actor the directory double names as Sam's party, so its turn reads test
        // owner 1's stored state and runs as the JOIN's does.
        const actorName = actorNameOf(FROM_KV);
        const traceId = await run.post(textOf(eventId, FROM_KV, JOIN_TEXT));
        await settle(actorName);
        await run.fakes.clock.advance(QUIET_MS);
        await runDurableObjectAlarm(stubOf(actorName));
        await run.untilHop(traceId, "providerAccepted");
        await untilReplied(actorName, await turnIdOf([eventId]));
        await settle(actorName);

        const trace = run.traceOf(traceId);
        expect(onlySpan(trace, "lease")).toMatchObject({ outcome: "ok", got: { manifestFrom: "kv" } });
        expect(frontierSpanOf(trace)).toMatchObject({
          outcome: "ok",
          bundle_id: BUNDLE_V0,
          got: { toolCall: "buildFrontier", bundleParts: ["flow/A"], bundleFrom: ["kv"] },
        });
        expect(contextOf(run.fakes).choices).toEqual(TURN_ONE_CHOICES);
        // PostgreSQL's copy was not read for any part: KV held each one as the bundle's own.
        expect(run.fakes.bundleReads.reads.filter((read) => read.call === "readBundleValue")).toEqual([]);
        expectOneFrontierSpan(trace);
      } finally {
        run.restore();
        for (const part of bundleV0Kv) await bundles.delete(part.key);
      }
    },
  );
});

describe("inside workerd, the frontier port checks with the prebuilt validators and makes no code", () => {
  /** build-frontier-s1-01.json's request on the given trace, under bundle v0 as bundles/v0 publishes it. */
  function turnOneRequest(traceId: string): BuildFrontierRequest {
    const request = structuredClone(TURN_ONE.request);
    return {
      ...request,
      caller: { ...request.caller, traceId },
      turn: { ...request.turn, traceId, bundleId: { ...BUNDLE_V0 } },
    };
  }

  it("a call checks its request against K-09 (a refused one answers invalidRequest) and makes no code from strings", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fakes = skeletonFakes();
    const root = composeRoot({
      environment: "test",
      sets: { fake: fakes.ports },
      actors: null,
      vars: env,
      clock: fakes.clock,
      bundleReads: fakes.bundleReads.calls,
      frontierScope: fakes.frontier.scope,
    });
    const spans: Span[] = [];
    const trace = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE_V0,
      sink: (span) => spans.push(span),
    });
    const request = turnOneRequest(trace.traceId);
    trace.setTurn(request.turn.id);
    // The port makes its validator and checker at its first call: from here on, no code may be made from a string.
    const trap = trapCodeFromStrings();

    // A request K-09 v1.5 accepts: the fixture's frontier, its one choice the sign-up door, from the bundle read by its id
    // (no run pinned this trace) through the bundle port, PostgreSQL's copy: the port carries no KV.
    const answer = await root.turn.toolApi.buildFrontier(request, trace);
    expect((answer as { context?: { choices?: unknown } }).context?.choices).toEqual(TURN_ONE_CHOICES);
    // A request K-09 refuses: its caller is no K-09 caller kind. The validator is no no-op.
    const refused = await root.turn.toolApi.buildFrontier(
      { ...request, caller: { ...request.caller, kind: "nobody" as "turn" } },
      trace,
    );
    expect(refused).toMatchObject({ error: "invalidRequest", call: "buildFrontier" });

    expect(trap.calls).toEqual([]);
    expect(spans.map((span) => [span.hop, span.outcome, span.got?.bundleFrom ?? null])).toEqual([
      ["frontier", "ok", ["postgres", "postgres"]],
      ["frontier", "refused", []],
    ]);
    expect(spans[0]?.got?.bundleParts).toEqual(["manifest", "flow/A"]);
  });
});
