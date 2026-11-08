// The runtime's trace check end to end (T-260; C-044, C-046, C-124; build prompt section 10, D-017: "the trace shows every
// hop once, in order"), run inside the Workers runtime. K-06 webhook fixtures go in as Linq sends them, signed by the Linq
// double's own hook and checked by T-413's verifier, through the merged runtime pieces: the gateway (scrub, seal, hand-off),
// the handle actor with its safety read on arrival, batch window, turn lease and bundle pin, the guard, the turn loop
// (`turnHooks`) over its fakes, the outbox dispatcher with limit 8, and a delivery receipt that arms a clock (T-255). The
// spans are read from the log lines (one JSON line each, ADR-009) and judged with runtime/src/trace/hop-check.ts against
// K-08 v1's trace-skeleton.json, trace-duplicate-webhook.json, trace-batch-three-texts.json and trace-clock-fire.json.
//
// Doubles: the turn's ports and fixtures (src/turn/test-support.ts: the S1-02 frontier, decide and commit, retargeted to the
// running turn's id; S1-02's compose input and finalize-pass.json, retargeted to the row the commit wrote), K-05's bundle
// reads, K-05 v1.2's targets for the guard, the safety read answering safety-no.json, the dispatcher's K-05 store, Linq port,
// recipients and send state (src/dispatch/test-support.ts), the clock arming's ports (src/clocks/arming-support.ts, which
// know A7-03's question, so the delivered row names it), and the clocks' K-05 and K-09 doubles for a firing. One test clock
// stands behind every fake clock: the Workers clock plus what the test moves it on, so each span's start (`at`) is on one
// line of time and the order is read from it. What is wired here is the test's own join (D-017 joins production):
//
//   - The dispatcher, woken by the turn with the turn's trace, records each row's spans on that trace (`traceFor`).
//   - The receipt door records the delivery on the trace of the row that sent the part (found by its Linq message id), so
//     the delivery receipt carries the text's trace id. In production the receipt handler is handed the receipt's own trace
//     before the row is known (T-260's handoff names it).
//
// What the merged runtime does not write yet is named below (NOT_WRITTEN, CLOCK_NOT_WRITTEN), and the handle actor's own
// receive span, written beside the gateway's, is named by `actorReceive`; each is shown still to be so, so the lists only
// shrink. No span may carry a raw phone number or a message's words (asserted on every span of every test). Test values
// only: the master's sample cast, the frozen fixtures' ids and the fictional 555-01xx numbers (rule 9).
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { createLinqWebhookDouble } from "../../adapters/src/linq/double-webhooks";
import { createLinqWebhookVerifier } from "../../adapters/src/linq/webhook";
import type { InboundEvent as LinqEvent } from "../../adapters/src/linq/webhook/types";
import traceBatchThree from "../../contracts/event-trace/fixtures/trace-batch-three-texts.json";
import traceClockFire from "../../contracts/event-trace/fixtures/trace-clock-fire.json";
import traceDuplicate from "../../contracts/event-trace/fixtures/trace-duplicate-webhook.json";
import traceSkeleton from "../../contracts/event-trace/fixtures/trace-skeleton.json";
import deliveredFixture from "../../contracts/inbound-event/fixtures/delivered.json";
import duplicateFixture from "../../contracts/inbound-event/fixtures/duplicate-event.json";
import textFixture from "../../contracts/inbound-event/fixtures/text-imessage.json";
import decideS102 from "../../contracts/model/fixtures/decide-s1-02-choose.json";
import buildFrontierS102 from "../../contracts/tool-api/fixtures/build-frontier-s1-02.json";
import commitS102 from "../../contracts/tool-api/fixtures/commit-s1-02.json";
import composeInputS102 from "../../contracts/tool-api/fixtures/compose-input-s1-02.json";
import finalizePass from "../../contracts/tool-api/fixtures/finalize-pass.json";
import {
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  type BatchEntry,
  type HandleActor,
} from "../src/actor";
import { BUNDLE_A, fakeBundles } from "../src/bundle/test-support";
import { clockArming, setClockDeps, type FireReport } from "../src/clocks";
import { A7_03_DELIVERED, A7_03_QUESTION, wireArming } from "../src/clocks/arming-support";
import { A7_03, ALEX_ACTOR, ALEX_HANDLE, fakeClocks } from "../src/clocks/test-support";
import { handleDeliveryReceipt, runDispatch } from "../src/dispatch";
import { FakeLinq, FakeOutboxStore, FakeRecipients, FakeSendState } from "../src/dispatch/test-support";
import {
  actorNameOf,
  durableObjectActor,
  handleLinqWebhook,
  LINQ_WEBHOOK_PATH,
  type ActorHandoff,
  type ActorNamespace,
  type GatewayDeps,
  type HandleActorRpc,
  type InboundEvent,
  type StoreAnswer,
  type VerifyWebhookResult,
} from "../src/gateway";
import { fakeKeyStore } from "../src/gateway/test-support";
import { setGuardDeps } from "../src/guard";
import { fakeTargets } from "../src/guard/test-support";
import { fakeCore, fakeDirect, fakeRead, fixtureBundle } from "../src/safety/test-support";
import type { HandleIds, SafetyDeps, SafetyResult } from "../src/safety/types";
import { spanProblems, type Hop, type Span, type Trace, type TraceContext } from "../src/trace";
import {
  checkHops,
  hopsOfTrace,
  leaks,
  seqProblems,
  spansOfLogLines,
  spansOfTrace,
  type HopCheck,
} from "../src/trace/hop-check";
import { setTurnDeps, turnHooks, type TurnDeps } from "../src/turn";
import {
  SAM,
  SAM_S1_02_TARGETS,
  decided,
  fakeDecide,
  fakeFacts,
  fakeReply,
  fakeTurnFace,
  planned,
  safetyNoFor,
  targetsAnswer,
  turnDeps,
  unplannedRow,
  until,
  type FakeTurnFace,
} from "../src/turn/test-support";

