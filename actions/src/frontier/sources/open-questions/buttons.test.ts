// T-1478's proofs (the card's "Proves it with"; K-09 README v1.11 defaults 179, 180 and 188; the S1-04 design ruling's
// card 9, DL-999): the open-questions source offers the options of a plain step asked with buttons, S1-04, from the
// bundle the question was asked under, through buildFrontier on the Tool API base with the registry's own slots:
//   - on bundle v1's own S1-04, the three choices equal build-frontier-s1-04.json's, each low with no stake, with no step
//     card and no fact; the context passes K-02's schema and the optionOffered rule for a choose of each, and K-09's
//     buttonsOptionChoices; the table is K-09's BUTTONS_OPTIONS word for word;
//   - the question is offered while the turn pins another bundle, and its stakes walk the question's own bundle
//     (bundle v2: S1-08, then S1-09's question);
//   - a buttons step outside the table, or whose buttons the table no longer lists word for word, offers nothing and is
//     logged by its ids alone; a plain step with no buttons and no card is not offered, as before;
//   - S1-02's context still equals K-02's context-s1-02.json;
//   - a choice the frontier gives handed to limit 1 passes default 14 (the sign-up's own answer, control not proven).
// Values come only from the contracts' fixtures, the published bundles and the master's sample cast (rule 9). No model
// call, no network and no database.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isLabel } from "../../../../../runtime/src/trace";
import type { AllowedDecision } from "../../../gate/limit-1";
import {
  SAM,
  limitIn,
  partOf,
  requestFor,
  s1_02Asked,
  signUpRecord,
  turnOf,
} from "../../../gate/limit-1/test-support";
import { CONTRACTS_DIR } from "../../../tool-api/validator";
import { FrontierError } from "../../assemble/handler";
import { FRONTIER_SOURCES } from "../../assemble/registry";
import {
  bundleIdOf,
  callBuildFrontier,
  checks,
  contractFixture,
  fakeBundles,
  openQuestionRow,
  publishedBundle,
  s102Exchange,
  samSeed,
  sampleBundle,
  standIn,
  stringsIn,
  withStepChanged,
  withSteps,
  type BundleDocument,
  type Called,
  type FrontierExchange,
  type TurnSeed,
} from "../../assemble/test-support";
import type { Choice, Context, OpenQuestionRow, SourceSlot } from "../../assemble/types";
import { BUTTONS_OPTIONS } from "./buttons";

type Json = Record<string, unknown>;

const { validator, checker } = checks();

const V1 = publishedBundle("v1");
const V2 = publishedBundle("v2");
const V1_ID = bundleIdOf(V1);
const V2_ID = bundleIdOf(V2);
const V0_SKELETON = sampleBundle("bundle-v0-skeleton.json");

const S1_04_QUESTION = "oq-s1-04-sam";
const S1_04_BUTTONS = ["Some share one", "All share one", "Each is its own"];

/** K-09 v1.11's build-frontier-s1-04.json, freshly parsed. */
function s104Exchange(): FrontierExchange {
  return contractFixture("tool-api/fixtures/build-frontier-s1-04.json") as FrontierExchange;
}

/** The fixture's request with its turn pinned to `bundleId` (the fixture carries the stand-in id every K-09 one does). */
function s104Request(bundleId = V1_ID): Json {
  const { request } = s104Exchange();
  return { ...request, turn: { ...request.turn, bundleId } };
}

/** S1-04's question to Sam as commit-s1-02.json opened it (oq-s1-04-sam, no options), asked under `bundleId`. */
function s104Row(bundleId = V1_ID, more: Partial<OpenQuestionRow> = {}): OpenQuestionRow {
  return openQuestionRow({
    id: S1_04_QUESTION,
    step: "S1-04",
    turnId: "turn-s1-02-sam-kinds",
    sentAt: "2026-10-19T14:05:10Z",
    bundleId,
    ...more,
  });
}

