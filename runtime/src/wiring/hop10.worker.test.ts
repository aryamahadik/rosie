// T-561's join, hop 10 of D-017 (C-046; build prompt section 10, D-017: "finalize"; 02-contracts section 11, 'Code fills
// slots and fixed lines; claim check and message checks': K-09 finalizeMessage, K-03 final parts; ADR-013 section 6;
// QUESTIONS Q-30's default), in the Workers runtime. The composition root is composed for the test environment as hop 9's
// tests compose it (the HandleActor namespace, the skeleton flag on, the actor's ports installed, every joined port fed its
// double), now with the port this hop joins: finalize, @rosie/actions' turn face's finalizeMessage (T-1141: the Tool API
// base with K-09's checks and the call's business scope; T-313's finalize with T-314's fixed-line inserter over T-1141's
// row binding), over K-05 doubles of readOutboxRow, readFixedLineFacts, writePlan and cancelClock over the rows the commit
// wrote and test owner 1's seeded rows (./test-support.ts fakeFinalizeData), with T-1146's privacyLink line. The turn's
// finalize calls are watched on their way to the root's own (watchGate).
//
// Test owner 1 holds no role (T-1148), so the JOIN's S1-02 row is read by S1-02's sign-up line as the owner, on a step that
// does not need business: its first text opens with signUpOpener, S1-02's own words, never with the business opener (K-01
// README default 19; T-1511; DL-1033 fault 1). Bundle v0 has no such line, so finalize would refuse the text there (fail
// closed); the turn pins bundle v2 as bundles/v2 publishes it (T-1477), which carries the line and holds S1-01 and S1-02
// byte for byte as bundle v0 does (T-1512: the fakes hold bundle v2 active).
//
//   - The JOIN as recording 2 names it (evt-sam-0000, test owner 1, Sam's chat): hops 1 to 10 once each. The turn hands
//     finalize K-09 v1 finalize-pass.json's plan in (plan-s1-02.json, recording 4's answer) on the run's own row. Finalize
//     answers send at the first attempt, its seven message checks all passed as K-03 check-pass.json lists them, and its
//     final parts are not finalize-pass.json's outcome (K-09 v1.5 open gap 121) but Q-30's: signUpOpener first, then the
//     plan's words, the STOP, HELP and rates line, and the privacy link alone on the last line, each fixed line word for
//     word as bundle v2 writes it, and no business named. The plan and those final parts are written into the row
//     together, once, after the commit (T-196's writePlan); finalize read the row and its fixed-line facts once each,
//     under Lee's Barbershop's scope; the turn records the row's one fillAndChecks span and no rewriteOrFallback span, and
//     the Tool API base records none (DL-376). No span or log line holds a word of the message, a number or the chat id.
//   - A plan with a typed price (K-03 check-raw-price.json's): finalize's Values check fails it, so the row gets its one
//     rewrite, told that check and its detail; the rewrite types the price again, so finalize runs the step's fallback
//     text (S1-02's, as bundle v2 writes it) through the same checks, which pass, and the fallback's final parts are
//     written with the rewrite's plan. S1-02's fallback text already begins with signUpOpener's exact words, so finalize
//     records the line's id and adds its words no second time (default 19, no doubles). The trace shows each: the
//     fillAndChecks span (the rewrite asked, Values failed) and the rewriteOrFallback span (told Values, the rewrite
//     planned, the fallback sent). @rosie/ai's composer refuses a typed price itself before finalize could see one
//     (ai/src/composer/check.ts literalValue, for a plan and for a plan to fix), so a composer double that types it stands
//     in for the AI layer here: finalize's Values check is the backstop shown.
//   - T-1514 (DL-1033 fault 2; K-05 v1.21 defaults 200 to 204): finalize's K-05 doubles by direct call, as T-1513's
//     db/repo writes and reads K-04's opener mark. writePlan writes the mark once, for the first row planned to carry an
//     opener, either id, with a business; the facts read it, past a mark whose row ended withdrawn, failed,
//     dropped_stopped or superseded, to the earliest earlier row that carries an opener and did not end so, with a
//     business and with none; and the STOP, HELP and rates line's time is the phone row's as the dispatch double holds it.
//
// Each test runs the JOIN on a fresh rig, and the Durable Objects' storage is reset after each (as hop 8's tests run it).
// Test values only (rule 9): the master's sample cast, the fictional 555-01xx numbers and the fixtures' own words.
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import type { Composer } from "@rosie/ai/src/composer/types";
import { HAIKU_MODEL } from "@rosie/ai/src/gateway/index";
import commitS101Sam from "@rosie/contracts/data-access/fixtures/commit-s1-01-sam.json";
import traceSkeleton from "@rosie/contracts/event-trace/fixtures/trace-skeleton.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import checkPass from "@rosie/contracts/message-plan/fixtures/check-pass.json";
import checkRawPrice from "@rosie/contracts/message-plan/fixtures/check-raw-price.json";
import planS102 from "@rosie/contracts/message-plan/fixtures/plan-s1-02.json";
import finalizePass from "@rosie/contracts/tool-api/fixtures/finalize-pass.json";
import type { CommitTurnRequest } from "@rosie/db/repo/commit-turn";
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
  BUNDLE_V2,
  bundleV2FallbackText,
  bundleV2FixedLine,
  fakeFlags,
  SAM_CHAT,
  samPhoneRow,
  skeletonFakes,
  TEST_OWNER_1,
  TEST_OWNER_1_BUSINESS_NAME,
  testClock,
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

