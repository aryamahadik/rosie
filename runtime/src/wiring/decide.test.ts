// T-558's decide port (./real.ts realDecide), under Node (Vitest project "unit"): the turn loop's decide and its one
// re-read bound to @rosie/ai's decider (T-369's two reads, T-370's one Sonnet re-read), one per bundle, each answer
// mapped as T-370's handoff maps it (DL-342). The deciders are the real ones (createDecider: the router, decide's one
// read, the context bundle, the AI gateway), over a fake Messages API answered by the recorded-model double
// (./test-support.ts fakeDecideModels): ai/recordings' turn 1 recordings as they are, and decide-reads-disagree.json's
// three reads on its context. The global fetch is stubbed and never called: no model is called (J-02). Test values only
// (rule 9): the master's sample cast and the fixtures' own words.
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import { HAIKU_MODEL, SONNET_MODEL } from "@rosie/ai/src/gateway/index";
import decideReadsDisagree from "@rosie/contracts/model/fixtures/decide-reads-disagree.json";
import decideS101Enter from "@rosie/contracts/model/fixtures/decide-s1-01-enter.json";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { BUNDLE_B } from "../bundle/test-support";
import { openTrace, type BundleId, type Span, type TraceContext } from "../trace";
import type { DecideAnswer, DecideContext, DecideResult, RereadRequest, TurnDecide } from "../turn/types";
import { DeciderBundleError, NoDeciderError, realDecide } from "./index";
import { BUNDLE_V0, disagreeContext, fakeDecideModels, type FakeDecideModels } from "./test-support";

/** The JOIN run's own context (K-02 README "v1.1", recording 2): turn 1's frontier, keyed on the run's ids (DL-347). */
const JOIN_CONTEXT = joinRunContext as unknown as DecideContext;

/** A model call's own span: a portCall to provider anthropic, one per attempt (the AI gateway's). */
const modelCall = (span: Span): boolean => span.hop === "portCall" && span.provider === "anthropic";

interface Run {
  readonly models: FakeDecideModels;
  readonly port: TurnDecide;
  readonly spans: Span[];
  traceFor(context: DecideContext): TraceContext;
}

function run(): Run {
  const models = fakeDecideModels();
  const spans: Span[] = [];
  return {
    models,
    port: realDecide({ deciders: models.deciders }),
    spans,
    traceFor(context) {
      const trace = openTrace({
        openedBy: "textWebhook",
        bundleId: context.bundleId,
        sink: (span) => spans.push(span),
      });
      trace.setTurn(context.turnId);
      return trace;
    },
  };
}

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

