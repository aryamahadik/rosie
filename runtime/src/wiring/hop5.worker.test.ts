// T-556's join, hop 5 of D-017 (C-051; build prompt section 10, D-017; 02-contracts section 11, 'Guard: keywords, then
// targets': K-01 keywords, K-04 phones, roles, open questions and booking heads), in the Workers runtime: this hop's e2e
// line is proven here until T-1149 moves the skeleton's local target into workerd (DL-332). The composition root is
// composed for the test environment as hop 4's tests compose it (the HandleActor namespace, the skeleton flag on, the
// actor's ports installed, K-05's turn-row calls handed in and the Tool API's gate stood in through them), now with the
// two ports this hop joins fed by their K-05 doubles (./test-support.ts): the bundle port holding bundle v0 as bundles/v0
// publishes it (RootOptions.bundleReads), and the targets port holding test owner 1's seeded rows (T-1148), which answers
// for his handle as targets-first-text.json does (RootOptions.handleTargets; T-1148's integration test shows the seeded
// rows give exactly that answer from the real handleTargets on local PostgreSQL). Each text goes in through
// root.linqWebhook and through every joined hop once, in order, under its own trace id: signed by the Linq double and
// verified (hop 1), sealed into its handle's ordered inbox (hop 2), read for danger on arrival over the recorded-model
// double (hop 3), batched and leased on its K-06 event id, the turn's bundle pinned through the bundle port (hop 4), then
// the guard (this hop), whose keyword list is the pinned bundle's (K-01 v1 lists.keywords: START, HELP and the 16 opt-out
// words) and whose targets are the targets port's.
//
//   - JOIN from the seeded test owner (K-21 tp-01: Sam, the fictional 555-0100): hops 1 to 5 once each, in order, under
//     one trace id and bundle v0's id; a guard span with no keyword and no target (the doors), its targets those of
//     targets-first-text.json (no role, no open question, no booking, no phone row), so the JOIN goes on to the frontier
//     with no target. Then a bare HELP from the same phone takes the guard's code path: its keyword is help, no targets
//     are read, nothing reaches the frontier, decide or the composer, and no model call comes after the guard. Its one
//     model call is its safety read on arrival (hop 3), which reads every raw text before batching, a keyword too.
//   - With no targets read handed in (the Worker until T-567): the guard's span fails (noAnswer) and nothing reaches the
//     frontier, decide or a commit.
//   - With no bundle reads handed in (the Worker until T-567): no bundle is pinned, so no turn's work starts and no guard
//     runs; the gateway's trace names bundle v0's stand-in.
//
// The spans after hop 5 belong to later hops (the frontier, joined by T-557 and judged in ./hop6.worker.test.ts; decide,
// joined by T-558 and judged in ./hop7.worker.test.ts; the gate onward, on the fakes) and are not judged. The root is fed
// the frontier's scope and decide's deciders too, so the JOIN's turn runs on to its reply; that the JOIN went on with no target shows in the joined frontier's one read and in its answer, the sign-up
// door, which it offers only when the guard's targets say noTarget with no role, open question or booking (T-1147). The
// Durable Objects' storage is not cleared between this file's tests, so each test's texts go to a handle no other test
// uses. Test values only (rule 9): the master's sample cast, the fictional 555-01xx numbers and made-up words.
import { HAIKU_MODEL } from "@rosie/ai/src/gateway/index";
import targetsFirstText from "@rosie/contracts/data-access/fixtures/targets-first-text.json";
import traceSkeleton from "@rosie/contracts/event-trace/fixtures/trace-skeleton.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { QUIET_MS, turnIdOf, type HandleActor } from "../actor";
import { actorNameOf, DEFAULT_BUNDLE_ID } from "../gateway";
import type { Hop, Span, Trace } from "../trace";
import { checkHops, hopsOfTrace, leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { flush, until } from "../turn/test-support";
import { composeRoot, SKELETON_FLAG, type HandleActors, type Root } from "./index";
import {
  BUNDLE_V0,
  fakeFlags,
  HELP_TEXT,
  JOIN_TEXT,
  SAM_CHAT,
  skeletonFakes,
  TEST_OWNER_1,
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
/** The turn's hops on its way to a model: the frontier, decide's reads, the one re-read, meaning search, the composer. */
const MODEL_HOPS: readonly Hop[] = ["frontier", "decideReads", "reread", "search", "compose"];

/** The fictional numbers this file's texts come from, in each form a number could leak in. */
const CAST_NUMBERS = ["0100", "0102", "0103"].flatMap((line) => [
  `+1555555${line}`,
  `1555555${line}`,
  `555555${line}`,
]);

/** Sam's JOIN's event id (K-08 trace-skeleton.json's, as the e2e skeleton sends it), and his HELP's after it. */
const JOIN_EVENT = "evt-sam-0000";
const HELP_EVENT = "evt-sam-0501";
/** Two more fictional handles no other test of this file uses. */
const UNREAD = { kind: "phone", address: "+15555550102" };
const UNPINNED = { kind: "phone", address: "+15555550103" };

const OWNER_ACTOR = actorNameOf(TEST_OWNER_1.handle);
const UNREAD_ACTOR = actorNameOf(UNREAD);
const UNPINNED_ACTOR = actorNameOf(UNPINNED);

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

/** Waits until the actor has read every text and handed on, and run, what its batch window and lease can. */
async function settle(actorName: string): Promise<void> {
  await stubOf(actorName).safetyIdle();
  await stubOf(actorName).batchIdle();
}

/** Waits until a committed turn's reply has ended and its lease is released (T-253): the next turn may open. */
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

/** A span that carries model calls: the safety read's own, and decide's, the re-read's and the composer's. */
const callsAModel = (span: Span): boolean => (span.model_calls?.length ?? 0) > 0;

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
 * The root for "test" with the HandleActor namespace, the skeleton flag on, K-05's turn-row calls (the double) and the two
 * ports this hop joins fed their K-05 doubles, unless a test leaves one out (as the Worker does until T-567); its actor
 * ports installed; the gate (joined by T-559) fed its reads' doubles, its one commit through the root's turn-row port.
 */
function rig(log: MockInstance, fed: { bundles?: boolean; targets?: boolean } = {}): Rig {
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
    turnRows: fakes.turnRows.calls,
    bundleReads: fed.bundles === false ? null : fakes.bundleReads.calls,
    handleTargets: fed.targets === false ? null : fakes.handleTargets.call,
    frontierScope: fakes.frontier.scope,
    deciders: fakes.decide.deciders,
    gateReads: fakes.gate.reads,
    composeReads: fakes.compose.reads,
    composers: fakes.composer.composers,
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

/**
 * Judges one text's trace as the e2e prefix SKELETON_UPTO=guard judges it (T-551): hops 1 to 5 once each, in turn order,
 * under the trace id and one bundle id; the actor's own receive span and the model-call spans set aside; the spans after
 * hop 5 not judged. Answers the hops judged.
 */
function expectHopsOneToFive(spans: readonly Span[], traceId: string): readonly Hop[] {
  const unwritten = NO_WRITER_YET.filter((hop) => !spans.some((span) => span.hop === hop));
  const report = checkHops(spans, {
    traceId,
    expected: HOPS_1_TO_5,
    notWritten: unwritten,
    extra: (span) => actorReceive(span) || modelCall(span) || !HOPS_1_TO_5.includes(span.hop),
  });
  expect(report.problems).toEqual([]);
  expect(report.judged).toEqual(expect.arrayContaining(["receive", "scrub", "safetyRead", "lease", "guard"]));
  return report.judged;
}

/** The one span of a hop in a trace. */
function onlySpan(spans: readonly Span[], hop: Hop): Span {
  const found = spans.filter((span) => span.hop === hop);
  expect(found).toHaveLength(1);
  const [span] = found;
  if (span === undefined) throw new Error(`no ${hop} span`);
  return span;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("hop 5 joined: the guard's keyword list comes from the pinned bundle, and its targets from the seeded core rows through K-05", () => {
  it(
    "JOIN from the seeded test owner: hops 1 to 5 once each, in order, under one trace id; a guard span with no keyword and no target, its targets those of targets-first-text.json; then a bare HELP from the same phone takes the code path and reaches no model call",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        // ---- JOIN, test owner 1's first text ----
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
        // One bundle id on every span: bundle v0's, as bundles/v0 publishes it, read at receipt and pinned for the turn
        // through the bundle port (its manifest from PostgreSQL's copy: the pool has no BUNDLES binding).
        expect(new Set(join.map((span) => JSON.stringify(span.bundle_id)))).toEqual(
          new Set([JSON.stringify(BUNDLE_V0)]),
        );
        expect(onlySpan(join, "lease")).toMatchObject({
          outcome: "ok",
          turn_id: joinTurn,
          got: { texts: 1, manifestFrom: "postgres" },
          decided: { bundlePinned: true, tries: 1 },
        });
        expect(run.fakes.bundleReads.reads).toContainEqual({
          call: "readBundleValue",
          key: `bundle/${BUNDLE_V0.hash}/${String(BUNDLE_V0.build)}/manifest`,
        });

        // The guard: JOIN is none of bundle v0's keywords, and the seeded test owner has no target, so the doors. Its span
        // is trace-skeleton.json's guard span (labels and counts only).
        const skeletonGuard = SKELETON.spans.find((span) => span.hop === "guard");
        if (skeletonGuard === undefined) throw new Error("trace-skeleton.json has no guard span");
        const guard = onlySpan(join, "guard");
        expect(guard).toMatchObject({
          outcome: skeletonGuard.outcome,
          turn_id: joinTurn,
          got: skeletonGuard.got,
          decided: skeletonGuard.decided,
        });
        expect(guard).toMatchObject({
          error_code: null,
          got: { texts: 1, roles: 0, openQuestions: 0, bookings: 0 },
          decided: { keyword: null, flagsVisit: false, toDecide: 1, targets: 0, doors: true },
        });
        // The targets: K-05's handleTargets asked once, for the seeded handle, and answered as targets-first-text.json
        // does (no role, no open question, no booking, no phone row); the JOIN went on to the frontier with no target.
        expect(run.fakes.handleTargets.requests).toEqual([{ handleId: TEST_OWNER_1.handleId }]);
        expect(targetsFirstText.outcome).toMatchObject({
          persons: [{ roles: [] }],
          openQuestions: [],
          bookings: [],
          phone: null,
        });
        // The JOIN went on to the frontier (joined by T-557) with no target: its one read of the stored state, for the
        // seeded handle under Lee's Barbershop, names only Sam's name among the people (no role was listed for another),
        // and its answer to the turn is the sign-up door alone, which it offers only when the guard's targets say noTarget
        // with no role, open question or booking and the read holds none either (T-1147); the turn's text is the JOIN.
        expect(
          run.fakes.frontier.reads.map((read) => {
            const request = read.request as { handleId: string; facts: { key: string }[] };
            return [read.call, read.scope, request.handleId, request.facts.map((fact) => fact.key)];
          }),
        ).toEqual([
          [
            "readTurnState",
            TEST_OWNER_1.businessId,
            TEST_OWNER_1.handleId,
            ["biz.name", "biz.zone", `person.name/${TEST_OWNER_1.personId}`],
          ],
        ]);
        expect(
          run.fakes.decide.decideCalls.map((context) =>
            context.choices.map((choice) => [choice.choiceId, choice.door]),
          ),
        ).toEqual([[["c-01", "signUp"]]]);
        expect(
          run.fakes.decide.decideCalls.map((context) =>
            (context.texts as { eventId: string; words: string }[]).map((text) => [text.eventId, text.words]),
          ),
        ).toEqual([[[JOIN_EVENT, JOIN_TEXT]]]);
        // The turn went on through the joined gate and the stood-in hops after it, and committed its one row, under the
        // pinned bundle v0.
        expect([...run.fakes.turnRows.turns.values()].map((row) => [row.id, row.bundleId])).toEqual([
          [joinTurn, BUNDLE_V0],
        ]);
        const joinCalls = run.fakes.face.log.length;
        const joinReads = run.fakes.models.calls.length;
        const joinFrontierReads = run.fakes.frontier.reads.length;

        // ---- a bare HELP, from the same phone ----
        run.fakes.known(HELP_EVENT);
        const helpTrace = await run.post(textOf(HELP_EVENT, TEST_OWNER_1.handle, HELP_TEXT));
        await settle(OWNER_ACTOR);
        await run.fakes.clock.advance(QUIET_MS);
        await runDurableObjectAlarm(stubOf(OWNER_ACTOR));
        await run.untilHop(helpTrace, "guard");
        // The keyword's own path after the guard (T-267's fixed replies): its span says the run reached it.
        await run.untilHop(helpTrace, "fillAndChecks");
        await settle(OWNER_ACTOR);

        const help = run.traceOf(helpTrace);
        expectHopsOneToFive(help, helpTrace);
        const helpTurn = await turnIdOf([HELP_EVENT]);
        const helpGuard = onlySpan(help, "guard");
        // The code path: HELP alone is a keyword text, decided by code from the pinned bundle's list, with nothing to
        // decide and no targets read (a turn of keyword texts reads nothing).
        expect(helpGuard).toMatchObject({
          outcome: "ok",
          error_code: null,
          turn_id: helpTurn,
          bundle_id: BUNDLE_V0,
          got: { texts: 1 },
          decided: { keyword: ["help"], flagsVisit: false, toDecide: 0 },
        });
        expect(helpGuard.got).not.toHaveProperty("roles");
        expect(helpGuard.decided).not.toHaveProperty("targets");
        expect(run.fakes.handleTargets.requests).toEqual([{ handleId: TEST_OWNER_1.handleId }]);
        // Nothing past the guard reaches a model: no frontier, decide, re-read, meaning search or composer for it.
        expect(help.filter((span) => MODEL_HOPS.includes(span.hop))).toEqual([]);
        expect(run.fakes.frontier.reads).toHaveLength(joinFrontierReads);
        expect(
          run.fakes.face.log
            .slice(joinCalls)
            .filter(
              (entry) =>
                ["frontier", "decide", "reread", "search"].includes(entry) || entry.startsWith("compose"),
            ),
        ).toEqual([]);
        // Its one model call is its safety read on arrival (hop 3: every raw text, a keyword too), named on the read's own
        // portCall span and on its safetyRead span, both ended before the guard started; no span after the guard names one.
        expect(run.fakes.models.calls.slice(joinReads)).toEqual([{ model: HAIKU_MODEL, text: HELP_TEXT }]);
        const helpModelSpans = help.filter(callsAModel);
        expect(
          helpModelSpans
            .filter(modelCall)
            .map((span) => span.model_calls?.map((call) => [call.model, call.purpose])),
        ).toEqual([[[HAIKU_MODEL, "safetyRead"]]]);
        expect(
          helpModelSpans
            .filter((span) => !modelCall(span))
            .map((span) => [span.hop, span.model_calls?.map((call) => call.purpose)]),
        ).toEqual([["safetyRead", ["safetyRead"]]]);
        for (const span of helpModelSpans) {
          expect(Date.parse(span.at) + span.ms).toBeLessThanOrEqual(Date.parse(helpGuard.at));
        }
        expect(leaks(run.spans(), [...CAST_NUMBERS, JOIN_TEXT])).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "with no targets read handed in (the Worker until T-567): the guard's span fails (noAnswer), and nothing reaches the frontier, decide or a commit",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log, { targets: false });
      try {
        const eventId = "evt-unread-0501";
        run.fakes.known(eventId);
        const traceId = await run.post(textOf(eventId, UNREAD, JOIN_TEXT));
        await settle(UNREAD_ACTOR);
        await run.fakes.clock.advance(QUIET_MS);
        await runDurableObjectAlarm(stubOf(UNREAD_ACTOR));
        await run.untilHop(traceId, "guard");
        await settle(UNREAD_ACTOR);

        const trace = run.traceOf(traceId);
        expectHopsOneToFive(trace, traceId);
        expect(onlySpan(trace, "guard")).toMatchObject({
          outcome: "failed",
          error_code: "noAnswer",
          decided: { keyword: null, toDecide: 1 },
        });
        expect(run.fakes.handleTargets.requests).toEqual([]);
        expect(run.fakes.frontier.reads).toEqual([]);
        expect(trace.filter((span) => span.hop === "frontier")).toEqual([]);
        expect(run.fakes.decide.decideCalls).toEqual([]);
        expect(run.fakes.face.log.filter((entry) => ["frontier", "decide", "gate"].includes(entry))).toEqual(
          [],
        );
        // No gateAndCommit reached the joined gate (T-559): it opened no scope and read nothing.
        expect(run.fakes.gate.scopes).toEqual([]);
        expect(run.fakes.turnRows.commits).toEqual([]);
        expect(leaks(run.spans(), CAST_NUMBERS)).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "with no bundle reads handed in (the Worker until T-567): no bundle is pinned, so no turn's work starts and no guard runs, and the gateway's trace names bundle v0's stand-in",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log, { bundles: false });
      try {
        const eventId = "evt-unpinned-0501";
        run.fakes.known(eventId);
        const traceId = await run.post(textOf(eventId, UNPINNED, JOIN_TEXT));
        await settle(UNPINNED_ACTOR);
        await run.fakes.clock.advance(QUIET_MS);
        await runDurableObjectAlarm(stubOf(UNPINNED_ACTOR));
        await run.untilHop(traceId, "lease");
        await settle(UNPINNED_ACTOR);

        const trace = run.traceOf(traceId);
        expect(onlySpan(trace, "lease")).toMatchObject({
          outcome: "failed",
          error_code: "noAnswer",
          bundle_id: DEFAULT_BUNDLE_ID,
          decided: { bundlePinned: false, tries: 1 },
        });
        expect(trace.filter((span) => span.hop === "guard")).toEqual([]);
        expect(
          onlySpan(
            trace.filter((span) => !actorReceive(span)),
            "receive",
          ).bundle_id,
        ).toEqual(DEFAULT_BUNDLE_ID);
        expect(run.fakes.bundleReads.reads).toEqual([]);
        expect(run.fakes.handleTargets.requests).toEqual([]);
        expect(run.fakes.frontier.reads).toEqual([]);
        expect(trace.filter((span) => span.hop === "frontier")).toEqual([]);
        expect(run.fakes.face.log).toEqual([]);
        expect(leaks(run.spans(), CAST_NUMBERS)).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );
});
