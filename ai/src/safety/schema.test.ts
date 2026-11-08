// Tests of the safety read's model-facing schema and its answer check (T-365): the schema sent is K-02 v1's own
// `safetyRead`, bundled exactly as the contracts' structured-subset lint bundles it and passing that lint; the hand
// written check of an answer refuses and accepts what K-02's schema (Ajv) refuses and accepts.

import path from "node:path";
import { pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { loadModelContract, type ModelContract } from "../recorded-double";
import {
  SAFETY_OUTCOMES,
  SAFETY_READ_DEF,
  SAFETY_READ_SCHEMA,
  SAFETY_SOURCES,
  TENSES,
  bundleLocalDefinition,
  isSafetyRead,
  safetyReadProblems,
} from "./index";
import { REPO_ROOT, SAFETY_RECORDINGS, k02, readJson } from "./test-support";

interface SubsetLint {
  bundleSchema(target: { schema: string; def: string }): unknown;
  lintSchema(bundled: unknown): {
    errors: string[];
    counts: { optionalProperties: number; unionParameters: number };
  };
}

let lint: SubsetLint;
let contract: ModelContract;

beforeAll(async () => {
  const file = path.join(REPO_ROOT, "contracts", "scripts", "structured-subset-lint.mjs");
  lint = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as SubsetLint;
  contract = await loadModelContract();
});

const MODEL_SCHEMA = readJson("contracts/model/model.v1.schema.json") as {
  $defs: Record<string, { enum?: string[]; properties?: Record<string, { enum?: string[] }> }>;
};

/** The reads of every accepted K-02 safety fixture with a verdict. */
const fixtureReads = (): unknown[] =>
  SAFETY_RECORDINGS.map((recording) => k02(recording.seed?.fixture ?? "").read).filter(
    (read) => read !== null,
  );

describe("the schema the model answers in", () => {
  it("is K-02 v1's safetyRead, bundled exactly as the contracts' structured-subset lint bundles it", () => {
    expect(SAFETY_READ_DEF).toBe("safetyRead");
    expect(SAFETY_READ_SCHEMA).toEqual(
      lint.bundleSchema({ schema: "model/model.v1.schema.json", def: "safetyRead" }),
    );
    expect(Object.keys(SAFETY_READ_SCHEMA.$defs as object)).toEqual([
      "safetyLabel",
      "safetyOutcome",
      "tense",
    ]);
  });

  it("passes the structured-outputs subset lint: every property required, no union, no recursion", () => {
    const { errors, counts } = lint.lintSchema(SAFETY_READ_SCHEMA);
    expect(errors).toEqual([]);
    expect(counts).toEqual({ optionalProperties: 0, unionParameters: 0 });
  });

  it("accepts and refuses what the contract does, on every K-02 safety fixture's read and on broken ones", () => {
    const validate = new Ajv2020({ strict: true, strictRequired: false }).compile(SAFETY_READ_SCHEMA);
    for (const read of fixtureReads()) {
      expect(validate(read)).toBe(true);
      expect(contract.validate("safetyRead", read)).toEqual([]);
    }
    for (const broken of BROKEN_READS) {
      expect(validate(broken.read)).toBe(false);
      expect(contract.validate("safetyRead", broken.read)).not.toEqual([]);
    }
  });

  it("cannot be changed in place: what is sent is the contract's", () => {
    expect(Object.isFrozen(SAFETY_READ_SCHEMA)).toBe(true);
    expect(Object.isFrozen(SAFETY_READ_SCHEMA.$defs)).toBe(true);
    expect(() => {
      SAFETY_READ_SCHEMA.type = "string";
    }).toThrow(TypeError);
    expect(SAFETY_READ_SCHEMA.type).toBe("object");
  });

  it("names the outcomes, tenses and sources exactly as K-02 v1 does", () => {
    expect(SAFETY_OUTCOMES).toEqual(MODEL_SCHEMA.$defs.safetyOutcome?.enum);
    expect(TENSES).toEqual(MODEL_SCHEMA.$defs.tense?.enum);
    expect(SAFETY_SOURCES).toEqual(MODEL_SCHEMA.$defs.safetyResult?.properties?.source?.enum);
  });
});

describe("bundling one definition with only local references", () => {
  it("copies every definition it reaches, in the order first met", () => {
    const defs = {
      root: { type: "object", properties: { a: { $ref: "#/$defs/a" }, b: { $ref: "#/$defs/b" } } },
      a: { type: "array", items: { $ref: "#/$defs/b" } },
      b: { type: "string" },
      unused: { type: "null" },
    };
    expect(bundleLocalDefinition(defs, "root")).toEqual({ ...defs.root, $defs: { a: defs.a, b: defs.b } });
    expect(bundleLocalDefinition(defs, "b")).toEqual({ type: "string" });
  });

  it("refuses a recursive definition, a reference into another file, and a definition that is not there", () => {
    expect(() => bundleLocalDefinition({ root: { items: { $ref: "#/$defs/root" } } }, "root")).toThrow(
      /recursive/u,
    );
    expect(() =>
      bundleLocalDefinition({ root: { $ref: "../bundle/bundle.v1.schema.json#/$defs/stepId" } }, "root"),
    ).toThrow(/outside/u);
    expect(() => bundleLocalDefinition({ root: { $ref: "#/$defs/gone" } }, "root")).toThrow(
      /does not define/u,
    );
    expect(() => bundleLocalDefinition({}, "root")).toThrow(/no definition/u);
  });
});

const LABEL = {
  outcome: "An emergency",
  tense: "now",
  evidence: "my lips are swelling",
  atRisk: "the writer",
  writer: "the person at the handle",
};

/** Reads K-02 refuses, each for one reason. */
const BROKEN_READS: { why: string; read: unknown }[] = [
  { why: "not an object", read: null },
  { why: "a list, not a read", read: [LABEL] },
  { why: "no labels", read: {} },
  { why: "labels is not a list", read: { labels: LABEL } },
  { why: "no label at all", read: { labels: [] } },
  { why: "a field the read does not have", read: { labels: [LABEL], verdict: "danger" } },
  { why: "a label that is not an object", read: { labels: ["An emergency"] } },
  { why: "an outcome that is none of the 8 or Unsure", read: { labels: [{ ...LABEL, outcome: "Danger" }] } },
  { why: "an outcome in other words", read: { labels: [{ ...LABEL, outcome: "an emergency" }] } },
  { why: "a tense that is not one of the five", read: { labels: [{ ...LABEL, tense: "past" }] } },
  { why: "evidence that is not text", read: { labels: [{ ...LABEL, evidence: null }] } },
  { why: "who is at risk left out", read: { labels: [{ ...LABEL, atRisk: undefined }] } },
  { why: "who wrote it not text", read: { labels: [{ ...LABEL, writer: 7 }] } },
  { why: "a field a label does not have", read: { labels: [{ ...LABEL, confidence: "high" }] } },
];

describe("the check of an answer, before it counts as a verdict", () => {
  it("accepts every K-02 safety fixture's read", () => {
    const reads = fixtureReads();
    expect(reads.length).toBeGreaterThanOrEqual(9);
    for (const read of reads) {
      expect(safetyReadProblems(read)).toEqual([]);
      expect(isSafetyRead(read)).toBe(true);
    }
  });

  it.each(BROKEN_READS)("refuses $why, as K-02's schema does", ({ read }) => {
    expect(safetyReadProblems(read)).not.toEqual([]);
    expect(isSafetyRead(read)).toBe(false);
    expect(contract.validate("safetyRead", read)).not.toEqual([]);
  });

  it("accepts several labels, and every outcome and tense K-02 names", () => {
    const labels = SAFETY_OUTCOMES.flatMap((outcome) =>
      TENSES.map((tense) => ({ ...LABEL, outcome, tense })),
    );
    expect(labels).toHaveLength(45);
    expect(safetyReadProblems({ labels })).toEqual([]);
    expect(contract.validate("safetyRead", { labels })).toEqual([]);
  });

  it("names the fields that fail, never the words in them", () => {
    const secret = "my partner hurts me when he drinks";
    const problems = safetyReadProblems({
      labels: [{ ...LABEL, outcome: secret, evidence: 3, writer: secret }],
      note: secret,
    });
    expect(problems).toEqual([
      "note is not a field of the read",
      "labels[0].outcome is not one of the 8 outcomes or Unsure",
      "labels[0].evidence is not text",
    ]);
    expect(problems.join(" ")).not.toContain("partner");
  });
});