/** Sam's stored state at S1-04: no role yet (the fixture's writer), the given open questions, under Lee's Barbershop. */
function s104Seed(rows: OpenQuestionRow[] = [s104Row()]): TurnSeed {
  return { ...samSeed(), roles: [], openQuestions: rows };
}

/** One buildFrontier call with the registry's own slots over the given bundles; its context, or the test fails. */
async function frontierOf(
  request: Json,
  seed: TurnSeed,
  documents: BundleDocument[],
): Promise<{ context: Context; called: Called }> {
  const called = await callBuildFrontier(request, { seed, bundles: fakeBundles(...documents) });
  if (!called.answer.ok) throw new Error(`the call threw: ${String(called.answer.error)}`);
  const answer = called.answer.value as { context?: Context };
  if (answer.context === undefined) throw new Error(`no context: ${JSON.stringify(answer)}`);
  return { context: answer.context, called };
}

/** The words of the turn's first text, which a part quotes. */
function wordsOf(context: Context): string {
  const [text] = context.texts;
  return text.words;
}

/** The option choices of one open question. */
function optionsOf(context: Context, question: string): Choice[] {
  return context.choices.filter((choice) => choice.kind === "option" && choice.question === question);
}

/** The words that must never reach the log: every button and definition of the table. */
const TABLE_WORDS = Object.values(BUTTONS_OPTIONS).flatMap((options) =>
  options.flatMap((option) => [option.label, option.definition]),
);

