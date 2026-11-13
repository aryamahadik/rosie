// Tests of decide's two reads and their agreement (T-369, C-115). Offline, as every AI test (J-02: no live call; CI makes
// none): the router (T-363) routes each turn by its stakes and the bundle's policy, decide's one read (T-368) makes each
// of the two reads through the context bundle (T-367) and the real AI gateway (T-361), and the model answers from the
// recorded-model double (T-004) through a fake Messages API with Anthropic's prompt cache (T-364's), which tells the two
// reads apart by the order each lists the choices in (each read's own seed). The global fetch fails the file if anything
// reaches it. K-02 v1's fixtures come through the model-contract fixture loader (T-004), and every decide result is
// checked against K-02's own schema. Names and values are the master's sample cast (rule 9).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { FakeCachingApi } from "../cache/test-support";
import type { DecideContext } from "../context";
import { GatewayConfigError, HAIKU_MODEL, MissingKeyError, SONNET_MODEL, type FetchLike } from "../gateway";
import {
  buildRecordedModel,
  loadModelContract,
  loadRecordedModel,
  type JsonObject,
  type ModelContract,
  type RecordedModel,
} from "../recorded-double";
import { RoutingPolicyError, RoutingRefusedError, type RoutingPolicy, type TurnRoute } from "../routing";
import { isLabel, openTrace, spanProblems, type TraceContext } from "../../../runtime/src/trace";
import {
  DIFFERENCES,
  DecideRequestError,
  agreeReads,
  createDecider,
  partDifferences,
  type AskPart,
  type ChoosePart,
  type DecidePart,
  type DecideRead,
  type DecideResult,
  type DecideTurnAnswer,
  type DecideTurnDecided,
  type Difference,
  type EnterPart,
  type HandOffPart,
  type ReadRole,
  type Stakes,
} from "./index";
import {
  CARD_FIXTURES,
  ENV,
  K02_CONTEXTS,
  KEY,
  MINI_A,
  MINI_B,
  MORE_FIXTURES,
  WRITTEN_CONTEXTS,
  bundleOf,
  choiceIdsOf,
  deciderFor,
  drawFrom,
  fakeTwoReadApi,
  promptsFor,
  readOfRequest,
  rolesOf,
  routeOf,
  routingBundle,
  stepOf,
  twoStep,
  userOf,
  writtenRecordings,
  type FakeDecideOptions,
  type Raw,
  type TwoReadAnswers,
} from "./test-support";

/** A K-02 v1 decide fixture: a decideResult. */
type DecideFixture = DecideResult;

const globalFetch = vi.fn(() => {
  throw new Error("no network in a decide test: the global fetch was called");
});

let contract: ModelContract;
let shipped: RecordedModel;
let written: RecordedModel;
const fixtures = new Map<string, DecideFixture>();
const contexts = new Map<string, DecideContext>();

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
};
const fixtureOf = (file: string): DecideFixture => must(fixtures.get(file), file);
const contextOf = (file: string): DecideContext => must(contexts.get(file), `the context of ${file}`);

/** Every K-02 decide fixture whose first and check reads agree: all but decide-reads-disagree.json. */
const AGREEING: readonly string[] = [...CARD_FIXTURES, "decide-hand-off-owner-or-staff.json"];
/** The seeds each turn's two reads draw, unless a test gives its own. */
const SEEDS: readonly number[] = [11, 12];
const ZONE = "America/New_York";

