// T-558's join, hop 7 of D-017 (C-046; build prompt section 10, D-017: "decide joins between the frontier and the gate";
// 02-contracts section 11, 'Decide, two reads': K-02; ADR-013 sections 2 and 6), in the Workers runtime. The composition
// root is composed for the test environment as hop 6's tests compose it (the HandleActor namespace, the skeleton flag on,
// the actor's ports installed, the joined ports fed their doubles, the gate among them since T-559), now with the decide port
// this hop joins: @rosie/ai's decider (T-369's two reads, T-370's one Sonnet re-read), one per bundle for both, the real
// router, decide's one read, the context bundle and the AI gateway, over a fake Messages API whose every answer comes from
// the recorded-model double (./test-support.ts fakeDecideModels; T-1145's turn 1 recordings as ai/recordings holds them).
//
//   - The JOIN as recording 2 names it (evt-sam-0000, the text JOIN sent 2026-10-19 14:01:49Z, from test owner 1): hops 1
//     to 6 once each, then one decideReads span: two reads, first and check, both Haiku, agreeing, and no re-read; both
//     reads enter c-01, the sign-up door, with the quote JOIN and no field, as decide-s1-01-enter.json's reads do with its
//     own text (the gate is handed exactly that result); the context decide was given is recording 2's, field for field,
//     so every call was answered from it (DL-347).
//   - decide-reads-disagree.json, through the root's decide port in the turn loop (the frontier and the gate stood in with
//     the fixtures: no stored state gives A7-17 on bundle v0): the decideReads span (Sonnet's and Haiku's reads differ on
//     the high-stakes part), then one reread span (one Sonnet re-read), then the gate is asked with that part as one
//     question, and the turn commits nothing for it.
//   - With no deciders handed in (the Worker until J-02): decide fails closed before any model call; nothing reaches the
//     gate.
//
// One span per hop: the AI layer records no hop span of its own, only each model call's portCall span (the AI gateway's,
// one per attempt), so the turn's decideReads and reread spans are the hop's one span each and no flag is set (CQ-159's
// rule). The spans after hop 7 belong to later hops (the gate and commit, joined by T-559 and judged in
// ./hop8.worker.test.ts; the composer onward, on the fakes) and are not judged. The Durable
// Objects' storage is not cleared between this file's tests, so each test's texts go to a handle no other test uses. Test
// values only (rule 9): the master's sample cast, the fictional 555-01xx numbers and the fixtures' own words.
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import { HAIKU_MODEL, SONNET_MODEL } from "@rosie/ai/src/gateway/index";
import traceSkeleton from "@rosie/contracts/event-trace/fixtures/trace-skeleton.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import decideReadsDisagree from "@rosie/contracts/model/fixtures/decide-reads-disagree.json";
import decideS101Enter from "@rosie/contracts/model/fixtures/decide-s1-01-enter.json";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { QUIET_MS, turnIdOf, type HandleActor } from "../actor";
import { BUNDLE_B, WHOLE_B } from "../bundle/test-support";
import { actorNameOf } from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import { setGuardDeps } from "../guard";
import { fakeTargets } from "../guard/test-support";
import type { Hop, Span, Trace } from "../trace";
import { checkHops, hopsOfTrace, leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { runTurnLoop, setTurnDeps } from "../turn";
import {
  ALEX,
  checkedManifest,
  fakeDecide,
  fakeFacts,
  fakeTurnFace,
  flush,
  safetyNoFor,
  storedText,
  targetsAnswer,
  testTurn,
  turnDeps,
  until,
} from "../turn/test-support";
import type { DecideContext, DecideResult, GateAndCommitRequest } from "../turn/types";
import { composeRoot, SKELETON_FLAG, type HandleActors, type Root, type RootOptions } from "./index";
import {
  BUNDLE_V0,
  disagreeContext,
  fakeFlags,
  SAM_CHAT,
  skeletonFakes,
  TEST_OWNER_1,
  watchGate,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
  type WatchedGateCall,
} from "./test-support";

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;

/** A run through the Workers runtime's own steps: a resource guard above Vitest's 5 s default. */
const TEST_MS = 30_000;
/** How long a step of the actor's lent work may take before a wait gives up. */
const WAIT_MS = 15_000;

const SKELETON = traceSkeleton as unknown as Trace;
/** Hops 1 to 7 of a text's trace (K-08 trace-skeleton.json), in D-017's turn order: receive to decide's two reads. */
const HOPS_1_TO_7: readonly Hop[] = hopsOfTrace(SKELETON).slice(
  0,
  hopsOfTrace(SKELETON).indexOf("decideReads") + 1,
);
/** Hops of those with no writer yet (T-260's gap b): the batch window writes no span until T-1108. Judged once written. */
const NO_WRITER_YET: readonly Hop[] = ["scrub", "batch"];

/** The JOIN run's own context (K-02 README "v1.1", recording 2; T-1145 round 2, DL-347). */
const JOIN_CONTEXT = joinRunContext as unknown as DecideContext & {
  readonly texts: readonly {
    readonly eventId: string;
    readonly words: string;
    readonly sentAt: { utc: string };
  }[];
};
const [JOIN_TEXT_OF_RECORDING] = JOIN_CONTEXT.texts;

/** The fictional numbers this file's texts come from, in each form a number could leak in. */
const CAST_NUMBERS = ["0100", "0101"].flatMap((line) => [
  `+1555555${line}`,
  `1555555${line}`,
  `555555${line}`,
]);

const OWNER_ACTOR = actorNameOf(TEST_OWNER_1.handle);

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

/**
 * The JOIN as recording 2 names it: K-06 text-imessage.json's form from test owner 1 (the fictional 555-0100, Sam's
 * chat), with the recording's event id, words and send time (the text tests/e2e/skeleton sends).
 */
function joinAsRecorded(): LinqInboundEvent {
  if (JOIN_TEXT_OF_RECORDING === undefined) throw new Error("recording 2's context holds its text");
  return {
    ...(structuredClone(textFixture) as Json),
    eventId: JOIN_TEXT_OF_RECORDING.eventId,
    handle: { ...TEST_OWNER_1.handle },
    body: JOIN_TEXT_OF_RECORDING.words,
    sentAt: JOIN_TEXT_OF_RECORDING.sentAt.utc,
    chatId: SAM_CHAT,
    messageId: `linq-msg-demo-in-${JOIN_TEXT_OF_RECORDING.eventId}`,
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

/** A model call's own span beside the hops: a portCall to provider anthropic, one per attempt. */
const modelCall = (span: Span): boolean => span.hop === "portCall" && span.provider === "anthropic";

/** The model calls a span names, as [model, purpose], sorted (a decide's two reads go side by side). */
const callsOf = (spans: readonly Span[]): string[][] =>
  spans
    .flatMap((span) => span.model_calls ?? [])
    .map((call) => [call.model, call.purpose])
    .sort((a, b) => a.join().localeCompare(b.join()));

/** decide-s1-01-enter.json's result for a turn of its own, its reads' quote the turn's own words (T-376's JOIN case). */
function enterResultFor(context: DecideContext, quote: string): DecideResult {
  const enter = structuredClone(decideS101Enter) as unknown as DecideResult;
  const requoted = <T extends { readonly quote: string }>(part: T): T => ({ ...part, quote });
  return {
    ...enter,
    turnId: context.turnId,
    bundleId: context.bundleId,
    reads: enter.reads.map((read) => {
      const output = read.output as { parts: { quote: string }[] };
      return { ...read, output: { ...output, parts: output.parts.map(requoted) } };
    }),
    parts: enter.parts.map((part) => ({ ...part, part: requoted(part.part) })),
  };
}

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  /** Each gateAndCommit the turn handed the root (the joined gate's, T-559), as the turn made it. */
  readonly gateCalls: readonly WatchedGateCall[];
  /** Signs one K-06 event with the Linq double, posts it through root.linqWebhook, and answers its trace id. */
  post(event: LinqInboundEvent): Promise<string>;
  spans(): Span[];
  traceOf(traceId: string): Span[];
  /** Waits until the trace shows this hop; on a timeout, says which hops it shows and what decide's double missed. */
  untilHop(traceId: string, hop: Hop): Promise<void>;
  restore(): void;
}

/**
 * The root for "test" with the HandleActor namespace, the skeleton flag on, every joined port fed its double, decide's
 * deciders among them unless a test leaves them out (as the Worker does until J-02); its actor ports installed; the gate
 * (joined by T-559) fed its reads' doubles, its one commit through the root's turn-row port, and each request the turn
 * hands it watched.
 */
function rig(log: MockInstance, fed: { deciders?: boolean } = {}): Rig {
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
    bundleReads: fakes.bundleReads.calls,
    handleTargets: fakes.handleTargets.call,
    frontierScope: fakes.frontier.scope,
    deciders: fed.deciders === false ? null : fakes.decide.deciders,
    gateReads: fakes.gate.reads,
    composeReads: fakes.compose.reads,
    composers: fakes.composer.composers,
    flags: fakeFlags([SKELETON_FLAG]),
  });
  const restoreRoot = root.install();
  const watched = watchGate(root);
  const restore = (): void => {
    watched.restore();
    restoreRoot();
  };
  const spans = (): Span[] => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0]));
  return {
    fakes,
    root,
    gateCalls: watched.calls,
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
        throw new Error(
          `no ${hop} span: the trace shows ${seen.join(", ")}; decide's double missed ${fakes.decide.misses.join(" | ")}`,
        );
      }
    },
    restore,
  };
}

