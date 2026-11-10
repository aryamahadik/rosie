// Tests of the turn's one Sonnet re-read (T-370, C-116). Offline, as every AI test (J-02: no live call; CI makes none):
// decide (T-369) routes the turn and makes its two reads, then the re-read runs through decide's one read (T-368), the
// context bundle (T-367) and the real AI gateway (T-361), and the model answers from the recorded-model double (T-004)
// through one fake Messages API with Anthropic's prompt cache (T-364's), which answers the two reads and then the
// re-read. The global fetch fails the file if anything reaches it. K-02 v1's fixtures come through the model-contract
// fixture loader (T-004), K-09 v1's limit 6 pair is read as the contract gives it, and every result is checked against
// K-02's own schema. Names and values are the master's sample cast (rule 9).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DecideContext } from "../context";
import { MissingKeyError, SONNET_MODEL, HAIKU_MODEL } from "../gateway";
import {
  buildRecordedModel,
  loadModelContract,
  loadRecordedModel,
  type JsonObject,
  type ModelContract,
  type RecordedModel,
} from "../recorded-double";
import { RoutingRefusedError, choiceOrder } from "../routing";
import { isLabel, openTrace, spanProblems, type TraceContext } from "../../../runtime/src/trace";
import {
  DecideRequestError,
  RereadRefusedError,
  SETTLEMENTS,
  agreeReads,
  createDecider,
  createRereadLedger,
  rereadResult,
  twoReadResult,
  type AskPart,
  type ChoosePart,
  type DecidePart,
  type DecideRead,
  type DecideResult,
  type Decider,
  type DecideTurnAnswer,
  type DecideTurnDecided,
  type DecideTurnUnmapped,
  type FailingPart,
  type Read,
  type ReadRole,
  type RereadAfterReads,
  type RereadAnswer,
  type RereadDecided,
  type RereadRequest,
  type ResultRoute,
  type Stakes,
} from "./index";
import {
  CARD_FIXTURES,
  K02_CONTEXTS,
  KEY,
  MINI_A,
  MORE_FIXTURES,
  V0,
  WRITTEN_CONTEXTS,
  bundleOf,
  choiceIdsOf,
  deciderFor,
  drawFrom,
  fakeTurnApi,
  promptsFor,
  readJson,
  rolesOf,
  routeOf,
  routingBundle,
  stepOf,
  twoStep,
  userOf,
  writtenRecordings,
  type FakeTurnApi,
  type Raw,
  type StepAnswers,
} from "./test-support";

const globalFetch = vi.fn(() => {
  throw new Error("no network in a re-read test: the global fetch was called");
});

/** A K-09 v1 gateAndCommit fixture of a decided turn: its request's context and decide result, and its outcome. */
interface DecidedExchange {
  readonly request: {
    readonly input: { readonly decided: { context: DecideContext; decide: DecideResult } };
  };
  readonly outcome: { readonly error?: string; readonly parts?: readonly FailingPart[] };
}

/** K-09 v1's limit 6 pair: the gate refuses a value failing its words before the re-read, then takes the turn after it. */
const LIMIT6_FIRST = readJson(
  "contracts/tool-api/fixtures/commit-limit-6-reread-first.json",
) as DecidedExchange;
const LIMIT6_AFTER = readJson(
  "contracts/tool-api/fixtures/commit-limit-6-value-fails.json",
) as DecidedExchange;

/**
 * The limit 6 turn's context: K-09's own, with bundle v0's S1-02 card as the bundle holds it (the K-09 fixture writes
 * the card with two of its branches; the prompt cache lays out only the bundle's own cards). Nothing a decide result
 * holds comes from the card, so the turn's results are K-09's word for word.
 */
function limit6Context(): DecideContext {
  const card = V0.flows.A?.steps["S1-02"]?.card;
  if (card === undefined) throw new Error("bundle v0 holds S1-02's card");
  const context = structuredClone(LIMIT6_FIRST.request.input.decided.context);
  return { ...context, cards: [{ step: "S1-02", card }] };
}

let contract: ModelContract;
let shipped: RecordedModel;
let written: RecordedModel;
let LIMIT6: DecideContext;
const fixtures = new Map<string, DecideResult>();
const contexts = new Map<string, DecideContext>();

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
};
const fixtureOf = (file: string): DecideResult => must(fixtures.get(file), file);
const contextOf = (file: string): DecideContext => must(contexts.get(file), `the context of ${file}`);

/** The seeds of each turn's two reads, and the re-read's own, unless a test gives its own. */
const SEEDS: readonly number[] = [11, 12];
const REREAD_SEED = 13;
const ZONE = "America/New_York";