// ---- what the merged runtime does not write yet ----------------------------------------------------------------------

/**
 * Hops of a text's trace (trace-skeleton.json, trace-batch-three-texts.json) with no writer in the merged runtime: left out
 * of the check, and unexpected (so the test fails) once a writer lands. Take a hop off when its writer merges.
 */
const NOT_WRITTEN: Readonly<Partial<Record<Hop, string>>> = {
  scrub: "the gateway's scrub span: T-1096, carded and not built",
  batch:
    "the batch window records no span (runtime/src/actor/batch.ts says nothing here logs), and runtime/src/trace closeBatch, which writes the batch spans of CQ-06, has no caller",
};

/**
 * Hops of a clock firing's trace (trace-clock-fire.json) with no writer on the clock path: runtime/src/clocks/fire.ts
 * records the clockFired span alone (its gate and commit go through K-09 with no span of their own), and nothing composes
 * or sends the clock turn's rows yet.
 */
const CLOCK_NOT_WRITTEN: Readonly<Partial<Record<Hop, string>>> = {
  gate: "fire.ts records no gate span for the clock turn's gateAndCommit",
  commit: "fire.ts records no commit span for it",
  compose: "the clock turn's rows are not composed on the clock path",
  fillAndChecks: "nor finalized",
  dispatch: "the dispatcher is not woken on the clock path",
  providerAccepted: "so no part goes",
  delivered: "and no receipt comes",
};

const hopsIn = (gaps: Readonly<Partial<Record<Hop, string>>>): Hop[] => Object.keys(gaps) as Hop[];

/**
 * The handle actor's own receive span (runtime/src/actor/handle-actor.ts `recordSpan`, got.door handleActor), written under
 * the same trace id beside the gateway's: every text's trace shows exactly one of them (asserted), set aside from the
 * count, so K-08's one receive per webhook is judged on the gateway's span.
 */
