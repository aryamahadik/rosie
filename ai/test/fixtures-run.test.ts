// The AI layer over every model-contract fixture, on the recorded-model double (T-376; BP starting shape M2: "AI layer
// ... against the model contract's fixtures and a recorded-model double"): npm run test:unit -- ai/test/fixtures-run.
//
// Every K-02 fixture (v1 and v1.1) and every K-03 v1 fixture, as their indexes list them, is run through the stage its
// definition belongs to, built as the Worker builds it, with the real AI gateway, prompt layout and checks:
//
//   K-02 safetyResult       the safety read (C-113, T-365, T-366): each text the double holds, with K-02's danger words;
//                           the two timeout fixtures with both tries getting no answer (no verdict in 4 s, fake clock);
//   K-02 context            decide (C-115, T-369) takes it, and gives the decide result made from it;
//   K-02 decideResult       decide's two reads; decide-reads-disagree.json then its one Sonnet re-read (C-116, T-370);
//                           T-1145's JOIN run (recording 2) on bundle v0 as bundles/v0 publishes it;
//   K-02 refused            the context with 61 choices is refused before any call; each refused read and each pair a
//                           named rule refuses is answered as a model might, and refused by decide's validator at every
//                           read, the AI layer's own re-read included, so nothing leaves as a K-02 result;
//   K-02 plannerOutput      none of this card's four stages (the planner, C-117, is not built): the double replays each,
//                           checked against K-02, and refuses to hold refuse-planner-books.json;
//   K-03 composeInput, plan the composer (C-118, T-373 to T-375): each row the double holds gives its plan, or is refused
//                           as K-03 says; the refused fixtures are refused before or after the one call;
//   K-03 slotVocabulary, rowPlan   the vocabulary the composer's checks read; an email copy reuses its text row's plan;
//   K-03 finalParts, checkResult   the action layer's documents (C-088 to C-093), checked only where they meet the plan.
//
// Every model answer comes from the double, asked through its call log (./double-transport.ts), or, for a refused
// fixture, is that fixture's own answer, which the double's loader refuses to hold; the global fetch is stubbed to fail
// and asserted never called, so the run makes no live call. Every model call writes one K-08 portCall span, checked to
// carry the model id, its tokens, cached tokens and cache writes, its cost and the bundle id, and matched one for one
// with the requests the transport got. Fixtures the double cannot reproduce yet are named in WAITING, with what they
// wait for. Names and values are the master's sample cast (rule 9).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPromptCache, type PromptCache } from "../src/cache";
import {
  CHECK_NAMES,
  SLOT_NAMES,
  createComposer,
  planProblems,
  readerProblems,
  type ComposeAnswer,
  type ComposeInput,
  type ComposeProblem,
  type Composer,
  type MessagePlan,
} from "../src/composer";
import { GATEWAY_BUNDLE as COMPOSER_BUNDLE, PROMPTS as COMPOSER_PROMPTS } from "../src/composer/test-support";
import { ContextRefusedError, type DecideContext } from "../src/context";
import {
  createDecider,
  type DecidePart,
  type DecideRead,
  type DecideResult,
  type Decider,
  type DecideTurnAnswer,
  type RereadAnswer,
} from "../src/decide";
import {
  WRITTEN_CONTEXTS,
  bundleOf,
  drawFrom,
  promptsFor,
  routingBundle,
  rolesOf,
  twoStep,
  writtenRecordings,
} from "../src/decide/test-support";
import {
  ALLOWED_MODELS,
  HAIKU_MODEL,
  KEY_VARIABLE,
  SONNET_MODEL,
  costMicroUsd,
  type ModelCall,
} from "../src/gateway";
import {
  RecordingRefusedError,
  canonicalJson,
  buildRecordedComposer,
  buildRecordedModel,
  loadModelContract,
  loadPlanContract,
  loadRecordedDouble,
  type ModelContract,
  type PlanContract,
  type RecordedModel,
} from "../src/recorded-double";
import { CONTRACTS_ROOT } from "../src/recorded-double/contract";
import { JOIN_TURN_ID, bundleV0 } from "../src/recorded-double/test-support";
import { createRouter, type RoutingBundle, type RoutingPolicy, type TurnRoute } from "../src/routing";
import { SAFETY_VERDICT_MS, createSafetyReader, type SafetyResult } from "../src/safety";
import {
  BUNDLE as SAFETY_BUNDLE,
  K02_DANGER_WORDS,
  PROMPTS as SAFETY_PROMPTS,
} from "../src/safety/test-support";
import {
  bundleIdProblems,
  openTrace,
  spanProblems,
  type BundleId,
  type Span,
  type TraceContext,
} from "../../runtime/src/trace";
import { schemaErrors } from "../../runtime/src/trace/test-support";
import {
  LoggedDouble,
  RECORDINGS,
  RECORDING_FILES,
  RunLog,
  composeTransport,
  decideTransport,
  hanging,
  keysOf,
  modelFixture,
  planFixture,
  requestOf,
  safetyTransport,
  seededFrom,
  type Raw,
  type RecordingSpec,
  type Served,
  type Source,
  type WireCall,
} from "./double-transport";

const globalFetch = vi.fn(() => {
  throw new Error("no live call in the fixtures run: the global fetch was called");
});

// An obviously fake key, long enough to be found anywhere it leaks (never a real key's prefix).
const KEY = "FAKE-KEY-FOR-THE-FIXTURES-RUN-ONLY-0123456789abcdef";
const ENV = Object.freeze({ [KEY_VARIABLE]: KEY });

/** The seeds of each turn's two reads, and the re-read's own (as decide's own tests draw them). */
const SEEDS: readonly number[] = [11, 12];
const REREAD_SEED = 13;

// ---- What became of each fixture ---------------------------------------------------------------------------------------

/**
 * given      an accepted output the AI layer gives, word for word;
 * taken      an accepted input the AI layer takes and makes its calls on (a context, a composer input, the vocabulary);
 * refused    a refused fixture the AI layer refuses (and the double's loader refuses to hold);
 * waiting    an accepted fixture the AI layer cannot give on the double yet: WAITING names what it waits for;
 * notAStage  an accepted fixture none of this card's four stages gives: NOT_A_STAGE names whose it is.
 */
