// Tests of the composer's schema and checks (T-373, C-118), offline:
//   - the schema the model answers in is K-03 v1's plan, cut from the frozen file exactly as the contracts'
//     structured-subset lint bundles it, and inside the structured-outputs subset by that lint;
//   - the hand-written checks accept and refuse what K-03's own schema does (Ajv over the contract files: the plan
//     through the message-plan contract loader, T-1071; the input against K-03 v1.1's composeInput, whose facts are slot
//     facts and term facts), on every K-03 plan and input at hand and on damaged copies of each;
//   - each refusal is typed: the frontier, a format outside the five, {{hold}}, a slot outside the vocabulary;
//   - the literal-value check: a number, date or price typed outside the slots is refused unless a fact holds it, a
//     slot fact or a term fact (facts[].value); on numbers it is K-03 v1.1's named rule numbersHeldByFacts exactly.
// Round 3 (DL-163): prices written in words are literals, held only by a fact's value with the same amount (rule 1);
// English month names join the date words, beside the Spanish ones and the day names (rule 2); the input check refuses
// a term fact whose words hold "{{", one rule stricter than v1.1's schema (rule 3).

import path from "node:path";
import { pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import planContractFile from "../../../contracts/message-plan/message-plan.v1.schema.json";
import { loadPlanContract, type PlanContract } from "../recorded-double";
import inputContractFile from "../../../contracts/message-plan/message-plan.v1.1.schema.json";
import {
  FORMATS,
  INPUT_FILE,
  PLAN_FILE,
  PLAN_SCHEMA,
  SLOT_NAMES,
  TERM_FACT_SOURCE,
  TERM_FACT_VALUE,
  bundlePlanDefinition,
  inputProblems,
  literalProblems,
  planAgainstInput,
  planProblems,
  type ComposeInput,
  type ComposeProblem,
  type InputFact,
  type MessagePlan,
} from "./index";
import { COMPOSER_EXAMPLES } from "./prompt";
import {
  RECORDED_INPUTS,
  REPO_ROOT,
  loadPlanRules,
  readJson,
  recordedInput,
  v1dot1Errors,
  v1dot1Fixture,
  type InputAndPlan,
  type PlanRules,
} from "./test-support";

interface SubsetLint {
  bundleSchema(target: { schema: string; def: string }): unknown;
  lintSchema(bundled: unknown): {
    errors: string[];
    counts: { optionalProperties: number; unionParameters: number };
  };
}

const load = async <T>(file: string): Promise<T> =>
  (await import(/* @vite-ignore */ pathToFileURL(path.join(REPO_ROOT, file)).href)) as T;

let lint: SubsetLint;
let contract: PlanContract;
let rules: PlanRules;

beforeAll(async () => {
  lint = await load<SubsetLint>("contracts/scripts/structured-subset-lint.mjs");
  contract = loadPlanContract();
  rules = await loadPlanRules();
});

const PLAN_FIXTURES = [
  "plan-s1-02.json",
  "plan-block-readback-poll.json",
  "plan-confirmation-a6-14.json",
  "plan-relay-private-a7-12.json",
  "plan-sensitive.json",
  "plan-tapback-thanks.json",
] as const;
const REFUSED_PLANS = ["refuse-format-not-allowed.json", "refuse-hold-slot.json"] as const;
const invalid = (file: string): unknown => readJson(`contracts/message-plan/fixtures/invalid/${file}`);
const k03 = (file: string): unknown => contract.fixtures.read(file);
/** K-03 v1.1's twin of input-s1-02.json: the same input, with S1-02's four card terms as term facts. */
const twinInput = (): ComposeInput => v1dot1Fixture("input-s1-02-v1.1.json") as ComposeInput;
const pair = (file: string): InputAndPlan => v1dot1Fixture(file) as InputAndPlan;
/** Every input at hand: K-03's v1 input and its v1.1 twin, and the double's five inputs. */
const inputs = (): ComposeInput[] => [
  k03("input-s1-02.json") as ComposeInput,
  twinInput(),
  ...RECORDED_INPUTS.map(recordedInput),
];

type Path = readonly (string | number)[];
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether an input has a fact with no slot (a term fact, if the schema takes it) whose words hold "{{": the one rule the
 * input check adds to K-03 v1.1's composeInput (DL-163 rule 3).
 */
const termWordsHoldSlot = (input: unknown): boolean =>
  isObject(input) &&
  Array.isArray(input.facts) &&
  (input.facts as unknown[]).some(
    (fact) =>
      isObject(fact) && !("slot" in fact) && typeof fact.value === "string" && fact.value.includes("{{"),
  );

/** Every node's path in a JSON value, the root first. */
function pathsOf(value: unknown, at: Path = []): Path[] {
  const paths: Path[] = [at];
  if (Array.isArray(value))
    (value as unknown[]).forEach((item, k) => paths.push(...pathsOf(item, [...at, k])));
  else if (isObject(value))
    for (const [key, inner] of Object.entries(value)) paths.push(...pathsOf(inner, [...at, key]));
  return paths;
}

function nodeAt(value: unknown, at: Path): unknown {
  let node: unknown = value;
  for (const step of at) {
    if (Array.isArray(node)) node = (node as unknown[])[step as number];
    else if (isObject(node)) node = node[step as string];
    else throw new Error("no node at that path");
  }
  return node;
}

function withNode(value: unknown, at: Path, replacement: unknown): unknown {
  const [head, ...rest] = at;
  if (head === undefined) return replacement;
  if (Array.isArray(value)) {
    const copy = [...(value as unknown[])];
    copy[head as number] = withNode(copy[head as number], rest, replacement);
    return copy;
  }
  if (isObject(value)) return { ...value, [head]: withNode(value[head as string], rest, replacement) };
  throw new Error("no node at that path");
}

/** Damaged copies: each node replaced by a wrong type or an edge value, an object with a key too many or too few, a list one longer or shorter. */
function damagedCopies(value: unknown): unknown[] {
  const copies: unknown[] = [];
  for (const at of pathsOf(value)) {
    const node = nodeAt(value, at);
    const variants: unknown[] = [7, 1.5, null, true, "", "x", "{{hold}}", [], {}];
    if (Array.isArray(node)) {
      const list = node as unknown[];
      variants.push([...list, 7], [...list, "x"]);
      if (list.length > 0) variants.push(list.slice(1));
    }
    if (isObject(node)) {
      variants.push({ ...node, extra: "x" });
      for (const key of Object.keys(node))
        variants.push(Object.fromEntries(Object.entries(node).filter(([name]) => name !== key)));
    }
    for (const variant of variants) copies.push(withNode(value, at, variant));
  }
  return copies;
}

describe("the schema the model answers in is K-03 v1's plan", () => {
  it("is the structured-subset lint's own bundle of K-03's $defs/plan, and the lint passes it: no optional property, 3 unions", () => {
    expect(PLAN_SCHEMA).toEqual(lint.bundleSchema({ schema: PLAN_FILE, def: "plan" }));
    const result = lint.lintSchema(PLAN_SCHEMA);
    expect(result.errors).toEqual([]);
    expect(result.counts).toMatchObject({ optionalProperties: 0, unionParameters: 3 });
    expect(JSON.stringify(PLAN_SCHEMA)).not.toContain('"$id"');
    expect(JSON.stringify(PLAN_SCHEMA)).not.toContain("formats.v1");
  });

  it("is static and frozen: built again it is the same, and every call sends this one object", () => {
    expect(bundlePlanDefinition()).toEqual(PLAN_SCHEMA);
    expect(Object.isFrozen(PLAN_SCHEMA)).toBe(true);
    expect(Object.isFrozen(PLAN_SCHEMA.properties)).toBe(true);
  });

  it("compiles in strict Ajv, accepts each of K-03's plans and refuses both refused plan fixtures", () => {
    const validate = new Ajv2020({ strict: true, strictRequired: false }).compile(PLAN_SCHEMA);
    for (const file of PLAN_FIXTURES) expect(validate(k03(file)), file).toBe(true);
    for (const file of REFUSED_PLANS) expect(validate(invalid(file)), file).toBe(false);
  });

  it("reads its lists from the contract: the five formats and the 52 slots, with no hold", () => {
    const defs = (planContractFile as unknown as { $defs: Record<string, { enum?: string[] }> }).$defs;
    expect(FORMATS).toEqual(defs.format?.enum);
    expect(SLOT_NAMES).toEqual(defs.slotName?.enum);
    expect(SLOT_NAMES).toHaveLength(52);
    expect(SLOT_NAMES).not.toContain("hold");
  });

  it("reads the input's term fact from K-03 v1.1, whose plan is v1's own: the term's value and source patterns, and no slot", () => {
    expect(INPUT_FILE).toBe("message-plan/message-plan.v1.1.schema.json");
    const defs = (
      inputContractFile as unknown as {
        $defs: Record<
          string,
          { $ref?: string; required?: string[]; properties?: Record<string, { pattern?: string }> }
        >;
      }
    ).$defs;
    expect(defs.plan?.$ref).toBe("message-plan.v1.schema.json#/$defs/plan");
    expect(defs.termFact?.required).toEqual(["value", "source"]);
    expect(TERM_FACT_VALUE.source).toBe(defs.termFact?.properties?.value?.pattern);
    expect(TERM_FACT_SOURCE.source).toBe(defs.termFact?.properties?.source?.pattern);
    expect(TERM_FACT_VALUE.unicode && TERM_FACT_SOURCE.unicode).toBe(true);
  });
});

describe("the checks refuse exactly what K-03's own schema refuses", () => {
  it("planProblems: every K-03 plan, both refused plans and damaged copies of each plan", () => {
    let compared = 0;
    let refused = 0;
    const plans: unknown[] = [...PLAN_FIXTURES.map(k03), ...REFUSED_PLANS.map(invalid)];
    for (const plan of plans) {
      for (const variant of [plan, ...damagedCopies(plan)]) {
        const accepted = contract.validate("plan", variant).length === 0;
        expect(planProblems(variant).length === 0, JSON.stringify(variant)).toBe(accepted);
        compared += 1;
        if (!accepted) refused += 1;
      }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(500);
  });

  it("inputProblems: K-03 v1.1's composeInput, less a term fact whose words hold '{{' (DL-163 rule 3), over K-03's input and its v1.1 twin, the double's five inputs, the frontier fixture, inputs mixing slot and term facts, and damaged copies of each", () => {
    let compared = 0;
    let refused = 0;
    let termFactsAccepted = 0;
    let slotInTermRefused = 0;
    const twin = twinInput();
    const confirmation = recordedInput("confirmation-a6-14");
    const mixed: ComposeInput = { ...confirmation, facts: [...confirmation.facts, ...twin.facts] };
    const all: unknown[] = [...inputs(), mixed, invalid("refuse-frontier-in-input.json")];
    for (const input of all) {
      for (const variant of [input, ...damagedCopies(input)]) {
        const schemaAccepts = v1dot1Errors("composeInput", variant).length === 0;
        const accepted = schemaAccepts && !termWordsHoldSlot(variant);
        expect(inputProblems(variant).length === 0, JSON.stringify(variant)).toBe(accepted);
        compared += 1;
        if (!accepted) refused += 1;
        if (schemaAccepts && !accepted) slotInTermRefused += 1;
        const facts = isObject(variant) ? variant.facts : undefined;
        if (accepted && Array.isArray(facts) && facts.some((fact) => isObject(fact) && !("slot" in fact)))
          termFactsAccepted += 1;
      }
    }
    expect(compared).toBeGreaterThan(3000);
    expect(refused).toBeGreaterThan(1500);
    expect(termFactsAccepted).toBeGreaterThan(20);
    // The damaged copies whose term words became "{{hold}}": v1.1's schema takes each, and the input check refuses it.
    expect(slotInTermRefused).toBeGreaterThanOrEqual(8);
  });

  it("inputProblems still refuses exactly what K-03 v1's own schema refuses on every v1 input and its damaged copies: v1.1 adds term facts and loosens nothing else", () => {
    let compared = 0;
    let refused = 0;
    const v1Inputs: unknown[] = [
      k03("input-s1-02.json"),
      ...RECORDED_INPUTS.map(recordedInput),
      invalid("refuse-frontier-in-input.json"),
    ];
    for (const input of v1Inputs) {
      for (const variant of [input, ...damagedCopies(input)]) {
        const accepted = contract.validate("composeInput", variant).length === 0;
        expect(inputProblems(variant).length === 0, JSON.stringify(variant)).toBe(accepted);
        compared += 1;
        if (!accepted) refused += 1;
      }
    }
    expect(compared).toBeGreaterThan(2000);
    expect(refused).toBeGreaterThan(1000);
  });
});

describe("each refusal is typed", () => {
  it("the frontier: refuse-frontier-in-input.json is refused for its frontier alone; without it, it is input-s1-02.json", () => {
    const fixture = invalid("refuse-frontier-in-input.json") as Record<string, unknown>;
    expect(inputProblems(fixture)).toEqual([{ check: "frontier", at: "frontier" }]);
    const without = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== "frontier"));
    expect(without).toEqual(k03("input-s1-02.json"));
    expect(inputProblems(without)).toEqual([]);
    // Any other field the input does not have is refused as well, as the input's shape.
    expect(inputProblems({ ...without, choices: [] })).toEqual([{ check: "input", at: "(root)" }]);
  });

  it("a term fact is K-03 v1.1's: its words and its source, and no slot; any other fact is the input's shape, as v1.1's schema says", () => {
    const twin = twinInput();
    expect(inputProblems(twin)).toEqual([]);
    const withFacts = (facts: unknown[]): unknown => ({ ...twin, facts });
    const bad: unknown[] = [
      { value: "Free to use", source: "S1-02's card, line 3", slot: "fee" },
      { value: "Free to use" },
      { source: "S1-02's card, line 3" },
      { value: "", source: "S1-02's card, line 3" },
      { value: "\n", source: "S1-02's card, line 3" },
      { value: "Free to use", source: "" },
      { value: 2, source: "S1-02's card, line 4" },
      { value: "Free to use", source: "S1-02's card, line 3", extra: "x" },
    ];
    for (const fact of bad) {
      const input = withFacts([fact]);
      expect(v1dot1Errors("composeInput", input), JSON.stringify(fact)).not.toEqual([]);
      expect(inputProblems(input), JSON.stringify(fact)).toEqual([{ check: "input", at: "facts[0]" }]);
    }
    // Words that only look odd are still a term's words: v1.1 holds a term to "some words" and its source, nothing more.
    for (const value of ["Free to use\n", " "]) {
      const input = withFacts([{ value, source: "S1-02's card" }]);
      expect(v1dot1Errors("composeInput", input), value).toEqual([]);
      expect(inputProblems(input), value).toEqual([]);
    }
    // But for "{{": v1.1's schema takes "{{fee}} a booking" as a term's words, and the input check refuses it (DL-163).
    const slotted = withFacts([{ value: "{{fee}} a booking", source: "S1-02's card" }]);
    expect(v1dot1Errors("composeInput", slotted)).toEqual([]);
    expect(inputProblems(slotted)).toEqual([{ check: "input", at: "facts[0]" }]);
    // The frontier is refused by name on a v1.1 input too.
    expect(inputProblems({ ...twin, frontier: [] })).toEqual([{ check: "frontier", at: "frontier" }]);
  });

  it("a term fact whose words hold '{{' is refused at its place, though v1.1's schema takes it (DL-163 rule 3; the security review's N3): the filler would fill that slot inside Rosie's own line", () => {
    const twin = twinInput();
    const fee = twin.facts[3];
    if (fee === undefined || !("source" in fee))
      throw new Error("the twin's fourth fact is Rosie's fee term");
    const termWords = [
      "{{fee}} a booking, counted at its check-in or DONE, explained before you go live",
      "{{price}}",
      "About {{visit.time}} minutes for your first kind of work",
      "Free {{ to use",
      "$2 a booking {{",
    ];
    for (const value of termWords) {
      const input: ComposeInput = { ...twin, facts: [...twin.facts.slice(0, 3), { ...fee, value }] };
      expect(v1dot1Errors("composeInput", input), value).toEqual([]);
      expect(inputProblems(input), value).toEqual([{ check: "input", at: "facts[3]" }]);
    }
    // Each such term is named at its own place, beside the other problems of the input.
    const two: ComposeInput = {
      ...twin,
      facts: [
        { ...fee, value: "{{fee}} a booking" },
        ...twin.facts.slice(1, 3),
        { ...fee, value: "{{fee}}" },
      ],
    };
    expect(inputProblems({ ...two, frontier: [] })).toEqual([
      { check: "frontier", at: "frontier" },
      { check: "input", at: "facts[0]" },
      { check: "input", at: "facts[3]" },
    ]);
    // A single brace opens no slot, and a term's source is never filled or shown: neither is held to this rule.
    for (const fact of [
      { ...fee, value: "Free to use {" },
      { ...fee, value: "Free to use }}" },
      { ...fee, source: "S1-02's card, line 4 {{fee}}" },
    ]) {
      expect(inputProblems({ ...twin, facts: [fact] }), JSON.stringify(fact)).toEqual([]);
    }
  });

  it("a format outside K-03's five: refuse-format-not-allowed.json's contact card", () => {
    expect(planProblems(invalid("refuse-format-not-allowed.json"))).toEqual([
      { check: "formatNotAllowed", at: "formats[1]" },
    ]);
  });

  it("a format K-03 knows that the row's allowedFormats does not list", () => {
    const input = recordedInput("confirmation-a6-14");
    const plan = k03("plan-confirmation-a6-14.json");
    expect(planAgainstInput(plan, input)).toEqual([]);
    expect(planAgainstInput(plan, { ...input, allowedFormats: ["text", "linkCard"] })).toEqual([
      { check: "formatNotAllowed", at: "formats[1]" },
    ]);
  });

  it("a {{hold}} slot: refuse-hold-slot.json, and its {{hold:$89}} example price is never read as a literal", () => {
    const plan = invalid("refuse-hold-slot.json");
    expect(planProblems(plan)).toEqual([{ check: "holdSlot", at: "lines[1].text" }]);
    expect(planAgainstInput(plan, recordedInput("confirmation-a6-14"))).toEqual([
      { check: "holdSlot", at: "lines[1].text" },
    ]);
  });

  it("a slot outside the vocabulary, in a line or in the question", () => {
    const plan = structuredClone(k03("plan-block-readback-poll.json")) as {
      lines: { role: string; text: string }[];
      question: { text: string; optionIds: string[] };
    };
    plan.question.text = "Block it at {{price.total}}?";
    expect(planProblems(plan)).toEqual([{ check: "unknownSlot", at: "question.text" }]);
    plan.lines.push({ role: "fact", text: "{{biz.name}} · {{hold}}" });
    expect(planProblems(plan)).toEqual([
      { check: "holdSlot", at: "lines[1].text" },
      { check: "unknownSlot", at: "question.text" },
    ]);
  });
});