const actorReceive = (span: Span): boolean => span.hop === "receive" && span.got?.door === "handleActor";

// ---- K-08 v1's traces ---------------------------------------------------------------------------------------------------

const SKELETON = traceSkeleton as unknown as Trace;
const DUPLICATE = traceDuplicate as unknown as Trace;
const BATCH_THREE = (traceBatchThree as unknown as { traces: Trace[] }).traces;
const CLOCK_FIRE = traceClockFire as unknown as Trace;

function traceAt(traces: readonly Trace[], place: number): Trace {
  const trace = traces[place];
  if (trace === undefined) throw new Error(`trace-batch-three-texts.json has no trace ${String(place)}`);
  return trace;
}

// ---- one clock for every fake ----------------------------------------------------------------------------------------

/** The Workers clock plus what the test moves it on; `after` waits on it (polled, as the fixtures' clocks are). */
interface TestClock {
  now(): number;
  utc(): string;
  after(ms: number): Promise<void>;
  advance(ms: number): Promise<void>;
}

const flush = (ms = 12): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function testClock(): TestClock {
  let moved = 0;
  const now = (): number => Date.now() + moved;
  return {
    now,
    utc: () => new Date(now()).toISOString(),
    async after(ms) {
      const at = now() + ms;
      while (now() < at) await flush(1);
    },
    async advance(ms) {
      moved += ms;
      await flush();
    },
  };
}

// ---- the actor --------------------------------------------------------------------------------------------------------

type Namespace = DurableObjectNamespace<HandleActor>;

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

/** The actor's calls this test reads over RPC, typed here. */
interface ActorRpc {
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
  readBatches(): Promise<BatchEntry[]>;
  syncClocks(handleId: string): Promise<FireReport[]>;
}

function stubOf(actorName: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorName));
}

const actorOf = (actorName: string): ActorRpc => stubOf(actorName);

const SAM_ACTOR = actorNameOf(SAM.handle);

function actorDoor(): GatewayDeps["actor"] {
  const ns = namespace();
  const adapter: ActorNamespace<DurableObjectId> = {
    idFromName: (name) => ns.idFromName(name),
    get: (id): HandleActorRpc => ns.get(id),
  };
  return durableObjectActor(adapter);
}

// ---- the texts, as K-06 events --------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Every pair [from, to] swapped wherever the value names it as a whole string (a fixture's ids to the running turn's). */
function swap<T>(value: T, pairs: readonly (readonly [string, string])[]): T {
  let text = JSON.stringify(value);
  for (const [from, to] of pairs) text = text.replaceAll(JSON.stringify(from), JSON.stringify(to));
  return JSON.parse(text) as T;
}

/** A text of Sam's: K-06's text-imessage.json with his handle, this event id and these words. */
function samText(eventId: string, body: string): InboundEvent {
  return {
    ...(structuredClone(textFixture) as Json),
    eventId,
    handle: { ...SAM.handle },
    body,
    chatId: "linq-chat-demo-sam",
    messageId: `linq-msg-demo-in-${eventId}`,
  } as unknown as InboundEvent;
}

const SAM_IDS: HandleIds = {
  handleId: SAM.party.handleId,
  businessId: SAM.party.businessId,
  personId: SAM.party.personId,
  bookingId: null,
};

/** The fictional numbers of the sample cast, in each form a number could leak in. */
const CAST_NUMBERS = [
  "+15555550100",
  "15555550100",
  "5555550100",
  "+15555550101",
  "15555550101",
  "5555550101",
];

/** The row commit-s1-02.json writes (S1-04's question to Sam), the one the turn composes and the dispatcher sends. */
const ROW = commitS102.outcome.written.outboxRows[0]?.id ?? "out-s1-04-sam";
const FIXTURE_ROW = composeInputS102.request.outboxRowId;
const FIXTURE_TURN = composeInputS102.request.caller.turnId;
const S1_02_TURN = commitS102.request.turn.id;

