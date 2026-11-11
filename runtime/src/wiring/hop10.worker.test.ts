// T-561's join, hop 10 of D-017 (C-046; build prompt section 10, D-017: "finalize"; 02-contracts section 11, 'Code fills
// slots and fixed lines; claim check and message checks': K-09 finalizeMessage, K-03 final parts; ADR-013 section 6;
// QUESTIONS Q-30's default), in the Workers runtime. The composition root is composed for the test environment as hop 9's
// tests compose it (the HandleActor namespace, the skeleton flag on, the actor's ports installed, every joined port fed its
// double), now with the port this hop joins: finalize, @rosie/actions' turn face's finalizeMessage (T-1141: the Tool API
// base with K-09's checks and the call's business scope; T-313's finalize with T-314's fixed-line inserter over T-1141's
// row binding), over K-05 doubles of readOutboxRow, readFixedLineFacts, writePlan and cancelClock over the rows the commit
// wrote and test owner 1's seeded rows (./test-support.ts fakeFinalizeData), on bundle v0 as bundles/v0 publishes it,
// with T-1146's privacyLink line. The turn's finalize calls are watched on their way to the root's own (watchGate).
//
//   - The JOIN as recording 2 names it (evt-sam-0000, test owner 1, Sam's chat): hops 1 to 10 once each. The turn hands
//     finalize K-09 v1 finalize-pass.json's plan in (plan-s1-02.json, recording 4's answer) on the run's own row. Finalize
//     answers send at the first attempt, its seven message checks all passed as K-03 check-pass.json lists them, and its
//     final parts are not finalize-pass.json's outcome (K-09 v1.5 open gap 121) but Q-30's: S13-01's opener first, filled
//     with Lee's Barbershop, then the plan's words, the STOP, HELP and rates line, and the privacy link alone on the last
//     line, each fixed line word for word as bundle v0 writes it. The plan and those final parts are written into the row
//     together, once, after the commit (T-196's writePlan); finalize read the row and its fixed-line facts once each,
//     under Lee's Barbershop's scope; the turn records the row's one fillAndChecks span and no rewriteOrFallback span, and
//     the Tool API base records none (DL-376). No span or log line holds a word of the message, a number or the chat id.
//   - A plan with a typed price (K-03 check-raw-price.json's): finalize's Values check fails it, so the row gets its one
//     rewrite, told that check and its detail; the rewrite types the price again, so finalize runs the step's fallback
//     text (S1-02's, as bundle v0 writes it) through the same checks, which pass, and the fallback's final parts are
//     written with the rewrite's plan. The trace shows each: the fillAndChecks span (the rewrite asked, Values failed) and
//     the rewriteOrFallback span (told Values, the rewrite planned, the fallback sent). @rosie/ai's composer refuses a typed
//     price itself before finalize could see one (ai/src/composer/check.ts literalValue, for a plan and for a plan to fix),
//     so a composer double that types it stands in for the AI layer here: finalize's Values check is the backstop shown.
//
// Each test runs the JOIN on a fresh rig, and the Durable Objects' storage is reset after each (as hop 8's tests run it).
// Test values only (rule 9): the master's sample cast, the fictional 555-01xx numbers and the fixtures' own words.
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import type { Composer } from "@rosie/ai/src/composer/types";
import { HAIKU_MODEL } from "@rosie/ai/src/gateway/index";
import traceSkeleton from "@rosie/contracts/event-trace/fixtures/trace-skeleton.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import checkPass from "@rosie/contracts/message-plan/fixtures/check-pass.json";
import checkRawPrice from "@rosie/contracts/message-plan/fixtures/check-raw-price.json";
import planS102 from "@rosie/contracts/message-plan/fixtures/plan-s1-02.json";
import finalizePass from "@rosie/contracts/tool-api/fixtures/finalize-pass.json";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { QUIET_MS, turnIdOf, type HandleActor } from "../actor";
import { actorNameOf } from "../gateway";
import type { Hop, Span, Trace } from "../trace";
import { checkHops, hopsOfTrace, leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import type { ModelCall } from "../trace/types";
import { flush } from "../turn/test-support";
import type { CheckResult, FinalParts, FinalizeMessageResponse, MessagePlan } from "../turn/types";
import { composeRoot, SKELETON_FLAG, type Composers, type HandleActors, type Root } from "./index";
import {
  BUNDLE_V0,
  bundleV0FallbackText,
  bundleV0FixedLine,
  fakeFlags,
  SAM_CHAT,
  skeletonFakes,
  TEST_OWNER_1,
  TEST_OWNER_1_BUSINESS_NAME,
  watchGate,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
  type WatchedFinalizeCall,
} from "./test-support";

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;

/** A run through the Workers runtime's own steps: a resource guard above Vitest's 5 s default. */
const TEST_MS = 30_000;
/** How long a step of the actor's lent work may take before a wait gives up. */
const WAIT_MS = 15_000;

const SKELETON = traceSkeleton as unknown as Trace;
/** Hops 1 to 10 of a text's trace (K-08 trace-skeleton.json), in D-017's turn order: receive to fillAndChecks. */
const HOPS_1_TO_10: readonly Hop[] = hopsOfTrace(SKELETON).slice(
  0,
  hopsOfTrace(SKELETON).indexOf("fillAndChecks") + 1,
);
/** Hops of those with no writer yet (T-260's gap b): the batch window writes no span until T-1108. Judged once written. */
const NO_WRITER_YET: readonly Hop[] = ["scrub", "batch"];

/** K-03's plan-s1-02.json: recording 4's answer, the plan finalize-pass.json hands finalize. */
const PLAN_S1_02 = planS102 as unknown as MessagePlan & {
  readonly lines: readonly { readonly text: string }[];
  readonly question: { readonly text: string };
};

/** K-09 v1 finalize-pass.json: the plan in (its request) and the outcome that predates T-314's first-text lines. */
const FINALIZE_PASS = finalizePass as unknown as {
  readonly request: { readonly expectVersion: number; readonly plan: Json };
  readonly outcome: Json;
};

/** K-03 check-pass.json's checks: the seven message checks, in K-03's order, each passed. */
const ALL_PASSED = checkPass.checks;

/** The price check-raw-price.json's Values check names as typed by the model, not a code-supplied fact. */
const TYPED_PRICE = typedPriceOf();
/** The sentence of check-raw-price.json's checked words that types that price. */
const TYPED_SENTENCE = typedSentenceOf();

function typedPriceOf(): string {
  const detail = checkRawPrice.checks.find((check) => check.check === "values")?.detail ?? "";
  const price = /^The price (\S+) is not a code-supplied fact/u.exec(detail)?.[1];
  if (price === undefined) throw new Error("check-raw-price.json's Values check names no typed price");
  return price;
}

function typedSentenceOf(): string {
  const words = checkRawPrice.checked.sends[0]?.text ?? "";
  const sentence = words.split(/(?<=\.)\s+/u).find((each) => each.includes(TYPED_PRICE));
  if (sentence === undefined) throw new Error("check-raw-price.json's checked words hold no typed price");
  return sentence;
}

/** S1-02's plan with check-raw-price.json's typed sentence as one more fact line: a price no code supplied. */
const TYPED_PRICE_PLAN: MessagePlan = {
  ...PLAN_S1_02,
  lines: [...PLAN_S1_02.lines, { role: "fact", text: TYPED_SENTENCE }],
};

/** The JOIN run's own context (K-02 README "v1.1", recording 2; T-1145 round 2, DL-347). */
const JOIN_CONTEXT = joinRunContext as unknown as {
  readonly texts: readonly {
    readonly eventId: string;
    readonly words: string;
    readonly sentAt: { utc: string };
  }[];
};
const [JOIN_TEXT_OF_RECORDING] = JOIN_CONTEXT.texts;

/** The fictional numbers this file's texts come from, in each form a number could leak in. */
const CAST_NUMBERS = ["0100"].flatMap((line) => [`+1555555${line}`, `1555555${line}`, `555555${line}`]);

const OWNER_ACTOR = actorNameOf(TEST_OWNER_1.handle);

/** Bundle v0's opener, its <business> filled with the name limit 7 lets Sam see (the switch is off: biz.name). */
const OPENER = bundleV0FixedLine("opener").replace("<business>", TEST_OWNER_1_BUSINESS_NAME);
/** Q-30's lines as bundle v0 writes them: the STOP, HELP and rates line, then the privacy link. */
const OPT_OUT_LINE = bundleV0FixedLine("optOutLine");
const PRIVACY_LINK = bundleV0FixedLine("privacyLink");
/** The fixed lines of Rosie's first text to a handle about one business, in the order finalize adds them. */
const FIRST_TEXT_LINES = ["opener", "optOutLine", "privacyLink"];

/** The one words send of Rosie's first text: the opener before `words`, then Q-30's lines, the privacy link alone last. */
function firstTextSend(words: string): Json {
  return {
    kind: "words",
    text: [`${OPENER} ${words}`, OPT_OUT_LINE, PRIVACY_LINK].join("\n"),
    calendarFile: "none",
    options: [],
    link: null,
  };
}

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

/** Every line a console method was handed, as text. */
const linesOf = (spy: MockInstance): string[] =>
  spy.mock.calls.map((call: unknown[]) =>
    call.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "),
  );

/** The root for "test", every joined port fed its double (finalize's among them); `composers` in place of the double's. */
function testRoot(fakes: SkeletonFakes, actors: HandleActors<DurableObjectId>, composers?: Composers): Root {
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
    composers: composers ?? fakes.composer.composers,
    finalizeData: fakes.finalize.data,
    flags: fakeFlags([SKELETON_FLAG]),
  });
}

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  /** Each finalizeMessage the turn handed the root, as the turn made it, with the finalize port's answer. */
  readonly finalizeCalls: readonly WatchedFinalizeCall[];
  post(event: LinqInboundEvent): Promise<string>;
  spans(): Span[];
  traceOf(traceId: string): Span[];
  restore(): void;
}

