// Tests of the composer's one rewrite (T-374, C-118). Offline, as every AI test (J-02: no live call; CI makes none). K-03's
// check results come through the message-plan contract loader (T-1071, the composer's side of T-004's fixture loader),
// and what the rewrite is told is what the action layer's own rewriteTold (actions/src/finalize/rewrite/told.ts, T-313)
// gives for them, so the composer takes exactly that shape. Each model answer is sent back through the AI gateway
// (T-361) by T-364's fake Messages API with its prompt cache: the recorded-model double's plan where it holds one (A6-14's
// confirmation), else a K-03 plan written in test-support.ts (the double holds no rewrite). The global fetch fails the
// file if anything reaches it. Names and values are the master's sample cast (rule 9).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { rewriteTold } from "../../../../actions/src/finalize/rewrite/told";
import type { CheckResult } from "../../../../actions/src/finalize/rewrite/types";
import { fakeTokens } from "../../cache/test-support";
import { unescapeData } from "../../context";
import { HAIKU_MODEL, SONNET_MODEL, STAGE_OF, STAGE_TIMEOUT_MS } from "../../gateway";
import {
  loadPlanContract,
  loadRecordedDouble,
  type JsonObject,
  type PlanContract,
  type RecordedDouble,
} from "../../recorded-double";
import { openTrace, spanProblems, type Span } from "../../../../runtime/src/trace";
import { schemaErrors } from "../../../../runtime/src/trace/test-support";
import {
  COMPOSER_PROMPT,
  PLAN_SCHEMA,
  composeInputText,
  type ComposeAnswer,
  type MessagePlan,
} from "../index";
import { planText } from "../prompt";
import { GATEWAY_BUNDLE, KEY, composerOn, recordedInput } from "../test-support";
import { REWRITE_TASK, type RewriteAnswer, type RewriteRequest } from "./index";
import {
  A7_17_INPUT,
  ONE_QUESTION_PLAN,
  TWO_QUESTIONS_PLAN,
  TYPED_TIME_PLAN,
  fakeTurnApi,
  hangingApi,
  userOf,
} from "./test-support";

const globalFetch = vi.fn(() => {
  throw new Error("no network in a rewrite test: the global fetch was called");
});

let contract: PlanContract;
let double: RecordedDouble;

beforeAll(async () => {
  vi.stubGlobal("fetch", globalFetch);
  contract = loadPlanContract();
  double = await loadRecordedDouble();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/** A K-03 v1 check result fixture, read through the contract loader and accepted as a checkResult. */
function checkResult(file: string): CheckResult {
  const result = contract.fixtures.read(file);
  expect(contract.validate("checkResult", result), file).toEqual([]);
  return result as CheckResult;
}
const newTrace = (): ReturnType<typeof openTrace> =>
  openTrace({ openedBy: "textWebhook", bundleId: GATEWAY_BUNDLE.bundleId, handleRef: "handle-alex" });
const callsOf = (spans: readonly Span[]): NonNullable<Span["model_calls"]> =>
  spans.flatMap((span) => span.model_calls ?? []);
/** A rewrite's per-turn part, as opposed to compose's: it tells what failed. */
const isRewriteTurn = (turn: string): boolean => turn.includes("<failed_checks>");

function planOf(answer: ComposeAnswer | RewriteAnswer): MessagePlan {
  if (answer.status !== "ok") throw new Error(`expected a plan, got ${answer.status}`);
  return answer.plan;
}

/** Each <failed_check> of a per-turn part: its name and its detail, unescaped. */
const failedChecksIn = (turn: string): [string, string][] =>
  [...turn.matchAll(/<failed_check name="([^"]*)">([^<]*)<\/failed_check>/gu)].map((match) => [
    match[1] ?? "",
    unescapeData(match[2] ?? ""),
  ]);