/** The words that must never reach a span: the composer's master line, Sam's words it quotes, and the parts sent. */
const FIXTURE_WORDS: string[] = [
  composeInputS102.outcome.input.masterText.text,
  composeInputS102.outcome.input.inbound.text,
  ...finalizePass.outcome.finalParts.sends.map((send) => send.text),
];

/** Every string with a space in it a value holds: the words of a clock row's `fires`. */
function wordsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string" && value.includes(" ")) into.push(value);
  else if (Array.isArray(value)) for (const item of value as unknown[]) wordsIn(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Json)) wordsIn(item, into);
  }
  return into;
}

// ---- the rig: every piece wired over its doubles ---------------------------------------------------------------------

interface Rig {
  readonly clock: TestClock;
  readonly face: FakeTurnFace;
  readonly store: FakeOutboxStore;
  readonly linq: FakeLinq;
  /**
   * Sets a text's safety result before it is sent: safety-no.json under its event id, what the read on arrival answers and
   * what the turn's commit records (K-09 README default 5).
   */
  known(eventId: string): void;
  /** Waits until the trace shows this hop; on a timeout, says which hops it shows and which calls the turn made. */
  untilHop(traceId: string, hop: Hop): Promise<void>;
  /** The trace each row was sent on, by row id: the turn's, as the dispatcher's `traceFor` was handed it. */
  readonly traces: Map<string, TraceContext>;
  readonly receipts: string[];
  /** Signs one K-06 event as Linq's webhook and posts it to the gateway; answers the trace id the gateway opened. */
  post(event: InboundEvent, partKey?: string | null): Promise<string>;
  /** The spans logged so far. */
  spans(): Span[];
  restore(): void;
}

/** A made-up webhook secret for one test: "whsec_" and 32 random bytes in base64. Never Linq's, never stored. */
function madeUpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

const utcSeconds = (ms: number): string => new Date(ms).toISOString().replace(/[.][0-9]+Z$/u, "Z");

/**
 * Every piece over its doubles. With `turns`, the lease runs the turn loop (S1-02's fixtures for whichever turn asks) and
 * the turn wakes the real dispatcher; without, the actor keeps each closed batch stored (no turn can run).
 */