/** Bundle v2's sign-up opener, S1-02's own first words (K-01 README default 19): it names no business. */
const OPENER = bundleV2FixedLine("signUpOpener");
/** The business opener's words before its <business> (S13-01, bundle v2's `opener`): what Sam's sign-up text never says. */
const BUSINESS_OPENER = bundleV2FixedLine("opener").replace(" <business>.", "");
/** Q-30's lines as bundle v2 writes them: the STOP, HELP and rates line, then the privacy link. */
const OPT_OUT_LINE = bundleV2FixedLine("optOutLine");
const PRIVACY_LINK = bundleV2FixedLine("privacyLink");
/** The fixed lines of Rosie's first sign-up text to the owner, in the order finalize adds them (default 19). */
const FIRST_TEXT_LINES = ["signUpOpener", "optOutLine", "privacyLink"];

/** The one words send of Rosie's first text: `first` as its first line's words, then Q-30's lines, the link alone last. */
function sendOf(first: string): Json {
  return {
    kind: "words",
    text: [first, OPT_OUT_LINE, PRIVACY_LINK].join("\n"),
    calendarFile: "none",
    options: [],
    link: null,
  };
}

/** The one words send of Rosie's first text: the opener before `words`, then Q-30's lines, the privacy link alone last. */
function firstTextSend(words: string): Json {
  return sendOf(`${OPENER} ${words}`);
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
    // The chat-open port (T-1213) over the dispatch double: each text opens its number's chat before the actor.
    chatOpenCall: fakes.dispatch.openChat,
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

/**
 * The root for "test" with the HandleActor namespace, its actor ports installed and the turn's finalize calls watched;
 * bundle v2 active, so the JOIN's turn pins it (T-1512).
 */
function rig(log: MockInstance, composers?: Composers): Rig {
  const fakes = skeletonFakes(testClock(), { bundle: BUNDLE_V2 });
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
    "the JOIN under bundle v2: hops 1 to 10 once each; finalize-pass.json's plan in, every message check passed (check-pass.json), and final parts holding signUpOpener, the STOP, HELP and rates line and the privacy link alone on the last line, word for word as bundle v2 writes them, with no business named, not finalize-pass.json's outcome; written into the row with the plan once, after the commit; one fillAndChecks span, the turn's; no span or log line holds a word, a number or the chat id",
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
        // The words: S1-02's own opener first, the privacy link alone on the last line, the STOP, HELP and rates line
        // above it; neither the business opener's words nor the business's name anywhere (default 19).
        const text = String((answer.finalParts?.sends[0] as Json | undefined)?.text);
        const lines = text.split("\n");
        expect(lines[0]?.startsWith(`${OPENER} `)).toBe(true);
        expect(lines.slice(-2)).toEqual([OPT_OUT_LINE, PRIVACY_LINK]);
        expect(text).not.toContain(BUSINESS_OPENER);
        expect(text).not.toContain(TEST_OWNER_1_BUSINESS_NAME);

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
          bundle_id: BUNDLE_V2,
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
    "a plan with a typed price (check-raw-price.json): Values fails, the one rewrite is told so, the rewrite types it again, then the step's fallback is checked and sent with Q-30's lines, its own first words standing for signUpOpener (no doubles); the trace shows each, the fillAndChecks span and the rewriteOrFallback span",
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

        // 3. The rewrite types the price again: Values fails once more, so the step's fallback text (S1-02's, as bundle v2
        // writes it) runs through the same checks, which all pass, and goes with Q-30's lines. It already begins with
        // signUpOpener's exact words, so finalize records the line's id and adds the words no second time (default 19).
        const fallback = bundleV2FallbackText("S1-02");
        expect(fallback.startsWith(`${OPENER} `)).toBe(true);
        const fallbackParts: FinalParts = {
          row,
          channel: "imessage",
          sends: [sendOf(fallback)],
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
        const sent = String((rewritten?.finalParts?.sends[0] as Json | undefined)?.text);
        expect(sent.split(OPENER)).toHaveLength(2);

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
          bundle_id: BUNDLE_V2,
          got: { row, attempt: "composed", calls: 1 },
          decided: { outcome: "rewrite", failed: ["values"], fallback: false, fallbackFailed: [] },
          rows: [],
        });
        const rewrite = onlySpan(trace, "rewriteOrFallback");
        expect(rewrite).toMatchObject({
          outcome: "ok",
          error_code: null,
          turn_id: turnId,
          bundle_id: BUNDLE_V2,
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
        const words = [TYPED_SENTENCE, TYPED_PRICE, fallback, OPENER, OPT_OUT_LINE, PRIVACY_LINK];
        expect(leaks(run.spans(), [SAM_CHAT, ...CAST_NUMBERS, ...words])).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        run.restore();
      }
    },
  );
});