/** The root for "test" with the HandleActor namespace, its actor ports installed and the turn's finalize calls watched. */
function rig(log: MockInstance, composers?: Composers): Rig {
  const fakes = skeletonFakes();
  const root = testRoot(fakes, handleActors(), composers);
  const restoreRoot = root.install();
  const watched = watchGate(root, fakes.face);
  const spans = (): Span[] => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0]));
  return {
    fakes,
    root,
    finalizeCalls: watched.finalizeCalls,
    async post(event) {
      const response = await root.linqWebhook(webhookRequest(await fakes.sign(event)));
      if (response.status !== 200) throw new Error(`the gateway answered ${String(response.status)}`);
      const traceId = response.headers.get("x-trace-id");
      if (traceId === null) throw new Error("the gateway answered with no trace id");
      return traceId;
    },
    spans,
    traceOf: (traceId) => spansOfTrace(spans(), traceId),
    restore() {
      watched.restore();
      restoreRoot();
    },
  };
}

/** The JOIN's turn, run on `run` to its reply: its turn id and trace id. */
async function runJoin(run: Rig): Promise<{ turnId: string; traceId: string }> {
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
  return { turnId, traceId };
}

/** The one span of a hop in a trace. */
function onlySpan(spans: readonly Span[], hop: Hop): Span {
  const found = spans.filter((span) => span.hop === hop);
  expect(found.map((span) => span.hop)).toEqual([hop]);
  const [span] = found;
  if (span === undefined) throw new Error(`no ${hop} span`);
  return span;
}

