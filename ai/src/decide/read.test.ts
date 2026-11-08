// Tests of decide's one read (T-368, C-115). Offline, as every AI test (J-02: no live call; CI makes none): the model's
// answers are the recorded-model double's (T-004), split into the two steps of CQ-25's wire form and served by a fake
// Messages API with Anthropic's prompt cache (T-364's), behind the real AI gateway (T-361) and the real context bundle
// (T-367); the global fetch fails the file if anything reaches it. K-02 v1's fixtures come through the model-contract
// fixture loader (T-004) and are checked against K-02's own schema; the contexts K-02 does not give are test-support's,
// each checked against K-02 and, through the double's loader, against both named rules for every read made from it.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CacheLayoutError, createPromptCache } from "../cache";
import { ContextRefusedError, buildContextPrompt, type DecideContext } from "../context";
import {
  GatewayConfigError,
  HAIKU_MODEL,
  KEY_VARIABLE,
  MissingKeyError,
  SONNET_MODEL,
  type FetchLike,
} from "../gateway";
import {
  buildRecordedModel,
  loadModelContract,
  loadRecordedModel,
  type JsonObject,
  type ModelContract,
  type RecordedModel,
} from "../recorded-double";
import { openTrace, spanProblems } from "../../../runtime/src/trace";
import {
  DECIDE_PROMPT_TEXT,
  DecideRequestError,
  MAX_PARTS,
  STAGE1_SCHEMA,
  STAGE2_SCHEMAS,
  createDecideReader,
  decideReadProblems,
  readProblems,
  stageOneTail,
  stageTwoTail,
  type DecideRead,
  type DecideReadAnswer,
  type DecideReadOk,
  type DecideReadRefused,
  type ModelRole,
  type ReadRole,
} from "./index";
import {
  CARD_FIXTURES,
  ENV,
  K02_CONTEXTS,
  KEY,
  MINI_A,
  MINI_B,
  MORE_FIXTURES,
  V0,
  WRITTEN_CONTEXTS,
  copiedEscaped,
  fakeDecideApi,
  gatewayBundle,
  promptsFor,
  readJson,
  readerFor,
  retold,
  rolesOf,
  stepOf,
  twoStep,
  userOf,
  withDecidePrompt,
  writtenRecordings,
  type FakeDecideOptions,
  type Raw,
  type StepAnswers,
} from "./test-support";

interface DecideFixture {
  turnId: string;
  reads: { model: ModelRole; role: ReadRole; output: DecideRead }[];
}

const PURPOSE_OF = { first: "decideFirst", check: "decideCheck", reread: "reread" } as const;

const globalFetch = vi.fn(() => {
  throw new Error("no network in a decide test: the global fetch was called");
});