beforeAll(async () => {
  vi.stubGlobal("fetch", globalFetch);
  contract = await loadModelContract();
  shipped = await loadRecordedModel();
  for (const file of [...CARD_FIXTURES, ...MORE_FIXTURES]) {
    const fixture = contract.fixtures.read(file);
    expect(contract.validate("decideResult", fixture)).toEqual([]);
    fixtures.set(file, fixture as DecideResult);
    const k02 = K02_CONTEXTS[file];
    const context = k02 === undefined ? WRITTEN_CONTEXTS[file] : contract.fixtures.read(k02);
    expect(contract.validate("context", context), file).toEqual([]);
    contexts.set(file, context as DecideContext);
  }
  // K-09's limit 6 turn: its context is a K-02 context, and its three reads are recorded in the live form, each checked
  // by the double's loader against K-02 and both named rules on that context.
  LIMIT6 = limit6Context();
  expect(contract.validate("context", LIMIT6)).toEqual([]);
  for (const result of [LIMIT6_FIRST, LIMIT6_AFTER].map((pair) => pair.request.input.decided.decide))
    expect(contract.validate("decideResult", result)).toEqual([]);
  const roles = Object.fromEntries(
    [...fixtures].map(([file, fixture]) => [file, rolesOf({ reads: [...fixture.reads] })]),
  );
  written = await buildRecordedModel(
    writtenRecordings(
      roles,
      LIMIT6_AFTER.request.input.decided.decide.reads.map((read) => ({
        id: `limit-6-${read.role}`,
        context: LIMIT6,
        output: read.output as unknown as JsonObject,
        role: read.role,
      })),
    ),
  );
});
afterAll(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/** The double's read of a context in a role: the shipped recordings for K-02's own contexts, else the written ones. */
async function recorded(context: DecideContext, role: ReadRole): Promise<DecideRead> {
  const shippedTurns = Object.values(K02_CONTEXTS).map(
    (file) => (contract.fixtures.read(file) as DecideContext).turnId,
  );
  const double = shippedTurns.includes(context.turnId) ? shipped : written;
  return (await double.decide({ context: context as unknown as JsonObject, role })) as unknown as DecideRead;
}

/** A copy of a read with one change, as a model might answer instead. */
function changed(read: DecideRead, change: (copy: DecideRead) => void): DecideRead {
  const copy = structuredClone(read);
  change(copy);
  return copy;
}

const stepsOf = (read: DecideRead): StepAnswers => twoStep(read as unknown as Raw);

/** A copy of a read whose second part prices tile at `cents` (decide-two-requests.json's second part). */
const pricedAt = (read: DecideRead, cents: number): DecideRead =>
  changed(read, (copy) => {
    const part = copy.parts[1];
    if (part?.verb !== "choose") throw new Error("the second part chooses");
    const price = part.fields.find((field) => field.name === "price");
    if (price === undefined) throw new Error("the second part has a price");
    price.value = { cents, currency: "USD" };
  });

/** A copy of a read whose first part chooses a choice the context does not offer: the validator refuses it. */
const notOffered = (read: DecideRead): DecideRead =>
  changed(read, (copy) => {
    const part = copy.parts[0];
    if (part?.verb !== "choose") throw new Error("the part chooses");
    part.choice = "c-99";
  });

interface TurnRun {
  /** Decide's answer for the turn's two reads. */
  readonly decided: DecideTurnAnswer;
  readonly api: FakeTurnApi;
  readonly decider: Decider;
}

/**
 * Decides a context with its two reads per the route, the model answering each read from `reads` (default: the
 * double's read in that role), behind the real router, decide's one read and the AI gateway.
 */
async function decideTurn(
  context: DecideContext,
  reads: { first?: DecideRead; check?: DecideRead } = {},
  options: { seeds?: readonly number[]; fail?: () => number | null; trace?: TraceContext } = {},
): Promise<TurnRun> {
  const seeds = options.seeds ?? SEEDS;
  const route = routeOf(context, seeds);
  const api = fakeTurnApi(
    route,
    {
      first: stepsOf(reads.first ?? (await recorded(context, "first"))),
      check: stepsOf(reads.check ?? (await recorded(context, "check"))),
    },
    options.fail === undefined ? {} : { fail: options.fail },
  );
  const decider = deciderFor(context, api.fetch);
  const decided = await decider.decide(context, {
    draw: drawFrom(seeds),
    ...(options.trace !== undefined && { trace: options.trace }),
  });
  return { decided, api, decider };
}

/** The turn's re-read, the model answering it from `read`, with its own seed. */
async function rereadWith(
  run: TurnRun,
  request: RereadRequest,
  read: DecideRead,
  options: { seed?: number; trace?: TraceContext } = {},
): Promise<RereadAnswer> {
  run.api.rereadWith(stepsOf(read));
  return run.decider.reread(request, {
    draw: drawFrom([options.seed ?? REREAD_SEED]),
    ...(options.trace !== undefined && { trace: options.trace }),
  });
}

function decided(answer: DecideTurnAnswer): DecideTurnDecided {
  if (answer.status !== "decided") throw new Error(`the turn is ${answer.status}, not decided`);
  return answer;
}

function unmappedOf(answer: DecideTurnAnswer): DecideTurnUnmapped {
  if (answer.status !== "unmapped") throw new Error(`the turn is ${answer.status}, not unmapped`);
  return answer;
}

function rereadDecided(answer: RereadAnswer): RereadDecided {
  if (answer.status !== "decided") throw new Error(`the re-read is ${answer.status}, not decided`);
  return answer;
}

/** The turn loop's request after reads that disagree (T-251: why disagreed, no failing parts). */
const disagreed = (context: DecideContext, run: TurnRun): RereadAfterReads => ({
  why: "disagreed",
  context,
  decide: decided(run.decided).result,
  failing: [],
});

const outcomes = (result: DecideResult): string[] => result.parts.map((part) => part.outcome);
const settled = (answer: RereadDecided): [string | null, string][] =>
  answer.settlement.map((part) => [part.mark, part.settlement]);

/** The re-read's calls: the step of each and the model it went to. */
const stepsAndModels = (run: TurnRun): [number, string][] =>
  run.api.rereadCalls().map((call) => [stepOf(call.body).n, call.model]);

describe("decide-reads-disagree.json gives exactly one Sonnet re-read and the fixture's one-question result", () => {
  it("Sonnet picks the stand-in, Haiku another time; the one Sonnet re-read asks which: the result is the fixture's, word for word, the part one question with nothing changed", async () => {
    const file = "decide-reads-disagree.json";
    const context = contextOf(file);
    const fixture = fixtureOf(file);
    const run = await decideTurn(context);
    const before = decided(run.decided);
    // Before the re-read: the reads differ on the high-stakes part, so it holds one question and agreed is false.
    expect(before.result).toMatchObject({ stakes: "high", agreed: false, reread: false });
    expect(outcomes(before.result)).toEqual(["oneQuestion"]);
    const twoReadCalls = run.api.calls.length;

    const answer = rereadDecided(
      await rereadWith(run, disagreed(context, run), await recorded(context, "reread")),
    );

    // The fixture's result: three reads, the re-read run, the part the re-read's ask, one question, nothing changed.
    expect(answer.result).toEqual(fixture);
    expect(contract.validate("decideResult", answer.result)).toEqual([]);
    expect(answer.result.parts.filter((part) => part.outcome === "go")).toEqual([]);
    expect(settled(answer)).toEqual([["oneQuestion", "unclear"]]);
    expect(answer).toMatchObject({ status: "decided", why: "disagreed", model: "sonnet", stakes: "high" });
    // Exactly one re-read, and by Sonnet: one step-1 call with the purpose reread, then the one step-2 call of its one
    // part (the two-step wire form, T-368), both to Sonnet; nothing else was sent after the two reads.
    expect(stepsAndModels(run)).toEqual([
      [1, SONNET_MODEL],
      [2, SONNET_MODEL],
    ]);
    expect(run.api.calls).toHaveLength(twoReadCalls + 2);
    expect(answer.modelCalls.map((call) => [call.purpose, call.role, call.model, call.outcome])).toEqual([
      ["reread", "sonnet", SONNET_MODEL, "ok"],
      ["reread", "sonnet", SONNET_MODEL, "ok"],
    ]);
    // The re-read is a read of its own: its own seed and the choices in that seed's order.
    expect(answer.reread.seed).toBe(REREAD_SEED);
    expect(answer.reread.choiceOrder).toEqual(
      choiceOrder(
        context.choices.map((choice) => choice.choiceId),
        REREAD_SEED,
      ),
    );
    for (const call of run.api.rereadCalls())
      expect(choiceIdsOf(userOf(call.body))).toEqual(answer.reread.choiceOrder);
    // Sonnet's first read wrote the cached prefix, and the re-read's step 1 reads it (T-364).
    expect(run.api.rereadCalls()[0]?.usage?.cache_read_input_tokens).toBeGreaterThan(0);
  });
});

describe("a second request for a re-read in the same turn is refused, before any call", () => {
  it("after the turn's re-read: the same request, the result it gave, a copy of the result before it, and the gate's signal are each refused, and nothing more is sent", async () => {
    const context = contextOf("decide-reads-disagree.json");
    const run = await decideTurn(context);
    const request = disagreed(context, run);
    const first = rereadDecided(await rereadWith(run, request, await recorded(context, "reread")));
    const sent = run.api.calls.length;
    const again: RereadRequest[] = [
      request,
      { ...request, decide: first.result },
      { ...request, decide: structuredClone(request.decide) },
      { why: "valueFailsWords", context, decide: first.result, failing: [{ part: 0, fields: ["time"] }] },
    ];
    for (const next of again)
      await expect(run.decider.reread(next, { draw: drawFrom([REREAD_SEED]) })).rejects.toThrow(
        RereadRefusedError,
      );
    expect(run.api.calls).toHaveLength(sent);
  });

  it("two requests at once: one re-read runs, the other is refused", async () => {
    const context = contextOf("decide-reads-disagree.json");
    const run = await decideTurn(context);
    run.api.rereadWith(stepsOf(await recorded(context, "reread")));
    const request = disagreed(context, run);
    const both = await Promise.allSettled([
      run.decider.reread(request, { draw: drawFrom([REREAD_SEED]) }),
      run.decider.reread(request, { draw: drawFrom([REREAD_SEED + 1]) }),
    ]);
    expect(both.map((settledOne) => settledOne.status)).toEqual(["fulfilled", "rejected"]);
    const [, refused] = both;
    expect(refused.status === "rejected" && refused.reason instanceof RereadRefusedError).toBe(true);
    expect(stepsAndModels(run)).toEqual([
      [1, SONNET_MODEL],
      [2, SONNET_MODEL],
    ]);
  });

  it("an unmapped turn's re-read, which the AI layer asks for itself, is the turn's one: a second is refused", async () => {
    const context = contextOf("decide-bare-2.json");
    const run = await decideTurn(context, { check: notOffered(await recorded(context, "check")) });
    const unmapped = unmappedOf(run.decided);
    const request: RereadRequest = { why: "unmapped", context, unmapped };
    await rereadWith(run, request, await recorded(context, "first"));
    const sent = run.api.calls.length;
    for (const next of [request, { ...request, unmapped: structuredClone(unmapped) }])
      await expect(run.decider.reread(next, { draw: drawFrom([REREAD_SEED]) })).rejects.toThrow(
        RereadRefusedError,
      );
    expect(run.api.calls).toHaveLength(sent);
  });

  it("a request refused for what it asks does not use the turn's re-read; a new decide of the turn (a rerun of it) opens its one re-read again, and the run before stays refused", async () => {
    const context = contextOf("decide-reads-disagree.json");
    const run = await decideTurn(context);
    const request = disagreed(context, run);
    const meaningSearch = { ...request, why: "noneFits" } as unknown as RereadRequest;
    await expect(run.decider.reread(meaningSearch)).rejects.toThrow(DecideRequestError);
    const reread = await recorded(context, "reread");
    expect((await rereadWith(run, request, reread)).status).toBe("decided");
    // The lease reruns the turn from its sealed texts: decide reads it again, and that run has its own one re-read.
    run.api.twoReadsAgain();
    const rerun = await run.decider.decide(context, { draw: drawFrom(SEEDS) });
    const fresh = decided(rerun).result;
    expect(fresh).not.toBe(request.decide);
    expect(fresh).toEqual(request.decide);
    await expect(run.decider.reread(request, { draw: drawFrom([REREAD_SEED]) })).rejects.toThrow(
      RereadRefusedError,
    );
    const rerunRead = rereadDecided(await rereadWith(run, { ...request, decide: fresh }, reread));
    expect(rerunRead.result).toEqual(fixtureOf("decide-reads-disagree.json"));
    await expect(
      run.decider.reread({ ...request, decide: fresh }, { draw: drawFrom([REREAD_SEED]) }),
    ).rejects.toThrow(RereadRefusedError);
  });

  it("the ledger holds a bounded number of turns, the oldest let go first, and never lets one result be re-read twice", () => {
    const ledger = createRereadLedger(2);
    const results = [{}, {}, {}, {}];
    ledger.claim("turn-1", must(results[0], "a result"));
    ledger.claim("turn-2", must(results[1], "a result"));
    expect(() => {
      ledger.claim("turn-2", must(results[2], "a result"));
    }).toThrow(RereadRefusedError);
    ledger.claim("turn-3", must(results[2], "a result"));
    // turn-1 was let go: another result of it may be re-read, the one re-read before may not.
    expect(() => {
      ledger.claim("turn-1", must(results[0], "a result"));
    }).toThrow(RereadRefusedError);
    ledger.claim("turn-1", must(results[3], "a result"));
    ledger.open("turn-3");
    expect(() => {
      ledger.claim("turn-3", must(results[2], "a result"));
    }).toThrow(RereadRefusedError);
  });
});

describe("a value-failed-its-words signal from the turn loop triggers the re-read (K-09 README default 25)", () => {
  const failingOf = (pair: DecidedExchange): readonly FailingPart[] => must(pair.outcome.parts, "the parts");

  it("commit-limit-6-reread-first.json: both Haiku reads give kinds 'Barbershop, plumbing', the gate names part 0's kinds; the one Sonnet re-read gives the same value: the result is commit-limit-6-value-fails.json's, the part going to the gate again", async () => {
    const run = await decideTurn(LIMIT6);
    const before = decided(run.decided);
    // Decide's two reads agree, and the result is the one the gate refused (valueFailsWords) before any write.
    expect(before.result).toEqual(LIMIT6_FIRST.request.input.decided.decide);
    expect(LIMIT6_FIRST.outcome.error).toBe("valueFailsWords");
    const answer = rereadDecided(
      await rereadWith(
        run,
        { why: "valueFailsWords", context: LIMIT6, decide: before.result, failing: failingOf(LIMIT6_FIRST) },
        await recorded(LIMIT6, "reread"),
      ),
    );
    // The result the gate takes after the re-read, word for word: limit 6 then asks one question (K-09).
    expect(answer.result).toEqual(LIMIT6_AFTER.request.input.decided.decide);
    expect(contract.validate("decideResult", answer.result)).toEqual([]);
    expect(answer.settlement.map((part) => [part.mark, part.failed, part.settlement])).toEqual([
      ["agreed", true, "confirmed"],
    ]);
    expect(answer).toMatchObject({ why: "valueFailsWords", model: "sonnet", stakes: "low" });
    expect(stepsAndModels(run)).toEqual([
      [1, SONNET_MODEL],
      [2, SONNET_MODEL],
    ]);
    expect(answer.modelCalls.map((call) => call.purpose)).toEqual(["reread", "reread"]);
  });

  it("a re-read that gives the failing field another value: the reads now differ on it, so the part is one question with nothing changed (never a commit on a difference)", async () => {
    const run = await decideTurn(LIMIT6);
    const before = decided(run.decided).result;
    const reread = changed(await recorded(LIMIT6, "reread"), (copy) => {
      const part = copy.parts[0];
      if (part?.verb !== "choose") throw new Error("the part chooses");
      part.fields = part.fields.map((field) => ({ ...field, value: "Barbershop" }));
    });
    const answer = rereadDecided(
      await rereadWith(
        run,
        { why: "valueFailsWords", context: LIMIT6, decide: before, failing: failingOf(LIMIT6_FIRST) },
        reread,
      ),
    );
    expect(answer.result.parts).toEqual([{ part: reread.parts[0], outcome: "oneQuestion" }]);
    expect(answer.result).toMatchObject({ agreed: true, reread: true, language: "en" });
    expect(settled(answer)).toEqual([["agreed", "unclear"]]);
    expect(contract.validate("decideResult", answer.result)).toEqual([]);
  });

  it("decide-two-requests.json: the gate names the price's value, and the re-read prices tile otherwise: the price is one question, and the block, which the gate did not name, goes as decide gave it", async () => {
    const context = contextOf("decide-two-requests.json");
    const run = await decideTurn(context);
    const before = decided(run.decided).result;
    expect(outcomes(before)).toEqual(["go", "go"]);
    const reread = pricedAt(await recorded(context, "first"), 1300);
    const answer = rereadDecided(
      await rereadWith(
        run,
        { why: "valueFailsWords", context, decide: before, failing: [{ part: 1, fields: ["price"] }] },
        reread,
      ),
    );
    expect(answer.result.parts[0]).toBe(before.parts[0]);
    expect(answer.result.parts[1]).toEqual({ part: reread.parts[1], outcome: "oneQuestion" });
    expect(answer.settlement.map((part) => [part.failed, part.settlement])).toEqual([
      [false, "untouched"],
      [true, "unclear"],
    ]);
  });

  it("refused before any call: no part named, a part the result does not have, a part named twice or holding one question, a field its part does not carry, and failing values on a disagreement", async () => {
    const run = await decideTurn(LIMIT6);
    const before = decided(run.decided).result;
    const asked = (failing: readonly FailingPart[]): RereadRequest => ({
      why: "valueFailsWords",
      context: LIMIT6,
      decide: before,
      failing,
    });
    const bad: RereadRequest[] = [
      asked([]),
      asked([{ part: 1, fields: ["kinds"] }]),
      asked([{ part: 0.5, fields: ["kinds"] }]),
      asked([
        { part: 0, fields: ["kinds"] },
        { part: 0, fields: ["kinds"] },
      ]),
      asked([{ part: 0, fields: [] }]),
      asked([{ part: 0, fields: ["price"] }]),
    ];
    for (const request of bad) await expect(run.decider.reread(request)).rejects.toThrow(DecideRequestError);

    const disagree = await decideTurn(contextOf("decide-reads-disagree.json"));
    const oneQuestion = decided(disagree.decided).result;
    await expect(
      disagree.decider.reread({
        why: "valueFailsWords",
        context: contextOf("decide-reads-disagree.json"),
        decide: oneQuestion,
        failing: [{ part: 0, fields: ["time"] }],
      }),
    ).rejects.toThrow(DecideRequestError);
    await expect(
      disagree.decider.reread({
        ...disagreed(contextOf("decide-reads-disagree.json"), disagree),
        failing: [{ part: 0, fields: ["time"] }],
      }),
    ).rejects.toThrow(DecideRequestError);
    expect(run.api.rereadCalls()).toEqual([]);
    expect(disagree.api.rereadCalls()).toEqual([]);
    // None of them used the turn's re-read: the gate's real signal still gets it.
    const answer = await rereadWith(run, asked(failingOf(LIMIT6_FIRST)), await recorded(LIMIT6, "reread"));
    expect(answer.status).toBe("decided");
  });
});

describe("agreed parts are untouched", () => {
  it.each([
    ["the first read's", 1200],
    ["the check read's", 1300],
  ] as const)(
    "decide-two-requests.json, low stakes: the reads agree on the block and differ on the price (12 and 13 dollars a foot); a re-read giving %s price settles it and its part goes, while the block goes as decide gave it, though the re-read reads the block otherwise",
    async (_which, cents) => {
      const context = contextOf("decide-two-requests.json");
      const first = await recorded(context, "first");
      const run = await decideTurn(context, { check: pricedAt(await recorded(context, "check"), 1300) });
      const before = decided(run.decided).result;
      expect(outcomes(before)).toEqual(["go", "oneQuestion"]);
      // The re-read takes the block for another hub case: an agreed part, so it is not the re-read's to change.
      const reread = changed(pricedAt(first, cents), (copy) => {
        copy.parts[0] = {
          verb: "choose",
          quote: "block thursday afternoon",
          question: "S11-12",
          choice: "c-02",
          fields: [],
        };
      });
      const answer = rereadDecided(await rereadWith(run, disagreed(context, run), reread));
      expect(answer.result.parts[0]).toBe(before.parts[0]);
      expect(answer.result.parts[0]).toEqual({ part: first.parts[0], outcome: "go" });
      expect(answer.result.parts[1]).toEqual({ part: reread.parts[1], outcome: "go" });
      expect(settled(answer)).toEqual([
        ["agreed", "untouched"],
        ["notAgreed", "settled"],
      ]);
      expect(answer.result).toMatchObject({ agreed: false, reread: true, language: "en", stakes: "low" });
      expect(answer.result.reads.map((read) => [read.model, read.role])).toEqual([
        ["haiku", "first"],
        ["haiku", "check"],
        ["sonnet", "reread"],
      ]);
      expect(answer.result.reads[2]?.output).toEqual(reread);
      expect(contract.validate("decideResult", answer.result)).toEqual([]);
    },
  );

  it("decide-two-requests.json: a re-read giving a third price, or cutting the text into one part, leaves the price one question with nothing changed; the block still goes as decide gave it", async () => {
    const context = contextOf("decide-two-requests.json");
    const first = await recorded(context, "first");
    const onePart = changed(first, (copy) => {
      copy.parts.splice(1, 1);
    });
    for (const [reread, kept] of [
      [pricedAt(first, 1400), "reread"],
      [onePart, "check"],
    ] as const) {
      const check = pricedAt(await recorded(context, "check"), 1300);
      const run = await decideTurn(context, { check });
      const before = decided(run.decided).result;
      const answer = rereadDecided(await rereadWith(run, disagreed(context, run), reread));
      expect(answer.result.parts[0]).toBe(before.parts[0]);
      expect(answer.result.parts[1]).toEqual({
        part: kept === "reread" ? reread.parts[1] : check.parts[1],
        outcome: "oneQuestion",
      });
      expect(settled(answer)).toEqual([
        ["agreed", "untouched"],
        ["notAgreed", "unclear"],
      ]);
      expect(contract.validate("decideResult", answer.result)).toEqual([]);
    }
  });

  it("high stakes: Sonnet and Haiku differ on the price; a re-read siding with Sonnet still ends it in one question (arch 06 line 287), and the block goes", async () => {
    const base = contextOf("decide-two-requests.json");
    const context: DecideContext = {
      ...structuredClone(base),
      choices: base.choices.map((choice) =>
        choice.choiceId === "c-07"
          ? {
              ...structuredClone(choice),
              stakes: "high" as const,
              stakesFrom: [{ why: "unknown", step: null, ref: null }],
            }
          : structuredClone(choice),
      ),
    };
    expect(contract.validate("context", context)).toEqual([]);
    const first = await recorded(base, "first");
    const run = await decideTurn(context, { first, check: pricedAt(first, 1300) });
    const before = decided(run.decided).result;
    expect(before).toMatchObject({ stakes: "high", routing: { first: "sonnet", second: "haiku" } });
    const answer = rereadDecided(await rereadWith(run, disagreed(context, run), first));
    expect(answer.result.parts[0]).toBe(before.parts[0]);
    expect(answer.result.parts[1]).toEqual({ part: first.parts[1], outcome: "oneQuestion" });
    expect(settled(answer)).toEqual([
      ["agreed", "untouched"],
      ["oneQuestion", "unclear"],
    ]);
    expect(contract.validate("decideResult", answer.result)).toEqual([]);
  });

  it.each([
    ["English, one of the two", "en", "en"],
    ["Spanish, the other", "es", "es"],
    ["French, neither", "fr", null],
  ] as const)(
    "a language-only difference (CQ-07): every part goes as decide gave it, and a re-read in %s (%s) leaves the language %s",
    async (_which, language, expected) => {
      const context = contextOf("decide-two-requests.json");
      const first = await recorded(context, "first");
      const inSpanish = changed(await recorded(context, "check"), (copy) => {
        copy.language = "es";
      });
      const run = await decideTurn(context, { check: inSpanish });
      const before = decided(run.decided).result;
      expect(before).toMatchObject({ agreed: false, language: null });
      const reread = changed(first, (copy) => {
        copy.language = language;
      });
      const answer = rereadDecided(await rereadWith(run, disagreed(context, run), reread));
      expect(answer.result.parts).toEqual(before.parts);
      answer.result.parts.forEach((part, k) => {
        expect(part).toBe(before.parts[k]);
      });
      expect(answer.result).toMatchObject({ agreed: false, reread: true, language: expected });
      expect(contract.validate("decideResult", answer.result)).toEqual([]);
    },
  );
});

describe("a refused read ends the turn in one question with nothing changed; models down send nothing on", () => {
  it("decide-bare-2.json, the check read refused (a choice not offered): the AI layer's one Sonnet re-read runs, and the turn ends in one question with nothing changed, as K-02 v1's result holds no refused read (CQ-162 (a))", async () => {
    const context = contextOf("decide-bare-2.json");
    const run = await decideTurn(context, { check: notOffered(await recorded(context, "check")) });
    const unmapped = unmappedOf(run.decided);
    expect(unmapped.refused).toEqual(["check"]);
    const mapped = await rereadWith(
      run,
      { why: "unmapped", context, unmapped },
      await recorded(context, "first"),
    );
    expect(mapped).toMatchObject({
      status: "unmapped",
      why: "unmapped",
      refused: ["check"],
      end: "oneQuestion",
      stakes: "high",
      model: "sonnet",
    });
    expect("result" in mapped).toBe(false);
    expect(mapped.reread.status).toBe("ok");
    expect(stepsAndModels(run)).toEqual([
      [1, SONNET_MODEL],
      [2, SONNET_MODEL],
    ]);
    expect(mapped.modelCalls.map((call) => call.purpose)).toEqual(["reread", "reread"]);

    // Still unmapped: the re-read is refused too.
    const again = await decideTurn(context, {
      first: notOffered(await recorded(context, "first")),
      check: notOffered(await recorded(context, "check")),
    });
    const both = unmappedOf(again.decided);
    const still = await rereadWith(
      again,
      { why: "unmapped", context, unmapped: both },
      notOffered(await recorded(context, "first")),
    );
    expect(still).toMatchObject({
      status: "unmapped",
      refused: ["first", "check", "reread"],
      end: "oneQuestion",
    });
    expect(still.reread.status).toBe("refused");
  });

  it("a re-read the validator refuses after a disagreement: the turn ends in one question with nothing changed, the agreed block included, as K-02 v1 cannot hold it", async () => {
    const context = contextOf("decide-two-requests.json");
    const run = await decideTurn(context, { check: pricedAt(await recorded(context, "check"), 1300) });
    const reread = changed(await recorded(context, "first"), (copy) => {
      const part = copy.parts[1];
      if (part?.verb !== "choose") throw new Error("the second part chooses");
      part.choice = "c-99";
    });
    const answer = await rereadWith(run, disagreed(context, run), reread);
    expect(answer).toMatchObject({
      status: "unmapped",
      why: "disagreed",
      refused: ["reread"],
      end: "oneQuestion",
    });
    expect("result" in answer).toBe(false);
  });

  it("both models down at the re-read: modelsDown, no result, every attempt kept (Sonnet twice, then Haiku once)", async () => {
    let down = false;
    const context = contextOf("decide-reads-disagree.json");
    const run = await decideTurn(context, {}, { fail: () => (down ? 529 : null) });
    down = true;
    const answer = await rereadWith(run, disagreed(context, run), await recorded(context, "reread"));
    expect(answer.status).toBe("modelsDown");
    expect("result" in answer).toBe(false);
    expect(answer.modelCalls.map((call) => [call.purpose, call.role, call.outcome])).toEqual([
      ["reread", "sonnet", "failed"],
      ["reread", "sonnet", "failed"],
      ["reread", "haiku", "failed"],
    ]);
    expect(run.api.rereadCalls().map((call) => call.model)).toEqual([
      SONNET_MODEL,
      SONNET_MODEL,
      HAIKU_MODEL,
    ]);
  });
});

describe("nothing sent for a request the re-read cannot serve; no words in a span or an error", () => {
  it("refused before any call: the re-read after meaning search, another turn or bundle, stakes or a read pair not the route's, a result whose part goes where its reads differ, reads that are not the context's, reads that agree, an answer decide did not give, no key", async () => {
    const context = contextOf("decide-reads-disagree.json");
    const run = await decideTurn(context);
    const request = disagreed(context, run);
    const result = request.decide;
    const goes: DecideResult = {
      ...result,
      parts: result.parts.map((part) => ({ ...part, outcome: "go" as const })),
    };
    const alone = changed(must(result.reads[0], "the first read").output, (copy) => {
      copy.parts = [{ verb: "no_op", quote: "not in the text" }];
    });
    const refusals: [RereadRequest, new (message: string) => Error][] = [
      [{ ...request, why: "noneFits" } as unknown as RereadRequest, DecideRequestError],
      [{ ...request, context: { ...context, turnId: "turn-another" } }, DecideRequestError],
      [{ ...request, context: contextOf("decide-two-requests.json") }, DecideRequestError],
      [{ ...request, decide: { ...result, stakes: "low" } }, DecideRequestError],
      [
        { ...request, decide: { ...result, routing: { first: "haiku", second: "haiku" } } },
        DecideRequestError,
      ],
      [{ ...request, decide: goes }, DecideRequestError],
      [{ ...request, decide: { ...result, reads: [...result.reads].reverse() } }, DecideRequestError],
      [
        {
          ...request,
          decide: {
            ...result,
            reads: [{ ...must(result.reads[0], "the first read"), output: alone }, ...result.reads.slice(1)],
          },
        },
        DecideRequestError,
      ],
      [{ ...request, context: { ...context, choices: [] } }, RoutingRefusedError],
    ];
    for (const [bad, error] of refusals) await expect(run.decider.reread(bad)).rejects.toThrow(error);

    // Reads that agree: nothing to re-read.
    const agreeing = await decideTurn(contextOf("decide-two-requests.json"));
    await expect(
      agreeing.decider.reread(disagreed(contextOf("decide-two-requests.json"), agreeing)),
    ).rejects.toThrow(DecideRequestError);
    // An unmapped answer decide did not give: both reads mapped, or one down.
    const unmappedRun = await decideTurn(contextOf("decide-bare-2.json"), {
      check: notOffered(await recorded(contextOf("decide-bare-2.json"), "check")),
    });
    const unmapped = unmappedOf(unmappedRun.decided);
    const [firstAnswer] = unmapped.answers;
    for (const forged of [
      { ...unmapped, answers: [firstAnswer, firstAnswer] as const, refused: [] },
      { ...unmapped, refused: ["first"] as const },
      { ...unmapped, status: "decided" } as unknown as DecideTurnUnmapped,
    ])
      await expect(
        unmappedRun.decider.reread({
          why: "unmapped",
          context: contextOf("decide-bare-2.json"),
          unmapped: forged,
        }),
      ).rejects.toThrow(DecideRequestError);
    expect(run.api.rereadCalls()).toEqual([]);
    expect(agreeing.api.rereadCalls()).toEqual([]);
    expect(unmappedRun.api.rereadCalls()).toEqual([]);

    // No key: decide's one read refuses before any call.
    const keyless = createDecider({
      bundle: routingBundle(MINI_A),
      prompts: promptsFor(MINI_A),
      env: {},
      fetch: run.api.fetch,
    });
    run.api.rereadWith(stepsOf(await recorded(context, "reread")));
    await expect(keyless.reread(request, { draw: drawFrom([REREAD_SEED]) })).rejects.toThrow(MissingKeyError);
    expect(run.api.rereadCalls()).toEqual([]);
  });

  it("the trace holds one K-08 portCall span per re-read call and no word; the span facts are the re-read's seed and the context's counts", async () => {
    const context = contextOf("decide-reads-disagree.json");
    const trace = openTrace({
      openedBy: "textWebhook",
      bundleId: bundleOf(context).manifest.bundleId,
      handleRef: "handle-alex",
    });
    trace.setTurn(context.turnId);
    const run = await decideTurn(context, {}, { trace });
    const spansBefore = trace.spans.length;
    const answer = rereadDecided(
      await rereadWith(run, disagreed(context, run), await recorded(context, "reread"), { trace }),
    );
    const spans = trace.spans.slice(spansBefore);
    expect(spans).toHaveLength(run.api.rereadCalls().length);
    for (const span of spans) {
      expect(span.hop).toBe("portCall");
      expect(spanProblems(span)).toEqual([]);
    }
    const part = answer.result.parts[0]?.part;
    if (part?.verb !== "ask") throw new Error("the part asks");
    const logged = JSON.stringify(trace.toTrace());
    const never = [
      ...context.texts.map((text) => text.words),
      part.quote,
      part.unclear,
      ...context.writer.people.map((person) => person.name),
      context.writer.handle,
      KEY,
    ];
    for (const value of never) {
      expect(logged).not.toContain(value);
      expect(JSON.stringify(answer.span)).not.toContain(value);
      expect(JSON.stringify(answer.settlement.map((entry) => [entry.mark, entry.settlement]))).not.toContain(
        value,
      );
    }
    expect(answer.span).toMatchObject({ rereadSeed: REREAD_SEED, texts: 1, choices: context.choices.length });
    for (const value of Object.values(answer.span)) expect(typeof value).toBe("number");
    for (const label of SETTLEMENTS) expect(isLabel(label)).toBe(true);
  });

  it("a refusal names places, fields and rules, never the words of a read or a text", async () => {
    const context = contextOf("decide-reads-disagree.json");
    const run = await decideTurn(context);
    const request = disagreed(context, run);
    const secret = "my card is 4242 and I live at 12 Elm";
    const bad: RereadRequest[] = [
      {
        ...request,
        decide: {
          ...request.decide,
          reads: request.decide.reads.map((read) => ({
            ...read,
            output: { language: "en", parts: [{ verb: "no_op", quote: secret }] },
          })),
        },
      },
      { ...request, failing: [{ part: 0, fields: [secret] }] },
    ];
    for (const one of bad) {
      const error = await run.decider.reread(one).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(DecideRequestError);
      const message = error instanceof Error ? error.message : "";
      for (const word of ["4242", "Elm", "card is", "Avery", "Saturday"]) expect(message).not.toContain(word);
    }
  });
});

describe("rereadResult: what the re-read makes of each part (no model)", () => {
  const ROUTE: Readonly<Record<Stakes, ResultRoute>> = {
    low: {
      turnId: "turn-a7-17-alex-either",
      bundleId: MINI_A.manifest.bundleId,
      stakes: "low",
      routing: { first: "haiku", second: "haiku" },
    },
    high: {
      turnId: "turn-a7-17-alex-either",
      bundleId: MINI_A.manifest.bundleId,
      stakes: "high",
      routing: { first: "sonnet", second: "haiku" },
    },
  };
  const CHOOSE: ChoosePart = {
    verb: "choose",
    quote: "or I'll just come Saturday at 2",
    question: "oq-a7-17",
    choice: "c-02",
    fields: [{ name: "time", value: { utc: "2026-10-24T18:00:00Z", zone: ZONE }, words: "Saturday at 2" }],
  };
  const ASK: AskPart = {
    verb: "ask",
    quote: "can Avery do it, or I'll just come Saturday at 2",
    questions: ["oq-a7-17"],
    unclear: "Alex names both the stand-in and another time.",
  };
  const read = (role: ReadRole, parts: DecidePart[], language = "en"): Read => ({
    model: role === "check" ? "haiku" : "sonnet",
    role,
    output: { language, parts },
  });

  /** The result before and after a re-read: the first and check reads' parts, then the re-read's. */
  function after(
    stakes: Stakes,
    first: DecidePart[],
    check: DecidePart[],
    again: DecidePart[],
    failing: readonly FailingPart[] = [],
  ): { before: DecideResult; result: DecideResult; settlement: string[] } {
    const one = read("first", first);
    const other = read("check", check);
    const agreement = agreeReads(one.output, other.output, stakes);
    const before = twoReadResult(ROUTE[stakes], one, other, agreement);
    const { result, settlement } = rereadResult(before, agreement, read("reread", again), failing);
    expect(contract.validate("decideResult", result)).toEqual([]);
    return { before, result, settlement: settlement.map((entry) => entry.settlement) };
  }

  const LATER: ChoosePart = {
    ...CHOOSE,
    fields: CHOOSE.fields.map((field) => ({ ...field, value: { utc: "2026-10-24T19:00:00Z", zone: ZONE } })),
  };
  const OTHERS: readonly [string, DecidePart, DecidePart][] = [
    ["another value", CHOOSE, LATER],
    ["another choice", CHOOSE, { ...CHOOSE, choice: "c-03", fields: [] }],
    ["a field less", CHOOSE, { ...CHOOSE, fields: [] }],
    ["another verb", CHOOSE, ASK],
  ];

  it.each(OTHERS)(
    "%s: on low stakes a re-read giving either read's part settles it, and the re-read's part goes; on high stakes it stays one question",
    (_why, one, other) => {
      for (const [again, quote] of [
        [one, "Saturday at 2"],
        [other, "or I'll just come"],
      ] as const) {
        // The re-read quotes the text its own way: quotes are never compared.
        const mine = { ...again, quote } as DecidePart;
        const low = after("low", [one], [other], [mine]);
        expect(low.settlement).toEqual(["settled"]);
        expect(low.result.parts).toEqual([{ part: mine, outcome: "go" }]);
        const high = after("high", [one], [other], [mine]);
        expect(high.settlement).toEqual(["unclear"]);
        expect(high.result.parts).toEqual([{ part: mine, outcome: "oneQuestion" }]);
      }
    },
  );

  it("a third answer, or none there, leaves the part one question: holding the re-read's part, else the last read's", () => {
    const third = after("low", [CHOOSE], [LATER], [{ ...CHOOSE, choice: "c-01", fields: [] }]);
    expect(third.settlement).toEqual(["unclear"]);
    expect(third.result.parts[0]?.part).toMatchObject({ choice: "c-01" });
    const none = after("low", [ASK, CHOOSE], [ASK, LATER], [ASK]);
    expect(none.settlement).toEqual(["untouched", "unclear"]);
    expect(none.result.parts[1]).toEqual({ part: LATER, outcome: "oneQuestion" });
    // A part the check read lacks: the re-read giving the first read's settles it on low stakes.
    const missing = after("low", [ASK, CHOOSE], [ASK], [ASK, CHOOSE]);
    expect(missing.settlement).toEqual(["untouched", "settled"]);
    // A part only the re-read gives: no two reads give it, so it is one question.
    const extra = after("low", [ASK], [ASK], [ASK, CHOOSE]);
    expect(extra.settlement).toEqual(["untouched", "unclear"]);
    expect(extra.result.parts[1]).toEqual({ part: CHOOSE, outcome: "oneQuestion" });
  });

  it("an agreed part is untouched whatever the re-read gives; named by the gate, it goes again only when the re-read gives it alike", () => {
    for (const stakes of ["low", "high"] as const) {
      const kept = after(stakes, [ASK, CHOOSE], [ASK, LATER], [CHOOSE, CHOOSE]);
      expect(kept.settlement[0]).toBe("untouched");
      expect(kept.result.parts[0]).toBe(kept.before.parts[0]);
      const confirmed = after(stakes, [CHOOSE], [CHOOSE], [CHOOSE], [{ part: 0, fields: ["time"] }]);
      expect(confirmed.settlement).toEqual(["confirmed"]);
      expect(confirmed.result.parts[0]).toBe(confirmed.before.parts[0]);
      const unclear = after(stakes, [CHOOSE], [CHOOSE], [LATER], [{ part: 0, fields: ["time"] }]);
      expect(unclear.settlement).toEqual(["unclear"]);
      expect(unclear.result.parts).toEqual([{ part: LATER, outcome: "oneQuestion" }]);
      expect(unclear.result.agreed).toBe(true);
    }
  });

  it("only untouched, confirmed and settled parts go; every other part is one question", () => {
    const cases = [
      after("low", [ASK, CHOOSE], [ASK, LATER], [CHOOSE, CHOOSE]),
      after("high", [ASK, CHOOSE], [ASK, LATER], [ASK, CHOOSE]),
      after("low", [CHOOSE], [CHOOSE], [LATER], [{ part: 0, fields: ["time"] }]),
      after("low", [ASK], [ASK], [ASK, CHOOSE]),
    ];
    for (const { result, settlement } of cases) {
      result.parts.forEach((part, k) => {
        const going = ["untouched", "confirmed", "settled"].includes(settlement[k] ?? "");
        expect(part.outcome).toBe(going ? "go" : "oneQuestion");
      });
      expect(result.reread).toBe(true);
      expect(result.reads.map((one) => one.role)).toEqual(["first", "check", "reread"]);
    }
  });
});