describe("no plan carries a literal number, date or price the input's facts do not hold as a slot", () => {
  /** A one-line plan in `words`, for an input with these facts. */
  function literals(words: string, facts: InputFact[] = []): unknown[] {
    const base = k03("input-s1-02.json") as ComposeInput;
    const input = { ...base, facts } as ComposeInput;
    const plan: MessagePlan = {
      formats: ["text"],
      lines: [{ role: "first", text: words }],
      question: null,
      pageType: null,
      threadReplyTo: null,
    };
    expect(planProblems(plan)).toEqual([]);
    return literalProblems(plan, input);
  }
  const problem = (kind: string): unknown => ({ check: "literalValue", at: "lines[0].text", kind });
  const PRICE = { slot: "price", value: "$40" };
  const DAY = { slot: "day", value: "Sat Oct 24" };
  const TIME = { slot: "visit.time", value: "11:00am" };
  const CODE = { slot: "visit.code", value: "5160" };

  it("refuses a price, a date, a time, a day word, a code or any other number that no fact holds", () => {
    expect(literals("Your total is $45.", [PRICE])).toEqual([problem("price")]);
    expect(literals("It's 45 dollars.", [PRICE])).toEqual([problem("price")]);
    expect(literals("See you Sun Oct 25.", [DAY])).toEqual([problem("date")]);
    expect(literals("See you at 2:00pm.", [TIME])).toEqual([problem("date")]);
    expect(literals("See you on 10/25.", [DAY])).toEqual([problem("date")]);
    expect(literals("See you tomorrow.", [DAY])).toEqual([problem("date")]);
    expect(literals("Te esperamos el sábado.", [DAY])).toEqual([problem("date")]);
    expect(literals("Your code is 5161.", [CODE])).toEqual([problem("number")]);
    expect(literals("About 15 minutes.")).toEqual([problem("number")]);
    expect(literals("$45 on Sun, 3 people.")).toEqual([problem("price"), problem("date"), problem("number")]);
  });

  it("passes words with no value, values written as slots (example words included), and what a fact holds", () => {
    expect(literals("We're open and glad to help.")).toEqual([]);
    expect(literals("Your total is {{price:$45}}, {{day:Sun Oct 25}} at {{visit.time:2:00pm}}.")).toEqual([]);
    expect(literals("See you {{tomorrow}} at {{visit.time}}.", [TIME])).toEqual([]);
    expect(literals("Your total is $40.", [PRICE])).toEqual([]);
    expect(literals("See you Sat at 11:00am.", [DAY, TIME])).toEqual([]);
    expect(literals("Your code is 5160.", [CODE])).toEqual([]);
    // Words that only look like a date: a lowercase "sat", and "may" with no day after it.
    expect(literals("She sat down; you may cancel.")).toEqual([]);
  });

  it("reads the question too, and names a field and a kind, never the words", () => {
    const input = recordedInput("block-readback-poll");
    const plan = structuredClone(k03("plan-block-readback-poll.json")) as MessagePlan & {
      question: { text: string };
    };
    expect(literalProblems(plan, input)).toEqual([]);
    plan.question.text = "Block Fri Oct 30, 1–4pm?";
    const problems = literalProblems(plan, input);
    // "Fri", "Oct 30" and "4pm" are a date and a time; the range's "1" is a number no fact holds.
    expect(problems).toEqual([
      { check: "literalValue", at: "question.text", kind: "date" },
      { check: "literalValue", at: "question.text", kind: "number" },
    ]);
    expect(JSON.stringify(problems)).not.toMatch(/Fri|30|4pm/u);
  });

  it("the recorded rows' plans type no value, but K-03's plan-s1-02.json types a price and a number that input-s1-02.json's facts (none) do not hold", () => {
    const pairs: [ComposeInput, string][] = [
      [recordedInput("block-readback-poll"), "plan-block-readback-poll.json"],
      [recordedInput("confirmation-a6-14"), "plan-confirmation-a6-14.json"],
      [recordedInput("relay-private-a7-12"), "plan-relay-private-a7-12.json"],
      [recordedInput("sensitive-a6-15"), "plan-sensitive.json"],
      [recordedInput("tapback-thanks"), "plan-tapback-thanks.json"],
    ];
    for (const [input, file] of pairs)
      expect(literalProblems(k03(file) as MessagePlan, input), file).toEqual([]);
    const s1 = k03("input-s1-02.json") as ComposeInput;
    expect(s1.facts).toEqual([]);
    expect(literalProblems(k03("plan-s1-02.json") as MessagePlan, s1)).toEqual([
      { check: "literalValue", at: "lines[1].text", kind: "price" },
      { check: "literalValue", at: "lines[1].text", kind: "number" },
    ]);
  });

  it("a term fact holds a literal by its own words alone, never by its source, beside the slot facts", () => {
    const SETUP = {
      value: "About 15 minutes for your first kind of work",
      source: "S1-02's card, line 1 (MASTER-FLOW-A.md line 28)",
    };
    const FEE = {
      value: "$2 a booking, counted at its check-in or DONE, explained before you go live",
      source: "S1-02's card, line 4; RULES 3.15",
    };
    expect(literals("About 15 minutes.", [SETUP])).toEqual([]);
    expect(literals("$2 a booking.", [FEE])).toEqual([]);
    expect(literals("$40 · About 15 minutes · $2 a booking.", [PRICE, SETUP, FEE])).toEqual([]);
    expect(literals("About 16 minutes.", [SETUP])).toEqual([problem("number")]);
    expect(literals("$3 a booking.", [FEE])).toEqual([problem("price")]);
    expect(literals("$2.50 a booking.", [FEE])).toEqual([problem("price")]);
    // Numbers only a source holds: "line 28", "RULES 3.15".
    expect(literals("See line 28.", [SETUP])).toEqual([problem("number")]);
    expect(literals("RULES 3.15.", [FEE])).toEqual([problem("number")]);
  });

  it("K-03 v1.1's named rule's fixtures: input-and-plan-s1-02.json is accepted; refuse-term-no-fact-holds.json is refused for its one reason and refuse-plan-s1-02-on-v1-input.json for its two literals; each is accepted once put right", () => {
    const held = pair("input-and-plan-s1-02.json");
    const extra = pair("invalid/refuse-term-no-fact-holds.json");
    const onV1 = pair("invalid/refuse-plan-s1-02-on-v1-input.json");
    expect(planAgainstInput(held.plan, held.input)).toEqual([]);
    expect(planAgainstInput(extra.plan, extra.input)).toEqual([
      { check: "literalValue", at: "lines[1].text", kind: "price" },
    ]);
    expect(planAgainstInput(onV1.plan, onV1.input)).toEqual([
      { check: "literalValue", at: "lines[1].text", kind: "price" },
      { check: "literalValue", at: "lines[1].text", kind: "number" },
    ]);
    // Without the added term the pair is input-and-plan-s1-02 (the same input); with the twin's term facts, so is v1's.
    expect(extra.input).toEqual(held.input);
    expect(onV1.plan).toEqual(held.plan);
    expect(planAgainstInput(held.plan, extra.input)).toEqual([]);
    expect(planAgainstInput(onV1.plan, held.input)).toEqual([]);
  });

  it("on numbers it is numbersHeldByFacts exactly: over every pair at hand and many numbers typed into each words field, the fields the rule names are the fields the check refuses", () => {
    const pairs: InputAndPlan[] = [
      pair("input-and-plan-s1-02.json"),
      pair("invalid/refuse-term-no-fact-holds.json"),
      pair("invalid/refuse-plan-s1-02-on-v1-input.json"),
      ...RECORDED_PAIRS.map(([name, file]) => ({
        input: recordedInput(name),
        plan: k03(file) as MessagePlan,
      })),
    ];
    // Amounts, times, dates, durations, counts and codes in digits (README "Named rule (v1.1)"), held by some facts and
    // not by others, with runs a date or price might cut short ("10/255", "123pm", "12:300").
    const TYPED = [
      "0",
      "2",
      "$2",
      "$2.50",
      "5",
      "7",
      "15",
      "49",
      "$35",
      "$20",
      "5160",
      "#5160",
      "100%",
      "1,234",
      "3.15",
      "11am",
      "11:00am",
      "2–5pm",
      "123pm",
      "12:300",
      "10/255",
      "Oct 24",
      "Oct 25",
      "2026-10-24",
      "line 28",
    ];
    const fieldsOfRule = (problems: string[]): string[] =>
      [...new Set(problems.map((line) => line.slice(0, line.indexOf(": ")).replace(/^plan\./u, "")))].sort();
    const fieldsOfCheck = (problems: readonly ComposeProblem[]): string[] =>
      [...new Set(problems.map((problem) => problem.at))].sort();
    let compared = 0;
    let refused = 0;
    let accepted = 0;
    for (const { input, plan } of pairs) {
      expect(fieldsOfCheck(literalProblems(plan, input))).toEqual(
        fieldsOfRule(rules.numbersHeldByFacts({ input, plan })),
      );
      for (const field of wordsFields(plan)) {
        for (const typed of TYPED) {
          const variant = withWords(plan, field, (words) => `${words} ${typed}`);
          const ours = fieldsOfCheck(literalProblems(variant, input));
          expect(ours, `${field} + ${typed}`).toEqual(
            fieldsOfRule(rules.numbersHeldByFacts({ input, plan: variant })),
          );
          compared += 1;
          if (ours.includes(field)) refused += 1;
          else accepted += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(200);
    expect(accepted).toBeGreaterThan(20);
  });

  it("a literal's digits are whole runs, as the named rule reads them: '10/255' needs 255 held, not 25; '123pm' needs 123, not 23", () => {
    const base = k03("input-s1-02.json") as ComposeInput;
    const oneLine = (words: string): MessagePlan => ({
      formats: ["text"],
      lines: [{ role: "first", text: words }],
      question: null,
      pageType: null,
      threadReplyTo: null,
    });
    const cases: [string, InputFact[], boolean][] = [
      ["See you 10/255.", [{ slot: "day", value: "Oct 10" }, PRICE_25], false],
      ["See you 10/25.", [{ slot: "day", value: "Oct 10" }, PRICE_25], true],
      ["See you at 123pm.", [{ slot: "visit.code", value: "123" }], true],
      ["See you at 123pm.", [{ slot: "visit.code", value: "23" }], false],
      ["See you at 12:300.", [{ slot: "visit.time", value: "12:30" }], false],
    ];
    for (const [words, facts, held] of cases) {
      const input: ComposeInput = { ...base, facts };
      const plan = oneLine(words);
      expect(literalProblems(plan, input).length === 0, words).toBe(held);
      expect(rules.numbersHeldByFacts({ input, plan }).length === 0, words).toBe(held);
    }
  });

  it("dates in words are the check's alone: the named rule states only the number part (README 'Named rule (v1.1)')", () => {
    const held = pair("input-and-plan-s1-02.json");
    const variant = withWords(held.plan, "lines[1].text", (words) => `${words} · Starts Saturday`);
    expect(rules.numbersHeldByFacts({ input: held.input, plan: variant })).toEqual([]);
    expect(literalProblems(variant, held.input)).toEqual([
      { check: "literalValue", at: "lines[1].text", kind: "date" },
    ]);
  });

  // Round 3 (DL-163): dates and prices written in words, which K-03 README line 87 keeps with this check.
  const FEE_TERM = {
    value: "$2 a booking, counted at its check-in or DONE, explained before you go live",
    source: "S1-02's card, line 4; RULES 3.15",
  };
  const SETUP_TERM = {
    value: "About 15 minutes for your first kind of work",
    source: "S1-02's card, line 1",
  };
  const LATER_TERM = { value: "About 5 minutes for each one after", source: "S1-02's card, line 2" };
  const priced = (value: string): InputFact => ({ slot: "price", value });

  it("a price in words is a literal (DL-163 rule 1): number words, then a money word, held when a fact's value states the same amount, in digits or in words", () => {
    // Rosie's fee term states $2, so two dollars, said any way, is held.
    expect(literals("Two dollars a booking.", [FEE_TERM])).toEqual([]);
    expect(literals("It's two bucks a booking.", [FEE_TERM])).toEqual([]);
    expect(literals("Dos dólares por reserva.", [FEE_TERM])).toEqual([]);
    expect(literals("two hundred cents a booking", [FEE_TERM])).toEqual([]);
    // Amounts in digits, held by words that say them.
    expect(literals("Thirty-five dollars at the chair.", [priced("$35")])).toEqual([]);
    expect(literals("Treinta y cinco dólares.", [priced("$35")])).toEqual([]);
    expect(literals("Fifty cents more.", [priced("$0.50")])).toEqual([]);
    expect(literals("Fifty cents more.", [priced("50¢")])).toEqual([]);
    expect(literals("A dollar a booking.", [priced("$1")])).toEqual([]);
    expect(literals("One hundred and fifty dollars in all.", [priced("$150")])).toEqual([]);
    expect(literals("Mil quinientos dólares.", [priced("$1,500")])).toEqual([]);
    expect(literals("A fifteen-dollar fee.", [priced("15 dollars")])).toEqual([]);
    expect(literals("Veinte pesos.", [priced("20 pesos")])).toEqual([]);
    // A fact that says its amount in words holds it in words too.
    expect(
      literals("Two dollars a booking.", [{ value: "two dollars a booking", source: "a card line" }]),
    ).toEqual([]);
  });

  it("a price in words that no fact's value states is refused, though a fact holds the same number for something else, another currency or only in its source", () => {
    // The S1-02 terms hold 5 and 15 as minutes and 2 as dollars: no five, fifteen or one dollars, and no cents.
    const terms = [SETUP_TERM, LATER_TERM, FEE_TERM];
    for (const words of [
      "Five dollars a booking.",
      "Fifteen bucks a booking.",
      "A dollar a booking.",
      "Fifty cents a booking.",
      "Cinco dólares por reserva.",
      "Un dólar por reserva.",
      "Two euros a booking.",
      "Two pesos a booking.",
      "Twenty-five dollars.",
      "Zero dollars to start.",
    ])
      expect(literals(words, terms), words).toEqual([problem("price")]);
    // A source never holds an amount.
    expect(
      literals("Two dollars a booking.", [{ value: "Rosie's own fee", source: "RULES 3.15: $2" }]),
    ).toEqual([problem("price")]);
    // "$2.50" is not two dollars, and two dollars and fifty cents are two amounts, neither of them $2.50.
    expect(literals("Two dollars a booking.", [priced("$2.50")])).toEqual([problem("price")]);
    expect(literals("Two dollars and fifty cents.", [priced("$2.50")])).toEqual([problem("price")]);
  });

  it("a number word outside a price stays outside this check: with no money word after it, it is not a literal (DL-163)", () => {
    expect(literals("One more thing: two people can come.")).toEqual([]);
    expect(literals("About five minutes for each one after.")).toEqual([]);
    expect(literals("Prices are in dollars, a booking at a time.")).toEqual([]);
    expect(literals("Fifty percent of the visits.")).toEqual([]);
    expect(literals("Free to use: no dollars, no cents.")).toEqual([]);
  });

  it("a date in words is a literal (DL-163 rule 2): the English month names beside the Spanish ones, and the English and Spanish day names, each held only by a fact's value with the same word", () => {
    // "See you in October" is refused unless a fact holds October: "Sat Oct 24" holds Oct, not October.
    expect(literals("See you in October.", [DAY])).toEqual([problem("date")]);
    expect(literals("See you in October.", [{ slot: "day", value: "Saturday, October 24" }])).toEqual([]);
    const words = [
      ...["January", "February", "March", "April", "May", "June", "July", "August", "September"],
      ...["October", "November", "December", "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept"],
      ...["Oct", "Nov", "Dec", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      ...["Mon", "Tue", "Tues", "Wed", "Thu", "Thur", "Thurs", "Fri", "Sat", "Sun", "Saturdays", "Sundays"],
      ...["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre"],
      ...["noviembre", "diciembre", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"],
      ...["miercoles", "sabado", "sábados", "domingos"],
    ];
    for (const word of words) {
      expect(literals(`See you ${word}.`), word).toEqual([problem("date")]);
      expect(literals(`See you ${word}.`, [{ slot: "day", value: `${word} 24` }]), word).toEqual([]);
    }
    // The full names that are no everyday word are read in any case; Spanish ones too.
    for (const typed of ["see you in october", "SEE YOU SATURDAY", "Te vemos el SÁBADO", "hasta el Lunes"])
      expect(literals(typed), typed).toEqual([problem("date")]);
    // An accent typed as its own mark (U+0301, the combining acute) reads the same, as the check reads NFC.
    const decomposed = `Te vemos el sa${String.fromCodePoint(0x301)}bado.`;
    expect(decomposed.normalize("NFC")).not.toBe(decomposed);
    expect(literals(decomposed)).toEqual([problem("date")]);
  });

  it("words that only look like a month stay words: may, march and august in lowercase, as round 1 kept sat and may", () => {
    expect(literals("You may cancel; we march on in an august hall.")).toEqual([]);
    expect(literals("She sat down; you may cancel.")).toEqual([]);
    // Capitalized, they are month names, held as any date word is.
    expect(literals("May we see you in March?", [{ slot: "day", value: "May 3" }])).toEqual([
      problem("date"),
    ]);
    expect(literals("See you in March.", [{ slot: "day", value: "Tue March 3" }])).toEqual([]);
  });

  it("the prompt's five worked examples, whose plans the model learns from, still pass the whole check against their own inputs", () => {
    expect(COMPOSER_EXAMPLES).toHaveLength(5);
    for (const { title, input, plan } of COMPOSER_EXAMPLES)
      expect(planAgainstInput(plan, input), title).toEqual([]);
  });
});

/** A price fact whose run, 25, is part of 255 but not 255. */
const PRICE_25: InputFact = { slot: "price", value: "$25" };

/** The double's five inputs with the K-03 plan each one answers. */
const RECORDED_PAIRS: readonly (readonly [(typeof RECORDED_INPUTS)[number], string])[] = [
  ["block-readback-poll", "plan-block-readback-poll.json"],
  ["confirmation-a6-14", "plan-confirmation-a6-14.json"],
  ["relay-private-a7-12", "plan-relay-private-a7-12.json"],
  ["sensitive-a6-15", "plan-sensitive.json"],
  ["tapback-thanks", "plan-tapback-thanks.json"],
];

/** A plan's words fields, as a refusal names them: each line's text, then the question's. */
function wordsFields(plan: MessagePlan): string[] {
  return [
    ...plan.lines.map((_line, k) => `lines[${String(k)}].text`),
    ...(plan.question === null ? [] : ["question.text"]),
  ];
}

/** The plan with one words field's text changed. */
function withWords(plan: MessagePlan, field: string, change: (words: string) => string): MessagePlan {
  if (field === "question.text") {
    if (plan.question === null) throw new Error("the plan has no question");
    return { ...plan, question: { ...plan.question, text: change(plan.question.text) } };
  }
  const k = Number(/^lines\[(\d+)\]\.text$/u.exec(field)?.[1]);
  return {
    ...plan,
    lines: plan.lines.map((line, n) => (n === k ? { ...line, text: change(line.text) } : line)),
  };
}
