// T-560's composer port (./real.ts realComposer), under Node (Vitest project "unit"): the turn loop's composer call per
// outbox row and its one rewrite bound to @rosie/ai's composer (T-373's call, T-374's one rewrite, T-375's reader checks),
// one per bundle, each answer mapped for the turn (../turn/types.ts ComposerAnswer) and the rewrite's request as T-374's
// handoff maps it (DL-309). The composer is the real one (createComposer: its checks, its prompt layout and the AI
// gateway) over a fake Messages API answered by the recorded-model double (./test-support.ts fakeComposerModels:
// ai/recordings' composer.v1.1.json as it is, recording 4 the JOIN run's S1-02 row, DL-347); the rewrite's mapping is
// shown on a composer double that keeps what it is asked, since the recorded double holds no rewrite recordings (T-1071).
// The global fetch is stubbed and never called: no model is called (J-02). Test values only (rule 9): the master's sample
// cast and the fixtures' own words.
import joinComposeInput from "@rosie/ai/recordings/composer-inputs/join-s1-02.json";
import type { RewriteAnswer } from "@rosie/ai/src/composer/rewrite/types";
import type { Composer } from "@rosie/ai/src/composer/types";
import { HAIKU_MODEL, SONNET_MODEL } from "@rosie/ai/src/gateway/index";
import refuseFrontierInInput from "@rosie/contracts/message-plan/fixtures/invalid/refuse-frontier-in-input.json";
import planS102 from "@rosie/contracts/message-plan/fixtures/plan-s1-02.json";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { openTrace, type Span, type TraceContext } from "../trace";
import type { ModelCall } from "../trace/types";
import type { ComposeInput, ComposerAnswer, MessagePlan, TurnComposer } from "../turn/types";
import { NoComposerError, realComposer, USE_FALLBACK } from "./index";
import { BUNDLE_V0, fakeComposerModels, type FakeComposerModels } from "./test-support";

/** Recording 4's request (K-02 README "v1.1"; T-1175): the JOIN run's S1-02 row, keyed on the run's own ids (DL-347). */
const JOIN_INPUT = joinComposeInput as unknown as ComposeInput;
/** K-03's plan-s1-02.json: recording 4's answer. */
const PLAN_S1_02 = planS102 as unknown as MessagePlan;

/** A model call's own span: a portCall to provider anthropic, one per attempt (the AI gateway's). */
const modelCall = (span: Span): boolean => span.hop === "portCall" && span.provider === "anthropic";

interface Run {
  readonly models: FakeComposerModels;
  readonly port: TurnComposer;
  readonly spans: Span[];
  /** The turn's trace for an input: under bundle v0, the bundle the JOIN run pins, set to the input's turn. */
  readonly traceFor: (input: ComposeInput) => TraceContext;
}

function run(): Run {
  const models = fakeComposerModels();
  const spans: Span[] = [];
  return {
    models,
    port: realComposer({ composers: models.composers }),
    spans,
    traceFor: (input) => {
      const trace = openTrace({
        openedBy: "textWebhook",
        bundleId: BUNDLE_V0,
        sink: (span) => spans.push(span),
      });
      trace.setTurn(input.turn);
      return trace;
    },
  };
}

/** Every model call an answer reports: a plan's, or a failure's (none when it reports none). */
const callsOf = (answer: ComposerAnswer): readonly ModelCall[] => answer.modelCalls ?? [];

/** The plan the composer answered, or the test fails naming what it answered instead. */
function plannedOf(answer: ComposerAnswer): Extract<ComposerAnswer, { result: "planned" }> {
  if (!("result" in answer)) throw new Error(`the composer answered ${answer.error}`);
  return answer;
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

/** A composer double for the rewrite's mapping alone: it keeps each rewrite it is asked and answers `answer`. */
function askedComposer(answer: RewriteAnswer): { readonly composer: Composer; readonly asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    composer: {
      compose: () => Promise.reject(new Error("this double answers only the rewrite")),
      rewrite: (request) => {
        asked.push(structuredClone(request));
        return Promise.resolve(answer);
      },
    },
  };
}