beforeAll(async () => {
  vi.stubGlobal("fetch", globalFetch);
  contract = await loadModelContract();
  shipped = await loadRecordedModel();
  for (const file of [...CARD_FIXTURES, ...MORE_FIXTURES]) {
    const fixture = contract.fixtures.read(file);
    expect(contract.validate("decideResult", fixture)).toEqual([]);
    fixtures.set(file, fixture as DecideFixture);
    const k02 = K02_CONTEXTS[file];
    const context = k02 === undefined ? WRITTEN_CONTEXTS[file] : contract.fixtures.read(k02);
    expect(contract.validate("context", context), file).toEqual([]);
    contexts.set(file, context as DecideContext);
  }
  const roles = Object.fromEntries(
    [...fixtures].map(([file, fixture]) => [file, rolesOf({ reads: [...fixture.reads] })]),
  );
  written = await buildRecordedModel(writtenRecordings(roles, []));
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

const stepsOf = (read: DecideRead): TwoReadAnswers["first"] => twoStep(read as unknown as Raw);

interface TwoRun {
  readonly answer: DecideTurnAnswer;
  readonly api: FakeCachingApi;
  readonly route: TurnRoute;
}

/**
 * Decides a context with its two reads per the route, the model answering each read from `reads` (default: the double's
 * read in that role), behind the real router, decide's one read and the AI gateway.
 */
async function decideTwice(
  context: DecideContext,
  reads: { first?: DecideRead; check?: DecideRead } = {},
  options: FakeDecideOptions & { seeds?: readonly number[]; trace?: TraceContext } = {},
): Promise<TwoRun> {
  const seeds = options.seeds ?? SEEDS;
  const route = routeOf(context, seeds);
  const answers: TwoReadAnswers = {
    first: stepsOf(reads.first ?? (await recorded(context, "first"))),
    check: stepsOf(reads.check ?? (await recorded(context, "check"))),
  };
  const api = fakeTwoReadApi(route, answers, options);
  const answer = await deciderFor(context, api.fetch).decide(context, {
    draw: drawFrom(seeds),
    ...(options.trace !== undefined && { trace: options.trace }),
  });
  return { answer, api, route };
}

function decided(answer: DecideTurnAnswer): DecideTurnDecided {
  if (answer.status !== "decided") throw new Error(`the turn is ${answer.status}, not decided`);
  return answer;
}

/** The context with the given choices made high, for a reason the frontier builder gives when it cannot walk one. */
function madeHigh(context: DecideContext, ids: readonly string[]): DecideContext {
  const high: DecideContext = {
    ...structuredClone(context),
    choices: context.choices.map((choice) =>
      ids.includes(choice.choiceId)
        ? {
            ...structuredClone(choice),
            stakes: "high" as const,
            stakesFrom: [{ why: "unknown", step: null, ref: null }],
          }
        : structuredClone(choice),
    ),
  };
  expect(contract.validate("context", high)).toEqual([]);
  return high;
}

/** The context with every choice low: no reason to read it as high. */
function madeLow(context: DecideContext): DecideContext {
  const low: DecideContext = {
    ...structuredClone(context),
    choices: context.choices.map((choice) => ({
      ...structuredClone(choice),
      stakes: "low" as const,
      stakesFrom: [],
    })),
  };
  expect(contract.validate("context", low)).toEqual([]);
  return low;
}

/** Which read each call of a run was for, in the order the calls were sent. */
const readsOfCalls = (run: TwoRun): ("first" | "check")[] =>
  run.api.calls.map((call) => readOfRequest(run.route, call.body));

const marks = (answer: DecideTurnDecided): string[] => answer.agreement.parts.map((part) => part.mark);
const outcomes = (result: DecideResult): string[] => result.parts.map((part) => part.outcome);

describe("two reads that differ only in choice order agree", () => {
  it.each(AGREEING)(
    "%s: the two reads list the choices in two orders and agree, and K-02's result is the fixture's",
    async (file) => {
      const context = contextOf(file);
      const run = await decideTwice(context);
      const answer = decided(run.answer);
      // On the wire: each read's calls list the choices in its own seed's order, and the two orders differ.
      const [first, check] = run.route.reads;
      expect(first.choiceOrder).not.toEqual(check.choiceOrder);
      expect([...first.choiceOrder].sort()).toEqual([...check.choiceOrder].sort());
      for (const call of run.api.calls) {
        const order = choiceIdsOf(userOf(call.body));
        const read = readOfRequest(run.route, call.body);
        expect(order).toEqual(read === "first" ? first.choiceOrder : check.choiceOrder);
      }
      expect(new Set(readsOfCalls(run))).toEqual(new Set(["first", "check"]));
      // The same choices and values: every part agreed, so every part goes; the result is the fixture's, word for word.
      expect(answer.agreement.agreed).toBe(true);
      expect(answer.agreement.parts.every((part) => part.differences.length === 0)).toBe(true);
      expect(marks(answer).every((mark) => mark === "agreed")).toBe(true);
      expect(answer.result).toEqual(fixtureOf(file));
      expect(contract.validate("decideResult", answer.result)).toEqual([]);
    },
  );

  it("whatever two orders the seeds give, the same choice and values agree (decide-two-requests.json, ten seed pairs)", async () => {
    const context = contextOf("decide-two-requests.json");
    const orders = new Set<string>();
    let movedPicks = 0;
    for (let k = 0; k < 10; k += 1) {
      const seeds = [1000 + 7 * k, 5000 + 13 * k];
      const run = await decideTwice(context, {}, { seeds });
      const answer = decided(run.answer);
      expect(answer.result.agreed).toBe(true);
      expect(outcomes(answer.result)).toEqual(["go", "go"]);
      expect(answer.result).toEqual(fixtureOf("decide-two-requests.json"));
      for (const read of run.route.reads) orders.add(read.choiceOrder.join(" "));
      // Both reads pick c-01 and c-04: by id, wherever each read's list put them.
      const [first, check] = run.route.reads;
      if (["c-01", "c-04"].some((id) => first.choiceOrder.indexOf(id) !== check.choiceOrder.indexOf(id)))
        movedPicks += 1;
    }
    // The seeds listed the seven choices in many orders, the picks at other places, and every pair agreed.
    expect(orders.size).toBeGreaterThan(10);
    expect(movedPicks).toBeGreaterThan(5);
  });

  it("a choice is named by its id, never its place: an ask naming its questions in another order, and money written with its keys in another order, agree", () => {
    const ask: AskPart = {
      verb: "ask",
      quote: "1",
      questions: ["oq-a6-02", "oq-b6-04"],
      unclear: "Which request does '1' accept?",
    };
    const reordered: AskPart = { ...ask, questions: ["oq-b6-04", "oq-a6-02"] };
    expect(partDifferences(ask, reordered)).toEqual([]);
    const price: ChoosePart = {
      verb: "choose",
      quote: "tile is $12 a foot from now on",
      question: "S11-12",
      choice: "c-04",
      fields: [{ name: "price", value: { cents: 1200, currency: "USD" }, words: "$12 a foot" }],
    };
    const keysSwapped = structuredClone(price);
    const [field] = keysSwapped.fields;
    if (field === undefined) throw new Error("the part has a field");
    field.value = { currency: "USD", cents: 1200 };
    expect(JSON.stringify(keysSwapped)).not.toBe(JSON.stringify(price));
    expect(partDifferences(price, keysSwapped)).toEqual([]);
  });
});

describe("one differing field value marks that part not agreed", () => {
  it("decide-two-requests.json, low stakes: the check read prices tile at $13 where the first says $12: that part is not agreed, on its value alone", async () => {
    const context = contextOf("decide-two-requests.json");
    const check = changed(await recorded(context, "check"), (copy) => {
      const part = copy.parts[1];
      if (part?.verb !== "choose") throw new Error("the second part chooses");
      const price = part.fields.find((field) => field.name === "price");
      if (price === undefined) throw new Error("the second part has a price");
      price.value = { cents: 1300, currency: "USD" };
    });
    const answer = decided((await decideTwice(context, { check })).answer);
    expect(answer.stakes).toBe("low");
    expect(answer.agreement.parts.map((part) => [part.mark, part.differences])).toEqual([
      ["agreed", []],
      ["notAgreed", ["value"]],
    ]);
    expect(answer.result.agreed).toBe(false);
    expect(outcomes(answer.result)).toEqual(["go", "oneQuestion"]);
    expect(contract.validate("decideResult", answer.result)).toEqual([]);
  });

  const TIME_AT_2 = { utc: "2026-10-24T18:00:00Z", zone: ZONE };
  it.each([
    ["text", "Barbershop, plumbing, electrical", "Barbershop, plumbing"],
    ["whole number", 2, 3],
    ["true or false", true, false],
    ["money", { cents: 1200, currency: "USD" }, { cents: 1200, currency: "CAD" }],
    ["time (another instant)", TIME_AT_2, { utc: "2026-10-24T19:00:00Z", zone: ZONE }],
    ["time (another zone)", TIME_AT_2, { utc: "2026-10-24T18:00:00Z", zone: "America/Chicago" }],
  ] as const)(
    "a %s value that differs, its words the same, marks the part not agreed",
    (_kind, one, other) => {
      const part = (value: unknown): EnterPart => ({
        verb: "enter",
        quote: "Saturday at 2",
        choice: "c-04",
        fields: [
          { name: "detail", value: value as EnterPart["fields"][number]["value"], words: "Saturday at 2" },
        ],
      });
      const read = (value: unknown): DecideRead => ({ language: "en", parts: [part(value)] });
      const agreement = agreeReads(read(one), read(other), "low");
      expect(agreement.parts.map((entry) => [entry.mark, entry.differences])).toEqual([
        ["notAgreed", ["value"]],
      ]);
      expect(agreement.agreed).toBe(false);
      expect(agreeReads(read(one), read(structuredClone(one)), "low").agreed).toBe(true);
    },
  );
});

describe("two requests where the reads agree on one part and differ on the other: the first goes ahead, the second is not agreed", () => {
  it("decide-two-requests.json: the reads agree on the block and differ on the price: the block goes to the gate, the price holds one question", async () => {
    const context = contextOf("decide-two-requests.json");
    const first = await recorded(context, "first");
    const check = changed(await recorded(context, "check"), (copy) => {
      const part = copy.parts[1];
      if (part?.verb !== "choose") throw new Error("the second part chooses");
      const price = part.fields.find((field) => field.name === "price");
      if (price === undefined) throw new Error("the second part has a price");
      price.value = { cents: 1300, currency: "USD" };
    });
    const answer = decided((await decideTwice(context, { check })).answer);
    const { result } = answer;
    // The block: both reads agree, so the first read's part goes ahead.
    expect(result.parts[0]).toEqual({ part: first.parts[0], outcome: "go" });
    // The price: not agreed, so it holds the last read's part with one question; the gate commits nothing for it.
    expect(result.parts[1]).toEqual({ part: check.parts[1], outcome: "oneQuestion" });
    expect(result.parts.filter((part) => part.outcome === "go")).toHaveLength(1);
    expect(result).toMatchObject({ agreed: false, reread: false, language: "en", stakes: "low" });
    expect(result.reads.map((read) => [read.model, read.role])).toEqual([
      ["haiku", "first"],
      ["haiku", "check"],
    ]);
    expect(result.reads.map((read) => read.output)).toEqual([first, check]);
    expect(contract.validate("decideResult", result)).toEqual([]);
  });

  it("the same when the check read picks another hub case for the price: only the block goes", async () => {
    const context = contextOf("decide-two-requests.json");
    const check = changed(await recorded(context, "check"), (copy) => {
      copy.parts[1] = {
        verb: "choose",
        quote: "tile is $12 a foot from now on",
        question: "S11-12",
        choice: "c-05",
        fields: [],
      };
    });
    const answer = decided((await decideTwice(context, { check })).answer);
    expect(answer.agreement.parts.map((part) => [part.mark, part.differences])).toEqual([
      ["agreed", []],
      ["notAgreed", ["choice", "fields"]],
    ]);
    expect(outcomes(answer.result)).toEqual(["go", "oneQuestion"]);
    expect(answer.result.parts[1]?.part).toEqual(check.parts[1]);
    expect(contract.validate("decideResult", answer.result)).toEqual([]);
  });

  it("a part one read gives and the other does not is not agreed: the reads cut the text into two parts and one", async () => {
    const context = contextOf("decide-two-requests.json");
    const first = await recorded(context, "first");
    const check = changed(await recorded(context, "check"), (copy) => {
      copy.parts.splice(1, 1);
    });
    for (const [a, b, kept] of [
      [first, check, first.parts[1]],
      [check, first, first.parts[1]],
    ] as const) {
      const answer = decided((await decideTwice(context, { first: a, check: b })).answer);
      expect(answer.agreement.parts.map((part) => [part.mark, part.differences])).toEqual([
        ["agreed", []],
        ["notAgreed", ["missing"]],
      ]);
      expect(answer.result.parts).toEqual([
        { part: first.parts[0], outcome: "go" },
        { part: kept, outcome: "oneQuestion" },
      ]);
      expect(answer.result.agreed).toBe(false);
      expect(contract.validate("decideResult", answer.result)).toEqual([]);
    }
  });
});

describe("differing languages mark the turn not agreed (CQ-07)", () => {
  it("the check read takes Sam's text for Spanish: the turn is not agreed and its language unknown, while each part keeps its own mark", async () => {
    for (const file of ["decide-s1-02-choose.json", "decide-two-requests.json"]) {
      const context = contextOf(file);
      const check = changed(await recorded(context, "check"), (copy) => {
        copy.language = "es";
      });
      const answer = decided((await decideTwice(context, { check })).answer);
      expect(answer.agreement.agreed).toBe(false);
      expect(answer.agreement.language).toBeNull();
      expect(answer.result).toMatchObject({ agreed: false, language: null, reread: false });
      // The parts agree on every choice and value: the language is the turn's, not a part's.
      expect(marks(answer).every((mark) => mark === "agreed")).toBe(true);
      expect(outcomes(answer.result).every((outcome) => outcome === "go")).toBe(true);
      expect(answer.result.reads[1]?.output.language).toBe("es");
      expect(contract.validate("decideResult", answer.result)).toEqual([]);
    }
  });

  it("one language in both reads is the turn's, whatever the stored or business language", async () => {
    const context = contextOf("decide-no-op-thanks.json");
    const inSpanish = (read: DecideRead): DecideRead =>
      changed(read, (copy) => {
        copy.language = "es";
      });
    const answer = decided(
      (
        await decideTwice(context, {
          first: inSpanish(await recorded(context, "first")),
          check: inSpanish(await recorded(context, "check")),
        })
      ).answer,
    );
    expect(context.businessLanguage).toBe("en");
    expect(answer.result).toMatchObject({ agreed: true, language: "es" });
  });
});

describe("high stakes: any difference marks the part for one question (arch 06 'High stakes')", () => {
  it("decide-reads-disagree.json: Sonnet picks the stand-in and Haiku another time: the part is marked for one question, and the result is the fixture's before its re-read", async () => {
    const file = "decide-reads-disagree.json";
    const context = contextOf(file);
    const fixture = fixtureOf(file);
    const answer = decided((await decideTwice(context)).answer);
    expect(answer.stakes).toBe("high");
    expect(answer.agreement.parts.map((part) => [part.mark, part.differences])).toEqual([
      ["oneQuestion", ["choice", "fields"]],
    ]);
    const [first, check] = fixture.reads;
    expect(answer.result).toEqual({
      turnId: fixture.turnId,
      bundleId: fixture.bundleId,
      stakes: "high",
      routing: { first: "sonnet", second: "haiku" },
      reads: [first, check],
      agreed: false,
      reread: false,
      language: "en",
      parts: [{ part: check?.output.parts[0], outcome: "oneQuestion" }],
    });
    expect(contract.validate("decideResult", answer.result)).toEqual([]);
  });

  it("the same difference, a time an hour apart: one question on high stakes, not agreed on low", async () => {
    const high = contextOf("decide-reads-disagree.json");
    const at = (utc: string): DecideRead => ({
      language: "en",
      parts: [
        {
          verb: "choose",
          quote: "or I'll just come Saturday at 2",
          question: "oq-a7-17",
          choice: "c-02",
          fields: [{ name: "time", value: { utc, zone: ZONE }, words: "Saturday at 2" }],
        },
      ],
    });
    const reads = { first: at("2026-10-24T18:00:00Z"), check: at("2026-10-24T19:00:00Z") };
    const onHigh = decided((await decideTwice(high, reads)).answer);
    expect(onHigh.stakes).toBe("high");
    expect(onHigh.agreement.parts.map((part) => [part.mark, part.differences])).toEqual([
      ["oneQuestion", ["value"]],
    ]);
    expect(outcomes(onHigh.result)).toEqual(["oneQuestion"]);
    const onLow = decided((await decideTwice(madeLow(high), reads)).answer);
    expect(onLow.stakes).toBe("low");
    expect(onLow.agreement.parts.map((part) => [part.mark, part.differences])).toEqual([
      ["notAgreed", ["value"]],
    ]);
    // On both, nothing reaches the gate for the part before the re-read.
    expect(outcomes(onLow.result)).toEqual(["oneQuestion"]);
    for (const result of [onHigh.result, onLow.result])
      expect(contract.validate("decideResult", result)).toEqual([]);
  });

  it("decide-two-requests.json made high: Sonnet and Haiku differ on the price: that part is marked for one question, the block still goes", async () => {
    const context = madeHigh(contextOf("decide-two-requests.json"), ["c-07"]);
    const first = await recorded(contextOf("decide-two-requests.json"), "first");
    const check = changed(first, (copy) => {
      const part = copy.parts[1];
      if (part?.verb !== "choose") throw new Error("the second part chooses");
      part.fields = part.fields.filter((field) => field.name !== "price");
    });
    const run = await decideTwice(context, { first, check });
    const answer = decided(run.answer);
    expect(answer.result).toMatchObject({ stakes: "high", routing: { first: "sonnet", second: "haiku" } });
    expect(answer.agreement.parts.map((part) => [part.mark, part.differences])).toEqual([
      ["agreed", []],
      ["oneQuestion", ["fields"]],
    ]);
    expect(outcomes(answer.result)).toEqual(["go", "oneQuestion"]);
    expect(contract.validate("decideResult", answer.result)).toEqual([]);
  });

  const CHOOSE: ChoosePart = {
    verb: "choose",
    quote: "or I'll just come Saturday at 2",
    question: "oq-a7-17",
    choice: "c-02",
    fields: [{ name: "time", value: { utc: "2026-10-24T18:00:00Z", zone: ZONE }, words: "Saturday at 2" }],
  };
  const ENTER: EnterPart = { verb: "enter", quote: "can Avery do it", choice: "c-08", fields: [] };
  const ASK: AskPart = {
    verb: "ask",
    quote: "1",
    questions: ["oq-a6-02", "oq-b6-04"],
    unclear: "'1' could accept either request.",
  };
  const HAND_OFF: HandOffPart = {
    verb: "hand_off",
    quote: "can I talk to Sam directly please",
    reason: "Alex asks for Sam.",
    about: "other",
  };
  const withField = (change: Partial<ChoosePart["fields"][number]>): ChoosePart => ({
    ...CHOOSE,
    fields: CHOOSE.fields.map((field) => ({ ...field, ...change })),
  });
  const DIFFERING: readonly [string, DecidePart, DecidePart | null, Difference[]][] = [
    ["another verb", CHOOSE, ASK, ["verb"]],
    ["another question", CHOOSE, { ...CHOOSE, question: "oq-b6-04" }, ["question"]],
    ["another choice", CHOOSE, { ...CHOOSE, choice: "c-03", fields: [] }, ["choice", "fields"]],
    ["another choice entered", ENTER, { ...ENTER, choice: "c-09" }, ["choice"]],
    ["a field less", CHOOSE, { ...CHOOSE, fields: [] }, ["fields"]],
    ["a field named otherwise", CHOOSE, withField({ name: "when" }), ["fields"]],
    ["another value", CHOOSE, withField({ value: { utc: "2026-10-25T18:00:00Z", zone: ZONE } }), ["value"]],
    ["another question asked", ASK, { ...ASK, questions: ["oq-a6-02"] }, ["questions"]],
    ["a hand-off about someone else", HAND_OFF, { ...HAND_OFF, about: "ownerOrStaff" }, ["about"]],
    ["no part there", CHOOSE, null, ["missing"]],
  ];

  it.each(DIFFERING)(
    "%s: one question on high stakes, not agreed on low",
    (_why, first, check, differences) => {
      const read = (part: DecidePart | null): DecideRead => ({
        language: "en",
        parts: part === null ? [ASK] : [ASK, part],
      });
      // The part under test is the second; the first part (the same ask) agrees.
      const expected = (mark: string): unknown[] => [
        ["agreed", []],
        [mark, differences],
      ];
      const onHigh = agreeReads(read(first), read(check), "high");
      expect(onHigh.parts.map((part) => [part.mark, part.differences])).toEqual(expected("oneQuestion"));
      expect(onHigh.agreed).toBe(false);
      const onLow = agreeReads(read(first), read(check), "low");
      expect(onLow.parts.map((part) => [part.mark, part.differences])).toEqual(expected("notAgreed"));
      expect(onLow.agreed).toBe(false);
      expect(partDifferences(first, check)).toEqual(differences);
    },
  );

  it("what is never compared, on high stakes too: a quote, a value's words, the free words of an ask, none_fits, a hand-off, pass_on and redact", () => {
    const pairs: [DecidePart, DecidePart][] = [
      [CHOOSE, { ...CHOOSE, quote: "Saturday at 2" }],
      [CHOOSE, withField({ words: "come Saturday at 2" })],
      [ASK, { ...ASK, unclear: "Two requests are open." }],
      [
        { verb: "none_fits", quote: "do you sell gift cards?", why: "No choice is about gift cards." },
        { verb: "none_fits", quote: "gift cards", why: "Gift cards are never set up." },
      ],
      [HAND_OFF, { ...HAND_OFF, reason: "A person is asked for." }],
      [
        { verb: "pass_on", quote: "please tell Riley thanks", words: "please tell Riley thanks" },
        { verb: "pass_on", quote: "tell Riley thanks", words: "tell Riley thanks" },
      ],
      [
        { verb: "redact", quote: "my skin test", words: "my skin test" },
        { verb: "redact", quote: "skin test", words: "skin test came back fine" },
      ],
      [
        { verb: "no_op", quote: "thanks!" },
        { verb: "no_op", quote: "thanks" },
      ],
    ];
    for (const [first, check] of pairs) {
      expect(partDifferences(first, check)).toEqual([]);
      const agreement = agreeReads(
        { language: "en", parts: [first] },
        { language: "en", parts: [check] },
        "high",
      );
      expect(agreement.parts.map((part) => part.mark)).toEqual(["agreed"]);
      expect(agreement.agreed).toBe(true);
    }
  });
});

describe("decide runs its two reads per the route", () => {
  it("low stakes: Haiku twice; high stakes: Sonnet first, Haiku checking; each read with its purpose, model and seed", async () => {
    for (const [file, models] of [
      ["decide-s1-02-choose.json", { first: HAIKU_MODEL, check: HAIKU_MODEL }],
      ["decide-bare-2.json", { first: SONNET_MODEL, check: HAIKU_MODEL }],
    ] as const) {
      const context = contextOf(file);
      const run = await decideTwice(context);
      const answer = decided(run.answer);
      // Each call went to the model its read's route names.
      for (const call of run.api.calls) expect(call.model).toBe(models[readOfRequest(run.route, call.body)]);
      // Each read is decide's one read with the route's purpose, seed and choice order.
      const [first, check] = answer.answers;
      for (const [k, read] of [first, check].entries()) {
        const routed = run.route.reads[k];
        expect(read.purpose).toBe(routed?.purpose);
        expect(read.seed).toBe(routed?.seed);
        expect(read.choiceOrder).toEqual(routed?.choiceOrder);
      }
      expect(answer.answers.map((read) => read.seed)).toEqual(run.route.reads.map((read) => read.seed));
      expect(answer.answers[0].seed).toBe(SEEDS[0]);
      expect(answer.modelCalls.map((call) => call.purpose)).toEqual([
        ...first.modelCalls.map(() => "decideFirst"),
        ...check.modelCalls.map(() => "decideCheck"),
      ]);
      expect(answer.result.routing).toEqual(run.route.routing);
      expect(answer.result.stakes).toBe(run.route.stakes);
      expect(answer).toMatchObject({ stakes: run.route.stakes, highChoices: run.route.highChoices });
    }
  });

  it("the two reads run side by side: both step-1 calls are in flight at once", async () => {
    const context = contextOf("decide-two-requests.json");
    const route = routeOf(context, SEEDS);
    const api = fakeTwoReadApi(route, {
      first: stepsOf(await recorded(context, "first")),
      check: stepsOf(await recorded(context, "check")),
    });
    let inFlight = 0;
    let most = 0;
    const sideBySide: FetchLike = async (url, init) => {
      const body = JSON.parse(init.body as string) as Raw;
      if (stepOf(body).n !== 1) return api.fetch(url, init);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        return await api.fetch(url, init);
      } finally {
        inFlight -= 1;
      }
    };
    const answer = decided(await deciderFor(context, sideBySide).decide(context, { draw: drawFrom(SEEDS) }));
    expect(most).toBe(2);
    expect(answer.result.agreed).toBe(true);
  });

  it("a read the gateway's fallback answered counts as that model's read: the routing stays the route's, and on high stakes a difference still asks one question", async () => {
    const context = contextOf("decide-bare-2.json");
    const sonnetDown = (body: Raw): number | null => (body.model === SONNET_MODEL ? 529 : null);
    const run = await decideTwice(context, {}, { fail: sonnetDown });
    const answer = decided(run.answer);
    expect(answer.answers.map((read) => (read.status === "ok" ? read.fallback : null))).toEqual([
      true,
      false,
    ]);
    expect(answer.result.routing).toEqual({ first: "sonnet", second: "haiku" });
    expect(answer.result.reads.map((read) => read.model)).toEqual(["haiku", "haiku"]);
    expect(answer.result).toMatchObject({ stakes: "high", agreed: true });
    // Sonnet failed twice on the first read's step 1, then Haiku answered it and its step 2; the check read was Haiku's
    // throughout.
    expect(answer.modelCalls.map((call) => [call.purpose, call.role, call.outcome])).toEqual([
      ["decideFirst", "sonnet", "failed"],
      ["decideFirst", "sonnet", "failed"],
      ["decideFirst", "haiku", "ok"],
      ["decideFirst", "haiku", "ok"],
      ["decideCheck", "haiku", "ok"],
      ["decideCheck", "haiku", "ok"],
    ]);
    const check = changed(await recorded(context, "check"), (copy) => {
      copy.parts[0] = { verb: "choose", quote: "2", question: "oq-a7-17", choice: "c-03", fields: [] };
    });
    const differing = decided((await decideTwice(context, { check }, { fail: sonnetDown })).answer);
    expect(differing.agreement.parts.map((part) => [part.mark, part.differences])).toEqual([
      ["oneQuestion", ["choice"]],
    ]);
    expect(outcomes(differing.result)).toEqual(["oneQuestion"]);
  });
});

describe("a read that fails is never compared, and nothing goes ahead on one read", () => {
  const notOffered = (read: DecideRead): DecideRead =>
    changed(read, (copy) => {
      const part = copy.parts[0];
      if (part?.verb !== "choose") throw new Error("the part chooses");
      part.choice = "c-99";
    });

  it("a read the AI layer's validator refuses is an unmapped read: the turn is unmapped, with no result, both answers and every call", async () => {
    const context = contextOf("decide-bare-2.json");
    const run = await decideTwice(context, { check: notOffered(await recorded(context, "check")) });
    expect(run.answer.status).toBe("unmapped");
    if (run.answer.status !== "unmapped") throw new Error("unmapped");
    expect(run.answer.refused).toEqual(["check"]);
    expect(run.answer.answers.map((read) => read.status)).toEqual(["ok", "refused"]);
    expect("result" in run.answer).toBe(false);
    expect("agreement" in run.answer).toBe(false);
    expect(run.answer.modelCalls).toHaveLength(run.api.calls.length);
    expect(run.answer).toMatchObject({ stakes: "high", routing: { first: "sonnet", second: "haiku" } });

    const both = await decideTwice(context, {
      first: notOffered(await recorded(context, "first")),
      check: notOffered(await recorded(context, "check")),
    });
    expect(both.answer).toMatchObject({ status: "unmapped", refused: ["first", "check"] });
  });

  it("a read with both models down makes the turn modelsDown, before a refused read: no result, every call kept", async () => {
    const context = contextOf("decide-bare-2.json");
    const route = routeOf(context, SEEDS);
    const checkDown = (body: Raw): number | null => (readOfRequest(route, body) === "check" ? 500 : null);
    const run = await decideTwice(context, {}, { fail: checkDown });
    expect(run.answer.status).toBe("modelsDown");
    expect(run.answer.answers.map((read) => read.status)).toEqual(["ok", "modelsDown"]);
    expect("result" in run.answer).toBe(false);
    // The first read's two calls, then the check read's three attempts: Haiku twice, then Sonnet once.
    expect(run.answer.modelCalls.map((call) => [call.purpose, call.role, call.outcome])).toEqual([
      ["decideFirst", "sonnet", "ok"],
      ["decideFirst", "sonnet", "ok"],
      ["decideCheck", "haiku", "failed"],
      ["decideCheck", "haiku", "failed"],
      ["decideCheck", "sonnet", "failed"],
    ]);
    const refusedAndDown = await decideTwice(
      context,
      { first: notOffered(await recorded(context, "first")) },
      { fail: checkDown },
    );
    expect(refusedAndDown.answer.status).toBe("modelsDown");
    expect(refusedAndDown.answer.answers.map((read) => read.status)).toEqual(["refused", "modelsDown"]);
  });
});

describe("nothing sent when a turn cannot be routed or read; no words in a span or an error", () => {
  it("refused before any call: a turn of another bundle, a turn with no choice, a policy that is not K-01's, prompts of another bundle, no key", async () => {
    const api = fakeTwoReadApi(routeOf(contextOf("decide-bare-2.json"), SEEDS), {
      first: { step1: null, step2: [] },
      check: { step1: null, step2: [] },
    });
    const decider = createDecider({
      bundle: routingBundle(MINI_A),
      prompts: promptsFor(MINI_A),
      env: ENV,
      fetch: api.fetch,
    });
    await expect(decider.decide(contextOf("decide-two-requests.json"))).rejects.toThrow(RoutingRefusedError);
    await expect(decider.decide({ ...contextOf("decide-bare-2.json"), choices: [] })).rejects.toThrow(
      RoutingRefusedError,
    );
    const opus = { ...routingBundle(MINI_A).policy, reread: "opus" } as unknown as RoutingPolicy;
    expect(() =>
      createDecider({
        bundle: { ...routingBundle(MINI_A), policy: opus },
        prompts: promptsFor(MINI_A),
        env: ENV,
        fetch: api.fetch,
      }),
    ).toThrow(RoutingPolicyError);
    expect(() =>
      createDecider({
        bundle: routingBundle(MINI_A),
        prompts: promptsFor(MINI_B),
        env: ENV,
        fetch: api.fetch,
      }),
    ).toThrow(GatewayConfigError);
    const keyless = createDecider({
      bundle: routingBundle(MINI_A),
      prompts: promptsFor(MINI_A),
      env: {},
      fetch: api.fetch,
    });
    await expect(keyless.decide(contextOf("decide-bare-2.json"))).rejects.toThrow(MissingKeyError);
    expect(api.calls).toHaveLength(0);
    expect(decider.bundleId).toEqual(MINI_A.manifest.bundleId);
  });

  it("the trace holds one K-08 portCall span per call and no word; the span facts are both reads' seeds and the context's counts", async () => {
    const context = contextOf("decide-hand-off-owner-or-staff.json");
    const trace = openTrace({
      openedBy: "textWebhook",
      bundleId: bundleOf(context).manifest.bundleId,
      handleRef: "handle-alex",
    });
    trace.setTurn(context.turnId);
    const run = await decideTwice(context, {}, { trace });
    const answer = decided(run.answer);
    expect(trace.spans).toHaveLength(run.api.calls.length);
    for (const span of trace.spans) {
      expect(span.hop).toBe("portCall");
      expect(spanProblems(span)).toEqual([]);
    }
    const part = answer.result.parts[0]?.part;
    if (part?.verb !== "hand_off") throw new Error("the part hands off");
    const logged = JSON.stringify(trace.toTrace());
    const never = [
      ...context.texts.map((text) => text.words),
      part.quote,
      part.reason,
      ...context.writer.people.map((person) => person.name),
      context.writer.handle,
      KEY,
    ];
    for (const value of never) {
      expect(logged).not.toContain(value);
      expect(JSON.stringify(answer.span)).not.toContain(value);
    }
    expect(answer.span).toMatchObject({
      decideFirstSeed: run.route.reads[0].seed,
      decideCheckSeed: run.route.reads[1].seed,
      texts: 1,
      choices: context.choices.length,
    });
    for (const value of Object.values(answer.span)) expect(typeof value).toBe("number");
    // A difference is a label a span may hold, never words.
    for (const difference of DIFFERENCES) expect(isLabel(difference)).toBe(true);
  });

  it("agreeReads compares two K-02 reads on K-02 stakes, and refuses anything else naming fields, never words", () => {
    const secret = "my card is 4242 and I live at 12 Elm";
    const good: DecideRead = { language: "en", parts: [{ verb: "no_op", quote: secret }] };
    const cases: [DecideRead, DecideRead, Stakes][] = [
      [{ language: "en", parts: [] }, good, "low"],
      [good, { language: secret, parts: [{ verb: "no_op", quote: secret }] }, "low"],
      [good, { language: "en", parts: [{ verb: "book", quote: secret } as unknown as DecidePart] }, "high"],
      [good, good, "medium" as Stakes],
    ];
    for (const [first, check, stakes] of cases) {
      expect(() => agreeReads(first, check, stakes)).toThrow(DecideRequestError);
      try {
        agreeReads(first, check, stakes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const word of ["4242", "Elm", "card is", "book"]) expect(message).not.toContain(word);
      }
    }
    expect(agreeReads(good, good, "low").agreed).toBe(true);
  });
});