// ---- T-1514: finalize's K-05 doubles keep K-04's opener mark as db/repo does (K-05 v1.21 defaults 200 to 204) ----------

/** K-07's four ends of a row that did not go, or never will (K-05 v1.21 default 202). */
const NEVER_WENT = ["withdrawn", "failed", "dropped_stopped", "superseded"] as const;
/** K-07's other row states: a row in any of them went, or may yet (open gap 100), so it counts. */
const MAY_YET_GO = [
  "planned",
  "checked",
  "sending",
  "sent",
  "delivered",
  "held",
  "stale",
  "waiting_chat",
] as const;
/** A first text's fixed lines opening with the business opener (S13-01), the other opener id. */
const BUSINESS_FIRST_TEXT_LINES = ["opener", "optOutLine", "privacyLink"];

/**
 * K-05 commit-s1-01-sam.json's request committed on the K-05 double under ids of this test's own: one S1-02 row to test
 * owner 1, at `businessId` or, with null, at no business. Each commit is the next in commit order. Answers the row's id.
 */
async function commitOwnRow(fakes: SkeletonFakes, name: string, businessId: string | null): Promise<string> {
  const request = structuredClone(commitS101Sam.request) as unknown as CommitTurnRequest;
  const [first] = request.writes.outboxRows;
  if (first === undefined) throw new Error("commit-s1-01-sam.json writes an outbox row");
  expect(first.recipientHandleId).toBe(TEST_OWNER_1.handleId);
  const row = `outbox-t1514-${name}`;
  const committed = await fakes.turnRows.calls.commitTurn({
    ...request,
    turn: { ...request.turn, id: `turn-t1514-${name}`, eventIds: [`evt-t1514-${name}`] },
    writes: { ...request.writes, outboxRows: [{ ...first, id: row, businessId }] },
  });
  if (!("result" in committed) || committed.repeated) throw new Error("the commit was not taken");
  return row;
}