function rig(log: MockInstance, options: { turns: boolean }): Rig {
  const clock = testClock();
  const keys = fakeKeyStore();
  const answers: Record<string, SafetyResult> = {};
  const safety: SafetyDeps = {
    read: fakeRead(clock, answers),
    bundle: fixtureBundle(),
    core: fakeCore(clock),
    directory: { idsOf: () => Promise.resolve(SAM_IDS) },
    keys,
    direct: fakeDirect(clock),
    clock,
    isStopped: () => false,
  };

  const face = fakeTurnFace();
  const ai = fakeDecide(face.log);
  const reply = fakeReply(face.log);
  const facts = fakeFacts(SAM.party, [
    "2026-10-19T14:05:05Z",
    "2026-10-19T14:05:06Z",
    "2026-10-19T14:05:07Z",
  ]);
  face.frontier = (request) => swap(buildFrontierS102.outcome, [[S1_02_TURN, request.turn.id]]);
  ai.decide = (context) => decided(swap(decideS102, [[S1_02_TURN, context.turnId]]));
  face.gate = (request) => swap(commitS102.outcome, [[S1_02_TURN, request.turn.id]]) as never;
  face.composeInput = (request) =>
    swap(composeInputS102.outcome, [
      [FIXTURE_ROW, request.outboxRowId],
      [FIXTURE_TURN, request.caller.turnId],
    ]) as never;
  face.finalize = (request) => swap(finalizePass.outcome, [[FIXTURE_ROW, request.outboxRowId]]) as never;
  reply.composer.compose = () => planned(finalizePass.request.plan.plan);
  reply.rows.unplanned = () => ({ result: "rows", rows: [unplannedRow(ROW, 1, SAM.party.handleId)] });
  const targets = fakeTargets();
  targets.answers.set(SAM.party.handleId, targetsAnswer(SAM.party.handleId, SAM_S1_02_TARGETS));

  const store = new FakeOutboxStore([
    {
      id: ROW,
      recipient: SAM.party.handleId,
      commitSeq: 1,
      sends: finalizePass.outcome.finalParts.sends.map((send) => ({
        ...send,
        kind: "words" as const,
        calendarFile: "none" as const,
      })),
      openQuestionId: A7_03_QUESTION,
      sendClass: "quick_reply",
    },
  ]);
  const linq = new FakeLinq(() => clock.utc());
  const recipients = new FakeRecipients({
    [SAM.party.handleId]: { to: SAM.handle.address, chatId: "linq-chat-demo-sam", service: "imessage" },
  });
  const sendState = new FakeSendState();
  const traces = new Map<string, TraceContext>();
  const receipts: string[] = [];
  const arming = wireArming();

  const set: TurnDeps = {
    ...turnDeps(facts, face, ai, keys, reply),
    dispatcher: {
      async wake(request, trace) {
        await runDispatch(
          {
            store,
            linq,
            recipients,
            sendState,
            environment: "staging",
            traceFor: (row) => {
              traces.set(row.outboxRowId, trace);
              return trace;
            },
            now: () => clock.utc(),
            claimer: "dispatcher-trace-e2e",
          },
          { recipientHandleId: request.handleId },
        );
      },
    },
  };

  // The receipt door: the delivery goes on the trace of the row whose part Linq delivered (one id end to end).
  async function acceptReceipt(handoff: ActorHandoff): Promise<StoreAnswer> {
    const status = handoff.event.status as { messageId: string; at: string } | null;
    if (status === null) throw new Error("a receipt with no status");
    const key = [...linq.accepted].find(
      ([, accepted]) => accepted.providerMessageId === status.messageId,
    )?.[0];
    const trace = traces.get(key?.split("/")[0] ?? "");
    if (trace === undefined) throw new Error("no row of this test sent that message");
    const result = await handleDeliveryReceipt(
      { store, clockArming: clockArming({ ...arming.options, trace }), trace },
      { providerMessageId: status.messageId, partKey: handoff.partKey, at: status.at },
    );
    receipts.push(result.result);
    return result.result === "repeated" ? "duplicate" : "written";
  }

  const secret = madeUpSecret();
  const webhooks = createLinqWebhookDouble({ secret });
  // A receipt names Linq's chat, not the number (T-413): K-04 threads.linq_chat_id's lookup, as a double.
  const chats = new Map([["linq-chat-demo-sam", SAM.handle.address]]);
  const verifier = createLinqWebhookVerifier({
    secret: () => secret,
    chatHandle: (chatId) => chats.get(chatId) ?? null,
  });
  const gateway: GatewayDeps = {
    linq: {
      verifyWebhook: async (request) => (await verifier.verifyWebhook(request)) as VerifyWebhookResult,
    },
    actor: actorDoor(),
    receipts: { accept: acceptReceipt },
    keys,
    bundleId: () => BUNDLE_A,
  };

  const restores = [
    setSafetyDeps(safety),
    setBatchHooks({ clock: { now: () => clock.now() } }),
    setBundleDeps(fakeBundles().deps),
    setGuardDeps({ targets: targets.port }),
    ...(options.turns ? [setLeaseHooks(turnHooks), setTurnDeps(set)] : []),
  ];

  const spans = (): Span[] => loggedSpans(log);

  return {
    clock,
    face,
    store,
    linq,
    traces,
    receipts,
    known(eventId) {
      const result = safetyNoFor(eventId);
      answers[eventId] = result;
      facts.safety.set(eventId, result);
    },
    async untilHop(traceId, hop) {
      try {
        await until(() => spans().some((span) => span.trace_id === traceId && span.hop === hop), hop, 15_000);
      } catch {
        const seen = spansOfTrace(spans(), traceId).map((span) => `${span.hop}:${span.outcome}`);
        throw new Error(
          `no ${hop} span: the trace shows ${seen.join(", ")}; the turn called ${face.log.join(", ")}`,
        );
      }
    },
    async post(event, partKey = null) {
      const arriving = { ...event, receivedAt: utcSeconds(Date.now()) } as unknown as LinqEvent;
      const signed = await webhooks.sign({ event: arriving, partKey });
      const response = await handleLinqWebhook(
        new Request(`http://rosie.local${LINQ_WEBHOOK_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "webhook-id": signed.webhookId,
            "webhook-timestamp": signed.timestamp,
            "webhook-signature": signed.signature,
          },
          body: signed.raw,
        }),
        gateway,
        { environment: "staging", version: "test-sha" },
      );
      if (response.status !== 200) {
        // The gateway's failure lines name the stage and the error's name only (never a body or a number).
        const failed = log.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('"gateway_failed"'));
        throw new Error(`the gateway answered ${String(response.status)}: ${failed.join(" ")}`);
      }
      const traceId = response.headers.get("x-trace-id");
      if (traceId === null) throw new Error("the gateway answered with no trace id");
      return traceId;
    },
    spans,
    restore() {
      for (const restore of restores.reverse()) restore();
    },
  };
}

/** Waits until the actor has read every text and handed on what its batch window can. */
async function settle(actorName: string): Promise<void> {
  await actorOf(actorName).safetyIdle();
  await actorOf(actorName).batchIdle();
}

/** Every span is K-08's (labels and counts only), and none holds a raw phone number or a message's words. */
function expectNoWords(spans: readonly Span[], words: readonly string[]): void {
  expect(spans.flatMap((span) => spanProblems(span))).toEqual([]);
  expect(leaks(spans, [...CAST_NUMBERS, ...words])).toEqual([]);
}

/** The judged trace, with its problems shown when it fails. */
function expectHops(report: HopCheck): void {
  expect(report.problems).toEqual([]);
  expect(report.ok).toBe(true);
}

/**
 * A run through every piece takes the Workers runtime's own steps (WebCrypto, RPC, lent work, the fakes' polled waits):
 * a resource guard above Vitest's 5 s default, not part of any claim (as T-1073's unit limit).
 */
const TEST_MS = 30_000;

/** The spans logged so far. */
function loggedSpans(spy: MockInstance): Span[] {
  return spansOfLogLines(spy.mock.calls.map((call: unknown[]) => call[0]));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

// ---- the tests --------------------------------------------------------------------------------------------------------

describe("a text's webhook to its delivery receipt: one trace id, every runtime hop of trace-skeleton.json once, in order", () => {
  it(
    "drives Sam's text through the gateway, the actor, the lease, the guard, the turn, the dispatcher and a receipt that arms a clock",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log, { turns: true });
      try {
        const words = "Barbershop, plumbing, electrical";
        run.known("evt-sam-0001");
        const traceId = await run.post(samText("evt-sam-0001", words));
        await settle(SAM_ACTOR);

        // Three seconds quiet: the batch window closes, the lease opens the turn and the turn replies through the dispatcher.
        await run.clock.advance(3000);
        await runDurableObjectAlarm(stubOf(SAM_ACTOR));
        await run.untilHop(traceId, "providerAccepted");
        const accepted = run.linq.accepted.get(`${ROW}/1/1`);
        if (accepted?.providerMessageId == null) throw new Error("Linq accepted no part");

        // Linq's delivery receipt for that part: K-06 delivered.json with the part's message id, echoing its key.
        const receipt = {
          ...(structuredClone(deliveredFixture) as Json),
          eventId: "evt-linq-delivered-sam-0001",
          handle: { ...SAM.handle },
          chatId: "linq-chat-demo-sam",
          status: { messageId: accepted.providerMessageId, at: A7_03_DELIVERED.deliveredAt, failure: null },
        } as unknown as InboundEvent;
        const receiptTraceId = await run.post(receipt, `${ROW}/1/1`);
        expect(run.receipts).toEqual(["delivered"]);

        const spans = run.spans();
        const trace = spansOfTrace(spans, traceId);
        const report = checkHops(trace, {
          traceId,
          expected: hopsOfTrace(SKELETON),
          notWritten: hopsIn(NOT_WRITTEN),
          extra: actorReceive,
        });
        expectHops(report);
        expect(report.judged).toEqual([
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
        ]);
        // The actor's own receive span, set aside: exactly one, for this text.
        expect(report.extra.map((span) => [span.hop, span.event_id, span.outcome])).toEqual([
          ["receive", "evt-sam-0001", "ok"],
        ]);

        // One bundle id: the gateway's active id at receipt is the one the turn pinned, on every span.
        expect(new Set(trace.map((span) => JSON.stringify(span.bundle_id)))).toEqual(
          new Set([JSON.stringify(BUNDLE_A)]),
        );
        // One turn id from the lease on (CQ-09: the lease's hash of the event ids), none before the batch closed.
        const turnId = run.face.gateCalls[0]?.request.turn.id;
        expect(turnId).toMatch(/^[0-9a-f]{64}$/u);
        const fromLease = trace.slice(trace.findIndex((span) => span.hop === "lease"));
        expect(new Set(fromLease.map((span) => span.turn_id))).toEqual(new Set([turnId]));
        expect(trace.filter((span) => !fromLease.includes(span)).map((span) => span.turn_id)).toEqual([
          null,
          null,
          null,
        ]);
        // The gate request carries the text's trace id (one id from the webhook to the receipt).
        expect(run.face.gateCalls[0]?.request.turn.traceId).toBe(traceId);
        // The receipt's own webhook opened its own trace id: its receive hop alone.
        expect(receiptTraceId).not.toBe(traceId);
        expectHops(
          checkHops(spansOfTrace(spans, receiptTraceId), { traceId: receiptTraceId, expected: ["receive"] }),
        );

        // Each writer opens its own context and numbers from 1, so seq is not one run on this trace (T-260's handoff).
        expect(seqProblems(trace)).not.toEqual([]);
        expectNoWords(spans, [words, ...FIXTURE_WORDS]);
      } finally {
        run.restore();
      }
    },
  );
});

describe("a repeated webhook adds only a 'dropped at receipt' span (trace-duplicate-webhook.json)", () => {
  it("the same K-06 event id sent again opens its own trace, which is dropped at receipt with nothing after it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = rig(log, { turns: false });
    try {
      const first = structuredClone(textFixture) as unknown as InboundEvent;
      const again = structuredClone(duplicateFixture) as unknown as InboundEvent;
      expect(again.eventId).toBe(first.eventId);
      run.known(first.eventId);
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
      expectHops(report);
      const expected = DUPLICATE.spans[0];
      const dropped = repeat.find((span) => !actorReceive(span));
      expect(dropped?.outcome).toBe(expected?.outcome);
      expect(dropped?.event_id).toBe(first.eventId);
      expect(dropped?.decided).toMatchObject({ signatureValid: true, knownEventId: true, answered: 200 });
      // The actor's own receive span, set aside: one, also dropped.
      expect(report.extra.map((span) => span.outcome)).toEqual(["dropped"]);

      // The first arrival's trace went on to its safety read; the repeat's ran no hop after receive.
      expect(
        checkHops(spansOfTrace(spans, firstTrace), {
          traceId: firstTrace,
          expected: ["receive", "scrub", "safetyRead"],
          notWritten: hopsIn(NOT_WRITTEN),
          extra: actorReceive,
        }).problems,
      ).toEqual([]);
      expectNoWords(spans, [String((textFixture as Json).body)]);
    } finally {
      run.restore();
    }
  });
});

describe("a three-text batch (trace-batch-three-texts.json)", () => {
  it(
    "one turn carries the first text's trace id and lists the others; each text's trace shows its own hops once, in order",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log, { turns: true });
      try {
        // Each text has a space in it, so no label of a span (no spaces: K-08) could hold it by chance.
        const texts = [
          ["evt-sam-0101", "Barbershop for sure"],
          ["evt-sam-0102", "plumbing too"],
          ["evt-sam-0103", "and electrical"],
        ] as const;
        const traceIds: string[] = [];
        for (const [eventId, body] of texts) {
          run.known(eventId);
          traceIds.push(await run.post(samText(eventId, body)));
        }
        await settle(SAM_ACTOR);
        await runDurableObjectAlarm(stubOf(SAM_ACTOR));
        const [turnTrace, secondTrace, thirdTrace] = traceIds;
        if (turnTrace === undefined || secondTrace === undefined || thirdTrace === undefined) {
          throw new Error("three texts, three trace ids");
        }
        await run.untilHop(turnTrace, "providerAccepted");

        // The third text closed the batch at once (the fixture's closedBy thirdText).
        const batches = await actorOf(SAM_ACTOR).readBatches();
        expect(batches.map((batch) => [batch.reason, batch.handed, batch.eventIds.length])).toEqual([
          ["third", true, 3],
        ]);
        // CQ-06: the turn carries the first text's trace id and lists the other two (K-05 turn.joinedTraceIds).
        expect(run.face.gateCalls.map((call) => call.request.turn)).toMatchObject([
          { traceId: turnTrace, joinedTraceIds: [secondTrace, thirdTrace] },
        ]);

        const spans = run.spans();
        [turnTrace, secondTrace, thirdTrace].forEach((traceId, place) => {
          const report = checkHops(spansOfTrace(spans, traceId), {
            traceId,
            expected: hopsOfTrace(traceAt(BATCH_THREE, place)),
            notWritten: hopsIn(NOT_WRITTEN),
            extra: actorReceive,
          });
          expectHops(report);
          expect(report.extra).toHaveLength(1);
        });
        // The joined texts' traces carry no turn: nothing ran on them after their safety read.
        for (const traceId of [secondTrace, thirdTrace]) {
          expect(spansOfTrace(spans, traceId).map((span) => span.turn_id)).toEqual([null, null, null]);
        }
        expectNoWords(spans, [...texts.map(([, body]) => body), ...FIXTURE_WORDS]);
      } finally {
        run.restore();
      }
    },
  );
});

describe("a clock firing (trace-clock-fire.json)", () => {
  it("A7-03's armed row fired by the actor's alarm path opens its own trace under a job id, with the clockFired hop once", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const clock = testClock();
    const clocks = fakeClocks();
    const restores = [setBatchHooks({ clock: { now: () => clock.now() } }), setClockDeps(clocks.deps)];
    try {
      // Armed and past due: the actor's clock part fires it through the one fire path, as its alarm does (T-254, T-255).
      clocks.arm(A7_03);
      const reports = await actorOf(ALEX_ACTOR).syncClocks(ALEX_HANDLE);
      expect(
        reports.map((report) => [report.clockRowId, report.by, report.outcome, report.errorCode]),
      ).toEqual([[A7_03.clockRowId, "alarm", "fired", null]]);
      const traceId = reports[0]?.traceId ?? null;
      if (traceId === null) throw new Error("the firing opened no trace");

      const spans = loggedSpans(log);
      const trace = spansOfTrace(spans, traceId);
      expectHops(
        checkHops(trace, {
          traceId,
          expected: hopsOfTrace(CLOCK_FIRE),
          notWritten: hopsIn(CLOCK_NOT_WRITTEN),
        }),
      );
      // Its own trace under the firing's job id, on every span (CQ-06: a clock firing never shares a text's id).
      expect(new Set(trace.map((span) => span.job_id))).toEqual(new Set([`job-fire-${A7_03.clockRowId}`]));
      expect(CLOCK_FIRE.opened_by).toBe("clockFiring");
      expectNoWords(spans, wordsIn(A7_03.fires));
    } finally {
      for (const restore of restores.reverse()) restore();
    }
  });
});
