// The emitter's validation (T-149): K-01 v1 through the one validator (Ajv 8, its 2020-12 class, strict mode), with the
// schema read from contracts/ and never copied. Every fixture of contracts/bundle/fixtures/index.json gets the verdict
// the index gives it, so each refused fixture is refused by the emitter's validation; and the per-step lint marks name
// exactly the rule each refused step shows.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BundleValidationError,
  assertBundlePart,
  bundleSchema,
  checkBundlePart,
  lintMarksOf,
  lintRuleOrder,
  markedRules,
  stepSchemaChecks,
} from "./index";

const FIXTURES = new URL("../../../contracts/bundle/fixtures/", import.meta.url);

interface Entry {
  file: string;
  def?: string;
  expect: "accept" | "refuse";
  shows: string;
}

function fixture(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8")) as Record<string, unknown>;
}

const entries = (fixture("index.json") as { fixtures: Entry[] }).fixtures;
const refused = entries.filter((entry) => entry.expect === "refuse");
const accepted = entries.filter((entry) => entry.expect === "accept");

describe("the emitter's validation is K-01 v1's", () => {
  it("reads the schema from contracts/bundle/bundle.v1.schema.json", () => {
    const file = JSON.parse(
      readFileSync(new URL("../../../contracts/bundle/bundle.v1.schema.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(bundleSchema()).toEqual(file);
  });

  it("has fixtures of both kinds to check", () => {
    expect(refused.length).toBeGreaterThanOrEqual(8);
    expect(accepted.length).toBeGreaterThanOrEqual(12);
  });

  it.each(refused.map((entry) => [entry.file, entry] as const))("refuses %s", (_file, entry) => {
    const problems = checkBundlePart(fixture(entry.file), entry.def);
    expect(problems.length).toBeGreaterThan(0);
    expect(() => {
      assertBundlePart(fixture(entry.file), entry.file, entry.def);
    }).toThrow(BundleValidationError);
  });

  it.each(accepted.map((entry) => [entry.file, entry] as const))("accepts %s", (_file, entry) => {
    expect(checkBundlePart(fixture(entry.file), entry.def)).toEqual([]);
  });
});

describe("the lint marks a step's own fields ask for", () => {
  const steps = refused.filter((entry) => entry.def === "step");

  it.each(
    steps
      .filter((entry) => entry.file !== "invalid/refuse-judgment-rule-out-of-range.json")
      .map((entry) => [entry.file] as const),
  )("%s: the mark is its one rule, and with it the step is accepted", (file) => {
    const rule = /refuse-(.+)\.json$/.exec(file)?.[1];
    const step = fixture(file);
    expect(lintMarksOf(step)).toEqual([rule]);
    expect(checkBundlePart({ ...step, lint: lintMarksOf(step) }, "step")).toEqual([]);
  });

  it("a judgment rule number outside 1 to 67 is refused whatever the marks say (MC R6)", () => {
    const step = fixture("invalid/refuse-judgment-rule-out-of-range.json");
    expect(checkBundlePart({ ...step, lint: lintRuleOrder() }, "step").length).toBeGreaterThan(0);
  });

  it("an accepted sample step needs no mark beyond its own lint", () => {
    const bundle = fixture("bundle-mini-a.json") as {
      flows: { A: { steps: Record<string, Record<string, unknown>> } };
    };
    for (const step of Object.values(bundle.flows.A.steps)) expect(lintMarksOf(step)).toEqual(step.lint);
  });

  it("the step checks K-01 v1 makes are the seven per-step rules of its README", () => {
    const checks = stepSchemaChecks();
    expect(checks).toContainEqual({ field: "say", rule: "guard-keyword-button" });
    expect(checks).toContainEqual({ field: "vary", rule: "unknown-slot" });
    expect(checks).toContainEqual({ field: "walk", rule: "loop" });
    expect([...new Set(checks.map((check) => check.rule))].sort()).toEqual(
      [
        "choice-without-definition",
        "guard-keyword-button",
        "judgment-rule-out-of-range",
        "lookup-without-field",
        "loop",
        "no-safe-default-or-clock",
        "unknown-slot",
      ].sort(),
    );
  });

  it("the summary counts every rule the marks can show: loop's walk is not written, so loop is not among them", () => {
    expect(markedRules()).not.toContain("loop");
    expect(markedRules()).toContain("guard-keyword-button");
    expect(markedRules()).toContain("unknown-slot");
    expect(markedRules()).toEqual(lintRuleOrder().filter((rule) => markedRules().includes(rule)));
  });
});