/**
 * K-05 writePlan on the finalize double for `row`: finalize-pass.json's plan and final parts of one words send that carry
 * `fixedLines`, at `expectVersion` (a row's first by default) on `channel` (the row's by default).
 */
function planOwnRow(
  fakes: SkeletonFakes,
  row: string,
  fixedLines: readonly string[],
  expectVersion = 1,
  channel = "imessage",
): Promise<unknown> {
  return fakes.finalize.data.writePlan({
    outboxRowId: row,
    expectVersion,
    plan: { ...FINALIZE_PASS.request.plan, row, channel },
    finalParts: {
      row,
      channel,
      sends: [sendOf(PLAN_S1_02.question.text)],
      fixedLines,
      slotValues: [],
      threadReplyTo: null,
    },
  } as never);
}

/** K-05 v1.3 readFixedLineFacts' answer (item 36), whole: the Tool API's port type names only the two facts it reads. */
interface FactsAnswer {
  readonly result: "fixedLineFacts";
  readonly outboxRowId: string;
  readonly businessId: string | null;
  readonly recipientHandleId: string;
  readonly readAt: string;
  readonly textedAboutBusiness: boolean;
  readonly openerRowId: string | null;
  readonly optOutLineDeliveredAt: string | null;
}

/**
 * K-05 readFixedLineFacts on the finalize double for `row` under `businessId` (null: K-05's runtime-side read, with no
 * business, which the Tool API's port type never names): its answer, or its error.
 */
function readFacts(fakes: SkeletonFakes, row: string, businessId: string | null): Promise<unknown> {
  return fakes.finalize.data.readFixedLineFacts({ outboxRowId: row, businessId } as never);
}

/**
 * The three facts of `row` under `businessId` as [textedAboutBusiness, openerRowId, optOutLineDeliveredAt], the rest of
 * the answer checked here.
 */
async function factsOf(
  fakes: SkeletonFakes,
  row: string,
  businessId: string | null,
): Promise<[boolean, string | null, string | null]> {
  const facts = (await readFacts(fakes, row, businessId)) as FactsAnswer;
  expect(Object.keys(facts).sort()).toEqual([
    "businessId",
    "openerRowId",
    "optOutLineDeliveredAt",
    "outboxRowId",
    "readAt",
    "recipientHandleId",
    "result",
    "textedAboutBusiness",
  ]);
  expect(facts).toMatchObject({
    result: "fixedLineFacts",
    outboxRowId: row,
    businessId,
    recipientHandleId: TEST_OWNER_1.handleId,
  });
  return [facts.textedAboutBusiness, facts.openerRowId, facts.optOutLineDeliveredAt];
}

/**
 * The rows a test ends in a K-07 state of its own, by row id, read by the finalize double over the dispatch double's
 * (which no call of its own moves to failed or superseded): every other row and each phone row as the dispatch double
 * holds them.
 */
function endedRows(fakes: SkeletonFakes): Map<string, string> {
  const ended = new Map<string, string>();
  fakes.finalize.dispatched = {
    row: (id) => {
      const state = ended.get(id);
      return state === undefined ? fakes.dispatch.row(id) : { state };
    },
    phones: fakes.dispatch.phones,
  };
  return ended;
}

