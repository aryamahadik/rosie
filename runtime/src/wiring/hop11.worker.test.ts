// T-562's join, hop 11 of D-017 (C-124, C-125; build prompt section 10, D-017: "dispatcher"; 02-contracts section 11,
// 'Outbox dispatcher, limit 8': K-05, K-07; ADR-013 section 6: commit-s1-01.json's row, send class quick_reply, K-09 v1.5
// default 133; DL-312, DL-315, DL-317, DL-349, DL-433), in the Workers runtime. The composition root is composed for the
// test environment as hop 10's tests compose it, now with the two ports this hop joins: the outbox, the dispatcher's
// claim, renewal and marks over K-05 v1.2's claimOutboxV12, renewClaim, markPartV12 and markRowV12, and the send state,
// limit 8's read at send over K-05 v1.2 sendState, both fed one K-05 double over the rows the commit wrote, the plans and
// final parts finalize wrote into them and test owner 1's seeded rows (./test-support.ts fakeDispatchData). Test owner
// 1's seed holds no phone row (T-1148), so these tests give Sam the phone row K-05's send-state-owner.json reads for him
// (chat open on iMessage, not stopped), as a number has once it has texted Rosie; the skeleton's own run, with none,
// waits for the chat (tests/e2e/skeleton CLAIMS row 11).
//
//   - The JOIN at 11pm in Lee's Barbershop's zone, past its text hours (08:00 to 20:00): the turn's dispatcher claims the
//     row once, in commit order (claim 1, from checked, by the linq port), with the final parts finalize wrote; limit 8
//     reads Sam's send state and lets the reply go at once, a reply in the same turn going at any hour (Q-15; RULES 4.3);
//     the claim is renewed with Sam's phone row read beside it, and the one words part goes to the Linq port, carrying
//     the opener, the STOP, HELP and rates line and the privacy link, to Sam's chat, then is marked sent. One dispatch
//     span, which starts before the part's providerAccepted span (DL-349). No span holds a word, the number or the chat id.
//   - A row for a phone marked stopped before the claim (K-07 outbox-dropped-stopped): the row is claimed, limit 8 drops
//     it as stopped (markRow droppedStopped), and nothing is renewed or sent; no texts yes lifts the stop (T-1099).
//   - Two dispatchers claiming in parallel (two roots, each its own claimer, over the one K-05 double, as two isolates over
//     one database): the row is handed to one of them only (K-05's contract rule: parallel claims never hand one row to two
//     senders), and its part goes once.
//
// Each test runs the JOIN on a fresh rig, and the Durable Objects' storage is reset after each (as hop 10's tests run it).
// Test values only (rule 9): the master's sample cast, the fictional 555-01xx numbers and the fixtures' own words.
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { QUIET_MS, turnIdOf, type HandleActor } from "../actor";
import { actorNameOf } from "../gateway";
import { openTrace, type Hop, type Span } from "../trace";
import { leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { flush } from "../turn/test-support";
import { composeRoot, SKELETON_FLAG, type HandleActors, type Root } from "./index";
import {
  BUNDLE_V0,
  bundleV0FixedLine,
  fakeFlags,
  SAM_CHAT,
  samPhoneRow,
  skeletonFakes,
  TEST_OWNER_1,
  TEST_OWNER_1_BUSINESS_NAME,
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

/** The JOIN run's own context (K-02 README "v1.1", recording 2; T-1145 round 2, DL-347). */
const JOIN_CONTEXT = joinRunContext as unknown as {
  readonly texts: readonly {
    readonly eventId: string;
    readonly words: string;
    readonly sentAt: { utc: string };
  }[];
};
const [JOIN_TEXT_OF_RECORDING] = JOIN_CONTEXT.texts;

/** The fictional number the JOIN comes from, in each form a number could leak in. */
const CAST_NUMBERS = ["0100"].flatMap((line) => [`+1555555${line}`, `1555555${line}`, `555555${line}`]);

const OWNER_ACTOR = actorNameOf(TEST_OWNER_1.handle);

/** Lee's Barbershop's zone (K-04 seed-business-head.json), where its text hours are read. */
const BUSINESS_ZONE = "America/New_York";

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

function stubOf(actorName: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorName));
}

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
    if (Date.now() - started > WAIT_MS) {
      throw new Error(`gave up waiting for the turn's reply to end (state ${turn?.state ?? "none"})`);
    }
    await flush(5);
  }
}

