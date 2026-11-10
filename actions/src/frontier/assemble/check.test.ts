// T-1150: the frontier's checks (check.ts) read K-02 v1.1's choice, openQuestion, stepCard and context, in Node with
// Ajv's compiler over the Tool API validator's files: build-frontier-s1-01.json's frontier passes with its sign-up door,
// a door outside K-02 v1.1's six is refused, and every K-02 v1 value the frontier's tests read (K-02's v1 contexts, K-09
// v1's build-frontier-s1-02.json) gets the answer K-02 v1 gives it. Values come only from the contracts' fixtures (rule
// 9). The same checks inside workerd: check.worker.test.ts.

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { AJV_OPTIONS, formatProblems, loadToolApiSchemas } from "../../tool-api/validator";
import { K02_PARTS, MODEL_SCHEMA_ID, createFrontierChecker, type K02Part } from "./check";
import { contractFixture } from "./test-support";

type Json = Record<string, unknown>;

const checker = createFrontierChecker();

/** The $id of K-02 v1, whose definitions the frontier checked before v1.1. */
const K02_V1_ID = "https://rosie.invalid/contracts/model/model.v1.schema.json";

/** Ajv's compiler on the validator's files (K-02 v1 among them), for K-02 v1's answers beside v1.1's. */
const ajv = new Ajv2020(AJV_OPTIONS);
for (const schema of loadToolApiSchemas()) ajv.addSchema(schema);

/** The problem lines K-02 v1's `$defs/<part>` finds in `value`. */
function underV1(part: K02Part, value: unknown): string[] {
  const validate = ajv.getSchema(`${K02_V1_ID}#/$defs/${part}`);
  if (validate === undefined) throw new Error(`K-02 v1 has no definition ${part}`);
  return validate(value) ? [] : formatProblems(validate.errors);
}

/** A K-02 context with each of its choices, open questions and cards, as [part, value] pairs. */
function contextChecks(context: Json): [K02Part, unknown][] {
  const items = (list: string): unknown[] => (Array.isArray(context[list]) ? context[list] : []);
  return [
    ["context", context],
    ...items("choices").map((value): [K02Part, unknown] => ["choice", value]),
    ...items("openQuestions").map((value): [K02Part, unknown] => ["openQuestion", value]),
    ...items("cards").map((value): [K02Part, unknown] => ["stepCard", value]),
  ];
}

/** build-frontier-s1-01.json's frontier (K-09 v1.5): K-02 v1.1's context-s1-01.json, its one choice the sign-up door. */
function turnOneFrontier(): Json & { choices: Json[] } {
  const exchange = contractFixture("tool-api/fixtures/build-frontier-s1-01.json") as {
    outcome: { context: Json & { choices: Json[] } };
  };
  return exchange.outcome.context;
}

describe("the frontier checks K-02 v1.1's choice, openQuestion, stepCard and context", () => {
  it("reads K-02 v1.1's $id, and checks those four definitions", () => {
    const v11 = contractFixture("model/model.v1.1.schema.json") as { $id: string; $defs: Json };
    expect(MODEL_SCHEMA_ID).toBe(v11.$id);
    expect([...K02_PARTS]).toEqual(["choice", "openQuestion", "stepCard", "context"]);
    for (const part of K02_PARTS) expect(v11.$defs[part], part).toBeDefined();
    for (const part of K02_PARTS) expect(checker.check(part, {}), part).not.toEqual([]);
  });

  it("a name that is none of the four throws, rather than check against a definition the Worker does not hold", () => {
    expect(() => checker.check("decideRead" as K02Part, {})).toThrow(
      "not a K-02 v1.1 definition the frontier checks",
    );
  });

  it("takes the schemas it is given, as before", () => {
    const given = createFrontierChecker(loadToolApiSchemas());
    expect(given.check("context", turnOneFrontier())).toEqual([]);
  });
});

describe("the sign-up door (K-02 v1.1 default 9)", () => {
  it("build-frontier-s1-01.json's frontier passes, each choice too, its one choice the door to S1-01", () => {
    const frontier = turnOneFrontier();
    for (const [part, value] of contextChecks(frontier)) expect(checker.check(part, value), part).toEqual([]);
    expect(frontier.choices.map((choice) => [choice.kind, choice.door, choice.step, choice.label])).toEqual([
      ["door", "signUp", "S1-01", "Business onboarding"],
    ]);
  });

  it("K-02 v1 refuses the same door: v1.1 is what lets it pass", () => {
    const frontier = turnOneFrontier();
    expect(underV1("context", frontier)).not.toEqual([]);
    expect(underV1("choice", frontier.choices[0])).toContain(
      "/door must be equal to one of the allowed values (newBooking, existingBooking, ownerCommand, teamChange, " +
        "unclearOwnerOrHelp)",
    );
  });

  it("a door outside K-02 v1.1's six is refused, the problem naming the six", () => {
    const frontier = turnOneFrontier();
    const [door] = frontier.choices;
    if (door === undefined) throw new Error("no choice");
    door.door = "joinUs";
    expect(checker.check("choice", door)).toContain(
      "/door must be equal to one of the allowed values (newBooking, existingBooking, ownerCommand, teamChange, " +
        "unclearOwnerOrHelp, signUp)",
    );
    expect(checker.check("context", frontier)).not.toEqual([]);
  });

  it("the sign-up door leads to S1-01 alone: another step is refused", () => {
    const [door] = turnOneFrontier().choices;
    if (door === undefined) throw new Error("no choice");
    door.step = "S1-02";
    expect(checker.check("choice", door)).toContain("/step must be equal to constant");
  });
});

describe("every K-02 v1 value the frontier's tests read gets the answer K-02 v1 gives it", () => {
  const index = contractFixture("model/fixtures/index.json") as {
    fixtures: { file: string; version: string; def: string; expect: string }[];
  };
  const v1Contexts = index.fixtures.filter((entry) => entry.version === "v1" && entry.def === "context");

  it("reads K-02 v1's three contexts, one of them refused", () => {
    expect(v1Contexts.map((entry) => entry.expect).sort()).toEqual(["accept", "accept", "refuse"]);
  });

  const sources: [string, () => Json][] = [
    ...v1Contexts.map((entry): [string, () => Json] => [
      entry.file,
      () => contractFixture(`model/fixtures/${entry.file}`) as Json,
    ]),
    [
      "build-frontier-s1-02.json's frontier (K-09 v1)",
      () =>
        (contractFixture("tool-api/fixtures/build-frontier-s1-02.json") as { outcome: { context: Json } })
          .outcome.context,
    ],
  ];
  for (const [name, read] of sources) {
    it(`${name}: K-02 v1.1 gives K-02 v1's problem lines, for the context and each choice, question and card`, () => {
      for (const [part, value] of contextChecks(read())) {
        expect(checker.check(part, value), part).toEqual(underV1(part, value));
      }
    });
  }
});