/** Every log line holds labels only, and never a button's words or a definition. */
function expectLabelsOnly(called: Called): void {
  for (const line of called.log.lines) {
    const values = stringsIn(line);
    expect(values.every((value) => isLabel(value))).toBe(true);
    expect(values.some((value) => TABLE_WORDS.includes(value))).toBe(false);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The contracts' named rules (contracts/model/model.rules.mjs, contracts/tool-api/tool-api.rules.mjs)

interface K02Rules {
  optionOffered: (pair: { context: unknown; decide: unknown }) => string[];
}

interface K09Rules {
  BUTTONS_OPTIONS: Record<
    string,
    { options: readonly { label: string; definition: string; fields: readonly Json[] }[] }
  >;
  buttonsOptionChoices: (exchange: unknown) => string[];
}

async function rulesOf<T>(contract: string): Promise<T> {
  const file = path.join(CONTRACTS_DIR, contract, `${contract}.rules.mjs`);
  return (await import(pathToFileURL(file).href)) as T;
}

/** A decide result whose one part chooses `choice` with each field it carries, quoting the turn's text (K-02 decide). */
function chooseOf(choice: Choice, quote: string): Json {
  const part = {
    verb: "choose",
    quote,
    question: choice.question,
    choice: choice.choiceId,
    fields: choice.fields.map((field) => ({ name: field.name, value: quote, words: quote })),
  };
  return {
    reads: [{ model: "haiku", role: "first", output: { language: "en", parts: [part] } }],
    parts: [{ part, outcome: "go" }],
  };
}

// ---------------------------------------------------------------------------------------------------------------

describe("T-1478: S1-04's three options on bundle v1, the bundle the question was asked under", () => {
  it("the three choices equal build-frontier-s1-04.json's, each low with no stake: no card, no fact, nothing else offered", async () => {
    const exchange = s104Exchange();
    const { context, called } = await frontierOf(s104Request(), s104Seed(), [V1]);
    const expected = exchange.outcome.context;
    // The fixture's three choices are the whole frontier (its note: a bundle that holds S1-04 holds no door or any-time
    // step here), with the ids the frontier gives (c-01 to c-03).
    expect(context.choices).toEqual(expected.choices);
    expect(context.choices.map((choice) => [choice.choiceId, choice.stakes, choice.stakesFrom])).toEqual([
      ["c-01", "low", []],
      ["c-02", "low", []],
      ["c-03", "low", []],
    ]);
    expect(context.openQuestions).toEqual(expected.openQuestions);
    expect(context.cards).toEqual([]);
    expect(context.facts).toEqual([]);
    // Up to the bundle: the context names the bundle the turn pins and its always-on prefix, where the fixture gives the
    // stand-in id every K-09 fixture carries and that bundle's prefix.
    expect(context.bundleId).toEqual(V1_ID);
    const routing = (V1.flows.A as { routing: { alwaysOn: { prefixSha256: string } } }).routing;
    expect(context.alwaysOn).toEqual({ flow: "A", prefixSha256: routing.alwaysOn.prefixSha256 });
    // Only the slots main has not built are logged.
    expect(called.log.lines.map((line) => [line.msg, line.source])).toEqual([
      ["frontier_source_missing", "branchGates"],
      ["frontier_source_missing", "anyTime"],
    ]);
  });

  it("the context passes K-02's schema, the optionOffered rule for a choose of each, and K-09's buttonsOptionChoices", async () => {
    const { context, called } = await frontierOf(s104Request(), s104Seed(), [V1]);
    expect(checker.check("context", context)).toEqual([]);
    const answer = called.answer.ok ? called.answer.value : null;
    expect(validator.check("buildFrontier", "response", answer)).toEqual([]);

    const { optionOffered } = await rulesOf<K02Rules>("model");
    const words = wordsOf(context);
    for (const choice of context.choices) {
      expect(optionOffered({ context, decide: chooseOf(choice, words) }), choice.choiceId).toEqual([]);
    }
    // The rule is not vacuous: a field the choice does not carry, or another question, is refused.
    const [some, all, each] = context.choices;
    if (all === undefined || each === undefined) throw new Error("three choices");
    expect(optionOffered({ context, decide: chooseOf({ ...each, fields: all.fields }, words) })).not.toEqual(
      [],
    );
    expect(
      optionOffered({ context, decide: chooseOf({ ...some, question: "oq-s1-02" }, words) }),
    ).not.toEqual([]);

    const { buttonsOptionChoices } = await rulesOf<K09Rules>("tool-api");
    expect(buttonsOptionChoices({ call: "buildFrontier", outcome: answer })).toEqual([]);
  });

  it("the table is K-09's BUTTONS_OPTIONS word for word, and its labels are S1-04's buttons in bundles v1 and v2", async () => {
    const { BUTTONS_OPTIONS: contract } = await rulesOf<K09Rules>("tool-api");
    expect(Object.keys(BUTTONS_OPTIONS)).toEqual(Object.keys(contract));
    for (const [step, entry] of Object.entries(contract)) {
      expect(
        BUTTONS_OPTIONS[step]?.map((option) => ({ ...option, fields: option.fields.map((f) => ({ ...f })) })),
      ).toEqual(
        entry.options.map((option) => ({
          label: option.label,
          definition: option.definition,
          fields: option.fields.map((field) => ({ ...field })),
        })),
      );
    }
    for (const document of [V1, V2]) {
      const step = (document.flows.A as { steps: Record<string, { say: Json[] }> }).steps["S1-04"];
      const fromRosie = step?.say.find((message) => message.from === "san") as
        { elements: { buttons: string[] } } | undefined;
      expect(fromRosie?.elements.buttons).toEqual(BUTTONS_OPTIONS["S1-04"]?.map((option) => option.label));
    }
  });
});

describe("T-1478: the bundle the question was asked under, whatever bundle the turn pins", () => {
  it("offered while the turn pins another bundle: bundle v2, or bundle v0's skeleton, which holds no S1-04", async () => {
    const expected = s104Exchange().outcome.context;
    for (const [pinned, documents] of [
      [V2_ID, [V1, V2]],
      [bundleIdOf(V0_SKELETON), [V1, V0_SKELETON]],
    ] as const) {
      const { context, called } = await frontierOf(s104Request(pinned), s104Seed(), [...documents]);
      expect(optionsOf(context, S1_04_QUESTION)).toEqual(
        expected.choices.map((choice) => ({ ...choice, choiceId: expect.any(String) as unknown })),
      );
      expect(context.openQuestions).toEqual(expected.openQuestions);
      expect(context.cards.some((card) => card.step === "S1-04")).toBe(false);
      // The question's step and buttons were read from bundle v1's flow A, the bundle it was asked under.
      expect(called.bundles.reads).toContain(`${V1_ID.hash}/${String(V1_ID.build)}/flow/A`);
      expectLabelsOnly(called);
    }
  });

  it("asked under bundle v2: S1-04's options walk S1-08, which tells, and stop at S1-09's question: low with no stake", async () => {
    const { context } = await frontierOf(s104Request(V1_ID), s104Seed([s104Row(V2_ID)]), [V1, V2]);
    expect(
      optionsOf(context, S1_04_QUESTION).map((choice) => [choice.label, choice.stakes, choice.stakesFrom]),
    ).toEqual(S1_04_BUTTONS.map((label) => [label, "low", []]));
  });

  it("the stakes walk the question's bundle, never the turn's: a charge at S1-08 in the question's bundle makes every option high", async () => {
    const chargeAtS108 = withStepChanged(V2, "S1-08", (step) => {
      step.effects = [{ kind: "charge", ref: "plan_fee", to: ["pay"] }];
    });
    const charge = [{ why: "charge", step: "S1-08", ref: "plan_fee" }];
    // Asked under that bundle, pinned to bundle v1 (which holds no S1-08): high, by the question's bundle's walk.
    const asked = await frontierOf(s104Request(V1_ID), s104Seed([s104Row(V2_ID)]), [V1, chargeAtS108]);
    expect(
      optionsOf(asked.context, S1_04_QUESTION).map((choice) => [choice.stakes, choice.stakesFrom]),
    ).toEqual(S1_04_BUTTONS.map(() => ["high", charge]));
    // Asked under bundle v1, pinned to that bundle: low, since the question's own bundle holds no S1-08.
    const pinned = await frontierOf(s104Request(V2_ID), s104Seed([s104Row(V1_ID)]), [V1, chargeAtS108]);
    expect(
      optionsOf(pinned.context, S1_04_QUESTION).map((choice) => [choice.stakes, choice.stakesFrom]),
    ).toEqual(S1_04_BUTTONS.map(() => ["low", []]));
  });
});

describe("T-1478: a buttons step the table does not list is not offered, and is logged by its ids alone (fail closed)", () => {
  /** Bundle v1 with S1-03, a plain step with no card, sending Rosie's message with buttons the table does not list. */
  const S1_03_WITH_BUTTONS = withStepChanged(V1, "S1-03", (step) => {
    step.say = [
      {
        from: "san",
        to: "owner",
        text: "Test words.",
        plainText: "Test words.",
        elements: { buttons: ["Yes", "No"] },
      },
    ];
  });
  const S1_03_ROW = openQuestionRow({ id: "oq-s1-03-sam", step: "S1-03", bundleId: V1_ID });

  it("a buttons step outside the table offers nothing: S1-04's question beside it is still offered, and S1-03's is logged", async () => {
    const { context, called } = await frontierOf(s104Request(), s104Seed([S1_03_ROW, s104Row()]), [
      S1_03_WITH_BUTTONS,
    ]);
    expect(context.openQuestions.map((question) => question.openQuestionId)).toEqual([S1_04_QUESTION]);
    expect(context.choices.map((choice) => choice.question)).toEqual([
      S1_04_QUESTION,
      S1_04_QUESTION,
      S1_04_QUESTION,
    ]);
    expect(called.log.lines[0]).toEqual({
      level: "warn",
      msg: "frontier_buttons_unlisted",
      trace_id: "trace-sam-0002",
      turn_id: "turn-s1-04-sam",
      open_question_id: "oq-s1-03-sam",
      step: "S1-03",
    });
    expect(stringsIn(called.log.lines)).not.toContain("Yes");
    expectLabelsOnly(called);
  });

  it("alone, it leaves no choice at all: buildFrontier fails closed (noChoices), never offering a guess", async () => {
    const called = await callBuildFrontier(s104Request(), {
      seed: s104Seed([S1_03_ROW]),
      bundles: fakeBundles(S1_03_WITH_BUTTONS),
    });
    expect(called.answer.ok).toBe(false);
    const error = called.answer.ok ? null : called.answer.error;
    expect(error).toBeInstanceOf(FrontierError);
    expect((error as FrontierError).code).toBe("noChoices");
    expect(called.log.lines.map((line) => line.msg)).toContain("frontier_buttons_unlisted");
  });

  it("S1-04's buttons in the question's bundle not the table's word for word (reworded, dropped, added, moved, a lettered pair): nothing offered for it, logged", async () => {
    const variants: [string, unknown[]][] = [
      ["a button reworded", ["Some share one", "All share it", "Each is its own"]],
      ["a button dropped", ["Some share one", "All share one"]],
      ["a button added", [...S1_04_BUTTONS, "Not sure"]],
      ["two buttons moved", ["All share one", "Some share one", "Each is its own"]],
      ["a lettered pair", ["Some share one", "All share one", ["C", "Each is its own"]]],
    ];
    for (const [why, buttons] of variants) {
      const changed = withStepChanged(V1, "S1-04", (step) => {
        const message = (step.say as Json[]).find((each) => each.from === "san");
        if (message === undefined) throw new Error("Rosie sends nothing at S1-04");
        message.elements = { buttons };
      });
      const called = await callBuildFrontier(s104Request(), {
        seed: s104Seed(),
        bundles: fakeBundles(changed),
      });
      expect(called.answer.ok, why).toBe(false);
      expect(
        called.log.lines.filter((line) => line.msg === "frontier_buttons_unlisted").map((line) => line.step),
        why,
      ).toEqual(["S1-04"]);
      expectLabelsOnly(called);
    }
  });

  it("a plain step with no card that carries no buttons is not offered, as before (frontier_step_missing)", async () => {
    const { context, called } = await frontierOf(s104Request(), s104Seed([S1_03_ROW, s104Row()]), [V1]);
    expect(context.openQuestions.map((question) => question.openQuestionId)).toEqual([S1_04_QUESTION]);
    expect(called.log.lines[0]).toMatchObject({
      msg: "frontier_step_missing",
      open_question_id: "oq-s1-03-sam",
    });
  });

  it("a split with no card is not offered, as before, whatever its buttons (K-01 v1: a split's options are its card's)", async () => {
    const splitNoCard = withStepChanged(V2, "S1-09", (step) => {
      delete step.card;
    });
    const row = openQuestionRow({ id: "oq-s1-09-sam", step: "S1-09", bundleId: V2_ID });
    const { context, called } = await frontierOf(s104Request(V2_ID), s104Seed([row, s104Row(V2_ID)]), [
      splitNoCard,
    ]);
    expect(context.openQuestions.map((question) => question.openQuestionId)).toEqual([S1_04_QUESTION]);
    expect(called.log.lines[0]).toMatchObject({
      msg: "frontier_step_missing",
      open_question_id: "oq-s1-09-sam",
    });
  });
});

describe("T-1478: S1-02's choices and every other question's are unchanged", () => {
  it("S1-02's context still equals K-02's context-s1-02.json (its door and danger row stood in, as no slot builds them yet)", async () => {
    const exchange = s102Exchange();
    const choices = exchange.outcome.context.choices;
    const stands: Record<string, Json[]> = {
      hubsAndDoors: choices.filter((choice) => choice.kind === "door"),
      anyTime: choices.filter((choice) => choice.kind === "anytime"),
    };
    const sources: SourceSlot[] = FRONTIER_SOURCES.map((slot) => {
      const stood = stands[slot.name];
      return stood === undefined ? slot : { name: slot.name, source: standIn(slot.name, stood) };
    });
    const called = await callBuildFrontier(exchange.request, { sources });
    const answer = called.answer.ok ? (called.answer.value as { context: Context }) : null;
    const k02 = contractFixture("model/fixtures/context-s1-02.json") as Json;
    // The last 6 messages are empty while no frozen call reads them (K-05 v1.2 open gap 20).
    expect(answer?.context).toEqual({ ...k02, recentMessages: [] });
  });

  it("bundle v0's S1-02, a split with its card, still gives its card's three options and its card", async () => {
    const { context } = await frontierOf(s102Exchange().request, samSeed(), [V0_SKELETON]);
    expect(context.choices.map((choice) => choice.label)).toEqual([
      "All on the list",
      "One isn't on the list yet",
      "Not a service we book",
    ]);
    expect(context.cards.map((card) => card.step)).toEqual(["S1-02"]);
  });

  it("bundle v1's own S1-02 beside S1-04: each question its own options, only S1-02 with a card", async () => {
    const s102 = openQuestionRow({ id: "oq-s1-02", step: "S1-02", bundleId: V1_ID });
    const { context } = await frontierOf(s104Request(), s104Seed([s102, s104Row()]), [V1]);
    expect(context.choices.map((choice) => [choice.question, choice.label])).toEqual([
      ["oq-s1-02", "All on the list"],
      ["oq-s1-02", "One isn't on the list yet"],
      ["oq-s1-02", "Not a service we book"],
      ...S1_04_BUTTONS.map((label) => [S1_04_QUESTION, label]),
    ]);
    expect(context.cards.map((card) => card.step)).toEqual(["S1-02"]);
  });
});

describe("T-1478: a choice the frontier gives, handed to limit 1, passes default 14 (the sign-up's own answer)", () => {
  /** The sender's own word on their own record (defaults 3a and 14). */
  const PASS_OWN: AllowedDecision = { result: "pass", why: "decider" };
  /** S1-04's question as stored for default 14's read: Sam's, on his handle, at the barbershop, live and gone out. */
  const STORED = {
    questions: [{ asked: s1_02Asked({ openQuestionId: S1_04_QUESTION, step: "S1-04" }), live: true }],
  };

  it("each of S1-04's three choices, as the frontier gives them, passes limit 1 as Sam's own record, control not proven", async () => {
    const { context } = await frontierOf(s104Request(), s104Seed(), [V1]);
    const words = wordsOf(context);
    for (const choice of context.choices) {
      const request = requestFor({ who: SAM, choices: context.choices, choiceId: choice.choiceId, words });
      const limit = limitIn({ record: signUpRecord(), signUps: STORED });
      expect(await limit.decide(partOf(request), turnOf(request)), choice.choiceId).toEqual(PASS_OWN);
      expect(await limit.check(partOf(request), turnOf(request)), choice.choiceId).toEqual({
        result: "pass",
      });
    }
  });

  it("the low stakes are what pass it: the same choice with default 86's stakes (high, unknown) answers as before default 14", async () => {
    const { context } = await frontierOf(s104Request(), s104Seed(), [V1]);
    const [first] = context.choices;
    const unknown: Choice = {
      ...first,
      stakes: "high",
      stakesFrom: [{ why: "unknown", step: null, ref: null }],
    };
    const words = wordsOf(context);
    const request = requestFor({ who: SAM, choices: [unknown], choiceId: unknown.choiceId, words });
    const limit = limitIn({ record: signUpRecord(), signUps: STORED });
    expect(await limit.decide(partOf(request), turnOf(request))).not.toEqual(PASS_OWN);
  });
});

describe("T-1478: a partial bundle's walk, and a full one's", () => {
  it("bundle v1 read as a full bundle: S1-08 is missing, so the walk cannot be followed and every option is high (unknown)", async () => {
    const full = withSteps(V1, [], false);
    const { context } = await frontierOf(s104Request(), s104Seed(), [full]);
    expect(optionsOf(context, S1_04_QUESTION).map((choice) => [choice.stakes, choice.stakesFrom])).toEqual(
      S1_04_BUTTONS.map(() => ["high", [{ why: "unknown", step: null, ref: null }]]),
    );
  });
});