type Verdict = "given" | "taken" | "refused" | "waiting" | "notAStage";
const VERDICTS = new Map<string, Verdict>();
const mark = (contract: "K-02" | "K-03", file: string, verdict: Verdict): void => {
  const key = `${contract} ${file}`;
  const earlier = VERDICTS.get(key);
  if (earlier !== undefined && earlier !== verdict)
    throw new Error(`${key} came out ${earlier} in one run and ${verdict} in another`);
  VERDICTS.set(key, verdict);
};

/** The literals K-03 v1.1's refuse-plan-s1-02-on-v1-input.json names: S1-02's plan types $2 and 15 in its fact line. */
const S1_02_LITERALS: readonly ComposeProblem[] = [
  { check: "literalValue", at: "lines[1].text", kind: "price" },
  { check: "literalValue", at: "lines[1].text", kind: "number" },
];

/**
 * Accepted fixtures the AI layer cannot give on the double yet, each with what it waits for and what the composer gives
 * meanwhile for every input the double holds for it. When the recording lands, the run expects the fixture given.
 */
const WAITING: Readonly<
  Record<string, { readonly waitsFor: string; readonly meanwhile: readonly ComposeProblem[] }>
> = {
  "K-03 plan-s1-02.json": {
    waitsFor:
      "a recording of K-03 v1.1's input-s1-02-v1.1.json, whose term facts hold the plan's 15 and $2; the double holds the plan only for K-03 v1 inputs with no facts (input-s1-02.json, the JOIN run's composer-inputs/join-s1-02.json), and its composer loader reads K-03 v1 alone",
    meanwhile: S1_02_LITERALS,
  },
};

/** The definitions none of this card's four stages gives, and whose they are. */
const NOT_A_STAGE: Readonly<Record<string, string>> = {
  plannerOutput:
    "the planner's (C-117, not built in ai/): the double replays each answer, checked against K-02 and its named check",
  finalParts:
    "the action layer's: slots filled and fixed lines added (C-088, C-089); the AI layer's part is the plan they were filled from",
  checkResult:
    "the action layer's seven checks (C-092); the AI layer's part is the one rewrite told what failed (T-374), which the double holds no recording for",
};

// ---- The run's contracts, double and log --------------------------------------------------------------------------------

let model: ModelContract;
let plans: PlanContract;
/** The double as it ships: ai/recordings' K-02 files and the composer's (loadRecordedDouble). */
let shipped: RecordedModel;
/** The double over decide's written contexts, by the same loader. */
let written: RecordedModel;
let DOUBLE: LoggedDouble;
const LOG = new RunLog();
/** Every span the run wrote, every trace's. */
const SPANS: Span[] = [];
/** The written double's recordings (decide's contexts K-02 gives no file for, T-369), as its loader read them. */
let writtenSpec: { recordings: RecordingSpec[] };

beforeAll(async () => {
  vi.stubGlobal("fetch", globalFetch);
  model = await loadModelContract(CONTRACTS_ROOT, "v1.1");
  plans = loadPlanContract();
  const double = await loadRecordedDouble();
  // The decide fixtures whose context K-02 gives no file for are recorded by decide's own tests over the contexts their
  // reads were made from (ai/src/decide/test-support.ts WRITTEN_CONTEXTS), each read seeded from its fixture and loaded
  // by the double's own loader, which checks each against K-02 and both named rules.
  const roles = Object.fromEntries(
    Object.keys(WRITTEN_CONTEXTS).map((file) => [
      file,
      rolesOf({ reads: [...(model.fixtures.read(file) as DecideResult).reads] }),
    ]),
  );
  writtenSpec = writtenRecordings(roles, []) as unknown as { recordings: RecordingSpec[] };
  written = await buildRecordedModel(writtenSpec);
  shipped = double;
  DOUBLE = new LoggedDouble(LOG, double, double);
});
afterAll(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`the run lacks ${what}`);
  return value;
};

const newTrace = (bundleId: BundleId, turnId?: string): TraceContext => {
  const trace = openTrace({ openedBy: "textWebhook", bundleId, handleRef: "handle-fixtures-run" });
  if (turnId !== undefined) trace.setTurn(turnId);
  return trace;
};

/** A model call's model and usage, as one comparable line. */
const usageLine = (call: ModelCall): string =>
  [call.model, call.input_tokens, call.cached_tokens, call.cache_write_tokens, call.output_tokens].join(" ");
const wireLine = (call: WireCall): string =>
  [
    call.model,
    call.usage?.input_tokens ?? 0,
    call.usage?.cache_read_input_tokens ?? 0,
    call.usage?.cache_creation_input_tokens ?? 0,
    call.usage?.output_tokens ?? 0,
  ].join(" ");
const sorted = (lines: readonly string[]): string[] => [...lines].sort();

/**
 * Every model-call span of a run: one K-08 portCall span per request the transport got, each with one model call that
 * carries the model id, its tokens, cached tokens, cache writes and cost (priced by the price list in force), under the
 * run's bundle id; the same calls the stage itself reports.
 */
function expectSpans(
  trace: TraceContext,
  wire: readonly WireCall[],
  modelCalls: readonly ModelCall[],
  bundleId: BundleId,
): void {
  const spans = [...trace.spans];
  SPANS.push(...spans);
  expect(spans).toHaveLength(wire.length);
  for (const span of spans) {
    expect(span).toMatchObject({
      hop: "portCall",
      provider: "anthropic",
      call: "messages",
      bundle_id: bundleId,
    });
    expect(bundleIdProblems(span.bundle_id)).toEqual([]);
    expect(spanProblems(span)).toEqual([]);
    expect(schemaErrors("span", span)).toEqual([]);
    const calls = span.model_calls ?? [];
    expect(calls).toHaveLength(1);
    const call = must(calls[0], "a span's model call");
    expect(ALLOWED_MODELS).toContain(call.model);
    for (const count of [
      call.input_tokens,
      call.cached_tokens,
      call.cache_write_tokens,
      call.output_tokens,
      call.cost_micro_usd,
    ])
      expect(Number.isSafeInteger(count) && count >= 0).toBe(true);
    expect(call.cost_micro_usd).toBe(
      costMicroUsd(call.model, {
        inputTokens: call.input_tokens,
        cachedTokens: call.cached_tokens,
        cacheWriteTokens: call.cache_write_tokens,
        outputTokens: call.output_tokens,
      }),
    );
    if (call.outcome === "ok") expect(call.cost_micro_usd).toBeGreaterThan(0);
  }
  const fromSpans = spans.map((span) => usageLine(must(span.model_calls?.[0], "a span's model call")));
  expect(sorted(fromSpans)).toEqual(sorted(wire.map(wireLine)));
  expect(sorted(modelCalls.map(usageLine))).toEqual(sorted(fromSpans));
}

