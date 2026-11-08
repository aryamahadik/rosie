// Tests of what decide's model answers in and of the validator a read passes before it leaves the AI layer (T-368):
//   - the two steps' schemas are the ones the decide-wire spike sent and both models accepted live (CQ-25, T-1068),
//     cut from the frozen K-02 file exactly as the contracts' structured-subset lint bundles a definition, and they pass
//     that lint;
//   - the hand-written K-02 check accepts and refuses what K-02's own schema (Ajv over the contract files) does;
//   - the named rules refuse what contracts/model/model.rules.mjs refuses, on the fixtures and on damaged copies.

import path from "node:path";
import { pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import modelContract from "../../../contracts/model/model.v1.schema.json";
import type { DecideContext } from "../context";
import { loadModelContract, type ModelContract } from "../recorded-double";
import {
  CHOOSE_KINDS,
  ENTER_KINDS,
  FIELD_VERBS,
  HAND_OFF_ABOUT,
  MODEL_FILE,
  PART_DEF,
  PART_KEYS,
  STAGE1_SCHEMA,
  STAGE2_SCHEMAS,
  VERBS,
  bundleContractDefinition,
  decideReadProblems,
  isDecideRead,
  readProblems,
  type DecideRead,
} from "./index";
import {
  CARD_FIXTURES,
  K02_CONTEXTS,
  MORE_FIXTURES,
  REPO_ROOT,
  WRITTEN_CONTEXTS,
  readJson,
  twoStep,
  type Raw,
} from "./test-support";

interface SubsetLint {
  bundleSchema(target: { schema: string; def: string }): unknown;
  lintSchema(bundled: unknown): {
    errors: string[];
    counts: { optionalProperties: number; unionParameters: number };
  };
}
interface DecideWire {
  stage1Schema(): unknown;
  stage2Schema(verb: string): unknown;
}
interface RulesFile {
  CHOOSE_KINDS: readonly string[];
  ENTER_KINDS: readonly string[];
}

const load = async <T>(file: string): Promise<T> =>
  (await import(/* @vite-ignore */ pathToFileURL(path.join(REPO_ROOT, file)).href)) as T;

let lint: SubsetLint;
let wire: DecideWire;
let rulesFile: RulesFile;
let contract: ModelContract;
/** Each accepted decide fixture's context and reads. */
const pairs: { file: string; context: DecideContext; reads: DecideRead[] }[] = [];

beforeAll(async () => {
  lint = await load<SubsetLint>("contracts/scripts/structured-subset-lint.mjs");
  wire = await load<DecideWire>("ai/spikes/decide-wire/lib.mjs");
  rulesFile = await load<RulesFile>("contracts/model/model.rules.mjs");
  contract = await loadModelContract();
  for (const file of [...CARD_FIXTURES, ...MORE_FIXTURES]) {
    const k02 = K02_CONTEXTS[file];
    const context = (
      k02 === undefined ? WRITTEN_CONTEXTS[file] : contract.fixtures.read(k02)
    ) as DecideContext;
    const fixture = contract.fixtures.read(file) as { reads: { output: DecideRead }[] };
    pairs.push({ file, context, reads: fixture.reads.map((read) => read.output) });
  }
});

const MODEL_SCHEMA = readJson("contracts/model/model.v1.schema.json") as {
  $defs: Record<string, { required?: string[]; enum?: string[]; anyOf?: { $ref: string }[] }>;
};

const compile = (schema: unknown): ReturnType<Ajv2020["compile"]> =>
  new Ajv2020({ strict: true, strictRequired: false }).compile(schema as object);

describe("the schemas the model answers in: CQ-25's two steps", () => {
  it("step 1 is the decide-wire spike's stage-1 schema, the form accepted live on claude-haiku-5-5 and claude-sonnet-5-5", () => {
    expect(STAGE1_SCHEMA).toEqual(wire.stage1Schema());
  });

  it("step 2 of each verb is the spike's stage-2 schema, K-02's own part less verb and quote; no_op has none", () => {
    expect([...FIELD_VERBS]).toEqual(VERBS.filter((verb) => verb !== "no_op"));
    for (const verb of FIELD_VERBS) expect(STAGE2_SCHEMAS[verb]).toEqual(wire.stage2Schema(verb));
    expect(wire.stage2Schema("no_op")).toBeNull();
    expect(Object.keys(STAGE2_SCHEMAS).sort()).toEqual([...FIELD_VERBS].sort());
  });

  it("the bundler is the subset lint's: every K-02 definition decide reaches bundles to the same schema", () => {
    const defs = ["decideRead", "decidePart", "field", "fieldValue", "language", "nonEmptyText", "quote"];
    for (const def of [...defs, ...Object.values(PART_DEF)]) {
      expect(bundleContractDefinition(MODEL_FILE, def)).toEqual(
        lint.bundleSchema({ schema: MODEL_FILE, def }),
      );
    }
    expect(() => bundleContractDefinition(MODEL_FILE, "noSuchDefinition")).toThrow(/does not resolve/u);
  });

  it("each passes the structured-outputs subset lint: no optional property, at most the one union of a field's value", () => {
    const stage1 = lint.lintSchema(STAGE1_SCHEMA);
    expect(stage1.errors).toEqual([]);
    expect(stage1.counts).toEqual({ optionalProperties: 0, unionParameters: 0 });
    for (const verb of FIELD_VERBS) {
      const { errors, counts } = lint.lintSchema(STAGE2_SCHEMAS[verb]);
      expect(errors, verb).toEqual([]);
      expect(counts.optionalProperties, verb).toBe(0);
      expect(counts.unionParameters, verb).toBe(verb === "choose" || verb === "enter" ? 1 : 0);
    }
  });

  it("each compiles in Ajv's strict mode and accepts every K-02 fixture read's two steps", () => {
    const stage1 = compile(STAGE1_SCHEMA);
    const stage2 = Object.fromEntries(FIELD_VERBS.map((verb) => [verb, compile(STAGE2_SCHEMAS[verb])]));
    let checked = 0;
    for (const { reads } of pairs) {
      for (const read of reads) {
        const steps = twoStep(read as unknown as Raw);
        expect(stage1(steps.step1)).toBe(true);
        read.parts.forEach((part, k) => {
          if (part.verb === "no_op") return;
          expect(stage2[part.verb]?.(steps.step2[k])).toBe(true);
          checked += 1;
        });
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
    expect(stage1({ language: "en", parts: [{ quote: "2", verb: "book" }] })).toBe(false);
    expect(stage1({ language: "en", parts: [] })).toBe(false);
  });

  it("is static and cannot be changed in place: what is sent is the contract's", () => {
    expect(Object.isFrozen(STAGE1_SCHEMA)).toBe(true);
    for (const verb of FIELD_VERBS) expect(Object.isFrozen(STAGE2_SCHEMAS[verb].$defs)).toBe(true);
    expect(() => {
      STAGE1_SCHEMA.type = "string";
    }).toThrow(TypeError);
    // Bundling copies: the contract module's own objects are never frozen or shared.
    expect(Object.isFrozen(modelContract.$defs.choose)).toBe(false);
    expect(Object.isFrozen(modelContract.$defs.choose.required)).toBe(false);
    expect(Object.isFrozen(modelContract.$defs.language)).toBe(false);
  });

  it("the verbs, the hand-off's about, each part's keys and the kinds each verb takes are K-02's own", () => {
    const branches = (MODEL_SCHEMA.$defs.decidePart?.anyOf ?? []).map((branch) =>
      branch.$ref.replace("#/$defs/", ""),
    );
    expect(branches).toEqual(VERBS.map((verb) => PART_DEF[verb]));
    for (const verb of VERBS) expect(PART_KEYS[verb]).toEqual(MODEL_SCHEMA.$defs[PART_DEF[verb]]?.required);
    expect([...HAND_OFF_ABOUT]).toEqual(MODEL_SCHEMA.$defs.handOffAbout?.enum);
    expect(CHOOSE_KINDS).toEqual(rulesFile.CHOOSE_KINDS);
    expect(ENTER_KINDS).toEqual(rulesFile.ENTER_KINDS);
  });
});

const CHOOSE = { verb: "choose", quote: "2", question: "oq-a7-17", choice: "c-02", fields: [] as Raw[] };
const read = (...parts: unknown[]): Raw => ({ language: "en", parts });
const withField = (field: unknown): Raw => read({ ...CHOOSE, fields: [field] });
const TIME = { utc: "2026-10-24T18:00:00Z", zone: "America/New_York" };

/** Reads K-02's schema refuses, each for one reason. */
const BROKEN_READS: { why: string; read: unknown }[] = [
  { why: "not an object", read: null },
  { why: "a list", read: [CHOOSE] },
  { why: "no language and no parts", read: {} },
  { why: "a key a read does not have", read: { ...read(CHOOSE), confidence: 0.9 } },
  { why: "a language in capitals", read: { ...read(CHOOSE), language: "EN" } },
  { why: "a three-letter language", read: { ...read(CHOOSE), language: "eng" } },
  { why: "parts that are not a list", read: { language: "en", parts: CHOOSE } },
  { why: "no part", read: read() },
  { why: "a part that is not an object", read: read("choose") },
  { why: "a verb that is none of the eight", read: read({ ...CHOOSE, verb: "book" }) },
  { why: "a verb in other words", read: read({ ...CHOOSE, verb: "Choose" }) },
  {
    why: "choose without its question",
    read: read({ verb: "choose", quote: "2", choice: "c-02", fields: [] }),
  },
  { why: "a key its verb does not take", read: read({ ...CHOOSE, why: "it fits" }) },
  { why: "an empty quote", read: read({ ...CHOOSE, quote: "" }) },
  { why: "a quote of spaces", read: read({ ...CHOOSE, quote: "  " }) },
  { why: "a quote that is not text", read: read({ ...CHOOSE, quote: 2 }) },
  { why: "a choice that is not text", read: read({ ...CHOOSE, choice: 2 }) },
  { why: "fields that are not a list", read: read({ ...CHOOSE, fields: {} }) },
  { why: "a field that is not an object", read: withField("time") },
  { why: "a field without words", read: withField({ name: "time", value: TIME }) },
  { why: "a field with empty words", read: withField({ name: "time", value: TIME, words: "" }) },
  {
    why: "a field with a key it does not have",
    read: withField({ name: "n", value: 1, words: "1", sure: true }),
  },
  { why: "a field's value that is null", read: withField({ name: "n", value: null, words: "1" }) },
  { why: "a field's value that is not whole", read: withField({ name: "n", value: 1.5, words: "1.5" }) },
  {
    why: "money with a key it does not have",
    read: withField({ name: "p", value: { cents: 1, currency: "USD", note: "" }, words: "1c" }),
  },
  {
    why: "money in lowercase",
    read: withField({ name: "p", value: { cents: 1200, currency: "usd" }, words: "$12" }),
  },
  {
    why: "money in text",
    read: withField({ name: "p", value: { cents: "1200", currency: "USD" }, words: "$12" }),
  },
  {
    why: "a time not in UTC",
    read: withField({ name: "t", value: { utc: "2026-10-24 14:00", zone: "America/New_York" }, words: "2" }),
  },
  {
    why: "a time with a zone that is not a name",
    read: withField({ name: "t", value: { utc: TIME.utc, zone: "+05:00" }, words: "2" }),
  },
  {
    why: "ask with questions not a list",
    read: read({ verb: "ask", quote: "2", questions: "oq-a7-17", unclear: "which?" }),
  },
  {
    why: "ask with a question that is not text",
    read: read({ verb: "ask", quote: "2", questions: [17], unclear: "which?" }),
  },
  { why: "pass_on without words", read: read({ verb: "pass_on", quote: "2", words: "" }) },
  { why: "redact with words of spaces", read: read({ verb: "redact", quote: "2", words: " " }) },
  {
    why: "hand_off about someone K-02 does not list",
    read: read({ verb: "hand_off", quote: "2", reason: "r", about: "owner" }),
  },
  { why: "hand_off without about", read: read({ verb: "hand_off", quote: "2", reason: "r" }) },
  { why: "none_fits with why not text", read: read({ verb: "none_fits", quote: "2", why: 3 }) },
  { why: "no_op with fields", read: read({ verb: "no_op", quote: "2", fields: [] }) },
  { why: "a good part beside a broken one", read: read(CHOOSE, { verb: "no_op", quote: "" }) },
];

describe("the K-02 check a read passes before it leaves the AI layer", () => {
  it("accepts every read of every accepted K-02 decide fixture, as K-02's schema does", () => {
    let reads = 0;
    for (const pair of pairs) {
      for (const each of pair.reads) {
        expect(decideReadProblems(each), pair.file).toEqual([]);
        expect(isDecideRead(each)).toBe(true);
        expect(contract.validate("decideRead", each)).toEqual([]);
        reads += 1;
      }
    }
    expect(reads).toBe(27);
  });

  it("accepts every verb and a value of every type K-02 names: text, a whole number, true or false, money, a time", () => {
    const all = read(
      {
        ...CHOOSE,
        fields: [
          { name: "a", value: "Saturday", words: "Saturday" },
          { name: "b", value: 2, words: "2" },
          { name: "c", value: -3, words: "-3" },
          { name: "d", value: true, words: "yes" },
          { name: "e", value: { cents: 1200, currency: "USD" }, words: "$12" },
          { name: "f", value: TIME, words: "Saturday at 2" },
        ],
      },
      { verb: "enter", quote: "2", choice: "c-04", fields: [] },
      { verb: "ask", quote: "2", questions: [], unclear: "" },
      { verb: "none_fits", quote: "2", why: "" },
      { verb: "pass_on", quote: "2", words: "2" },
      { verb: "hand_off", quote: "2", reason: "", about: "ownerOrStaff" },
      { verb: "redact", quote: "2", words: "2" },
      { verb: "no_op", quote: "2" },
    );
    expect(decideReadProblems(all)).toEqual([]);
    expect(contract.validate("decideRead", all)).toEqual([]);
  });

  it.each(BROKEN_READS)("refuses $why, as K-02's schema does", ({ read: broken }) => {
    expect(decideReadProblems(broken)).not.toEqual([]);
    expect(isDecideRead(broken)).toBe(false);
    expect(contract.validate("decideRead", broken)).not.toEqual([]);
  });

  it("names parts and fields, never the words in them", () => {
    const secret = "my partner hurts me when he drinks";
    const problems = decideReadProblems({
      language: secret,
      parts: [
        {
          verb: "choose",
          quote: "",
          question: 3,
          choice: secret,
          fields: [{ name: secret, value: null, words: "" }],
        },
        { verb: secret, quote: secret },
        { verb: "hand_off", quote: secret, reason: secret, about: secret, [secret]: secret },
      ],
      [secret]: secret,
    });
    expect(problems).toEqual([
      "the read holds a key K-02 does not give it",
      "language is not a two-letter lowercase code",
      "parts[0].quote is empty",
      "parts[0].question is not text",
      "parts[0].fields[0].value is not text, a whole number, true or false, money or a time",
      "parts[0].fields[0].words are empty: a value without words is refused",
      "parts[1].verb is not one of the eight verbs",
      "parts[2] holds a key K-02 does not give it",
      "parts[2].about is not ownerOrStaff or other",
    ]);
    expect(problems.join(" ")).not.toContain("partner");
  });
});

describe("the named rules, as contracts/model/model.rules.mjs states them", () => {
  const contractRefuses = (context: DecideContext, output: unknown): boolean => {
    const pair = { context, decide: { reads: [{ output }], parts: [] } };
    return Object.values(contract.rules).some((rule) => rule(pair).length > 0);
  };

  it("every accepted fixture's reads keep both rules against their context, here and in the contract", () => {
    for (const pair of pairs) {
      for (const each of pair.reads) {
        expect(readProblems(pair.context, each), pair.file).toEqual([]);
        expect(contractRefuses(pair.context, each)).toBe(false);
      }
    }
  });

  it("each refused pair is refused by the rule its index entry names, here and in the contract", () => {
    for (const [file, rule] of [
      ["refuse-option-not-offered.json", "optionOffered"],
      ["refuse-quote-not-in-text.json", "quoteInText"],
    ] as const) {
      const pair = readJson(`contracts/model/fixtures/invalid/${file}`) as {
        context: DecideContext;
        decide: { reads: { output: DecideRead }[] };
      };
      expect(contract.rules[rule]?.(pair)).not.toEqual([]);
      for (const each of pair.decide.reads) {
        expect(decideReadProblems(each.output)).toEqual([]);
        const problems = readProblems(pair.context, each.output);
        expect(problems).not.toEqual([]);
        for (const line of problems) expect(line).toContain(`(${rule})`);
      }
    }
  });

  it("on damaged copies of the fixtures' reads: it refuses exactly what the contract's rules refuse", () => {
    type Damage = (output: DecideRead, context: DecideContext) => DecideRead | null;
    const first = (output: DecideRead): Raw => structuredClone(output.parts[0]) as unknown as Raw;
    const one = (output: DecideRead, part: Raw): DecideRead =>
      ({ ...output, parts: [part, ...output.parts.slice(1)] }) as DecideRead;
    const ofKind = (context: DecideContext, kinds: readonly string[]): string | undefined =>
      context.choices.find((choice) => kinds.includes(choice.kind))?.choiceId;
    const damages: Record<string, Damage> = {
      "a choice the context does not offer": (o) =>
        "choice" in first(o) ? one(o, { ...first(o), choice: "c-99" }) : null,
      "choose takes a door or an any-time row": (o, c) => {
        const id = ofKind(c, ENTER_KINDS);
        return first(o).verb === "choose" && id !== undefined ? one(o, { ...first(o), choice: id }) : null;
      },
      "enter takes an option": (o, c) => {
        const id = ofKind(c, CHOOSE_KINDS);
        const part = first(o);
        return part.verb === "choose" && id !== undefined
          ? one(o, { verb: "enter", quote: part.quote, choice: id, fields: [] })
          : null;
      },
      "another question than the choice's": (o) =>
        first(o).verb === "choose" ? one(o, { ...first(o), question: "oq-elsewhere" }) : null,
      "a field the choice does not carry": (o) =>
        first(o).verb === "choose"
          ? one(o, { ...first(o), fields: [{ name: "not_carried", value: "x", words: first(o).quote }] })
          : null,
      "ask about a question nothing answers": (o) =>
        first(o).verb === "ask" ? one(o, { ...first(o), questions: ["oq-elsewhere"] }) : null,
      "a quote not in the text": (o) => one(o, { ...first(o), quote: "words nobody typed" }),
      "a field's words not in the text": (o) => {
        const part = first(o);
        const fields = part.fields as Raw[] | undefined;
        return fields !== undefined && fields.length > 0
          ? one(o, { ...part, fields: [{ ...fields[0], words: "words nobody typed" }, ...fields.slice(1)] })
          : null;
      },
      "pass_on's or redact's words not in the text": (o) =>
        first(o).verb === "pass_on" || first(o).verb === "redact"
          ? one(o, { ...first(o), words: "words nobody typed" })
          : null,
    };
    const fired = new Set<string>();
    for (const pair of pairs) {
      for (const output of pair.reads) {
        for (const [name, damage] of Object.entries(damages)) {
          const damaged = damage(output, pair.context);
          if (damaged === null) continue;
          expect(decideReadProblems(damaged), name).toEqual([]);
          const ours = readProblems(pair.context, damaged).length > 0;
          expect(ours, `${pair.file}: ${name}`).toBe(contractRefuses(pair.context, damaged));
          expect(ours, `${pair.file}: ${name}`).toBe(true);
          fired.add(name);
        }
      }
    }
    expect([...fired].sort()).toEqual(Object.keys(damages).sort());
  });
});