/** The JOIN as recording 2 names it: K-06 text-imessage.json's form from test owner 1, on Sam's chat (imessage). */
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

/** The root for "test", every joined port fed its double, the outbox and send state (T-562) among them. */
function testRoot(fakes: SkeletonFakes, actors: HandleActors<DurableObjectId>): Root {
  return composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors,
    vars: env,
    clock: fakes.clock,
    linq: fakes.linqInputs,
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
    outboxCalls: fakes.dispatch.outbox,
    sendStateCall: fakes.dispatch.sendState,
    flags: fakeFlags([SKELETON_FLAG]),
  });
}

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  post(event: LinqInboundEvent): Promise<string>;
  spans(): Span[];
  traceOf(traceId: string): Span[];
  restore(): void;
}

function rig(log: MockInstance): Rig {
  const fakes = skeletonFakes();
  const root = testRoot(fakes, handleActors());
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
    restore,
  };
}

/** The JOIN's turn, run on `run` to its reply: its turn id, trace id and the row its commit wrote. */
async function runJoin(run: Rig): Promise<{ turnId: string; traceId: string; row: string }> {
  const join = joinAsRecorded();
  run.fakes.known(join.eventId);
  const traceId = await run.post(join);
  await settle(OWNER_ACTOR);
  await run.fakes.clock.advance(QUIET_MS);
  await runDurableObjectAlarm(stubOf(OWNER_ACTOR));
  const turnId = await turnIdOf([join.eventId]);
  try {
    await untilReplied(OWNER_ACTOR, turnId);
  } catch (error) {
    const seen = run.traceOf(traceId).map((span) => `${span.hop}:${span.outcome}:${span.error_code ?? ""}`);
    throw new Error(
      `${error instanceof Error ? error.message : "no reply"}; the trace shows ${seen.join(", ")}`,
      {
        cause: error,
      },
    );
  }
  await settle(OWNER_ACTOR);
  return { turnId, traceId, row: `outbox-s1-02-${turnId}-1` };
}

/** The one span of a hop in a trace. */
function onlySpan(spans: readonly Span[], hop: Hop): Span {
  const found = spans.filter((span) => span.hop === hop);
  expect(found.map((span) => span.hop)).toEqual([hop]);
  const [span] = found;
  if (span === undefined) throw new Error(`no ${hop} span`);
  return span;
}

/** The hour of an instant in a zone, 0 to 23. */
function hourIn(zone: string, at: number): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(at),
  );
}

/** How far the clock must move from `now` to reach ten seconds past the next 11pm in `zone` (whole hours there). */
function untilElevenPm(zone: string, now: number): number {
  const hour = 3_600_000;
  let at = Math.ceil(now / hour) * hour;
  while (hourIn(zone, at) !== 23) at += hour;
  return at + 10_000 - now;
}