let contract: ModelContract;
let shipped: RecordedModel;
let written: RecordedModel;
const fixtures = new Map<string, DecideFixture>();
const contexts = new Map<string, DecideContext>();
/** Made-up turns for what no K-02 fixture holds: an enter part, and words with markup in them. */
let UNCLEAR: DecideContext;
let MARKS: DecideContext;
const ENTER_READ: DecideRead = {
  language: "en",
  parts: [{ verb: "enter", quote: "not sure what you mean", choice: "c-04", fields: [] }],
};
const MARKED_WORDS = "Barbershop & <plumbing>, electrical &lt;3";
const MARKS_READ: DecideRead = {
  language: "en",
  parts: [
    {
      verb: "choose",
      quote: MARKED_WORDS,
      question: "oq-s1-02",
      choice: "c-01",
      fields: [{ name: "kinds", value: MARKED_WORDS, words: MARKED_WORDS }],
    },
  ],
};

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
};
const fixtureOf = (file: string): DecideFixture => must(fixtures.get(file), file);
const contextOf = (file: string): DecideContext => must(contexts.get(file), `the context of ${file}`);

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
  const s102 = contextOf("decide-s1-02-choose.json");
  UNCLEAR = retold(s102, "turn-s1-02-sam-unclear", "not sure what you mean");
  MARKS = retold(s102, "turn-s1-02-sam-marks", MARKED_WORDS);
  const roles = Object.fromEntries([...fixtures].map(([file, fixture]) => [file, rolesOf(fixture)]));
  written = await buildRecordedModel(
    writtenRecordings(roles, [
      { id: "made-up-enter", context: UNCLEAR, output: ENTER_READ as unknown as JsonObject },
      { id: "made-up-marks", context: MARKS, output: MARKS_READ as unknown as JsonObject },
    ]),
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

interface ReadRun {
  readonly answer: DecideReadAnswer;
  readonly api: ReturnType<typeof fakeDecideApi>;
  readonly answers: StepAnswers;
}

/** One read of a context, the model answering each step from `answers` (default: the double's read in that role). */
async function readOnce(
  context: DecideContext,
  role: ReadRole,
  model: ModelRole,
  options: FakeDecideOptions & { answers?: StepAnswers; seed?: number } = {},
): Promise<ReadRun> {
  const answers = options.answers ?? twoStep((await recorded(context, role)) as unknown as Raw);
  const api = fakeDecideApi(answers, options);
  const answer = await readerFor(context, api.fetch).read(context, {
    purpose: PURPOSE_OF[role],
    model,
    seed: options.seed ?? 7,
  });
  return { answer, api, answers };
}

function ok(answer: DecideReadAnswer): DecideReadOk {
  if (answer.status !== "ok") throw new Error(`the read is ${answer.status}: ${JSON.stringify(answer)}`);
  return answer;
}
function refused(answer: DecideReadAnswer): DecideReadRefused {
  if (answer.status !== "refused") throw new Error(`the read is ${answer.status}, not refused`);
  return answer;
}
const bodies = (run: ReadRun): Raw[] => run.api.calls.map((call) => call.body);

describe("each decide-*.json fixture's context gives that output", () => {
  it.each([...CARD_FIXTURES, ...MORE_FIXTURES])(
    "%s: each of its reads, through both steps, is that read: its model, role, language and every part",
    async (file) => {
      const fixture = fixtureOf(file);
      const context = contextOf(file);
      expect(context.turnId).toBe(fixture.turnId);
      for (const expected of fixture.reads) {
        const { answer, api } = await readOnce(context, expected.role, expected.model);
        const read = ok(answer);
        expect(read.read).toEqual(expected);
        expect(read.language).toBe(expected.output.language);
        expect(read.fallback).toBe(false);
        expect(contract.validate("read", read.read)).toEqual([]);
        // One step-1 call, one step-2 call per part that is not no_op, each on the model the fixture names.
        const fieldParts = expected.output.parts.filter((part) => part.verb !== "no_op").length;
        expect(api.calls).toHaveLength(1 + fieldParts);
        const id = expected.model === "haiku" ? HAIKU_MODEL : SONNET_MODEL;
        for (const call of api.calls) expect(call.model).toBe(id);
      }
    },
  );

  it("every card fixture is covered, with all eight verbs between them and the made-up enter", async () => {
    expect(CARD_FIXTURES).toHaveLength(11);
    const verbs = new Set(
      [...CARD_FIXTURES, ...MORE_FIXTURES].flatMap((file) =>
        fixtureOf(file).reads.flatMap((read) => read.output.parts.map((part) => part.verb)),
      ),
    );
    const enter = ok((await readOnce(UNCLEAR, "first", "haiku")).answer);
    expect(enter.read.output).toEqual(ENTER_READ);
    verbs.add("enter");
    expect([...verbs].sort()).toEqual(
      ["ask", "choose", "enter", "hand_off", "no_op", "none_fits", "pass_on", "redact"].sort(),
    );
  });

  it("a 'thanks!' turn gives no_op, with no step 2", async () => {
    const context = contextOf("decide-no-op-thanks.json");
    expect(context.texts.map((text) => text.words)).toEqual(["thanks!"]);
    const { answer, api } = await readOnce(context, "first", "haiku");
    expect(ok(answer).read.output).toEqual({ language: "en", parts: [{ verb: "no_op", quote: "thanks!" }] });
    expect(api.calls).toHaveLength(1);
    expect(stepOf(api.calls[0]?.body ?? {})).toEqual({ n: 1 });
  });

  it("a bare '2' with one open question gives choose: that question's option 2", async () => {
    const context = contextOf("decide-bare-2.json");
    expect(context.openQuestions).toHaveLength(1);
    expect(context.texts.map((text) => [text.kind, text.words])).toEqual([["text", "2"]]);
    const read = ok((await readOnce(context, "first", "sonnet")).answer).read;
    expect(read).toMatchObject({ model: "sonnet", role: "first" });
    expect(read.output.parts).toEqual([
      { verb: "choose", quote: "2", question: "oq-a7-17", choice: "c-02", fields: [] },
    ]);
    const chosen = context.choices.find((choice) => choice.choiceId === "c-02");
    expect(chosen).toMatchObject({ kind: "option", question: "oq-a7-17", label: "2 Another time" });
  });

  it("a tapback on a yes question gives ask (decide-tapback-asks-which.json): never a yes, never a pick", async () => {
    const context = contextOf("decide-tapback-asks-which.json");
    const [tapback] = context.texts;
    expect(tapback).toMatchObject({ kind: "tapback", words: "Liked", tapback: { reaction: "Liked" } });
    for (const expected of fixtureOf("decide-tapback-asks-which.json").reads) {
      const read = ok((await readOnce(context, expected.role, expected.model)).answer).read;
      expect(read.output.parts).toHaveLength(1);
      expect(read.output.parts[0]).toMatchObject({ verb: "ask", quote: "Liked", questions: ["oq-a7-17"] });
      expect(read.output.parts.some((part) => part.verb === "choose")).toBe(false);
    }
  });

  it("a poll vote answers its own poll: choose with the vote's option", async () => {
    const context = contextOf("decide-poll-vote.json");
    expect(context.texts[0]).toMatchObject({ kind: "pollVote", poll: { pollId: "poll-s11-13" } });
    expect(context.openQuestions[0]?.pollId).toBe("poll-s11-13");
    const read = ok((await readOnce(context, "first", "sonnet")).answer).read;
    expect(read.output.parts).toEqual([
      { verb: "choose", quote: "Block around it", question: "oq-s11-13", choice: "c-02", fields: [] },
    ]);
  });
});

describe("the output carries the language and which model read it", () => {
  it("a read is K-02's read: the model that answered, its role from the purpose, and the language step 1 gave", async () => {
    const context = contextOf("decide-two-requests.json");
    for (const [role, model] of [
      ["first", "haiku"],
      ["check", "sonnet"],
      ["reread", "sonnet"],
    ] as const) {
      const run = await readOnce(context, role, model, {
        answers: twoStep((await recorded(context, "first")) as unknown as Raw),
      });
      const read = ok(run.answer);
      expect(read.read.model).toBe(model);
      expect(read.read.role).toBe(role);
      expect(read.purpose).toBe(PURPOSE_OF[role]);
      expect(read.language).toBe("en");
      expect(read.read.output.language).toBe("en");
    }
  });

  it("the text's language is the one step 1 reads in it, whatever the stored or business language", async () => {
    const context = contextOf("decide-no-op-thanks.json");
    expect(context.writer.people[0]?.language).toBe("en");
    const run = await readOnce(context, "first", "haiku", {
      answers: { step1: { language: "es", parts: [{ quote: "thanks!", verb: "no_op" }] }, step2: [null] },
    });
    expect(ok(run.answer).language).toBe("es");
    expect(ok(run.answer).read.output.language).toBe("es");
  });

  it("Haiku failing step 1 twice: Sonnet answers it, reads every step 2, and the read is Sonnet's, marked as a fallback", async () => {
    const context = contextOf("decide-two-requests.json");
    const run = await readOnce(context, "first", "haiku", { fail: (_body, n) => (n < 2 ? 529 : null) });
    const read = ok(run.answer);
    expect(read.read.model).toBe("sonnet");
    expect(read.fallback).toBe(true);
    expect(read.read.output).toEqual(fixtureOf("decide-two-requests.json").reads[0]?.output);
    expect(run.api.calls.map((call) => [call.model, call.status])).toEqual([
      [HAIKU_MODEL, 529],
      [HAIKU_MODEL, 529],
      [SONNET_MODEL, 200],
      [SONNET_MODEL, 200],
      [SONNET_MODEL, 200],
    ]);
    expect(read.modelCalls.map((call) => [call.role, call.purpose, call.outcome])).toEqual([
      ["haiku", "decideFirst", "failed"],
      ["haiku", "decideFirst", "failed"],
      ["sonnet", "decideFirst", "ok"],
      ["sonnet", "decideFirst", "ok"],
      ["sonnet", "decideFirst", "ok"],
    ]);
  });

  it("a step 2 answered by the other model is a fallback too; the read stays the model that answered step 1", async () => {
    const context = contextOf("decide-two-requests.json");
    // Calls 0 (step 1) and 1, 2 (step 2, side by side) on Haiku; part 2's Haiku attempts fail twice, then Sonnet.
    const run = await readOnce(context, "first", "haiku", {
      fail: (body) =>
        stepOf(body).n === 2 && body.model === HAIKU_MODEL && userOf(body).endsWith('part="2"></step>')
          ? 500
          : null,
    });
    const read = ok(run.answer);
    expect(read.read.model).toBe("haiku");
    expect(read.fallback).toBe(true);
    expect(read.read.output).toEqual(fixtureOf("decide-two-requests.json").reads[0]?.output);
  });
});

describe("each refused fixture is refused by the AI layer's validator before it is returned", () => {
  const invalid = (file: string): Raw => readJson(`contracts/model/fixtures/invalid/${file}`) as Raw;
  /** The index entry as written: the loader's entries (T-004) leave out the named rule, so it is read here. */
  const entry = (file: string): Raw | undefined => {
    const index = readJson("contracts/model/fixtures/index.json") as { fixtures: Raw[] };
    expect(contract.fixtures.entries.some((each) => each.file === `invalid/${file}`)).toBe(true);
    return index.fixtures.find((each) => each.file === `invalid/${file}`);
  };

  it("refuse-unknown-verb.json: step 1's verb book is none of the eight; refused at step 1, before any step-2 call", async () => {
    expect(entry("refuse-unknown-verb.json")).toMatchObject({ def: "decideRead", expect: "refuse" });
    const read = invalid("refuse-unknown-verb.json");
    expect(contract.validate("decideRead", read)).not.toEqual([]);
    const context = contextOf("decide-bare-2.json");
    const run = await readOnce(context, "first", "sonnet", { answers: twoStep(read) });
    const answer = refused(run.answer);
    expect(answer).toMatchObject({ stage: 1, unmappedParts: [0] });
    expect(answer.problems).toEqual(["parts[0].verb is not one of the eight verbs"]);
    expect("read" in answer).toBe(false);
    expect(run.api.calls).toHaveLength(1);
    expect(decideReadProblems(read)).toEqual(["parts[0].verb is not one of the eight verbs"]);
  });

  it("refuse-value-without-words.json: a time with empty words; refused at step 2", async () => {
    expect(entry("refuse-value-without-words.json")).toMatchObject({ def: "decideRead", expect: "refuse" });
    const read = invalid("refuse-value-without-words.json");
    expect(contract.validate("decideRead", read)).not.toEqual([]);
    const run = await readOnce(contextOf("decide-bare-2.json"), "first", "sonnet", {
      answers: twoStep(read),
    });
    const answer = refused(run.answer);
    expect(answer).toMatchObject({ stage: 2, unmappedParts: [0] });
    expect(answer.problems).toEqual(["parts[0].fields[0].words are empty: a value without words is refused"]);
    expect("read" in answer).toBe(false);
    expect(decideReadProblems(read)).toEqual(answer.problems);
  });

  it("refuse-option-not-offered.json: both reads choose c-99, which the context does not offer; each refused at step 2 (optionOffered)", async () => {
    expect(entry("refuse-option-not-offered.json")).toMatchObject({
      rule: "optionOffered",
      expect: "refuse",
    });
    const pair = invalid("refuse-option-not-offered.json") as {
      context: DecideContext;
      decide: DecideFixture;
    };
    expect(contract.validate("contextAndDecide", pair)).toEqual([]);
    expect(contract.rules.optionOffered?.(pair)).not.toEqual([]);
    for (const each of pair.decide.reads) {
      expect(decideReadProblems(each.output)).toEqual([]);
      const run = await readOnce(pair.context, each.role, each.model, {
        answers: twoStep(each.output as unknown as Raw),
      });
      const answer = refused(run.answer);
      expect(answer).toMatchObject({ stage: 2, unmappedParts: [0] });
      expect(answer.problems).toEqual([
        "parts[0]: choose names a choice the context does not offer (optionOffered)",
      ]);
      expect(readProblems(pair.context, each.output)).toEqual(answer.problems);
    }
  });

  it("refuse-quote-not-in-text.json: the quote is not in Sam's text; refused at step 1, before any step-2 call (quoteInText)", async () => {
    expect(entry("refuse-quote-not-in-text.json")).toMatchObject({ rule: "quoteInText", expect: "refuse" });
    const pair = invalid("refuse-quote-not-in-text.json") as {
      context: DecideContext;
      decide: DecideFixture;
    };
    expect(contract.validate("contextAndDecide", pair)).toEqual([]);
    expect(contract.rules.quoteInText?.(pair)).not.toEqual([]);
    for (const each of pair.decide.reads) {
      const run = await readOnce(pair.context, each.role, each.model, {
        answers: twoStep(each.output as unknown as Raw),
      });
      const answer = refused(run.answer);
      expect(answer).toMatchObject({ stage: 1, unmappedParts: [0] });
      expect(answer.problems).toEqual(["parts[0].quote is not found in the turn's texts (quoteInText)"]);
      expect(run.api.calls).toHaveLength(1);
      expect(readProblems(pair.context, each.output)).toEqual(answer.problems);
    }
  });

  it("each fixture's mended read is accepted: the refusal is for its one fault", async () => {
    const context = contextOf("decide-bare-2.json");
    const verb = invalid("refuse-unknown-verb.json") as { parts: Raw[] };
    const mendedVerb = { ...verb, parts: [{ ...verb.parts[0], verb: "choose" }] };
    expect(
      ok((await readOnce(context, "first", "sonnet", { answers: twoStep(mendedVerb) })).answer),
    ).toBeTruthy();
    const words = invalid("refuse-value-without-words.json") as { parts: { fields: Raw[] }[] };
    const mendedWords = structuredClone(words);
    const [field] = mendedWords.parts[0]?.fields ?? [];
    if (field === undefined) throw new Error("the fixture has a field");
    field.words = "2";
    expect(
      ok((await readOnce(context, "first", "sonnet", { answers: twoStep(mendedWords) })).answer),
    ).toBeTruthy();
  });
});

describe("the two-step wire form through the AI gateway (CQ-25)", () => {
  it("one step-1 call, then one step-2 call per part, side by side, each with its own schema and the step's tail", async () => {
    const context = contextOf("decide-two-requests.json");
    const answers = twoStep((await recorded(context, "first")) as unknown as Raw);
    const api = fakeDecideApi(answers);
    let inFlight = 0;
    let most = 0;
    const sideBySide: FetchLike = async (url, init) => {
      const body = JSON.parse(init.body as string) as Raw;
      if (stepOf(body).n === 1) return api.fetch(url, init);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        return await api.fetch(url, init);
      } finally {
        inFlight -= 1;
      }
    };
    const answer = ok(
      await readerFor(context, sideBySide).read(context, {
        purpose: "decideFirst",
        model: "haiku",
        seed: 11,
      }),
    );
    expect(most).toBe(2);
    const sent = api.calls.map((call) => call.body);
    expect(sent.map((body) => stepOf(body))).toEqual([{ n: 1 }, { n: 2, part: 1 }, { n: 2, part: 2 }]);
    const format = (body: Raw): unknown => (body.output_config as Raw).format;
    expect(format(sent[0] ?? {})).toEqual({ type: "json_schema", schema: STAGE1_SCHEMA });
    expect(format(sent[1] ?? {})).toEqual({ type: "json_schema", schema: STAGE2_SCHEMAS.choose });
    expect(format(sent[2] ?? {})).toEqual({ type: "json_schema", schema: STAGE2_SCHEMAS.choose });
    for (const body of sent) expect((body.output_config as Raw).effort).toBe("low");

    // The per-turn part is the context bundle's (T-367), with the step's tail after it.
    const perTurn = buildContextPrompt(promptsFor(MINI_B), context, { purpose: "decideFirst", seed: 11 })
      .prompt.turn;
    const heads = answer.read.output.parts.map((part) => ({ quote: part.quote, verb: part.verb }));
    expect(userOf(sent[0] ?? {})).toBe(`${perTurn}\n\n${stageOneTail()}`);
    expect(userOf(sent[1] ?? {})).toBe(`${perTurn}\n\n${stageTwoTail(heads, 0)}`);
    expect(userOf(sent[2] ?? {})).toBe(`${perTurn}\n\n${stageTwoTail(heads, 1)}`);
    expect(stageTwoTail(heads, 1)).toBe(
      [
        "<parts>",
        '<part n="1" verb="choose">block thursday afternoon</part>',
        '<part n="2" verb="choose">tile is $12 a foot from now on</part>',
        "</parts>",
        '<step n="2" part="2"></step>',
      ].join("\n"),
    );
    // The seed and the choices' order are the read's, as the context bundle records them.
    expect(answer.seed).toBe(11);
    expect(answer.span).toMatchObject({ decideFirstSeed: 11, choices: 7, facts: 1, texts: 1 });
  });

  it("every call of a read sends the same cached system prompt: the decide prompt, the rules and the cards, with markers", async () => {
    const run = await readOnce(contextOf("decide-ask.json"), "first", "sonnet");
    const systems = bodies(run).map((body) => JSON.stringify(body.system));
    expect(new Set(systems).size).toBe(1);
    const system = bodies(run)[0]?.system as { text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(2);
    expect(system[0]?.text.startsWith(DECIDE_PROMPT_TEXT)).toBe(true);
    expect(system[0]?.text).toContain(MINI_A.flows.A?.routing.alwaysOn.prefixText.slice(0, 200));
    expect(system[1]?.text).toContain('<card step="A6-02">');
    for (const block of system) expect(block.cache_control).toEqual({ type: "ephemeral" });
    // Nothing of the turn is in the cached prefix.
    for (const block of system) expect(block.text).not.toContain("oq-b6-04");
  });

  it("a second read of the same turn reads the cached prefix the first one wrote", async () => {
    const context = contextOf("decide-two-requests.json");
    const answers = twoStep((await recorded(context, "first")) as unknown as Raw);
    const api = fakeDecideApi(answers);
    const reader = readerFor(context, api.fetch);
    ok(await reader.read(context, { purpose: "decideFirst", model: "haiku", seed: 1 }));
    ok(await reader.read(context, { purpose: "decideCheck", model: "haiku", seed: 2 }));
    const stepOnes = api.calls.filter((call) => stepOf(call.body).n === 1);
    expect(stepOnes).toHaveLength(2);
    expect(stepOnes[0]?.usage?.cache_creation_input_tokens).toBeGreaterThan(0);
    expect(stepOnes[1]?.usage?.cache_read_input_tokens).toBeGreaterThan(0);
  });

  it("quotes and words come back in the text's own characters, whether the model copies them escaped or as typed", async () => {
    for (const write of [copiedEscaped, (answer: unknown): unknown => answer]) {
      const run = await readOnce(MARKS, "first", "haiku", { write });
      expect(ok(run.answer).read.output).toEqual(MARKS_READ);
    }
    // The model saw the words escaped, as data, in the turn and in step 2's parts.
    const run = await readOnce(MARKS, "first", "haiku", { write: copiedEscaped });
    const escaped = "Barbershop & &lt;plumbing&gt;, electrical &amp;lt;3";
    expect(userOf(bodies(run)[0] ?? {})).toContain(`>${escaped}</text>`);
    expect(userOf(bodies(run)[1] ?? {})).toContain(`<part n="1" verb="choose">${escaped}</part>`);
  });
});

describe("what a read answers when the model fails or answers wrong", () => {
  const twoRequests = (): DecideContext => contextOf("decide-two-requests.json");

  it("step 1 failing on both models: modelsDown at step 1, after three attempts, with no step 2", async () => {
    const run = await readOnce(twoRequests(), "first", "haiku", { fail: () => 500 });
    expect(run.answer).toMatchObject({ status: "modelsDown", stage: 1 });
    if (run.answer.status !== "modelsDown") throw new Error("modelsDown");
    expect(run.answer.failures.map((failure) => [failure.role, failure.code])).toEqual([
      ["haiku", "http_500"],
      ["haiku", "http_500"],
      ["sonnet", "http_500"],
    ]);
    expect(run.api.calls).toHaveLength(3);
    expect(run.answer.modelCalls).toHaveLength(3);
  });

  it("a part's step 2 failing on both models: modelsDown at step 2, and no read", async () => {
    const run = await readOnce(twoRequests(), "first", "haiku", {
      fail: (body) => (stepOf(body).n === 2 && userOf(body).endsWith('part="1"></step>') ? 529 : null),
    });
    expect(run.answer).toMatchObject({ status: "modelsDown", stage: 2 });
    expect("read" in run.answer).toBe(false);
  });

  const stepOne = (parts: unknown): StepAnswers => ({ step1: { language: "en", parts }, step2: [] });

  it.each([
    ["not an object", { step1: "choose", step2: [] }, "step 1's answer is not an object"],
    ["no part", stepOne([]), "parts is empty: a read has at least one part"],
    [
      "a language that is not a code",
      { step1: { language: "English", parts: [{ quote: "2", verb: "choose" }] }, step2: [] },
      "language is not a two-letter lowercase code",
    ],
    ["an empty quote", stepOne([{ quote: " ", verb: "no_op" }]), "parts[0].quote is empty"],
    [
      "a key a part does not have",
      stepOne([{ quote: "2", verb: "no_op", confidence: 1 }]),
      "parts[0] holds a key step 1 does not give a part",
    ],
  ] as [string, StepAnswers, string][])(
    "step 1 with %s is refused at step 1, before any step-2 call",
    async (_why, answers, line) => {
      const run = await readOnce(contextOf("decide-bare-2.json"), "first", "sonnet", { answers });
      expect(refused(run.answer)).toMatchObject({ stage: 1 });
      expect(refused(run.answer).problems).toContain(line);
      expect(run.api.calls).toHaveLength(1);
    },
  );

  it(`more than ${String(MAX_PARTS)} parts is refused at step 1, before any step-2 call is spent`, async () => {
    const words = "thanks!";
    const many = stepOne(Array.from({ length: MAX_PARTS + 1 }, () => ({ quote: words, verb: "no_op" })));
    const run = await readOnce(contextOf("decide-no-op-thanks.json"), "first", "haiku", { answers: many });
    expect(refused(run.answer).problems).toEqual([
      `parts holds ${String(MAX_PARTS + 1)} parts, more than the ${String(MAX_PARTS)} one read may have`,
    ]);
    expect(run.api.calls).toHaveLength(1);
    const enough = stepOne(Array.from({ length: MAX_PARTS }, () => ({ quote: words, verb: "no_op" })));
    expect(
      ok(
        (await readOnce(contextOf("decide-no-op-thanks.json"), "first", "haiku", { answers: enough })).answer,
      ).read.output.parts,
    ).toHaveLength(MAX_PARTS);
  });

  it("a step-2 answer that gives its part's verb or quote again, or a key its verb does not take, is refused for that part", async () => {
    const context = twoRequests();
    const good = twoStep((await recorded(context, "first")) as unknown as Raw);
    const changed = (k: number, extra: Raw): StepAnswers => ({
      step1: good.step1,
      step2: good.step2.map((answer, index) => (index === k ? { ...(answer as Raw), ...extra } : answer)),
    });
    for (const [extra, line] of [
      [{ verb: "enter" }, "parts[1]: its step-2 answer gives the part's verb or quote again"],
      [{ quote: "tile" }, "parts[1]: its step-2 answer gives the part's verb or quote again"],
      [{ about: "other" }, "parts[1]: its step-2 answer holds a key its verb does not take"],
    ] as [Raw, string][]) {
      const answer = refused(
        (await readOnce(context, "first", "haiku", { answers: changed(1, extra) })).answer,
      );
      expect(answer).toMatchObject({ stage: 2, unmappedParts: [1], problems: [line] });
    }
  });

  it("every part that fails is named: one whose step 2 does not map and one that breaks a named rule, in one read", async () => {
    const context = twoRequests();
    const good = twoStep((await recorded(context, "first")) as unknown as Raw);
    const [one, two] = good.step2 as Raw[];
    const answers: StepAnswers = {
      step1: good.step1,
      step2: [
        { ...one, about: "other" },
        { ...two, choice: "c-99" },
      ],
    };
    const answer = refused((await readOnce(context, "first", "haiku", { answers })).answer);
    expect(answer).toMatchObject({ stage: 2, unmappedParts: [0, 1] });
    expect(answer.problems).toEqual([
      "parts[0]: its step-2 answer holds a key its verb does not take",
      "parts[1]: choose names a choice the context does not offer (optionOffered)",
    ]);
  });

  it("the named rules, part by part: a field the choice does not carry, a wrong question, a verb for another kind, words not in the text", async () => {
    const context = twoRequests();
    const good = twoStep((await recorded(context, "first")) as unknown as Raw);
    const part2 = good.step2[1] as { question: string; choice: string; fields: Raw[] };
    const withPart2 = (changes: Raw): StepAnswers => ({
      ...good,
      step2: [good.step2[0], { ...part2, ...changes }],
    });
    const cases: [StepAnswers, string[]][] = [
      [
        withPart2({ fields: [...part2.fields, { name: "deposit", value: true, words: "tile" }] }),
        ["parts[1].fields[2] is not a field its choice carries (optionOffered)"],
      ],
      [withPart2({ question: "S11-13" }), ["parts[1].question is not its choice's question (optionOffered)"]],
      [
        // The danger row is an any-time row: enter takes it, choose does not, and it answers no question.
        withPart2({ choice: "c-07", fields: [] }),
        [
          "parts[1]: choose takes a choice of kind option, hub, whichBooking, not anytime (optionOffered)",
          "parts[1].question is not its choice's question (optionOffered)",
        ],
      ],
      [
        withPart2({
          fields: [{ name: "price", value: { cents: 1300, currency: "USD" }, words: "$13 a foot" }],
        }),
        ["parts[1].fields[0].words are not found in the turn's texts (quoteInText)"],
      ],
    ];
    for (const [answers, lines] of cases) {
      const answer = refused((await readOnce(context, "first", "haiku", { answers })).answer);
      expect(answer).toMatchObject({ stage: 2, unmappedParts: [1] });
      expect(answer.problems).toEqual(lines);
    }
  });
});

describe("no words in a span, a problem or an error; no key anywhere; nothing sent when a read cannot be made", () => {
  it("a read's trace holds one portCall span per call, each a K-08 span, and no word of the turn, the prompt or the answer", async () => {
    const context = contextOf("decide-hand-off-owner-or-staff.json");
    const recordedRead = await recorded(context, "first");
    const api = fakeDecideApi(twoStep(recordedRead as unknown as Raw));
    const trace = openTrace({
      openedBy: "textWebhook",
      bundleId: MINI_A.manifest.bundleId,
      handleRef: "handle-alex",
    });
    trace.setTurn(context.turnId);
    const answer = ok(
      await readerFor(context, api.fetch).read(
        context,
        { purpose: "decideFirst", model: "haiku" },
        { trace },
      ),
    );
    expect(trace.spans.map((span) => [span.hop, span.provider, span.attempt])).toEqual([
      ["portCall", "anthropic", 1],
      ["portCall", "anthropic", 1],
    ]);
    for (const span of trace.spans) expect(spanProblems(span)).toEqual([]);
    const logged = JSON.stringify(trace.toTrace());
    const part = answer.read.output.parts[0];
    if (part?.verb !== "hand_off") throw new Error("the read hands off");
    const never = [
      ...context.texts.map((text) => text.words),
      part.quote,
      part.reason,
      ...context.writer.people.map((person) => person.name),
      context.writer.handle,
      ...DECIDE_PROMPT_TEXT.split("\n").filter((line) => line.length > 40),
      KEY,
    ];
    for (const value of never) expect(logged).not.toContain(value);
    // The read's own span facts are seeds and counts, for T-369's decideReads span.
    for (const value of Object.values(answer.span)) expect(typeof value).toBe("number");
  });

  it("a refusal's problems name parts, fields and rules, never the words the model wrote or the person typed", async () => {
    const context = contextOf("decide-pass-on.json");
    const typed = context.texts[0]?.words ?? "";
    const secret = "my card is 4242 and I live at 12 Elm";
    const runs: [StepAnswers, string][] = [
      // A quote that is not in the text, at step 1.
      [
        { step1: { language: "en", parts: [{ quote: secret, verb: "pass_on" }] }, step2: [] },
        "parts[0].quote",
      ],
      // pass_on's words not in the text, after step 2.
      [
        { step1: { language: "en", parts: [{ quote: typed, verb: "pass_on" }] }, step2: [{ words: secret }] },
        "parts[0].words",
      ],
      // A step-2 key named with the secret, holding it.
      [
        {
          step1: { language: "en", parts: [{ quote: typed, verb: "redact" }] },
          step2: [{ words: typed, [secret]: secret }],
        },
        "parts[0]:",
      ],
      // A choice id and a field name that are the secret.
      [
        {
          step1: { language: "en", parts: [{ quote: typed, verb: "enter" }] },
          step2: [{ choice: secret, fields: [{ name: secret, value: secret, words: typed }] }],
        },
        "parts[0]: enter names a choice the context does not offer",
      ],
    ];
    for (const [answers, where] of runs) {
      const answer = refused((await readOnce(context, "first", "haiku", { answers })).answer);
      expect(answer.problems.join(" ")).toContain(where);
      const all = JSON.stringify(answer);
      for (const word of ["4242", "Elm", "card is", typed]) expect(all).not.toContain(word);
    }
  });

  it("no key: MissingKeyError names the variable, before any call", async () => {
    const context = contextOf("decide-bare-2.json");
    const api = fakeDecideApi({ step1: null, step2: [] });
    const reader = createDecideReader({
      bundle: gatewayBundle(MINI_A),
      prompts: promptsFor(MINI_A),
      env: {},
      fetch: api.fetch,
    });
    await expect(reader.read(context, { purpose: "decideFirst", model: "haiku" })).rejects.toThrow(
      MissingKeyError,
    );
    await expect(reader.read(context, { purpose: "decideFirst", model: "haiku" })).rejects.toThrow(
      KEY_VARIABLE,
    );
    expect(api.calls).toHaveLength(0);
  });

  it("refused before any call: prompts of another bundle, a purpose that is not decide's, a context of another bundle or one the context bundle refuses", async () => {
    const api = fakeDecideApi({ step1: null, step2: [] });
    expect(() =>
      createDecideReader({
        bundle: gatewayBundle(MINI_A),
        prompts: promptsFor(MINI_B),
        env: ENV,
        fetch: api.fetch,
      }),
    ).toThrow(GatewayConfigError);
    const reader = createDecideReader({
      bundle: gatewayBundle(MINI_A),
      prompts: promptsFor(MINI_A),
      env: ENV,
      fetch: api.fetch,
    });
    const context = contextOf("decide-bare-2.json");
    await expect(
      reader.read(context, { purpose: "planner" as "decideFirst", model: "haiku" }),
    ).rejects.toThrow(DecideRequestError);
    await expect(
      reader.read(context, { purpose: "decideFirst", model: "opus" as ModelRole }),
    ).rejects.toThrow(DecideRequestError);
    await expect(
      reader.read(contextOf("decide-two-requests.json"), { purpose: "decideFirst", model: "haiku" }),
    ).rejects.toThrow(CacheLayoutError);
    const none = { ...context, choices: [] };
    await expect(reader.read(none, { purpose: "decideFirst", model: "haiku" })).rejects.toThrow(
      ContextRefusedError,
    );
    expect(api.calls).toHaveLength(0);
  });

  it("a read uses its own bundle's decide prompt, whatever it holds", async () => {
    const context = contextOf("decide-s1-02-choose.json");
    const answers = twoStep((await recorded(context, "first")) as unknown as Raw);
    const api = fakeDecideApi(answers);
    const sample = createPromptCache({
      ...withDecidePrompt(V0),
      manifest: { ...withDecidePrompt(V0).manifest, prompts: V0.manifest.prompts },
    });
    const reader = createDecideReader({
      bundle: gatewayBundle(V0),
      prompts: sample,
      env: ENV,
      fetch: api.fetch,
    });
    ok(await reader.read(context, { purpose: "decideFirst", model: "haiku" }));
    const system = api.calls[0]?.body.system as { text: string }[];
    expect(system[0]?.text.startsWith(V0.manifest.prompts.decide.text)).toBe(true);
    expect(system[0]?.text).not.toContain(DECIDE_PROMPT_TEXT.slice(0, 60));
  });
});
