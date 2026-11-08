// Tests of the composer's schema and checks (T-373, C-118), offline:
//   - the schema the model answers in is K-03 v1's plan, cut from the frozen file exactly as the contracts'
//     structured-subset lint bundles it, and inside the structured-outputs subset by that lint;
//   - the hand-written checks accept and refuse what K-03's own schema does (Ajv over the contract files, through the
//     message-plan contract loader, T-1071), on every K-03 plan and input at hand and on damaged copies of each;
//   - each refusal is typed: the frontier, a format outside the five, {{hold}}, a slot outside the vocabulary;
//   - the literal-value check: a number, date or price typed outside the slots is refused unless a fact holds it.

import path from "node:path";
import { pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import planContractFile from "../../../contracts/message-plan/message-plan.v1.schema.json";
import { loadPlanContract, type PlanContract } from "../recorded-double";
import {
  FORMATS,
  PLAN_FILE,
  PLAN_SCHEMA,
  SLOT_NAMES,
  bundlePlanDefinition,
  inputProblems,
  literalProblems,
  planAgainstInput,
  planProblems,
  type ComposeInput,
  type MessagePlan,
} from "./index";
import { RECORDED_INPUTS, REPO_ROOT, readJson, recordedInput } from "./test-support";

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

beforeAll(async () => {
  lint = await load<SubsetLint>("contracts/scripts/structured-subset-lint.mjs");
  contract = loadPlanContract();
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
const inputs = (): ComposeInput[] => [
  k03("input-s1-02.json") as ComposeInput,
  ...RECORDED_INPUTS.map(recordedInput),
];

type Path = readonly (string | number)[];
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

  it("inputProblems: K-03's input, the double's five inputs, the frontier fixture and damaged copies of each", () => {
    let compared = 0;
    let refused = 0;
    const all: unknown[] = [...inputs(), invalid("refuse-frontier-in-input.json")];
    for (const input of all) {
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
  function literals(words: string, facts: { slot: string; value: string }[] = []): unknown[] {
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
});