describe("T-1514: finalize's K-05 doubles write the opener mark at writePlan and read it with db/repo's fallback (K-05 v1.21 defaults 200 to 204)", () => {
  it("writePlan writes the mark once, for the first row planned to carry an opener, either id, at its turn's commit time: a row with no opener, a versionChanged and a refused write write none; a later row and a repeat never move it; the facts answer the mark's row, which for that row itself means the first text", async () => {
    const fakes = skeletonFakes(testClock(), { bundle: BUNDLE_V2 });
    const { finalize, turnRows } = fakes;
    const business = TEST_OWNER_1.businessId;
    const a = await commitOwnRow(fakes, "a", business);
    const b = await commitOwnRow(fakes, "b", business);
    const c = await commitOwnRow(fakes, "c", business);
    const d = await commitOwnRow(fakes, "d", business);
    expect(await factsOf(fakes, a, business)).toEqual([false, null, null]);

    // No mark: a row whose final parts carry no opener, a write whose version moved, and a write K-05 refuses.
    expect(await planOwnRow(fakes, a, ["optOutLine"])).toEqual({
      result: "written",
      outboxRowId: a,
      version: 2,
    });
    expect(await planOwnRow(fakes, d, FIRST_TEXT_LINES, 7)).toMatchObject({ error: "versionChanged" });
    await expect(planOwnRow(fakes, d, FIRST_TEXT_LINES, 1, "sms")).rejects.toThrow("another channel");
    expect(finalize.openersSent).toEqual([]);
    expect(await factsOf(fakes, b, business)).toEqual([false, null, null]);

    // The first row planned to carry an opener (signUpOpener) writes the mark, at its own turn's commit time.
    expect(await planOwnRow(fakes, b, FIRST_TEXT_LINES)).toEqual({
      result: "written",
      outboxRowId: b,
      version: 2,
    });
    const sentAt = turnRows.turns.get("turn-t1514-b")?.at;
    expect(sentAt).toEqual(expect.any(String));
    const mark = { handleId: TEST_OWNER_1.handleId, businessId: business, sentAt, outboxRowId: b };
    expect(finalize.openersSent).toEqual([mark]);
    // The mark names this row: it is the first text, and carries the opener whenever it is finalized (default 50).
    expect(await factsOf(fakes, b, business)).toEqual([false, b, null]);
    // Any other row to the handle at the business reads "texted before", naming the mark's row, as db/repo answers
    // while that row stands in a state that went or may yet go (whatever the two rows' commit order).
    expect(await factsOf(fakes, c, business)).toEqual([true, b, null]);
    expect(await factsOf(fakes, a, business)).toEqual([true, b, null]);

    // A later row carrying the other opener id never moves the mark, and a repeat (alreadyPlanned) writes nothing.
    expect(await planOwnRow(fakes, c, BUSINESS_FIRST_TEXT_LINES)).toEqual({
      result: "written",
      outboxRowId: c,
      version: 2,
    });
    expect(await planOwnRow(fakes, b, FIRST_TEXT_LINES)).toEqual({
      error: "alreadyPlanned",
      outboxRowId: b,
      version: 2,
    });
    expect(finalize.openersSent).toEqual([mark]);
    expect(await factsOf(fakes, d, business)).toEqual([true, b, null]);
    // Under another business the row is not there, as before.
    expect(await readFacts(fakes, d, "biz-other")).toEqual({
      error: "notFound",
      table: "outbox_rows",
      rowId: d,
    });
  });

  it.each(NEVER_WENT)(
    "with a business, a mark naming a row that ended %s is read past, to the earliest earlier row (a lower commit order) that carries an opener, either id, and did not end that way; the mark itself is never moved",
    async (state) => {
      const fakes = skeletonFakes(testClock(), { bundle: BUNDLE_V2 });
      const ended = endedRows(fakes);
      const business = TEST_OWNER_1.businessId;
      const a = await commitOwnRow(fakes, "a", business);
      const b = await commitOwnRow(fakes, "b", business);
      const c = await commitOwnRow(fakes, "c", business);
      const d = await commitOwnRow(fakes, "d", business);
      await planOwnRow(fakes, a, FIRST_TEXT_LINES);
      const marks = structuredClone(fakes.finalize.openersSent);
      expect(marks.map((mark) => mark.outboxRowId)).toEqual([a]);
      expect(await factsOf(fakes, b, business)).toEqual([true, a, null]);

      // The marked row never went: the next row reads "not texted", with no earlier row to fall back to, so it
      // carries the opener; the marked row's own read still names itself.
      ended.set(a, state);
      expect(await factsOf(fakes, b, business)).toEqual([false, null, null]);
      expect(await factsOf(fakes, a, business)).toEqual([false, a, null]);
      // A row committed after b that carries an opener is no fallback for b: only a lower commit order counts.
      await planOwnRow(fakes, c, BUSINESS_FIRST_TEXT_LINES);
      expect(await factsOf(fakes, b, business)).toEqual([false, null, null]);
      expect(await factsOf(fakes, d, business)).toEqual([true, c, null]);
      // b carries the opener too (signUpOpener): the fallback names the earliest of the two.
      await planOwnRow(fakes, b, FIRST_TEXT_LINES);
      expect(await factsOf(fakes, d, business)).toEqual([true, b, null]);
      expect(await factsOf(fakes, c, business)).toEqual([true, b, null]);
      // The state filter holds in the fallback too: each earlier row that ended this way is read past in its turn.
      ended.set(b, state);
      expect(await factsOf(fakes, d, business)).toEqual([true, c, null]);
      ended.set(c, state);
      expect(await factsOf(fakes, d, business)).toEqual([false, null, null]);
      // Written once: the mark still names the first row.
      expect(fakes.finalize.openersSent).toEqual(marks);
    },
  );

  it("with a business, a mark naming a row in any other K-07 state counts: Rosie has texted the handle about the business", async () => {
    const fakes = skeletonFakes(testClock(), { bundle: BUNDLE_V2 });
    const ended = endedRows(fakes);
    const business = TEST_OWNER_1.businessId;
    const a = await commitOwnRow(fakes, "a", business);
    const b = await commitOwnRow(fakes, "b", business);
    await planOwnRow(fakes, a, FIRST_TEXT_LINES);
    for (const state of MAY_YET_GO) {
      ended.set(a, state);
      expect([state, ...(await factsOf(fakes, b, business))]).toEqual([state, true, a, null]);
    }
  });

  it("the row states are the dispatch double's own: a marked row the dispatcher withdrew (limit 8), and then one it dropped for STOP, are each read past", async () => {
    const fakes = skeletonFakes(testClock(), { bundle: BUNDLE_V2 });
    const { dispatch } = fakes;
    const business = TEST_OWNER_1.businessId;
    const a = await commitOwnRow(fakes, "a", business);
    const b = await commitOwnRow(fakes, "b", business);
    const c = await commitOwnRow(fakes, "c", business);
    const endAs = async (row: string, outcome: "withdrawn" | "droppedStopped", at: string): Promise<void> => {
      const claimed = await dispatch.outbox.claimOutboxV12({
        claimer: "t1514-dispatcher",
        recipientHandleId: TEST_OWNER_1.handleId,
        now: at,
        limit: 1,
      });
      if (!("result" in claimed)) throw new Error("the claim was not answered");
      expect(claimed.claimed.map((each) => each.outboxRowId)).toEqual([row]);
      const version = claimed.claimed[0]?.version ?? 0;
      expect(
        await dispatch.outbox.markRowV12({ outboxRowId: row, expectVersion: version, outcome, at } as never),
      ).toMatchObject({ result: "marked", outcome });
    };

    await planOwnRow(fakes, a, FIRST_TEXT_LINES);
    expect(await factsOf(fakes, b, business)).toEqual([true, a, null]);
    await endAs(a, "withdrawn", "2026-10-19T14:02:00Z");
    expect(dispatch.row(a)).toMatchObject({ state: "withdrawn" });
    expect(await factsOf(fakes, b, business)).toEqual([false, null, null]);

    await planOwnRow(fakes, b, FIRST_TEXT_LINES);
    expect(await factsOf(fakes, c, business)).toEqual([true, b, null]);
    await endAs(b, "droppedStopped", "2026-10-19T14:03:00Z");
    expect(dispatch.row(b)).toMatchObject({ state: "dropped_stopped" });
    expect(await factsOf(fakes, c, business)).toEqual([false, null, null]);
    expect(fakes.finalize.openersSent.map((mark) => mark.outboxRowId)).toEqual([a]);
  });

  it("with no business there is no mark: the facts name the earliest earlier row to the handle with none that carries an opener, either id, and ended in none of the four states; rows with a business and rows with none never read each other", async () => {
    const fakes = skeletonFakes(testClock(), { bundle: BUNDLE_V2 });
    const ended = endedRows(fakes);
    const business = TEST_OWNER_1.businessId;
    const n1 = await commitOwnRow(fakes, "n1", null);
    const x = await commitOwnRow(fakes, "x", business);
    const n2 = await commitOwnRow(fakes, "n2", null);
    const n3 = await commitOwnRow(fakes, "n3", null);

    // A row with no business writes no mark, whichever opener it carries.
    await planOwnRow(fakes, n1, FIRST_TEXT_LINES);
    expect(fakes.finalize.openersSent).toEqual([]);
    // Only an earlier row counts: the row itself reads "not texted", the next one names it.
    expect(await factsOf(fakes, n1, null)).toEqual([false, null, null]);
    expect(await factsOf(fakes, n2, null)).toEqual([true, n1, null]);
    // A row at a business does not read the rows with none, and the other way round.
    expect(await factsOf(fakes, x, business)).toEqual([false, null, null]);
    await planOwnRow(fakes, x, BUSINESS_FIRST_TEXT_LINES);
    expect(fakes.finalize.openersSent.map((mark) => mark.outboxRowId)).toEqual([x]);
    ended.set(n1, "withdrawn");
    expect(await factsOf(fakes, n2, null)).toEqual([false, null, null]);
    ended.delete(n1);

    // The state filter, each of the four ends: the earlier row is read past, and counts again in any other state.
    for (const state of NEVER_WENT) {
      ended.set(n1, state);
      expect([state, ...(await factsOf(fakes, n2, null))]).toEqual([state, false, null, null]);
    }
    for (const state of MAY_YET_GO) {
      ended.set(n1, state);
      expect([state, ...(await factsOf(fakes, n2, null))]).toEqual([state, true, n1, null]);
    }
    // n1 ended without going, so n2 carries the opener (the other id); n3 names n2, the earliest earlier row that went.
    ended.set(n1, "superseded");
    await planOwnRow(fakes, n2, BUSINESS_FIRST_TEXT_LINES);
    expect(await factsOf(fakes, n3, null)).toEqual([true, n2, null]);
    ended.delete(n1);
    expect(await factsOf(fakes, n3, null)).toEqual([true, n1, null]);
    // Under a business a row with none is not there, and with none a row at a business is not there.
    expect(await readFacts(fakes, n3, business)).toEqual({
      error: "notFound",
      table: "outbox_rows",
      rowId: n3,
    });
    expect(await readFacts(fakes, x, null)).toEqual({ error: "notFound", table: "outbox_rows", rowId: x });
  });

  it("the STOP, HELP and rates line's time is the handle's phone row's, as the dispatch double holds it: null with no phone row, null while the line was never delivered, then the time a delivery set; with no dispatcher joined, null, each row as finalize left it", async () => {
    const fakes = skeletonFakes(testClock(), { bundle: BUNDLE_V2 });
    const { dispatch, finalize } = fakes;
    const business = TEST_OWNER_1.businessId;
    const a = await commitOwnRow(fakes, "a", business);
    const b = await commitOwnRow(fakes, "b", business);
    expect(dispatch.phones.size).toBe(0);
    expect(await factsOf(fakes, a, business)).toEqual([false, null, null]);

    const phone = { ...samPhoneRow(), optoutLineDeliveredAt: null };
    dispatch.phones.set(TEST_OWNER_1.handleId, phone);
    expect(await factsOf(fakes, a, business)).toEqual([false, null, null]);
    const deliveredAt = "2026-10-19T14:02:11Z";
    dispatch.phones.set(TEST_OWNER_1.handleId, { ...phone, optoutLineDeliveredAt: deliveredAt, version: 3 });
    expect(await factsOf(fakes, a, business)).toEqual([false, null, deliveredAt]);

    // No dispatcher joined (as ./finalize.test.ts builds the double alone): no phone row is read, and a planned row
    // stands checked, so its mark counts.
    await planOwnRow(fakes, a, FIRST_TEXT_LINES);
    finalize.dispatched = null;
    expect(await factsOf(fakes, a, business)).toEqual([false, a, null]);
    expect(await factsOf(fakes, b, business)).toEqual([true, a, null]);
  });
});