/** Hops 1 to 7 once each, in turn order, under the trace id and one bundle id; the model-call spans set aside. */
function expectHopsOneToSeven(spans: readonly Span[], traceId: string): void {
  const unwritten = NO_WRITER_YET.filter((hop) => !spans.some((span) => span.hop === hop));
  const report = checkHops(spans, {
    traceId,
    expected: HOPS_1_TO_7,
    notWritten: unwritten,
    extra: (span) => actorReceive(span) || modelCall(span) || !HOPS_1_TO_7.includes(span.hop),
  });
  expect(report.problems).toEqual([]);
  expect(report.judged).toEqual(
    expect.arrayContaining(["receive", "safetyRead", "lease", "guard", "frontier", "decideReads"]),
  );
}

/** The one span of a hop in a trace. */
function onlySpan(spans: readonly Span[], hop: Hop): Span {
  const found = spans.filter((span) => span.hop === hop);
  expect(found.map((span) => span.hop)).toEqual([hop]);
  const [span] = found;
  if (span === undefined) throw new Error(`no ${hop} span`);
  return span;
}

/** The gate's one request: the decided input the turn handed it. */
function gateRequestOf(gateCalls: readonly { readonly request: GateAndCommitRequest }[]) {
  expect(gateCalls).toHaveLength(1);
  const request = gateCalls[0]?.request;
  if (request?.input.kind !== "decided") throw new Error("the gate was handed no decided input");
  return request.input.decided;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("hop 7 joined: decide's two reads and its one Sonnet re-read through @rosie/ai, between the frontier and the gate", () => {
  it(
    "the JOIN as recording 2 names it: hops 1 to 7 once each; one decideReads span, two Haiku reads agreeing and no re-read; both reads enter c-01, the sign-up door, with the quote JOIN and no field, as decide-s1-01-enter.json's reads do with its own text; every call answered from recording 2",
    { timeout: TEST_MS },
    async () => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const join = joinAsRecorded();
        run.fakes.known(join.eventId);
        const traceId = await run.post(join);
        await settle(OWNER_ACTOR);
        await run.fakes.clock.advance(QUIET_MS);
        await runDurableObjectAlarm(stubOf(OWNER_ACTOR));
        await run.untilHop(traceId, "providerAccepted");
        const turnId = await turnIdOf([join.eventId]);
        await untilReplied(OWNER_ACTOR, turnId);
        await settle(OWNER_ACTOR);

        const trace = run.traceOf(traceId);
        expectHopsOneToSeven(trace, traceId);

        // The context decide was given is recording 2's, field for field (DL-347): the run's own turn id, bundle v0 as
        // published, the JOIN at its send time, and the frontier's one choice, c-01, the sign-up door.
        expect(turnId).toBe(JOIN_CONTEXT.turnId);
        expect(run.fakes.decide.decideCalls).toEqual([joinRunContext]);
        expect(JOIN_CONTEXT.choices).toMatchObject([
          { choiceId: "c-01", kind: "door", door: "signUp", stakes: "low" },
        ]);

        // One decideReads span: the first and check reads, both Haiku (each read's step 1 and its one part's step 2,
        // the two-step wire form), agreeing on the one part, enter, with no re-read; labels and counts only.
        const decide = onlySpan(trace, "decideReads");
        expect(decide).toMatchObject({
          outcome: "ok",
          error_code: null,
          turn_id: turnId,
          bundle_id: BUNDLE_V0,
          business_id: TEST_OWNER_1.businessId,
          got: { choices: 1 },
          decided: {
            agreed: true,
            reread: false,
            parts: 1,
            oneQuestion: 0,
            verbs: ["enter"],
            stakes: "low",
            language: "en",
          },
        });
        expect(callsOf([decide])).toEqual([
          [HAIKU_MODEL, "decideCheck"],
          [HAIKU_MODEL, "decideCheck"],
          [HAIKU_MODEL, "decideFirst"],
          [HAIKU_MODEL, "decideFirst"],
        ]);
        expect(Date.parse(decide.at)).toBeGreaterThanOrEqual(Date.parse(onlySpan(trace, "frontier").at));
        // Then no re-read: no reread span, and no model call for one.
        expect(trace.filter((span) => span.hop === "reread")).toEqual([]);
        // Each call's own portCall span (the AI gateway's), answered at its first attempt; the AI layer records no hop
        // span of its own, so decideReads is the hop's one span.
        const decideCalls = trace.filter(
          (span) => modelCall(span) && span.model_calls?.some((call) => call.purpose !== "safetyRead"),
        );
        expect(callsOf(decideCalls)).toEqual(callsOf([decide]));
        expect(decideCalls.map((span) => [span.attempt, span.outcome, span.decided])).toEqual(
          Array.from({ length: 4 }, () => [1, "ok", { role: "haiku", fallback: false }]),
        );

        // Both reads enter c-01, the sign-up door, with the quote JOIN and no field: the result the gate was handed is
        // decide-s1-01-enter.json's with the run's own turn, bundle and text.
        const decided = gateRequestOf(run.gateCalls);
        expect(decided.decide).toEqual(enterResultFor(JOIN_CONTEXT, "JOIN"));
        expect(decided.decide.reads.map((read) => [read.model, read.role, read.output])).toEqual([
          [
            "haiku",
            "first",
            { language: "en", parts: [{ verb: "enter", quote: "JOIN", choice: "c-01", fields: [] }] },
          ],
          [
            "haiku",
            "check",
            { language: "en", parts: [{ verb: "enter", quote: "JOIN", choice: "c-01", fields: [] }] },
          ],
        ]);
        expect(decided.context).toEqual(joinRunContext);

        // Every decide call was answered from recording 2 as ai/recordings keys it, both reads alike; no miss.
        expect(run.fakes.decide.misses).toEqual([]);
        expect(run.fakes.decide.calls.map((call) => [call.model, call.step, call.recordings])).toEqual([
          [HAIKU_MODEL, 1, ["decide-s1-01-join-first", "decide-s1-01-join-check"]],
          [HAIKU_MODEL, 1, ["decide-s1-01-join-first", "decide-s1-01-join-check"]],
          [HAIKU_MODEL, 2, ["decide-s1-01-join-first", "decide-s1-01-join-check"]],
          [HAIKU_MODEL, 2, ["decide-s1-01-join-first", "decide-s1-01-join-check"]],
        ]);
        expect(run.fakes.decide.rereadCalls).toEqual([]);
        expect(run.fakes.decide.asked).toEqual([`${BUNDLE_V0.hash}/${String(BUNDLE_V0.build)}`]);
        // The turn went on through the joined gate and committed its one row; no live call, no number or words in a span.
        expect([...run.fakes.turnRows.turns.keys()]).toEqual([turnId]);
        expect(fetch).not.toHaveBeenCalled();
        expect(leaks(run.spans(), [...CAST_NUMBERS, "JOIN"])).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );
});

describe("the one Sonnet re-read, and decide closed, through the root's decide port in the turn loop", () => {
  const ALEX_TEXT = {
    eventId: "evt-alex-0417",
    body: "can Avery do it, or I'll just come Saturday at 2",
    sentAt: "2026-10-23T15:20:00Z",
  };

  /** A committed answer for the turn's request: the one question asked, nothing changed for the part (K-09 `asked`). */
  const askedAnswer = (request: GateAndCommitRequest): Json => ({
    result: "committed",
    turnId: request.turn.id,
    committedAt: request.now,
    repeated: false,
    parts: [
      {
        part: 0,
        choiceId: null,
        result: "asked",
        limits: [1, 2, 3, 4, 5, 6].map((limit) => ({ limit, result: "notChecked", outcome: null })),
        stoppedBy: null,
        gives: [],
        dependsOnPart: null,
      },
    ],
    planner: null,
    core: [{ call: "recordSafetyOutcome", response: { outcomeId: "safety-outcome-alex-0417" }, error: null }],
    written: { written: [], outboxRows: [{ id: "out-a7-17-alex-which", commitSeq: 1 }], promoted: [] },
    effects: [],
    openQuestions: { opened: ["oq-a7-17-alex-2"], closed: ["oq-a7-17"] },
  });

  /**
   * Alex's text on A7-17 (decide-reads-disagree.json's turn, on bundle-mini-a), run by the turn loop with the root's decide
   * port: the frontier answers the fixture's context and the gate answers `asked` (both stood in: no stored state gives
   * A7-17 on bundle v0, and the gate joins at T-559); every other port is the turn's fixture double.
   */
  async function alexTurn(deciders: RootOptions["deciders"]) {
    const fakes = skeletonFakes();
    const root = composeRoot({
      environment: "test",
      sets: { fake: fakes.ports },
      actors: null,
      vars: env,
      clock: fakes.clock,
      deciders: deciders === undefined ? fakes.decide.deciders : deciders,
    });
    const keys = fakeKeyStore();
    const face = fakeTurnFace();
    const facts = fakeFacts(ALEX.party, ["2026-10-23T15:20:04Z", "2026-10-23T15:20:09Z"]);
    facts.safety.set(ALEX_TEXT.eventId, safetyNoFor(ALEX_TEXT.eventId));
    const deps = { ...turnDeps(facts, face, fakeDecide(face.log), keys), ai: root.turn.ai };
    const restores = [setTurnDeps(deps)];
    const targets = fakeTargets();
    targets.answers.set(
      ALEX.party.handleId,
      targetsAnswer(ALEX.party.handleId, {
        roles: [{ businessId: "biz-lees-barbershop", personId: "person-alex", role: "customer" }],
        openQuestionIds: ["oq-a7-17"],
        bookingIds: ["bk-alex-sat"],
      }),
    );
    restores.push(setGuardDeps({ targets: targets.port }));
    const entry = await storedText(
      { ...ALEX_TEXT, traceId: "trace-alex-0417" },
      ALEX.handle,
      keys,
      BUNDLE_B,
      1,
    );
    const t = testTurn({
      turnId: "turn-a7-17-alex-either",
      traceId: "trace-alex-0417",
      bundleId: BUNDLE_B,
      manifest: await checkedManifest(WHOLE_B, BUNDLE_B),
      entries: [entry],
    });
    face.frontier = () => ({ context: disagreeContext() as never, flagged: [], collapsedBookingIds: [] });
    face.gate = (request) => askedAnswer(request) as never;
    return {
      fakes,
      face,
      t,
      restore: () => {
        for (const restore of restores.reverse()) restore();
      },
    };
  }

  it("decide-reads-disagree.json: the decideReads span (Sonnet's and Haiku's reads disagree on the high-stakes part), then one reread span (one Sonnet re-read), then the gate is asked with that part as one question, and the turn commits nothing for it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const turn = await alexTurn(undefined);
    try {
      const outcome = await runTurnLoop(turn.t.turn);

      // The turn's hops, the model calls' own spans set aside: decide's reads, then the one re-read, then the gate.
      const hops = turn.t.spans.filter((span) => !modelCall(span));
      expect(hops.map((span) => span.hop)).toEqual([
        "guard",
        "frontier",
        "decideReads",
        "reread",
        "gate",
        "commit",
      ]);
      const [, , decide, reread] = hops;
      expect(decide).toMatchObject({
        outcome: "ok",
        bundle_id: BUNDLE_B,
        decided: {
          agreed: false,
          reread: false,
          parts: 1,
          oneQuestion: 1,
          verbs: ["choose"],
          stakes: "high",
          language: "en",
        },
      });
      // High stakes: Sonnet reads first and Haiku checks (Q-26's default), each its step 1 and its one part's step 2.
      expect(callsOf(decide === undefined ? [] : [decide])).toEqual([
        [HAIKU_MODEL, "decideCheck"],
        [HAIKU_MODEL, "decideCheck"],
        [SONNET_MODEL, "decideFirst"],
        [SONNET_MODEL, "decideFirst"],
      ]);
      // One re-read span follows: the one Sonnet re-read, why disagreed, which asks; still unclear, one question.
      expect(reread).toMatchObject({
        outcome: "ok",
        bundle_id: BUNDLE_B,
        got: { why: "disagreed", choices: 3, failingParts: 0 },
        decided: {
          agreed: false,
          reread: true,
          parts: 1,
          oneQuestion: 1,
          verbs: ["ask"],
          stakes: "high",
          language: "en",
        },
      });
      expect(callsOf(reread === undefined ? [] : [reread])).toEqual([
        [SONNET_MODEL, "reread"],
        [SONNET_MODEL, "reread"],
      ]);

      // The gate is handed decide-reads-disagree.json's result exactly: three reads, the re-read run, the part one
      // question with nothing changed; and it answers asked, writing nothing for the part.
      const decided = gateRequestOf(turn.face.gateCalls);
      expect(decided.decide).toEqual(decideReadsDisagree);
      expect(decided.decide.parts.map((part) => part.outcome)).toEqual(["oneQuestion"]);
      expect(decided.context).toEqual(disagreeContext());
      if (outcome.result !== "committed") throw new Error(`the turn did not commit: ${outcome.why}`);
      expect(outcome).toMatchObject({ reread: true, gateCalls: 1 });
      expect(outcome.answer.parts.map((part) => [part.part, part.result, part.choiceId])).toEqual([
        [0, "asked", null],
      ]);
      expect(outcome.answer.written.written).toEqual([]);

      // One decider for the bundle served decide and its re-read; every call answered from its own recording.
      expect(turn.fakes.decide.asked).toEqual([`${BUNDLE_B.hash}/${String(BUNDLE_B.build)}`]);
      expect(turn.fakes.decide.misses).toEqual([]);
      expect(turn.fakes.decide.calls.map((call) => call.recordings.join())).toEqual(
        expect.arrayContaining(["decide-reads-disagree-first", "decide-reads-disagree-check"]),
      );
      expect(turn.fakes.decide.calls.slice(4).map((call) => [call.model, call.recordings])).toEqual([
        [SONNET_MODEL, ["decide-reads-disagree-reread"]],
        [SONNET_MODEL, ["decide-reads-disagree-reread"]],
      ]);
      // No live call; no words, quote or number in any span.
      expect(fetch).not.toHaveBeenCalled();
      const logged = JSON.stringify(turn.t.spans);
      for (const words of ["Avery", "Saturday", "stand-in", "+15555550101", "5555550101"]) {
        expect(logged).not.toContain(words);
      }
    } finally {
      turn.restore();
    }
  });

  it("with no deciders handed in (the Worker until J-02): decide fails closed before any model call, and nothing reaches the gate", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const turn = await alexTurn(null);
    try {
      const outcome = await runTurnLoop(turn.t.turn);

      // The run ends with nothing committed (the lease runs it again at its lapse). K-08 v1 holds a decideReads span only
      // with its model calls, so a decide that made none leaves no span (the turn's rule: a span the trace refuses is not
      // kept); no model call was made.
      expect(outcome).toMatchObject({ result: "notCommitted", why: "noAnswer", gateCalls: 0 });
      expect(turn.t.spans.map((span) => [span.hop, span.outcome, span.error_code])).toEqual([
        ["guard", "ok", null],
        ["frontier", "ok", null],
      ]);
      expect(turn.face.gateCalls).toEqual([]);
      expect(turn.fakes.decide.calls).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      turn.restore();
    }
  });
});