/** The result decide answered, or the test fails naming what it answered instead. */
function decidedOf(answer: DecideAnswer): Extract<DecideAnswer, { result: "decided" }> {
  if (!("result" in answer)) throw new Error(`decide answered ${answer.error}`);
  return answer;
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

describe("decide bound to @rosie/ai: the two reads", () => {
  it("the JOIN run's context (recording 2): both Haiku reads enter c-01, the sign-up door, with the quote JOIN and no field, agreed with no re-read; the answer is K-02's result and every model call", async () => {
    const { models, port, spans, traceFor } = run();
    const context = structuredClone(JOIN_CONTEXT);

    const answer = decidedOf(await port.decide(context, traceFor(context)));

    expect(answer.decide).toEqual(enterResultFor(context, "JOIN"));
    expect(answer.decide).toMatchObject({ agreed: true, reread: false, stakes: "low" });
    expect(context.choices).toMatchObject([{ choiceId: "c-01", kind: "door", door: "signUp" }]);
    // Each read is decide's one read: step 1, then step 2 of its one part, both on Haiku (two-step wire form, CQ-25).
    expect(answer.modelCalls.map((call) => [call.model, call.role, call.purpose])).toEqual([
      [HAIKU_MODEL, "haiku", "decideFirst"],
      [HAIKU_MODEL, "haiku", "decideFirst"],
      [HAIKU_MODEL, "haiku", "decideCheck"],
      [HAIKU_MODEL, "haiku", "decideCheck"],
    ]);
    // Every call answered from recording 2 as ai/recordings keys it: the run's own context, both reads alike.
    expect(models.misses).toEqual([]);
    expect(models.calls.map((call) => [call.model, call.step, call.recordings])).toEqual([
      [HAIKU_MODEL, 1, ["decide-s1-01-join-first", "decide-s1-01-join-check"]],
      [HAIKU_MODEL, 1, ["decide-s1-01-join-first", "decide-s1-01-join-check"]],
      [HAIKU_MODEL, 2, ["decide-s1-01-join-first", "decide-s1-01-join-check"]],
      [HAIKU_MODEL, 2, ["decide-s1-01-join-first", "decide-s1-01-join-check"]],
    ]);
    expect(models.rereadCalls).toEqual([]);
    // The spans: the AI gateway's portCall per attempt, on the turn's trace and bundle; the port records no hop span.
    expect(spans.filter((span) => !modelCall(span))).toEqual([]);
    expect(spans.map((span) => [span.bundle_id, span.turn_id, span.outcome])).toEqual(
      Array.from({ length: 4 }, () => [BUNDLE_V0, context.turnId, "ok"]),
    );
    expect(JSON.stringify(spans)).not.toContain("JOIN");
  });

  it("the models down: every call fails on both models, and decide answers modelsDown (T-271's path follows)", async () => {
    const { models, port, traceFor } = run();
    models.down = true;
    const context = structuredClone(JOIN_CONTEXT);

    expect(await port.decide(context, traceFor(context))).toEqual({ error: "modelsDown" });
    expect(models.calls).toEqual([]);
  });

  it("an unmapped turn: both reads refused, the AI layer's own re-read runs once (Sonnet, why unmapped) and is refused too, and decide answers unmapped, so nothing is decided", async () => {
    const { models, port, traceFor } = run();
    const context = { ...structuredClone(JOIN_CONTEXT), turnId: "turn-unmapped-join" };
    // A read quoting words the turn never typed: the AI layer's validator refuses it at step 1 (quoteInText).
    const refused = {
      language: "en",
      parts: [{ verb: "enter", quote: "LEAVE", choice: "c-01", fields: [] }],
    };
    for (const role of ["first", "check", "reread"] as const) {
      models.hold({ id: `unmapped-${role}`, context, role, output: refused });
    }

    expect(await port.decide(context, traceFor(context))).toEqual({ error: "unmapped" });
    expect(models.rereadCalls).toMatchObject([{ why: "unmapped", unmapped: { status: "unmapped" } }]);
    expect(models.calls.map((call) => [call.model, call.roles, call.step])).toEqual([
      [HAIKU_MODEL, ["first", "check"], 1],
      [HAIKU_MODEL, ["first", "check"], 1],
      [SONNET_MODEL, ["reread"], 1],
    ]);
  });
});

describe("decide bound to @rosie/ai: the one Sonnet re-read", () => {
  /** decide-reads-disagree.json's turn on its context, decided by its two reads, which disagree. */
  async function disagreed(): Promise<{
    readonly run: Run;
    readonly context: DecideContext;
    readonly trace: TraceContext;
    readonly decided: DecideResult;
  }> {
    const each = run();
    const context = disagreeContext() as unknown as DecideContext;
    const trace = each.traceFor(context);
    const decided = decidedOf(await each.port.decide(context, trace)).decide;
    return { run: each, context, trace, decided };
  }

  it("decide-reads-disagree.json: the two reads differ on the high-stakes part, so it holds one question; the re-read, handed that very result, gives the fixture's result: one Sonnet re-read, the part one question, nothing to commit", async () => {
    const { run: each, context, trace, decided } = await disagreed();
    expect(decided).toMatchObject({ stakes: "high", agreed: false, reread: false });
    expect(decided.parts.map((part) => part.outcome)).toEqual(["oneQuestion"]);

    const request: RereadRequest = { context, decide: decided, why: "disagreed", failing: [] };
    const answer = decidedOf(await each.port.reread(request, trace));

    expect(answer.decide).toEqual(decideReadsDisagree);
    expect(answer.decide.parts.filter((part) => part.outcome === "go")).toEqual([]);
    expect(answer.modelCalls.map((call) => [call.model, call.purpose])).toEqual([
      [SONNET_MODEL, "reread"],
      [SONNET_MODEL, "reread"],
    ]);
    // The re-read was handed the very result decide gave (it checks it is exactly its two reads' own).
    expect(each.models.rereadCalls).toHaveLength(1);
    expect((each.models.rereadCalls[0] as { decide: unknown }).decide).toEqual(decided);
    // Sonnet's first read and Haiku's check read side by side (each its step 1 and its one part's step 2), then the
    // re-read's two steps on Sonnet: each answered from its own recording.
    const answeredBy = (role: string): unknown[] =>
      each.models.calls
        .filter((call) => call.roles.join() === role)
        .map((call) => [call.model, call.step, call.recordings]);
    expect(answeredBy("first")).toEqual([
      [SONNET_MODEL, 1, ["decide-reads-disagree-first"]],
      [SONNET_MODEL, 2, ["decide-reads-disagree-first"]],
    ]);
    expect(answeredBy("check")).toEqual([
      [HAIKU_MODEL, 1, ["decide-reads-disagree-check"]],
      [HAIKU_MODEL, 2, ["decide-reads-disagree-check"]],
    ]);
    expect(
      each.models.calls.slice(4).map((call) => [call.model, call.roles, call.step, call.recordings]),
    ).toEqual([
      [SONNET_MODEL, ["reread"], 1, ["decide-reads-disagree-reread"]],
      [SONNET_MODEL, ["reread"], 2, ["decide-reads-disagree-reread"]],
    ]);
    expect(each.models.misses).toEqual([]);
    // One decider for the bundle served both: built once.
    expect(each.models.asked).toEqual([`${BUNDLE_B.hash}/${String(BUNDLE_B.build)}`]);
    // No words in any span: the quotes and the question's words go to the gate only.
    const logged = JSON.stringify(each.spans);
    for (const words of ["Avery", "Saturday", "stand-in"]) expect(logged).not.toContain(words);
  });

  it("a second re-read in the same run is refused before any call: rereadDone", async () => {
    const { run: each, context, trace, decided } = await disagreed();
    const request: RereadRequest = { context, decide: decided, why: "disagreed", failing: [] };
    decidedOf(await each.port.reread(request, trace));
    const calls = each.models.calls.length;

    expect(await each.port.reread(request, trace)).toEqual({ error: "rereadDone" });
    expect(each.models.calls).toHaveLength(calls);
  });

  it("a re-read after meaning search (why noneFits) is refused by the AI layer before any call (until T-1159), and the refusal goes back as it came", async () => {
    const { run: each, context, trace, decided } = await disagreed();
    const calls = each.models.calls.length;

    await expect(
      each.port.reread({ context, decide: decided, why: "noneFits", failing: [] }, trace),
    ).rejects.toMatchObject({ name: "DecideRequestError" });
    expect(each.models.calls).toHaveLength(calls);
  });
});

describe("one decider per bundle, or none", () => {
  const OTHER: BundleId = { hash: "f".repeat(64), build: 1 };

  it("a decider is built at its bundle's first call and kept; one that cannot be built is not kept, so the next call asks again", async () => {
    const { models, port, traceFor } = run();
    const context = structuredClone(JOIN_CONTEXT);
    decidedOf(await port.decide(context, traceFor(context)));
    // The same turn decided again (a rerun of it, as the lease reruns a lapsed turn): the same decider.
    decidedOf(await port.decide(structuredClone(JOIN_CONTEXT), traceFor(context)));
    const elsewhere = { ...context, bundleId: OTHER };
    await expect(port.decide(elsewhere, traceFor(elsewhere))).rejects.toThrow(/holds no bundle/u);
    await expect(port.decide(elsewhere, traceFor(elsewhere))).rejects.toThrow(/holds no bundle/u);

    expect(models.asked).toEqual([
      `${BUNDLE_V0.hash}/${String(BUNDLE_V0.build)}`,
      `${OTHER.hash}/${String(OTHER.build)}`,
      `${OTHER.hash}/${String(OTHER.build)}`,
    ]);
  });

  it("a decider of another bundle than the one asked for is refused before any call", async () => {
    const models = fakeDecideModels();
    const port = realDecide({ deciders: () => models.deciders(BUNDLE_V0) });
    const context = disagreeContext() as unknown as DecideContext;
    const trace = openTrace({ openedBy: "textWebhook", bundleId: BUNDLE_B });

    await expect(port.decide(context, trace)).rejects.toThrow(new DeciderBundleError());
    expect(models.calls).toEqual([]);
  });

  it("with no decider bound (the Worker until J-02), decide and its re-read fail closed before any model call", async () => {
    const port = realDecide({ deciders: null });
    const context = structuredClone(JOIN_CONTEXT);
    const trace = openTrace({ openedBy: "textWebhook", bundleId: BUNDLE_V0 });

    await expect(port.decide(context, trace)).rejects.toThrow(new NoDeciderError());
    await expect(
      port.reread({ context, decide: enterResultFor(context, "JOIN"), why: "disagreed", failing: [] }, trace),
    ).rejects.toThrow(new NoDeciderError());
  });
});