describe("one rewrite, told exactly what failed, then 'use the fallback' (arch 02 line 123; arch 07 line 417)", () => {
  it("check-two-questions.json gives one rewrite whose prompt names the failed check; check-fallback.json, a second failed check, gives 'use the fallback' and no third model call", async () => {
    const twoQuestions = checkResult("check-two-questions.json");
    const fallback = checkResult("check-fallback.json");
    // One row: its composed plan missed One question; its one rewrite then missed Values.
    expect([twoQuestions.attempt, twoQuestions.outcome]).toEqual(["composed", "rewrite"]);
    expect([fallback.attempt, fallback.outcome]).toEqual(["rewrite", "fallback"]);
    expect(fallback.row).toBe(twoQuestions.row);
    expect(A7_17_INPUT.row).toBe(twoQuestions.row);

    // The fake model answers compose with the plan check-two-questions.json checked, and any rewrite with one question:
    // a third call would be answered too, so none is made only because the composer makes none.
    const api = fakeTurnApi((turn) => (isRewriteTurn(turn) ? ONE_QUESTION_PLAN : TWO_QUESTIONS_PLAN));
    const composer = composerOn(api.fetch);
    const trace = newTrace();

    // 1. The composed plan, which finalize checks.
    const composed = planOf(await composer.compose(A7_17_INPUT, { trace }));
    expect(composed).toEqual(TWO_QUESTIONS_PLAN);
    expect(api.calls).toHaveLength(1);

    // 2. finalize answered check-two-questions.json: the rewrite is told what rewriteTold gives for it, and only that.
    const told = rewriteTold(twoQuestions);
    expect(told).toEqual([
      { check: "oneQuestion", detail: "The text asks two questions; ask at most one question per text." },
    ]);
    const rewritten = await composer.rewrite(
      { input: A7_17_INPUT, plan: composed, attempt: "composed", told },
      { trace },
    );
    expect(rewritten).toMatchObject({
      status: "ok",
      model: HAIKU_MODEL,
      role: "haiku",
      attempt: 1,
      fallback: false,
    });
    expect(planOf(rewritten)).toEqual(ONE_QUESTION_PLAN);
    expect(api.calls).toHaveLength(2);

    const [composeCall, rewriteCall] = api.calls;
    expect(rewriteCall?.model).toBe(HAIKU_MODEL);
    // The composer's own system prompt, byte for byte what compose sent, with its one cache marker; K-03's plan schema.
    expect(rewriteCall?.body.system).toEqual([
      { type: "text", text: COMPOSER_PROMPT.text, cache_control: { type: "ephemeral" } },
    ]);
    expect(rewriteCall?.body.system).toEqual(composeCall?.body.system);
    expect(rewriteCall?.body.output_config).toEqual({
      effort: "low",
      format: { type: "json_schema", schema: PLAN_SCHEMA },
    });
    // The per-turn part: the row's input as compose sent it, the plan to fix as data, what failed, then the task.
    const turn = userOf(rewriteCall);
    expect(
      turn.startsWith(`${composeInputText(A7_17_INPUT)}\n<plan_to_fix>${planText(composed)}</plan_to_fix>\n`),
    ).toBe(true);
    expect(turn).toContain(
      '<failed_checks>\n<failed_check name="One question">The text asks two questions; ask at most one question per text.</failed_check>\n</failed_checks>',
    );
    expect(failedChecksIn(turn)).toEqual([
      ["One question", "The text asks two questions; ask at most one question per text."],
    ]);
    expect(turn.endsWith(`</failed_checks>\n\n${REWRITE_TASK}`)).toBe(true);
    // Never the final parts finalize checked: not their words, not a check that passed.
    for (const send of twoQuestions.checked.sends)
      if (send.text !== null) expect(turn).not.toContain(send.text);
    for (const name of [
      "Fixed lines",
      "Values",
      "Never in a message",
      "Shape",
      "Length and reading",
      "Format",
    ])
      expect(turn).not.toContain(`name="${name}"`);

    // 3. finalize answered check-fallback.json for the rewrite: the second failure. 'use the fallback', and no call.
    const secondTold = rewriteTold(fallback);
    expect(secondTold.map((each) => each.check)).toEqual(["values"]);
    const second = await composer.rewrite(
      { input: A7_17_INPUT, plan: planOf(rewritten), attempt: "rewrite", told: secondTold },
      { trace },
    );
    expect(second).toEqual({ status: "useFallback", why: "rewriteFailed", problems: [], modelCalls: [] });
    expect(api.calls).toHaveLength(2);

    // Two model calls for the row in all, compose and the one rewrite, each in a span valid under K-08.
    expect(callsOf(trace.spans).map((call) => [call.purpose, call.model])).toEqual([
      ["compose", HAIKU_MODEL],
      ["rewrite", HAIKU_MODEL],
    ]);
    for (const span of trace.spans) {
      expect(spanProblems(span)).toEqual([]);
      expect(schemaErrors("span", span)).toEqual([]);
    }
  });

  it("the rewrite's timeout is the composer's 6 s: each attempt times out at exactly 6,000 ms and not before; Haiku twice, Sonnet once, then modelsDown", async () => {
    expect(STAGE_OF.rewrite).toBe("composer");
    expect(STAGE_OF.rewrite).toBe(STAGE_OF.compose);
    expect(STAGE_TIMEOUT_MS[STAGE_OF.rewrite]).toBe(6000);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T18:00:00Z"));
    const api = hangingApi();
    const trace = newTrace();
    const told = rewriteTold(checkResult("check-two-questions.json"));
    const pending = composerOn(api.fetch).rewrite(
      { input: A7_17_INPUT, plan: TWO_QUESTIONS_PLAN, attempt: "composed", told },
      { trace },
    );
    await vi.advanceTimersByTimeAsync(5999);
    expect(api.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5999);
    expect(api.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(6000);

    const answer = await pending;
    if (answer.status !== "modelsDown") throw new Error(`expected modelsDown, got ${answer.status}`);
    expect(answer.failures.map((failure) => [failure.role, failure.code])).toEqual([
      ["haiku", "timeout"],
      ["haiku", "timeout"],
      ["sonnet", "timeout"],
    ]);
    expect(answer.modelCalls.map((call) => [call.purpose, call.model, call.outcome, call.ms])).toEqual([
      ["rewrite", HAIKU_MODEL, "timedOut", 6000],
      ["rewrite", HAIKU_MODEL, "timedOut", 6000],
      ["rewrite", SONNET_MODEL, "timedOut", 6000],
    ]);
    expect(api.sent.map((body) => body.model)).toEqual([HAIKU_MODEL, HAIKU_MODEL, SONNET_MODEL]);
    // Each attempt's K-08 span carries its model call: the rewrite's, timed out at 6,000 ms.
    expect(callsOf(trace.spans).map((call) => [call.purpose, call.outcome, call.ms])).toEqual([
      ["rewrite", "timedOut", 6000],
      ["rewrite", "timedOut", 6000],
      ["rewrite", "timedOut", 6000],
    ]);
    for (const span of trace.spans) expect(schemaErrors("span", span)).toEqual([]);
  });

  it("the rewrite reads the composer's system prompt from the cache compose wrote: one prefix, written once, for both calls", async () => {
    const api = fakeTurnApi((turn) => (isRewriteTurn(turn) ? ONE_QUESTION_PLAN : TWO_QUESTIONS_PLAN));
    const composer = composerOn(api.fetch);
    const trace = newTrace();
    const composed = planOf(await composer.compose(A7_17_INPUT, { trace }));
    const told = rewriteTold(checkResult("check-two-questions.json"));
    await composer.rewrite({ input: A7_17_INPUT, plan: composed, attempt: "composed", told }, { trace });
    const prefix = fakeTokens(COMPOSER_PROMPT.text);
    expect(
      callsOf(trace.spans).map((call) => [call.purpose, call.cached_tokens, call.cache_write_tokens]),
    ).toEqual([
      ["compose", 0, prefix],
      ["rewrite", prefix, 0],
    ]);
  });

  it("check-emoji.json on A6-14's confirmation row: told Never in a message, the one rewrite answers with the recorded-model double's own plan for the row", async () => {
    const emoji = checkResult("check-emoji.json");
    const input = recordedInput("confirmation-a6-14");
    const recorded = (await double.composer(input as unknown as JsonObject)) as unknown as MessagePlan;
    expect(recorded).toEqual(contract.fixtures.read("plan-confirmation-a6-14.json"));
    // The plan check-emoji.json checked: the confirmation with an emoji the model typed in its first line.
    const withEmoji: MessagePlan = {
      ...recorded,
      lines: [
        { role: "first", text: "You're booked! \u{1F389} {{day}} at {{visit.time}} with {{pro.name}}." },
        ...recorded.lines.slice(1),
      ],
    };
    const api = fakeTurnApi(() => recorded);
    const answer = await composerOn(api.fetch).rewrite({
      input,
      plan: withEmoji,
      attempt: "composed",
      told: rewriteTold(emoji),
    });
    expect(planOf(answer)).toEqual(recorded);
    expect(api.calls).toHaveLength(1);
    expect(failedChecksIn(userOf(api.calls[0]))).toEqual([
      ["Never in a message", "The text holds an emoji; write it without one."],
    ]);
  });

  it.each([
    ["check-two-questions.json", "One question"],
    ["check-raw-price.json", "Values"],
    ["check-emoji.json", "Never in a message"],
    ["check-unfilled-slot.json", "Values"],
  ] as const)(
    "%s: the prompt names exactly its failed check (%s) with the detail rewriteTold gives, and no word of the final parts it checked",
    async (file, name) => {
      const result = checkResult(file);
      const told = rewriteTold(result);
      expect(told).toHaveLength(1);
      const api = fakeTurnApi(() => ONE_QUESTION_PLAN);
      const answer = await composerOn(api.fetch).rewrite({
        input: A7_17_INPUT,
        plan: TWO_QUESTIONS_PLAN,
        attempt: "composed",
        told,
      });
      expect(answer.status).toBe("ok");
      expect(api.calls).toHaveLength(1);
      const turn = userOf(api.calls[0]);
      expect(failedChecksIn(turn)).toEqual(told.map((each) => [name, each.detail]));
      // No value of the parts it checked that the row's input does not give, and none of their words whole.
      const given = new Set(A7_17_INPUT.facts.map((fact) => fact.value));
      const unseen = result.checked.slotValues.filter((fact) => !given.has(fact.value));
      for (const fact of unseen) expect(turn, fact.slot).not.toContain(fact.value);
      for (const send of result.checked.sends) if (send.text !== null) expect(turn).not.toContain(send.text);
    },
  );
});

describe("never a second rewrite: a rewrite that fails is 'use the fallback', and a failed call is modelsDown", () => {
  it("a rewrite whose answer the AI layer refuses (a time no fact holds, as check-fallback.json's rewrite typed one) is 'use the fallback' after its one call, naming the check and place, never the words", async () => {
    const api = fakeTurnApi(() => TYPED_TIME_PLAN);
    const told = rewriteTold(checkResult("check-two-questions.json"));
    const answer = await composerOn(api.fetch).rewrite({
      input: A7_17_INPUT,
      plan: TWO_QUESTIONS_PLAN,
      attempt: "composed",
      told,
    });
    expect(answer).toEqual({
      status: "useFallback",
      why: "rewriteRefused",
      problems: [{ check: "literalValue", at: "lines[0].text", kind: "date" }],
      modelCalls: expect.any(Array) as unknown,
    });
    expect(api.calls).toHaveLength(1);
    if (answer.status !== "useFallback") throw new Error("expected useFallback");
    expect(answer.modelCalls.map((call) => call.purpose)).toEqual(["rewrite"]);
    expect(JSON.stringify(answer)).not.toMatch(/10:30|instead/u);
  });

  it("the gateway's ladder holds for the rewrite as for compose: Haiku failing twice, Sonnet answers once; all three failing is modelsDown, never 'use the fallback'", async () => {
    const told = rewriteTold(checkResult("check-two-questions.json"));
    const request = { input: A7_17_INPUT, plan: TWO_QUESTIONS_PLAN, attempt: "composed", told } as const;

    const sonnet = fakeTurnApi(
      () => ONE_QUESTION_PLAN,
      (n) => (n < 2 ? 529 : null),
    );
    const answered = await composerOn(sonnet.fetch).rewrite(request);
    expect(answered).toMatchObject({
      status: "ok",
      model: SONNET_MODEL,
      role: "sonnet",
      attempt: 3,
      fallback: true,
    });
    expect(planOf(answered)).toEqual(ONE_QUESTION_PLAN);
    expect(sonnet.calls.map((call) => call.model)).toEqual([HAIKU_MODEL, HAIKU_MODEL, SONNET_MODEL]);

    const down = fakeTurnApi(
      () => ONE_QUESTION_PLAN,
      () => 529,
    );
    const answer = await composerOn(down.fetch).rewrite(request);
    if (answer.status !== "modelsDown") throw new Error(`expected modelsDown, got ${answer.status}`);
    expect(answer.failures.map((failure) => [failure.role, failure.code])).toEqual([
      ["haiku", "http_529"],
      ["haiku", "http_529"],
      ["sonnet", "http_529"],
    ]);
    expect(answer.modelCalls).toHaveLength(3);
    expect(answer).not.toHaveProperty("plan");
  });
});

describe("never a word of the row, the plan or what failed in a span, a refusal or a log line (K-08 README line 75)", () => {
  it("a rewrite made, one refused for its answer, a second failure and a refused request leave no input words, plan words, told details or key in the trace, the answers or the console", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) => vi.spyOn(console, method));
    try {
      const told = rewriteTold(checkResult("check-raw-price.json"));
      const trace = newTrace();
      const ok = await composerOn(fakeTurnApi(() => ONE_QUESTION_PLAN).fetch).rewrite(
        { input: A7_17_INPUT, plan: TWO_QUESTIONS_PLAN, attempt: "composed", told },
        { trace },
      );
      const refusedAnswer = await composerOn(fakeTurnApi(() => TYPED_TIME_PLAN).fetch).rewrite(
        { input: A7_17_INPUT, plan: TWO_QUESTIONS_PLAN, attempt: "composed", told },
        { trace },
      );
      const second = await composerOn(fakeTurnApi(() => ONE_QUESTION_PLAN).fetch).rewrite(
        { input: A7_17_INPUT, plan: ONE_QUESTION_PLAN, attempt: "rewrite", told },
        { trace },
      );
      const badTold = [{ check: "values", detail: "The price $45 is wrong", extra: "Alex M. at 88 Elm St" }];
      const refusedRequest = await composerOn(fakeTurnApi(() => ONE_QUESTION_PLAN).fetch).rewrite(
        {
          input: A7_17_INPUT,
          plan: TWO_QUESTIONS_PLAN,
          attempt: "composed",
          told: badTold,
        } as unknown as RewriteRequest,
        { trace },
      );
      expect(ok.status).toBe("ok");
      expect(refusedAnswer).toMatchObject({ status: "useFallback", why: "rewriteRefused" });
      expect(second).toMatchObject({ status: "useFallback", why: "rewriteFailed" });
      expect(refusedRequest).toMatchObject({ status: "refused", stage: "request" });

      const seen =
        JSON.stringify(trace.toTrace()) +
        JSON.stringify(refusedAnswer) +
        JSON.stringify(second) +
        JSON.stringify(refusedRequest);
      const words = [
        ...A7_17_INPUT.facts.map((fact) => fact.value),
        A7_17_INPUT.masterText.text,
        A7_17_INPUT.audience.name ?? "",
        ...A7_17_INPUT.options.map((option) => option.label),
        ...[TWO_QUESTIONS_PLAN, ONE_QUESTION_PLAN, TYPED_TIME_PLAN].flatMap((plan) => [
          ...plan.lines.map((line) => line.text),
          plan.question?.text ?? "",
        ]),
        ...told.map((each) => each.detail),
        "$45",
        "10:30am",
        "Alex M.",
        "88 Elm St",
        KEY,
      ].filter((text) => text.length >= 3);
      expect(words.length).toBeGreaterThan(15);
      for (const text of words) expect(seen).not.toContain(text);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