/** A finalize answer the turn got, as K-09's response, or the test fails naming what came instead. */
function responseOf(call: WatchedFinalizeCall | undefined): FinalizeMessageResponse {
  const answer = call?.answer;
  if (typeof answer !== "object" || answer === null || !("outcome" in answer)) {
    throw new Error(`finalize answered no response: ${JSON.stringify(answer ?? null)}`);
  }
  return answer as FinalizeMessageResponse;
}

/** One model call as the AI gateway reports it (K-08 v1 modelCall): labels and counts only. */
function oneCall(purpose: ModelCall["purpose"]): ModelCall {
  return {
    model: HAIKU_MODEL,
    role: "haiku",
    purpose,
    input_tokens: 40,
    cached_tokens: 1800,
    cache_write_tokens: 0,
    output_tokens: 60,
    cost_micro_usd: 300,
    ms: 5,
    outcome: "ok",
  };
}

/**
 * @rosie/ai's composer as a double that types a price (`plan`) for every row and again in its one rewrite, keeping what
 * each was asked: what @rosie/ai's own checks never let through (literalValue), so finalize's checks are what meet it.
 */
function typingComposer(plan: MessagePlan): {
  readonly composers: Composers;
  readonly composed: unknown[];
  readonly rewrites: unknown[];
} {
  const composed: unknown[] = [];
  const rewrites: unknown[] = [];
  const answer = (purpose: ModelCall["purpose"]) => ({
    status: "ok" as const,
    plan: structuredClone(plan) as never,
    model: HAIKU_MODEL,
    role: "haiku" as const,
    attempt: 1,
    fallback: false,
    modelCalls: [oneCall(purpose)],
  });
  const composer: Composer = {
    compose(input) {
      composed.push(structuredClone(input));
      return Promise.resolve(answer("compose"));
    },
    rewrite(request) {
      rewrites.push(structuredClone(request));
      return Promise.resolve(answer("rewrite"));
    },
  };
  return { composers: () => composer, composed, rewrites };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("hop 10 joined: finalize through @rosie/actions' turn face fills slots and fixed lines, runs the claim check and the message checks, and writes the final parts", () => {
  it(
    "the JOIN: hops 1 to 10 once each; finalize-pass.json's plan in, every message check passed (check-pass.json), and final parts holding S13-01's opener, the STOP, HELP and rates line and the privacy link alone on the last line, word for word as bundle v0 writes them, not finalize-pass.json's outcome; written into the row with the plan once, after the commit; one fillAndChecks span, the turn's; no span or log line holds a word, a number or the chat id",
    { timeout: TEST_MS },
    async () => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const { turnId, traceId } = await runJoin(run);
        const trace = run.traceOf(traceId);
        const row = `outbox-s1-02-${turnId}-1`;

        // Hops 1 to 10 once each, in turn order, under the trace id and one bundle id; the model calls set aside.
        const unwritten = NO_WRITER_YET.filter((hop) => !trace.some((span) => span.hop === hop));
        const report = checkHops(trace, {
          traceId,
          expected: HOPS_1_TO_10,
          notWritten: unwritten,
          extra: (span) => actorReceive(span) || modelCall(span) || !HOPS_1_TO_10.includes(span.hop),
        });
        expect(report.problems).toEqual([]);
        expect(report.judged).toEqual(expect.arrayContaining(["commit", "compose", "fillAndChecks"]));

        // The plan in: finalize-pass.json's (plan-s1-02.json, recording 4's answer) on the run's own row, attempt
        // composed, at the row's first version, under the turn's caller.
        const [call, ...again] = run.finalizeCalls;
        expect(again).toEqual([]);
        expect(call?.request).toMatchObject({
          caller: {
            kind: "turn",
            turnId,
            businessId: TEST_OWNER_1.businessId,
            personId: TEST_OWNER_1.personId,
            traceId,
          },
          outboxRowId: row,
          expectVersion: FINALIZE_PASS.request.expectVersion,
          attempt: "composed",
        });
        expect(call?.request.plan).toEqual({ ...FINALIZE_PASS.request.plan, row });
        expect(call?.request.plan.plan).toEqual(PLAN_S1_02);
        // The fake face keeps the request as the stand-in did (hop 9's and the e2e's row 9 read it there).
        expect(run.fakes.face.finalizeCalls).toEqual([call?.request]);

        // Finalize's answer: send at the first attempt, each of the seven message checks passed as check-pass.json lists
        // them, as finalize ran them; the final parts Q-30's, not finalize-pass.json's outcome (open gap 121).
        const answer = responseOf(call);
        const expectedParts: FinalParts = {
          row,
          channel: "imessage",
          sends: [
            firstTextSend(
              [...PLAN_S1_02.lines.map((line) => line.text), PLAN_S1_02.question.text].join("\n"),
            ),
          ],
          fixedLines: FIRST_TEXT_LINES,
          slotValues: [],
          threadReplyTo: null,
        };
        expect(answer).toMatchObject({ outcome: "send", questionWithdrawn: false, teamPageId: null });
        expect(
          answer.checks.map((result: CheckResult) => [result.row, result.attempt, result.outcome]),
        ).toEqual([[row, "composed", "send"]]);
        expect(answer.checks[0]?.checks).toEqual(ALL_PASSED);
        expect(answer.finalParts).toEqual(expectedParts);
        expect(answer).not.toEqual(FINALIZE_PASS.outcome);
        // The words: the opener first, the privacy link alone on the last line, the STOP, HELP and rates line above it.
        const lines = String((answer.finalParts?.sends[0] as Json | undefined)?.text).split("\n");
        expect(lines[0]?.startsWith(`${OPENER} `)).toBe(true);
        expect(lines.slice(-2)).toEqual([OPT_OUT_LINE, PRIVACY_LINK]);

        // Written into the row with the plan, once, through T-196's writePlan, after the commit: the row is checked at
        // its next version, holding exactly what finalize answered.
        const { finalize } = run.fakes;
        expect(finalize.writes).toEqual([
          { outboxRowId: row, expectVersion: 1, plan: call?.request.plan, finalParts: expectedParts },
        ]);
        expect(finalize.plans.get(row)).toEqual({
          plan: call?.request.plan,
          finalParts: expectedParts,
          version: 2,
        });
        expect(finalize.cancels).toEqual([]);
        expect(run.fakes.turnRows.commits).toHaveLength(1);
        // Read once each, under Lee's Barbershop's scope (the Tool API's own), the row and its fixed-line facts.
        expect(finalize.scopes).toEqual([TEST_OWNER_1.businessId]);
        expect(finalize.rowReads).toEqual([{ outboxRowId: row, businessId: TEST_OWNER_1.businessId }]);
        expect(finalize.factReads).toEqual([{ outboxRowId: row, businessId: TEST_OWNER_1.businessId }]);

        // One fillAndChecks span for the row, the turn's (the base records none: DL-376), after the commit and the
        // compose: sent at the first attempt, no check failed, the first text's fixed lines by id, the row written.
        const checks = onlySpan(trace, "fillAndChecks");
        expect(checks).toMatchObject({
          outcome: "ok",
          error_code: null,
          turn_id: turnId,
          bundle_id: BUNDLE_V0,
          business_id: TEST_OWNER_1.businessId,
          got: { row, attempt: "composed", calls: 1 },
          decided: {
            outcome: "send",
            failed: [],
            fallback: false,
            fallbackFailed: [],
            fixedLines: FIRST_TEXT_LINES,
            sends: 1,
            questionWithdrawn: false,
            teamPaged: false,
          },
          rows: [{ table: "outbox_rows", id: row }],
        });
        expect(Date.parse(checks.at)).toBeGreaterThanOrEqual(Date.parse(onlySpan(trace, "commit").at));
        expect(Date.parse(checks.at)).toBeGreaterThanOrEqual(Date.parse(onlySpan(trace, "compose").at));
        // No rewrite: no rewriteOrFallback span, and the composer was asked none.
        expect(trace.filter((span) => span.hop === "rewriteOrFallback")).toEqual([]);
        expect(run.fakes.composer.rewrites).toEqual([]);

        // Finalize's note: one JSON line of labels, on the turn's trace id.
        const notes = linesOf(info).filter((line) => line.includes("finalize_attempt"));
        expect(notes.map((line) => JSON.parse(line) as Json)).toEqual([
          {
            level: "info",
            msg: "finalize_attempt",
            trace_id: traceId,
            row,
            attempt: "composed",
            outcome: "send",
            missed: [],
          },
        ]);

        // No span or log line holds a word of the message (the plan's, the fixed lines', the JOIN), a number or the chat
        // id.
        const words = [
          "JOIN",
          ...PLAN_S1_02.lines.map((line) => line.text),
          PLAN_S1_02.question.text,
          OPENER,
          OPT_OUT_LINE,
          PRIVACY_LINK,
        ];
        expect(leaks(run.spans(), [SAM_CHAT, ...CAST_NUMBERS, ...words])).toEqual([]);
        expect(
          [...linesOf(log), ...linesOf(warn), ...linesOf(info)].filter((line) =>
            [SAM_CHAT, ...words.slice(1)].some((secret) => line.includes(secret)),
          ),
        ).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a plan with a typed price (check-raw-price.json): Values fails, the one rewrite is told so, the rewrite types it again, then the step's fallback is checked and sent with Q-30's lines; the trace shows each, the fillAndChecks span and the rewriteOrFallback span",
    { timeout: TEST_MS },
    async () => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const typing = typingComposer(TYPED_PRICE_PLAN);
      const run = rig(log, typing.composers);
      try {
        const { turnId, traceId } = await runJoin(run);
        const trace = run.traceOf(traceId);
        const row = `outbox-s1-02-${turnId}-1`;
        const plan = { row, channel: "imessage", copyOf: null, plan: TYPED_PRICE_PLAN };

        // Two finalize calls for the row: the composed plan, then the one rewrite.
        expect(run.finalizeCalls.map((each) => [each.request.attempt, each.request.plan])).toEqual([
          ["composed", plan],
          ["rewrite", plan],
        ]);
        const [composed, rewritten] = run.finalizeCalls.map(responseOf);

        // 1. The composed plan: Values fails on the typed price, nothing written, the one rewrite asked.
        expect(composed).toMatchObject({ outcome: "rewrite", finalParts: null, questionWithdrawn: false });
        const values = composed?.checks[0]?.checks.find((check) => check.check === "values");
        expect(values).toMatchObject({ passed: false });
        expect(values?.detail).toContain(`The price ${TYPED_PRICE} is not a code-supplied fact`);
        expect(
          composed?.checks[0]?.checks.filter((check) => !check.passed).map((check) => check.check),
        ).toEqual(["values"]);

        // 2. The one rewrite: told only that failed check and its detail, about the plan the composer gave.
        expect(typing.composed).toHaveLength(1);
        expect(typing.rewrites).toEqual([
          {
            input: typing.composed[0],
            plan: TYPED_PRICE_PLAN,
            attempt: "composed",
            told: [{ check: "values", detail: values?.detail }],
          },
        ]);

        // 3. The rewrite types the price again: Values fails once more, so the step's fallback text (S1-02's, as bundle v0
        // writes it) runs through the same checks, which all pass, and goes with Q-30's lines.
        const fallbackParts: FinalParts = {
          row,
          channel: "imessage",
          sends: [firstTextSend(bundleV0FallbackText("S1-02"))],
          fixedLines: FIRST_TEXT_LINES,
          slotValues: [],
          threadReplyTo: null,
        };
        expect(rewritten).toMatchObject({ outcome: "send", questionWithdrawn: false, teamPageId: null });
        expect(rewritten?.checks.map((result) => [result.attempt, result.outcome])).toEqual([
          ["rewrite", "fallback"],
          ["fallback", "send"],
        ]);
        expect(rewritten?.checks[0]?.checks.find((check) => check.check === "values")).toMatchObject({
          passed: false,
        });
        expect(rewritten?.checks[1]?.checks).toEqual(ALL_PASSED);
        expect(rewritten?.finalParts).toEqual(fallbackParts);

        // Written once, the fallback's final parts with the rewrite's plan, after the commit.
        expect(run.fakes.finalize.writes).toEqual([
          { outboxRowId: row, expectVersion: 1, plan, finalParts: fallbackParts },
        ]);

        // The trace shows each: the fillAndChecks span (the rewrite asked, Values failed, nothing written) and the
        // rewriteOrFallback span (told Values, the rewrite planned, then the fallback sent and the row written).
        const checks = onlySpan(trace, "fillAndChecks");
        expect(checks).toMatchObject({
          outcome: "refused",
          error_code: null,
          turn_id: turnId,
          bundle_id: BUNDLE_V0,
          got: { row, attempt: "composed", calls: 1 },
          decided: { outcome: "rewrite", failed: ["values"], fallback: false, fallbackFailed: [] },
          rows: [],
        });
        const rewrite = onlySpan(trace, "rewriteOrFallback");
        expect(rewrite).toMatchObject({
          outcome: "ok",
          error_code: null,
          turn_id: turnId,
          bundle_id: BUNDLE_V0,
          got: { row, attempt: "rewrite", told: ["values"], planned: true, calls: 1 },
          decided: {
            outcome: "send",
            failed: ["values"],
            fallback: true,
            fallbackFailed: [],
            fixedLines: FIRST_TEXT_LINES,
            sends: 1,
            questionWithdrawn: false,
            teamPaged: false,
          },
          rows: [{ table: "outbox_rows", id: row }],
        });
        expect(rewrite.model_calls?.map((each) => [each.model, each.purpose])).toEqual([
          [HAIKU_MODEL, "rewrite"],
        ]);
        expect(Date.parse(rewrite.at)).toBeGreaterThanOrEqual(Date.parse(checks.at));

        // No span holds the typed price, the plan's or the fallback's words, a number or the chat id.
        const words = [
          TYPED_SENTENCE,
          TYPED_PRICE,
          bundleV0FallbackText("S1-02"),
          OPT_OUT_LINE,
          PRIVACY_LINK,
        ];
        expect(leaks(run.spans(), [SAM_CHAT, ...CAST_NUMBERS, ...words])).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        run.restore();
      }
    },
  );
});