// ---- The safety read (C-113) ----------------------------------------------------------------------------------------------

const safetyReader = (
  fetch: Parameters<typeof createSafetyReader>[0]["fetch"],
): ReturnType<typeof createSafetyReader> =>
  createSafetyReader({
    bundle: SAFETY_BUNDLE,
    prompts: SAFETY_PROMPTS,
    env: ENV,
    ...(fetch !== undefined && { fetch }),
  });

/** The text of a turn the double holds, by its words: the event id of that text (T-1145's runs), if any context has it. */
function eventIdOf(words: string): string | undefined {
  for (const recording of RECORDINGS) {
    if (recording.kind !== "decideRead") continue;
    const { context } = requestOf(recording) as { context: DecideContext };
    const text = context.texts.find((each) => each.words === words);
    if (text !== undefined) return text.eventId;
  }
  return undefined;
}

/** The texts read in K-02's two timeout fixtures: each holds that fixture's one danger word and no other of K-02's. */
const TIMEOUT_TEXTS: Readonly<Record<string, string>> = {
  // Fixture set v1's barber.json safety_stop ("a deep cut that won't stop bleeding"), as T-366's tests write it.
  "safety-timeout-danger-word.json": "Riley nicked my neck and the cut won't stop bleeding",
  // The crisis words the double holds a read of (safety-crisis-words.json's text).
  "safety-timeout-self-harm-word.json": must(
    seededFrom("safetyRead", "safety-crisis-words.json")[0]?.request.text as string | undefined,
    "the crisis words' text",
  ),
};

const SAFETY_RECORDINGS = RECORDINGS.filter((recording) => recording.kind === "safetyRead");