/** Every string a value holds, at any depth. */
function stringsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value as unknown[]) stringsOf(item, into);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) stringsOf(item, into);
  return into;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("hop 11 joined: the outbox dispatcher claims the committed row through K-05 v1.2 and checks limit 8 before any send", () => {
  it(
    "the JOIN at 11pm in the barbershop's zone: the row claimed once with the final parts finalize wrote; limit 8 lets the reply in the same turn go at any hour (Q-15); renewed with Sam's phone row read beside it, its one part sent to his chat and marked sent; one dispatch span, before providerAccepted's",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        run.fakes.dispatch.phones.set(TEST_OWNER_1.handleId, samPhoneRow());
        await run.fakes.clock.advance(untilElevenPm(BUSINESS_ZONE, run.fakes.clock.now()));
        const { turnId, traceId, row } = await runJoin(run);
        const { dispatch, finalize, linq } = run.fakes;
        const written = finalize.plans.get(row);
        if (written === undefined) throw new Error("finalize wrote no final parts into the JOIN turn's row");

        // One claim, the turn's, for Sam: the JOIN turn's row claimed once, in commit order, from checked, by linq.
        expect(dispatch.claims.map((call) => call.request.recipientHandleId)).toEqual([
          TEST_OWNER_1.handleId,
        ]);
        const answer = dispatch.claims[0]?.answer;
        if (answer === undefined || "error" in answer)
          throw new Error("the turn's claim was not answered claimed");
        expect(
          answer.claimed.map((claimed) => [
            claimed.outboxRowId,
            claimed.claimedFrom,
            claimed.port,
            claimed.sendClass,
            claimed.claim.claimNo,
          ]),
        ).toEqual([[row, "checked", "linq", "quick_reply", 1]]);
        expect(answer.claimed[0]?.finalParts).toEqual(written.finalParts);

        // Limit 8's read, before the send, past the barbershop's text hours, at 11pm in its zone; then the stopped flag
        // read once more just before the send (the dispatcher's own re-read, T-259).
        const read = {
          result: "sendState",
          outboxRowId: row,
          rowState: "sending",
          phone: { stopped: false, chatOpen: true, chatWay: "imessage" },
          chat: { linqChatId: SAM_CHAT },
          businessZone: BUSINESS_ZONE,
          textHours: { start: "08:00", end: "20:00" },
        };
        expect(dispatch.stateReads.map((call) => call.answer)).toMatchObject([read, read]);
        const dispatchSpan = onlySpan(run.traceOf(traceId), "dispatch");
        expect(hourIn(BUSINESS_ZONE, Date.parse(dispatchSpan.at))).toBe(23);
        expect(dispatch.rowMarks).toEqual([]);

        // The claim renewed just before the part went, the phone row read beside it; the part sent to Sam's chat with the
        // final parts finalize wrote: the opener first, then the plan's words, the STOP, HELP and rates line and the
        // privacy link alone on the last line, as bundle v0 writes them; then marked sent, the row sent.
        expect(dispatch.renewals.map((call) => call.answer)).toMatchObject([
          { result: "renewed", outboxRowId: row, recipient: { stopped: false, chatOpen: true } },
        ]);
        const text = written.finalParts.sends[0].text ?? "";
        const opener = bundleV0FixedLine("opener").replace("<business>", TEST_OWNER_1_BUSINESS_NAME);
        expect(text.startsWith(`${opener} `)).toBe(true);
        expect(text.split("\n").slice(-2)).toEqual([
          bundleV0FixedLine("optOutLine"),
          bundleV0FixedLine("privacyLink"),
        ]);
        expect(linq.requests).toMatchObject([
          {
            idempotencyKey: `${row}/1/1`,
            to: TEST_OWNER_1.handle.address,
            chatId: SAM_CHAT,
            service: "imessage",
            kind: "words",
            text,
            overrideOptout: false,
          },
        ]);
        expect(dispatch.partMarks.map((call) => [call.request.outcome, call.answer])).toMatchObject([
          ["sent", { result: "marked", outboxRowId: row, repeated: false, row: { state: "sent" } }],
        ]);
        expect(dispatch.row(row)).toMatchObject({ state: "sent", claim: { claimNo: 1 } });

        // One dispatch span: limit 8 passed, claim 1, the one part sent by Linq; it starts before providerAccepted's.
        expect(dispatchSpan).toMatchObject({
          outcome: "ok",
          error_code: null,
          turn_id: turnId,
          bundle_id: BUNDLE_V0,
          provider: "linq",
          call: "sendPart",
          attempt: 1,
          limits: [{ limit: 8, result: "pass", outcome: null }],
          got: { parts: 1, partsSent: 1 },
          decided: { result: "sent", claimNo: 1 },
          rows: [{ table: "outbox_rows", id: row }],
        });
        const accepted = onlySpan(run.traceOf(traceId), "providerAccepted");
        expect(accepted.rows).toEqual([{ table: "outbox_parts", id: `${row}/1/1` }]);
        expect(Date.parse(accepted.at)).toBeGreaterThan(Date.parse(dispatchSpan.at));
        expect(Date.parse(accepted.at)).toBeLessThanOrEqual(Date.parse(dispatchSpan.at) + dispatchSpan.ms);

        // No span holds a word of the part, the number or the chat id.
        const spans = run.spans();
        expect(leaks(spans, [...CAST_NUMBERS, SAM_CHAT])).toEqual([]);
        expect(
          stringsOf(spans).filter((value) => text.split("\n").some((line) => value.includes(line))),
        ).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a row for a phone marked stopped before the claim is dropped as stopped (K-07 outbox-dropped-stopped) and nothing is sent",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        // Sam's STOP came before the claim: the phone row stopped, with its time, and its chat closed (K-04
        // phones_stopped_has_time, phones_stop_closes_chat); no texts consent row, so no yes lifts the stop.
        const stopAt = new Date(run.fakes.clock.now() - 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z");
        run.fakes.dispatch.phones.set(TEST_OWNER_1.handleId, {
          ...samPhoneRow(),
          stopped: true,
          stopAt,
          chatOpen: false,
          version: samPhoneRow().version + 1,
        });
        const { turnId, traceId, row } = await runJoin(run);
        const { dispatch, linq } = run.fakes;

        // Claimed once, then limit 8's read: stopped, so the row is dropped as stopped at its claimed version.
        const answer = dispatch.claims[0]?.answer;
        if (answer === undefined || "error" in answer)
          throw new Error("the turn's claim was not answered claimed");
        expect(answer.claimed.map((claimed) => claimed.outboxRowId)).toEqual([row]);
        expect(dispatch.stateReads.map((call) => call.answer)).toMatchObject([
          { phone: { stopped: true, stopAt }, textsConsent: null },
        ]);
        expect(dispatch.rowMarks.map((call) => [call.request.outcome, call.request.expectVersion])).toEqual([
          ["droppedStopped", answer.claimed[0]?.version],
        ]);
        expect(dispatch.row(row)).toMatchObject({ state: "dropped_stopped" });
        // Nothing renewed, marked or sent.
        expect(dispatch.renewals).toEqual([]);
        expect(dispatch.partMarks).toEqual([]);
        expect(linq.requests).toEqual([]);
        expect(run.traceOf(traceId).filter((span) => span.hop === "providerAccepted")).toEqual([]);
        expect(onlySpan(run.traceOf(traceId), "dispatch")).toMatchObject({
          outcome: "dropped",
          turn_id: turnId,
          limits: [{ limit: 8, result: "fail", outcome: "droppedStopped" }],
          got: { parts: 1, partsSent: 0 },
          decided: { result: "droppedStopped", claimNo: 1 },
          rows: [{ table: "outbox_rows", id: row }],
        });
        expect(leaks(run.spans(), [...CAST_NUMBERS, SAM_CHAT])).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "two dispatchers claiming in parallel never hand the row to both: one claims it and sends its part once, the other claims nothing",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        run.fakes.dispatch.phones.set(TEST_OWNER_1.handleId, samPhoneRow());
        // The turn's own claim loses its connection (transient: nothing claimed), so the row stays checked for the two.
        run.fakes.dispatch.failNextClaim = { error: "transient", sqlstate: "08006" };
        const { turnId, row } = await runJoin(run);
        const { dispatch, linq } = run.fakes;
        expect(dispatch.claims.map((call) => call.answer)).toEqual([
          { error: "transient", sqlstate: "08006" },
        ]);
        expect(dispatch.row(row)).toMatchObject({ state: "checked", claim: null });
        expect(linq.requests).toEqual([]);

        // A second dispatcher: another root over the same K-05 double, with its own claimer, as a second isolate.
        const second = testRoot(run.fakes, handleActors());
        const spans: Span[] = [];
        const traceOf = (): ReturnType<typeof openTrace> =>
          openTrace({
            openedBy: "sweep",
            jobId: "dispatch-sweep",
            bundleId: BUNDLE_V0,
            sink: (span) => spans.push(span),
          });
        const wake = { turnId, handleId: TEST_OWNER_1.handleId, outboxRowIds: [row] };
        await Promise.all([
          run.root.dispatcher.wake(wake, traceOf()),
          second.dispatcher.wake(wake, traceOf()),
        ]);

        // Two claims at once, by two claimers: the row handed to one of them only.
        const parallel = dispatch.claims.slice(1);
        expect(new Set(parallel.map((call) => call.request.claimer)).size).toBe(2);
        const handed = parallel.flatMap((call) =>
          "error" in call.answer
            ? []
            : call.answer.claimed.map((claimed) => ({
                claimer: call.request.claimer,
                row: claimed.outboxRowId,
              })),
        );
        expect(handed.map((each) => each.row)).toEqual([row]);
        // Its part went once, under its one key, and the row is sent under that one claim.
        expect(linq.requests.map((request) => request.idempotencyKey)).toEqual([`${row}/1/1`]);
        expect(dispatch.partMarks.map((call) => call.request.outcome)).toEqual(["sent"]);
        expect(dispatch.row(row)).toMatchObject({
          state: "sent",
          claim: { claimer: handed[0]?.claimer, claimNo: 1 },
        });
        expect(spans.filter((span) => span.hop === "dispatch").map((span) => span.decided)).toMatchObject([
          { result: "sent", claimNo: 1 },
        ]);
      } finally {
        run.restore();
      }
    },
  );
});