let fetch: Mock;

beforeEach(() => {
  fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetch).not.toHaveBeenCalled();
});

describe("the composer bound to @rosie/ai: one call per row", () => {
  it("the JOIN run's S1-02 row (recording 4): one Haiku call answered from recording 4, plan-s1-02.json's plan; one portCall span on the turn's trace, under bundle v0 and the turn's id; no hop span", async () => {
    const { models, port, spans, traceFor } = run();
    const input = structuredClone(JOIN_INPUT);

    const answer = plannedOf(await port.compose(input, traceFor(input)));

    expect(answer.plan).toEqual(PLAN_S1_02);
    expect(answer.modelCalls.map((call) => [call.model, call.role, call.purpose, call.outcome])).toEqual([
      [HAIKU_MODEL, "haiku", "compose", "ok"],
    ]);
    // Answered from recording 4 as ai/recordings keys it: the input the composer was given is the recording's.
    expect(models.misses).toEqual([]);
    expect(models.calls).toEqual([{ model: HAIKU_MODEL, recording: "composer-join-s1-02" }]);
    expect(models.inputs).toEqual([JOIN_INPUT]);
    expect(models.asked).toEqual([`${BUNDLE_V0.hash}/${String(BUNDLE_V0.build)}`]);
    // The spans: the AI gateway's portCall per attempt, on the turn's trace and bundle; the port records no hop span.
    expect(spans.filter((span) => !modelCall(span))).toEqual([]);
    expect(spans.map((span) => [span.bundle_id, span.turn_id, span.outcome])).toEqual([
      [BUNDLE_V0, input.turn, "ok"],
    ]);
    expect(spans[0]?.model_calls?.map((call) => call.purpose)).toEqual(["compose"]);
    const words = JSON.stringify(spans);
    expect(words).not.toContain("JOIN");
    expect(words).not.toContain("kinds of work");
  });

  it("keeps one composer per bundle: two rows of the same bundle ask for it once", async () => {
    const { models, port, traceFor } = run();
    const input = structuredClone(JOIN_INPUT);

    plannedOf(await port.compose(input, traceFor(input)));
    plannedOf(await port.compose(input, traceFor(input)));

    expect(models.asked).toEqual([`${BUNDLE_V0.hash}/${String(BUNDLE_V0.build)}`]);
    expect(models.calls.map((call) => call.recording)).toEqual([
      "composer-join-s1-02",
      "composer-join-s1-02",
    ]);
  });

  it("refuses an input carrying the frontier (refuse-frontier-in-input.json) before any model call: the error names the frontier, with no model call and no span", async () => {
    const { models, port, spans, traceFor } = run();
    const input = structuredClone(refuseFrontierInInput) as unknown as ComposeInput;

    const answer = await port.compose(input, traceFor(input));

    expect(answer).toEqual({ error: "frontier", modelCalls: [] });
    expect(models.calls).toEqual([]);
    expect(models.misses).toEqual([]);
    expect(spans).toEqual([]);
  });

  it("an input the double holds no plan for is a miss, named by what differs from recording 4, and the models answer no plan: modelsDown, with every attempt's call", async () => {
    const { models, port, traceFor } = run();
    const input = { ...structuredClone(JOIN_INPUT), situation: "gentle" } as ComposeInput;

    const answer = await port.compose(input, traceFor(input));

    expect(answer).toMatchObject({ error: "modelsDown" });
    expect(callsOf(answer).map((call) => [call.model, call.outcome])).toEqual([
      [HAIKU_MODEL, "failed"],
      [HAIKU_MODEL, "failed"],
      [SONNET_MODEL, "failed"],
    ]);
    expect(models.misses).toHaveLength(3);
    expect(new Set(models.misses)).toEqual(
      new Set(["no plan is recorded for the input: composer-join-s1-02 differs at situation"]),
    );
  });

  it("with the models down, compose answers modelsDown with each attempt's call, Haiku twice then Sonnet once", async () => {
    const { models, port, traceFor } = run();
    models.down = true;
    const input = structuredClone(JOIN_INPUT);

    const answer = await port.compose(input, traceFor(input));

    expect(answer).toMatchObject({ error: "modelsDown" });
    expect(callsOf(answer).map((call) => call.model)).toEqual([HAIKU_MODEL, HAIKU_MODEL, SONNET_MODEL]);
    expect(models.calls).toEqual([]);
  });

  it("with no composer bound (the Worker until J-02), compose and the rewrite fail before any model call", async () => {
    const port = realComposer({ composers: null });
    const { traceFor } = run();
    const input = structuredClone(JOIN_INPUT);

    await expect(port.compose(input, traceFor(input))).rejects.toThrow(new NoComposerError());
    await expect(
      port.rewrite(
        { input, plan: PLAN_S1_02, failed: [{ check: "oneQuestion", detail: "x" }] },
        traceFor(input),
      ),
    ).rejects.toThrow(new NoComposerError());
  });

  it("a composer that cannot be built is not kept: the next call asks again", async () => {
    const models = fakeComposerModels();
    let builds = 0;
    const port = realComposer({
      composers: (bundleId) => {
        builds += 1;
        if (builds === 1) throw new Error("the bundle's manifest cannot be read yet");
        return models.composers(bundleId);
      },
    });
    const { traceFor } = run();
    const input = structuredClone(JOIN_INPUT);

    await expect(port.compose(input, traceFor(input))).rejects.toThrow(
      "the bundle's manifest cannot be read yet",
    );
    plannedOf(await port.compose(input, traceFor(input)));
    expect(builds).toBe(2);
  });
});