describe("the safety read (C-113): every K-02 safety result, on the double", () => {
  it.each(SAFETY_RECORDINGS.map((recording) => [recording.id, recording] as const))(
    "%s: the double's read of its text, after code's danger-word rules, is its seed fixture's whole result",
    async (_id, recording) => {
      const file = must(recording.seed?.fixture, "the recording's seed");
      const text = recording.request.text as string;
      const fixture = model.fixtures.read(file) as SafetyResult;
      // A text of T-1145's JOIN run (recording 3) carries that run's own event id; any other its fixture's.
      const eventId = eventIdOf(text) ?? fixture.eventId;
      const asked = await DOUBLE.safetyRead(text);
      const transport = safetyTransport(LOG, text, { output: asked.answer, source: asked.source });
      const trace = newTrace(SAFETY_BUNDLE.bundleId);
      const answer = await safetyReader(transport.fetch).read(
        { eventId, source: "text", text },
        { trace, dangerWords: K02_DANGER_WORDS },
      );
      const wire = transport.finish();
      expect(answer.result).toEqual({ ...fixture, eventId });
      expect(model.validate("safetyResult", answer.result)).toEqual([]);
      // Haiku's verdict, in one call; Sonnet is asked only when Haiku fails.
      expect(wire.map((call) => [call.model, call.answered])).toEqual([[HAIKU_MODEL, true]]);
      expectSpans(trace, wire, answer.modelCalls, SAFETY_BUNDLE.bundleId);
      mark("K-02", file, "given");
    },
  );

  it.each(Object.entries(TIMEOUT_TEXTS))(
    "%s: no answer from Haiku or Sonnet, so at 4 s and not before, the timeout marker with the danger word found",
    async (file, text) => {
      const fixture = model.fixtures.read(file) as SafetyResult;
      expect(fixture.read).toBeNull();
      vi.useFakeTimers();
      try {
        const transport = hanging("safetyRead", LOG);
        const trace = newTrace(SAFETY_BUNDLE.bundleId);
        let settled = false;
        const pending = safetyReader(transport.fetch)
          .read({ eventId: fixture.eventId, source: "text", text }, { trace, dangerWords: K02_DANGER_WORDS })
          .then((answer) => {
            settled = true;
            return answer;
          });
        await vi.advanceTimersByTimeAsync(SAFETY_VERDICT_MS - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const answer = await pending;
        const wire = transport.finish();
        expect(answer.result).toEqual(fixture);
        expect(model.validate("safetyResult", answer.result)).toEqual([]);
        expect(wire.map((call) => [call.model, call.answered])).toEqual([
          [HAIKU_MODEL, false],
          [SONNET_MODEL, false],
        ]);
        expectSpans(trace, wire, answer.modelCalls, SAFETY_BUNDLE.bundleId);
        expect(answer.modelCalls.map((call) => call.outcome)).toEqual(["timedOut", "timedOut"]);
        mark("K-02", file, "given");
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

// ---- Decide: two reads (C-115) and the one Sonnet re-read (C-116) ---------------------------------------------------------

/** A sample bundle's K-01 manifest, or bundle v0 as published, as decide is built on it. */
interface DecideBundle {
  readonly routing: RoutingBundle;
  readonly prompts: PromptCache;
}

/** Bundle v0 as bundles/v0 publishes it (the bundle the JOIN run pins: T-556, T-1145), its prompts as published. */
function publishedV0(): DecideBundle {
  const v0 = bundleV0();
  const manifest = v0.cache.manifest as typeof v0.cache.manifest & {
    models?: RoutingBundle["models"];
    policy?: RoutingPolicy;
  };
  return {
    routing: {
      bundleId: v0.bundleId,
      models: must(manifest.models, "bundle v0's models"),
      policy: must(manifest.policy, "bundle v0's routing policy"),
    },
    prompts: createPromptCache(v0.cache),
  };
}

/** The sample bundle a context is on, as decide's own tests pack it (decide/test-support.ts). */
function sampleBundle(context: DecideContext): DecideBundle {
  const bundle = bundleOf(context);
  return { routing: routingBundle(bundle), prompts: promptsFor(bundle) };
}

interface DecideRun {
  readonly decided: DecideTurnAnswer;
  readonly reread: RereadAnswer | null;
  readonly wire: readonly WireCall[];
  readonly trace: TraceContext;
  readonly decider: Decider;
}

/** What a read of the turn is answered with: the double's read in that role, or a refused fixture's read. */
type ReadSource =
  { readonly double: RecordedModel } | { readonly refused: string; readonly read: DecideRead };

async function served(
  context: DecideContext,
  role: "first" | "check" | "reread",
  from: ReadSource,
): Promise<Served> {
  if ("double" in from) {
    const asked = await DOUBLE.decide(context, role, from.double);
    return { steps: twoStep(asked.answer), source: asked.source };
  }
  const source: Source = { from: "refusedFixture", fixture: from.refused };
  return { steps: twoStep(from.read as unknown as Raw), source };
}

/**
 * Decides a context with its two reads, as T-558's decide port does, then its one re-read when asked: the real router,
 * decide's one read, the context bundle and the AI gateway, every answer through the run's transport.
 */
async function decideTurn(
  context: DecideContext,
  bundle: DecideBundle,
  reads: { readonly first: ReadSource; readonly check: ReadSource },
  reread?: { readonly from: ReadSource; readonly why: "disagreed" | "unmapped" },
): Promise<DecideRun> {
  const route: TurnRoute = createRouter(bundle.routing).route(context, { draw: drawFrom(SEEDS) });
  const transport = decideTransport(LOG, route, {
    first: await served(context, "first", reads.first),
    check: await served(context, "check", reads.check),
  });
  const decider = createDecider({
    bundle: bundle.routing,
    prompts: bundle.prompts,
    env: ENV,
    fetch: transport.fetch,
  });
  const trace = newTrace(bundle.routing.bundleId, context.turnId);
  const decided = await decider.decide(context, { draw: drawFrom(SEEDS), trace });
  let again: RereadAnswer | null = null;
  if (reread !== undefined) {
    transport.rereadWith(await served(context, "reread", reread.from));
    const options = { draw: drawFrom([REREAD_SEED]), trace };
    if (reread.why === "disagreed") {
      if (decided.status !== "decided") throw new Error(`the turn is ${decided.status}, not decided`);
      again = await decider.reread(
        { why: "disagreed", context, decide: decided.result, failing: [] },
        options,
      );
    } else {
      if (decided.status !== "unmapped") throw new Error(`the turn is ${decided.status}, not unmapped`);
      again = await decider.reread({ why: "unmapped", context, unmapped: decided }, options);
    }
  }
  const wire = transport.finish();
  expectSpans(trace, wire, [...decided.modelCalls, ...(again?.modelCalls ?? [])], bundle.routing.bundleId);
  return { decided, reread: again, wire, trace, decider };
}

/** The decide fixtures K-02 accepts, with the contexts the double holds their reads on (shipped, else written). */
interface DecideCase {
  readonly file: string;
  readonly fixture: DecideResult;
  /** The context, and the K-02 context fixture it is when it is one. */
  readonly context: DecideContext;
  readonly contextFixture: string | null;
  readonly double: RecordedModel;
}

/**
 * The contexts the double holds one decide fixture's reads on: the shipped recordings seeded from it, one case per
 * context, else the context decide's own tests wrote for it. A fixture with neither is a NEED (the double holds no
 * recording of its reads), never a made-up answer.
 */
function decideCasesOf(file: string): DecideCase[] {
  const fixture = model.fixtures.read(file) as DecideResult;
  const recordings = seededFrom("decideRead", file);
  if (recordings.length === 0) {
    const context = WRITTEN_CONTEXTS[file];
    if (context === undefined)
      throw new Error(`NEED: the double holds no recording of ${file}'s reads, shipped or written`);
    return [{ file, fixture, context, contextFixture: null, double: written }];
  }
  const byContext = new Map<string, DecideCase>();
  for (const recording of recordings) {
    const { context } = requestOf(recording) as { context: DecideContext };
    const named = recording.request.context as Raw;
    const contextFixture = typeof named.fixture === "string" ? named.fixture : null;
    byContext.set(JSON.stringify(context), { file, fixture, context, contextFixture, double: shipped });
  }
  return [...byContext.values()];
}

/** K-02's accepted decide fixtures, every version, as its index lists them (read when the suite is collected). */
const DECIDE_FILES: readonly string[] = (
  modelFixture("index.json") as { fixtures: { file: string; def?: string; expect: string }[] }
).fixtures
  .filter((entry) => entry.def === "decideResult" && entry.expect === "accept")
  .map((entry) => entry.file);

const outcomes = (result: DecideResult): string[] => result.parts.map((part) => part.outcome);

describe("decide (C-115): every K-02 decide result from its context, two reads on the double", () => {
  it("covers K-02's fourteen accepted decide fixtures, v1's and v1.1's", () => {
    expect(DECIDE_FILES).toHaveLength(14);
    expect(DECIDE_FILES).toContain("decide-s1-01-enter.json");
    expect(DECIDE_FILES).toContain("decide-reads-disagree.json");
  });

  it.each(DECIDE_FILES)(
    "%s: the two reads, then the one re-read when the fixture holds one, give the fixture word for word",
    async (file) => {
      for (const one of decideCasesOf(file)) {
        const { fixture, context } = one;
        const source: ReadSource = { double: one.double };
        const rereads = fixture.reread;
        const run = await decideTurn(
          context,
          sampleBundle(context),
          { first: source, check: source },
          rereads ? { from: source, why: "disagreed" } : undefined,
        );
        if (run.decided.status !== "decided") throw new Error(`the turn is ${run.decided.status}`);
        const final = rereads ? run.reread : null;
        if (final !== null && final.status !== "decided") throw new Error(`the re-read is ${final.status}`);
        const result = final === null ? run.decided.result : final.result;
        expect(result).toEqual(fixture);
        expect(model.validate("decideResult", result)).toEqual([]);
        // Without a re-read only agreed parts can go: both reads agreed on every part and on the language.
        if (!rereads) expect(run.decided.agreement.agreed).toBe(true);
        // Each read is decide's one read (T-368): step 1, then one step-2 call per part that is not no_op.
        const parts = (read: DecideRead): number => read.parts.filter((part) => part.verb !== "no_op").length;
        expect(run.wire).toHaveLength(result.reads.reduce((sum, read) => sum + 1 + parts(read.output), 0));
        mark("K-02", file, "given");
        if (one.contextFixture !== null) mark("K-02", one.contextFixture, "taken");
      }
    },
  );

  it("decide-reads-disagree.json: Sonnet's and Haiku's reads differ on the high-stakes part, so it holds one question; the one Sonnet re-read is still unclear: one question, nothing changed (T-558's disagreement case)", async () => {
    const file = "decide-reads-disagree.json";
    const context = must(WRITTEN_CONTEXTS[file], "decide-reads-disagree.json's context");
    const source: ReadSource = { double: written };
    const run = await decideTurn(
      context,
      sampleBundle(context),
      { first: source, check: source },
      {
        from: source,
        why: "disagreed",
      },
    );
    if (run.decided.status !== "decided" || run.reread?.status !== "decided")
      throw new Error("the turn and its re-read are decided");
    expect(run.decided.result).toMatchObject({ stakes: "high", agreed: false, reread: false });
    expect(outcomes(run.decided.result)).toEqual(["oneQuestion"]);
    expect(run.reread.result).toEqual(model.fixtures.read(file));
    expect(run.reread.result.parts.filter((part) => part.outcome === "go")).toEqual([]);
    // Exactly one re-read, by Sonnet: its step 1 and the step 2 of its one part, after the two reads' four calls.
    expect(run.wire.map((call) => call.model)).toHaveLength(6);
    expect(run.wire.slice(4).map((call) => call.model)).toEqual([SONNET_MODEL, SONNET_MODEL]);
    expect(run.reread.modelCalls.map((call) => [call.purpose, call.role])).toEqual([
      ["reread", "sonnet"],
      ["reread", "sonnet"],
    ]);
  });

  it("T-1145's JOIN run (recording 2), on bundle v0 as bundles/v0 publishes it: both Haiku reads enter c-01, the sign-up door, with the quote JOIN and no re-read: decide-s1-01-enter.json's result for that run's own turn, bundle and text", async () => {
    const recordings = RECORDINGS.filter(
      (recording) => recording.kind === "decideRead" && recording.seed === undefined,
    );
    expect(recordings.map((recording) => recording.request.role)).toEqual(["first", "check"]);
    const { context } = requestOf(must(recordings[0], "recording 2")) as { context: DecideContext };
    const bundle = publishedV0();
    expect(context.turnId).toBe(JOIN_TURN_ID);
    expect(context.bundleId).toEqual(bundle.routing.bundleId);
    const source: ReadSource = { double: shipped };
    const run = await decideTurn(context, bundle, { first: source, check: source });
    if (run.decided.status !== "decided") throw new Error(`the JOIN turn is ${run.decided.status}`);
    const enter = model.fixtures.read("decide-s1-01-enter.json") as DecideResult;
    const words = must(context.texts[0], "the JOIN text").words;
    const requoted = (part: DecidePart): DecidePart => ({ ...part, quote: words });
    expect(run.decided.result).toEqual({
      ...enter,
      turnId: context.turnId,
      bundleId: context.bundleId,
      reads: enter.reads.map((read) => ({
        ...read,
        output: { ...read.output, parts: read.output.parts.map(requoted) },
      })),
      parts: enter.parts.map((part) => ({ ...part, part: requoted(part.part) })),
    });
    expect(model.validate("decideResult", run.decided.result)).toEqual([]);
    expect(run.wire.map((call) => call.model)).toEqual([HAIKU_MODEL, HAIKU_MODEL, HAIKU_MODEL, HAIKU_MODEL]);
  });
});

describe("decide refuses every K-02 fixture K-02 refuses, at every read, the AI layer's own re-read included", () => {
  it("invalid/refuse-over-60-choices.json: decide refuses the context before any call (ContextRefusedError), and the double's loader refuses to hold a read on it", async () => {
    const file = "invalid/refuse-over-60-choices.json";
    const context = modelFixture(file) as DecideContext;
    expect(context.choices).toHaveLength(61);
    expect(model.validate("context", context)).not.toEqual([]);
    const bundle = sampleBundle(context);
    const transport = decideTransport(
      LOG,
      createRouter(bundle.routing).route(context, { draw: drawFrom(SEEDS) }),
      {
        first: { steps: { step1: null, step2: [] }, source: { from: "refusedFixture", fixture: file } },
        check: { steps: { step1: null, step2: [] }, source: { from: "refusedFixture", fixture: file } },
      },
    );
    const decider = createDecider({
      bundle: bundle.routing,
      prompts: bundle.prompts,
      env: ENV,
      fetch: transport.fetch,
    });
    const trace = newTrace(bundle.routing.bundleId, context.turnId);
    await expect(decider.decide(context, { draw: drawFrom(SEEDS), trace })).rejects.toThrow(
      ContextRefusedError,
    );
    expect(transport.finish()).toEqual([]);
    expect(trace.spans).toEqual([]);
    const read = must(
      (model.fixtures.read("decide-s1-02-choose.json") as DecideResult).reads[0],
      "a read to record",
    ).output;
    await expect(
      buildRecordedModel({
        version: "v1",
        contract: "model.v1",
        recordings: [
          { id: "over-60", kind: "decideRead", request: { context, role: "first" }, output: read },
        ],
      }),
    ).rejects.toThrow(RecordingRefusedError);
    mark("K-02", file, "refused");
  });

  /** Each refused read or pair: the context it is read against, and the reads a model answers with, by role. */
  const REFUSED_READS: readonly (readonly [file: string, rule: string | null])[] = [
    ["invalid/refuse-unknown-verb.json", null],
    ["invalid/refuse-value-without-words.json", null],
    ["invalid/refuse-option-not-offered.json", "optionOffered"],
    ["invalid/refuse-quote-not-in-text.json", "quoteInText"],
  ];

  it.each(REFUSED_READS)(
    "%s: decide's validator refuses each read the model gives (unmapped), and the AI layer's one re-read too, so the turn ends in one question with nothing changed and no K-02 result; the double's loader refuses to hold the read",
    async (file, rule) => {
      const raw = modelFixture(file) as Raw;
      let context: DecideContext;
      let readOf: (role: "first" | "check") => DecideRead;
      if (rule === null) {
        // A refused read alone (def decideRead): read against the turn its words answer, decide-bare-2.json's ("2" to
        // A7-17's open question), as decide's own tests write that context.
        expect(model.validate("decideRead", raw)).not.toEqual([]);
        context = must(WRITTEN_CONTEXTS["decide-bare-2.json"], "decide-bare-2.json's context");
        readOf = () => raw as unknown as DecideRead;
      } else {
        // A pair K-02's schema accepts and a named rule refuses (def contextAndDecide).
        const pair = raw as unknown as { context: DecideContext; decide: DecideResult };
        expect(model.validate("context", pair.context)).toEqual([]);
        expect(model.validate("decideResult", pair.decide)).toEqual([]);
        expect(must(model.rules[rule], `the rule ${rule}`)(pair)).not.toEqual([]);
        context = pair.context;
        readOf = (role) =>
          must(
            pair.decide.reads.find((read) => read.role === role),
            `the ${role} read`,
          ).output;
      }
      const from = (role: "first" | "check"): ReadSource => ({ refused: file, read: readOf(role) });
      const run = await decideTurn(
        context,
        sampleBundle(context),
        { first: from("first"), check: from("check") },
        {
          from: from("first"),
          why: "unmapped",
        },
      );
      expect(run.decided).toMatchObject({ status: "unmapped", refused: ["first", "check"] });
      expect(run.reread).toMatchObject({
        status: "unmapped",
        why: "unmapped",
        refused: ["first", "check", "reread"],
        end: "oneQuestion",
      });
      expect(run.decided).not.toHaveProperty("result");
      expect(run.reread).not.toHaveProperty("result");
      expect(run.wire.every((call) => call.source.from === "refusedFixture")).toBe(true);
      // The double never replays it: its loader refuses a recording of the read on that context.
      const error = await buildRecordedModel({
        version: "v1",
        contract: "model.v1",
        recordings: [
          { id: "refused", kind: "decideRead", request: { context, role: "first" }, output: readOf("first") },
        ],
      }).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(RecordingRefusedError);
      if (rule !== null) expect(String(error)).toContain(`rule ${rule}`);
      mark("K-02", file, "refused");
    },
  );
});

describe("the planner's K-02 answers: none of this card's four stages (C-117 is not built)", () => {
  const PLANNER_RECORDINGS = RECORDINGS.filter((recording) => recording.kind === "plannerOutput");

  it.each(PLANNER_RECORDINGS.map((recording) => [recording.id, recording] as const))(
    "%s: the double replays its seed fixture, a K-02 planner output naming only facts its context holds",
    async (_id, recording) => {
      const file = must(recording.seed?.fixture, "the recording's seed");
      const { context } = requestOf(recording) as { context: DecideContext };
      const asked = await DOUBLE.planner(context);
      expect(asked.answer).toEqual(model.fixtures.read(file));
      expect(model.validate("plannerOutput", asked.answer)).toEqual([]);
      mark("K-02", file, "notAStage");
    },
  );

  it("invalid/refuse-planner-books.json: K-02 refuses it, and the double's loader refuses to hold it", async () => {
    const file = "invalid/refuse-planner-books.json";
    const books = modelFixture(file);
    expect(model.validate("plannerOutput", books)).not.toEqual([]);
    const recording = must(PLANNER_RECORDINGS[0], "a planner recording");
    await expect(
      buildRecordedModel({
        version: "v1",
        contract: "model.v1",
        recordings: [{ id: "books", kind: "plannerOutput", request: recording.request, output: books }],
      }),
    ).rejects.toThrow(RecordingRefusedError);
    mark("K-02", file, "refused");
  });
});

// ---- The composer (C-118) -------------------------------------------------------------------------------------------------

const composerOn = (fetch: Parameters<typeof createComposer>[0]["fetch"]): Composer =>
  createComposer({
    bundle: COMPOSER_BUNDLE,
    prompts: COMPOSER_PROMPTS,
    env: ENV,
    ...(fetch !== undefined && { fetch }),
  });

interface ComposeRun {
  readonly answer: ComposeAnswer;
  readonly wire: readonly WireCall[];
}

/** One row composed, its one call answered with `served` (default: the double's plan for exactly that input). */
async function composeRow(
  input: ComposeInput,
  served?: { readonly output: unknown; readonly source: Source },
): Promise<ComposeRun> {
  let row: { readonly output: unknown; readonly source: Source };
  if (served === undefined) {
    const asked = await DOUBLE.composerPlan(input);
    row = { output: asked.answer, source: asked.source };
  } else {
    row = served;
  }
  const transport = composeTransport(LOG, [{ input, output: row.output, source: row.source }]);
  const trace = newTrace(COMPOSER_BUNDLE.bundleId);
  const answer = await composerOn(transport.fetch).compose(input, { trace });
  const wire = transport.finish();
  expectSpans(trace, wire, answer.modelCalls, COMPOSER_BUNDLE.bundleId);
  return { answer, wire };
}

const planOf = (answer: ComposeAnswer): MessagePlan => {
  if (answer.status !== "ok") throw new Error(`expected a plan, got ${answer.status}`);
  return answer.plan;
};

/** A K-03 v1 fixture the index accepts. */
const k03 = (file: string): unknown => plans.fixtures.read(file);

/** The slots a plan's words open, each once. */
function slotsOf(plan: MessagePlan): Set<string> {
  const words = [...plan.lines.map((line) => line.text), plan.question?.text ?? ""];
  return new Set(
    words.flatMap((text) => [...text.matchAll(/\{\{([^:{}|]*)/gu)].map((match) => match[1] ?? "")),
  );
}

const COMPOSER_RECORDINGS = RECORDING_FILES["composer.v1.json"].recordings;
/** Which plan fixtures a recorded row gave, and which it did not. */
const PLANS_GIVEN = new Map<string, boolean[]>();

describe("the composer (C-118): every row the double holds, one Haiku call each", () => {
  it.each(COMPOSER_RECORDINGS.map((recording) => [recording.id, recording] as const))(
    "%s: the double's plan passes T-375's four reader checks against its input, and leaves the composer as its K-03 plan, or is refused as K-03 says",
    async (_id, recording) => {
      const input = requestOf(recording) as ComposeInput;
      const file = must(recording.seed?.fixture, "the recording's seed");
      const fixture = k03(file);
      const asked = await DOUBLE.composerPlan(input);
      expect(asked.answer).toEqual(fixture);
      // The lead's note (DL-346): every plan the double holds passes the relay quote, sensitive work, tone and language
      // checks against its recorded input.
      expect(readerProblems(asked.answer as unknown as MessagePlan, input)).toEqual([]);
      const run = await composeRow(input, { output: asked.answer, source: asked.source });
      expect(run.wire.map((call) => [call.model, call.answered])).toEqual([[HAIKU_MODEL, true]]);
      const waiting = WAITING[`K-03 ${file}`];
      const given = run.answer.status === "ok";
      PLANS_GIVEN.set(file, [...(PLANS_GIVEN.get(file) ?? []), given]);
      if (given) {
        expect(run.answer).toMatchObject({ model: HAIKU_MODEL, role: "haiku", attempt: 1, fallback: false });
        const plan = planOf(run.answer);
        expect(plan).toEqual(fixture);
        expect(plans.validate("plan", plan)).toEqual([]);
        expect(planProblems(plan)).toEqual([]);
      } else {
        // Refused, never a plan: only for a plan WAITING names, for the reason it names.
        expect(waiting, `${recording.id} is refused`).toBeDefined();
        expect(run.answer).toEqual({
          status: "refused",
          stage: "plan",
          problems: waiting?.meanwhile,
          modelCalls: expect.any(Array) as unknown,
        });
        expect(run.answer).not.toHaveProperty("plan");
      }
    },
  );

  it("each accepted K-03 v1 plan is given by a row the double holds, but for the ones WAITING names, which no row gives yet", () => {
    const files = (
      planFixture("index.json") as {
        fixtures: { file: string; version: string; def: string; expect: string }[];
      }
    ).fixtures
      .filter((entry) => entry.version === "v1" && entry.def === "plan" && entry.expect === "accept")
      .map((entry) => entry.file);
    expect(files).toHaveLength(6);
    for (const file of files) {
      const runs = must(PLANS_GIVEN.get(file), `a recorded row of ${file}`);
      const waiting = WAITING[`K-03 ${file}`] !== undefined;
      expect(runs.some(Boolean), file).toBe(!waiting);
      mark("K-03", file, waiting ? "waiting" : "given");
    }
  });

  it("input-s1-02.json: the composer takes it (one Haiku call), and the double's plan for it, plan-s1-02.json, is refused for the two literals no fact holds, the pair K-03 v1.1 refuses (refuse-plan-s1-02-on-v1-input.json); the JOIN run's input (recording 4) is the same row", async () => {
    const input = k03("input-s1-02.json") as ComposeInput;
    expect(input.facts).toEqual([]);
    const run = await composeRow(input);
    expect(run.answer).toMatchObject({ status: "refused", stage: "plan", problems: S1_02_LITERALS });
    expect(planFixture("invalid/refuse-plan-s1-02-on-v1-input.json")).toEqual({
      input,
      plan: k03("plan-s1-02.json"),
    });
    const join = requestOf(
      must(
        COMPOSER_RECORDINGS.find((recording) => recording.request.file === "composer-inputs/join-s1-02.json"),
        "recording 4",
      ),
    ) as ComposeInput;
    expect({ ...join, row: input.row, turn: input.turn, inbound: input.inbound }).toEqual(input);
    mark("K-03", "input-s1-02.json", "taken");
  });

  it("invalid/refuse-frontier-in-input.json: refused before any call, and the double's loader refuses to hold a plan for it", async () => {
    const file = "invalid/refuse-frontier-in-input.json";
    const input = planFixture(file) as ComposeInput;
    expect(plans.validate("composeInput", input)).not.toEqual([]);
    const transport = composeTransport(LOG, []);
    const answer = await composerOn(transport.fetch).compose(input);
    expect(answer).toEqual({
      status: "refused",
      stage: "input",
      problems: [{ check: "frontier", at: "frontier" }],
      modelCalls: [],
    });
    expect(transport.finish()).toEqual([]);
    expect(() =>
      buildRecordedComposer({
        version: "v1",
        contract: "message-plan.v1",
        recordings: [
          { id: "frontier", kind: "composerPlan", request: input, seed: { fixture: "plan-s1-02.json" } },
        ],
      }),
    ).toThrow(RecordingRefusedError);
    mark("K-03", file, "refused");
  });

  it.each([
    ["invalid/refuse-format-not-allowed.json", [{ check: "formatNotAllowed", at: "formats[1]" }]],
    ["invalid/refuse-hold-slot.json", [{ check: "holdSlot", at: "lines[1].text" }]],
  ] as const)(
    "%s: answered for A6-14's confirmation row as a model might, it is refused before it leaves the composer, and the double's loader refuses to hold it",
    async (file, problems) => {
      const recording = must(
        COMPOSER_RECORDINGS.find((each) => each.seed?.fixture === "plan-confirmation-a6-14.json"),
        "A6-14's row",
      );
      const input = requestOf(recording) as ComposeInput;
      const refused = planFixture(file);
      expect(plans.validate("plan", refused)).not.toEqual([]);
      const run = await composeRow(input, {
        output: refused,
        source: { from: "refusedFixture", fixture: file },
      });
      expect(run.answer).toMatchObject({ status: "refused", stage: "plan", problems });
      expect(run.answer).not.toHaveProperty("plan");
      expect(() =>
        buildRecordedComposer({
          version: "v1",
          contract: "message-plan.v1",
          recordings: [{ id: "refused", kind: "composerPlan", request: recording.request, output: refused }],
        }),
      ).toThrow(RecordingRefusedError);
      mark("K-03", file, "refused");
    },
  );

  it("slots.json: the vocabulary the composer's checks read is the fixture's, hold left out (D66), and every plan the double holds opens only its slots", () => {
    const vocabulary = k03("slots.json") as { slots: { name: string }[] };
    const names = new Set(vocabulary.slots.map((slot) => slot.name));
    expect(new Set(SLOT_NAMES)).toEqual(names);
    expect(plans.slotNames).toEqual(names);
    expect(names.has("hold")).toBe(false);
    for (const recording of COMPOSER_RECORDINGS) {
      const plan = k03(must(recording.seed?.fixture, "a seed")) as MessagePlan;
      for (const slot of slotsOf(plan)) expect(names.has(slot), `${recording.id}: ${slot}`).toBe(true);
    }
    mark("K-03", "slots.json", "taken");
  });

  it("plan-email-copy.json: an email copy makes no call of its own; its plan is, word for word, the plan the composer gives its text row, A6-14's confirmation", async () => {
    const copy = k03("plan-email-copy.json") as EmailCopy;
    const run = await composeRow(a6_14Row(copy));
    expect(planOf(run.answer)).toEqual(copy.plan);
    expect(run.wire).toHaveLength(1);
    mark("K-03", "plan-email-copy.json", "given");
  });
});

/** K-03 v1's rowPlan: an email row that reuses its text row's plan. */
interface EmailCopy {
  readonly row: string;
  readonly copyOf: string;
  readonly plan: MessagePlan;
}

/**
 * The row the double holds whose plan is the email copy's: A6-14's confirmation. K-03 v1 gives no input for it, so the
 * double's input is T-1071's sample row (its own row id, outbox-a6-14-alex-1, where K-03 names the text row
 * outbox-a6-14-alex-text); the plan does not depend on the row's id.
 */
function a6_14Row(copy: EmailCopy): ComposeInput {
  const recording = must(
    COMPOSER_RECORDINGS.find(
      (each) => canonicalJson(k03(must(each.seed?.fixture, "a seed"))) === canonicalJson(copy.plan),
    ),
    "the row whose plan the email copy reuses",
  );
  return requestOf(recording) as ComposeInput;
}

describe("K-03's action-layer documents, where they meet the composer's plan", () => {
  it("final-two-sends.json: it is the email copy's text row (A6-14's confirmation), and it fills only the slots the plan the composer gives that row opens", async () => {
    const parts = k03("final-two-sends.json") as { row: string; slotValues: { slot: string }[] };
    const copy = k03("plan-email-copy.json") as EmailCopy;
    expect(parts.row).toBe(copy.copyOf);
    const opened = slotsOf(planOf((await composeRow(a6_14Row(copy))).answer));
    expect(parts.slotValues.length).toBeGreaterThan(0);
    for (const { slot } of parts.slotValues) expect(opened.has(slot), slot).toBe(true);
    mark("K-03", "final-two-sends.json", "notAStage");
  });

  it("every check result names only K-03's seven checks, the ones the composer's one rewrite is told", () => {
    const files = (
      planFixture("index.json") as { fixtures: { file: string; version: string; def: string }[] }
    ).fixtures
      .filter((entry) => entry.version === "v1" && entry.def === "checkResult")
      .map((entry) => entry.file);
    expect(files).toHaveLength(8);
    for (const file of files) {
      const result = k03(file) as { checks: { check: string }[] };
      for (const { check } of result.checks) expect(CHECK_NAMES, `${file}: ${check}`).toContain(check);
      mark("K-03", file, "notAStage");
    }
  });
});

// ---- One transport, and every fixture run --------------------------------------------------------------------------------

describe("the double's call log is the run's only transport, and every fixture is run", () => {
  it("no live call: every request was answered by a recording the double holds (or a refused fixture's own answer, or none for a timeout), every double call is one of its recordings, and there is one span per request", () => {
    expect(globalFetch).not.toHaveBeenCalled();
    expect(LOG.misses).toEqual([]);
    const held = new Map([...keysOf(RECORDINGS), ...keysOf(writtenSpec.recordings)]);
    for (const call of LOG.doubleCalls) expect(held.has(call.key), `${call.kind} ${call.key}`).toBe(true);
    const refusedFiles = [
      ...model.fixtures.entries,
      ...(planFixture("index.json") as { fixtures: { file: string; expect: string }[] }).fixtures,
    ]
      .filter((entry) => entry.expect === "refuse")
      .map((entry) => entry.file);
    for (const call of LOG.wire) {
      if (call.source.from === "double") {
        expect(LOG.doubleCalls).toContain(call.source.call);
        expect(call.answered).toBe(true);
      } else if (call.source.from === "refusedFixture") {
        expect(refusedFiles).toContain(call.source.fixture);
      } else {
        expect(call.answered).toBe(false);
      }
    }
    expect(SPANS).toHaveLength(LOG.wire.length);
    expect(sorted(SPANS.map((span) => usageLine(must(span.model_calls?.[0], "a model call"))))).toEqual(
      sorted(LOG.wire.map(wireLine)),
    );
    // The usage is live: some calls wrote the cached prefix and later ones read it (T-364).
    expect(SPANS.some((span) => (span.model_calls?.[0]?.cache_write_tokens ?? 0) > 0)).toBe(true);
    expect(SPANS.some((span) => (span.model_calls?.[0]?.cached_tokens ?? 0) > 0)).toBe(true);
    expect(new Set(SPANS.map((span) => span.model_calls?.[0]?.purpose))).toEqual(
      new Set(["safetyRead", "decideFirst", "decideCheck", "reread", "compose"]),
    );
  });

  it("every K-02 fixture (v1 and v1.1) and every K-03 v1 fixture came out as its index says: each accepted one given or taken, but for those WAITING and NOT_A_STAGE name; each refused one refused", () => {
    const k02 = model.fixtures.entries.map((entry) => ({
      key: `K-02 ${entry.file}`,
      def: entry.def ?? "",
      expect: entry.expect,
    }));
    const k03 = (
      planFixture("index.json") as {
        fixtures: { file: string; version: string; def: string; expect: string }[];
      }
    ).fixtures
      .filter((entry) => entry.version === "v1")
      .map((entry) => ({ key: `K-03 ${entry.file}`, def: entry.def, expect: entry.expect }));
    expect(k02).toHaveLength(37);
    expect(k03).toHaveLength(21);
    for (const entry of [...k02, ...k03]) {
      const verdict = VERDICTS.get(entry.key);
      expect(verdict, entry.key).toBeDefined();
      if (entry.expect === "refuse") {
        expect(verdict, entry.key).toBe("refused");
        continue;
      }
      expect(["given", "taken", "waiting", "notAStage"], entry.key).toContain(verdict);
      expect(verdict === "waiting", entry.key).toBe(WAITING[entry.key] !== undefined);
      expect(verdict === "notAStage", entry.key).toBe(NOT_A_STAGE[entry.def] !== undefined);
    }
    expect(sorted([...VERDICTS.keys()])).toEqual(sorted([...k02, ...k03].map((entry) => entry.key)));
  });
});