describe("the composer's one rewrite, as T-374's handoff maps it (DL-309)", () => {
  const failed = [
    { check: "oneQuestion", detail: "The message asks 2 questions; at most one is allowed." },
    { check: "format", detail: null },
  ];

  it("asks @rosie/ai's rewrite with the row's input, the plan the composer gave, attempt composed and told only the failed checks that carry a detail", async () => {
    const double = askedComposer({
      status: "ok",
      plan: planS102 as never,
      model: HAIKU_MODEL,
      role: "haiku",
      attempt: 1,
      fallback: false,
      modelCalls: [oneCall("rewrite")],
    });
    const port = realComposer({ composers: () => double.composer });
    const { traceFor } = run();
    const input = structuredClone(JOIN_INPUT);

    const answer = await port.rewrite({ input, plan: PLAN_S1_02, failed }, traceFor(input));

    expect(double.asked).toEqual([
      {
        input: JOIN_INPUT,
        plan: PLAN_S1_02,
        attempt: "composed",
        told: [{ check: "oneQuestion", detail: "The message asks 2 questions; at most one is allowed." }],
      },
    ]);
    expect(answer).toEqual({ result: "planned", plan: PLAN_S1_02, modelCalls: [oneCall("rewrite")] });
  });

  it.each([
    [
      "use the fallback (the rewrite's answer refused)",
      {
        status: "useFallback",
        why: "rewriteRefused",
        problems: [{ check: "literalValue", at: "lines[0].text", kind: "price" }],
        modelCalls: [oneCall("rewrite")],
      },
      { error: USE_FALLBACK, modelCalls: [oneCall("rewrite")] },
    ],
    [
      "a request refused before any call",
      { status: "refused", stage: "request", problems: [{ check: "told", at: "told" }], modelCalls: [] },
      { error: "told", modelCalls: [] },
    ],
    [
      "the models down",
      { status: "modelsDown", failures: [], modelCalls: [oneCall("rewrite")] },
      { error: "modelsDown", modelCalls: [oneCall("rewrite")] },
    ],
  ] as const)("maps %s to a label the turn reads, with its model calls", async (_name, given, expected) => {
    const double = askedComposer(given);
    const port = realComposer({ composers: () => double.composer });
    const { traceFor } = run();
    const input = structuredClone(JOIN_INPUT);

    expect(await port.rewrite({ input, plan: PLAN_S1_02, failed }, traceFor(input))).toEqual(expected);
    expect(double.asked).toHaveLength(1);
  });
});
