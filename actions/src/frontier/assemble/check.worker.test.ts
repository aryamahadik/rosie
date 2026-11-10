// T-1150's proof, inside the Workers runtime (workerd): the frontier's checks (check.ts) read K-02 v1.1's choice,
// openQuestion, stepCard and context with the prebuilt code that `npm run build:validators` compiles beside the Tool
// API's (infra/build/tool-api-validators.mjs), never with Ajv's compiler, which makes each check's code with new
// Function: the Workers runtime refuses that when it serves a request. This test pool's workerd does not refuse it, so,
// as validator.worker.test.ts does, the test traps Function and eval while check.ts makes its checker and runs every
// check below, and the trap counts no call.
//
// The build records, in ajv-answers.js, what Ajv's compiler answers in Node to each of the frontier's checks on the
// contracts' fixtures: each K-02 fixture of a definition the frontier checks (K-02 v1's and v1.1's contexts), the
// frontier each K-09 buildFrontier exchange answers (v1's build-frontier-s1-02.json, v1.5's build-frontier-s1-01.json
// with the sign-up door), each choice, open question and card in them, and {} against each of the four. Here, each
// check gives the same verdict, errors and problem lines. Values come only from the contracts' fixtures (rule 9).

import { afterEach, describe, expect, it, vi } from "vitest";

import modelIndex from "../../../../contracts/model/fixtures/index.json";
import buildFrontierS101 from "../../../../contracts/tool-api/fixtures/build-frontier-s1-01.json";
import { ajvAnswers, type AjvCheck } from "../../tool-api/generated/ajv-answers";
import { build, definitions } from "../../tool-api/generated/validators";
import { MODEL_SCHEMA_ID, RUNS_IN_WORKERD, formatProblems } from "../../tool-api/validator";
import {
  K02_PARTS,
  createFrontierChecker,
  defaultChecker,
  type FrontierChecker,
  type K02Part,
} from "./check";

type Json = Record<string, unknown>;

const MODEL_DEFS = `${MODEL_SCHEMA_ID}#/$defs/`;

/** The frontier's recorded checks: K-02 v1.1's four definitions. */
const FRONTIER_CHECKS = ajvAnswers.checks.filter((check) => check.definition.startsWith(MODEL_DEFS));

/** The checker inside workerd: createFrontierChecker() takes no schemas and compiles nothing. */
const checker = createFrontierChecker();

/** The value a check reads: the fixture's value at its path, or {}. */
function valueOf(check: AjvCheck): unknown {
  let value: unknown = check.source === null ? {} : ajvAnswers.fixtures[check.source];
  for (const key of check.at) value = (value as Record<string | number, unknown>)[key];
  return value;
}

/** The K-02 v1.1 definition a recorded check is against. */
function partOf(check: AjvCheck): K02Part {
  const part = check.definition.slice(MODEL_DEFS.length);
  if (!(K02_PARTS as readonly string[]).includes(part))
    throw new Error(`${check.definition} is not the frontier's`);
  return part as K02Part;
}

/** The prebuilt code's validate function for a $ref; fails the test when it holds none. */
function prebuiltOf(ref: string): NonNullable<(typeof definitions)[string]> {
  const validate = definitions[ref];
  if (validate === undefined) throw new Error(`the prebuilt code holds no ${ref}`);
  return validate;
}

/** The frontier's checks on each fixture (or on {}), by fixture, in the build's order. */
function checksBySource(): Map<string, AjvCheck[]> {
  const bySource = new Map<string, AjvCheck[]>();
  for (const check of FRONTIER_CHECKS) {
    const source = check.source ?? "{} against each definition";
    bySource.set(source, [...(bySource.get(source) ?? []), check]);
  }
  return bySource;
}

/** Traps Function and eval until the test ends, as validator.worker.test.ts does: each call is counted, then made. */
function trapCodeFromStrings(): { readonly calls: string[] } {
  const calls: string[] = [];
  const realFunction = globalThis.Function;
  const realEval = globalThis.eval;
  vi.stubGlobal(
    "Function",
    new Proxy(realFunction, {
      construct(target, args, newTarget) {
        calls.push("new Function");
        return Reflect.construct(target, args, newTarget) as object;
      },
      apply(target, self, args) {
        calls.push("Function()");
        return Reflect.apply(target, self, args) as unknown;
      },
    }),
  );
  vi.stubGlobal(
    "eval",
    new Proxy(realEval, {
      apply(target, self, args) {
        calls.push("eval()");
        return Reflect.apply(target, self, args) as unknown;
      },
    }),
  );
  return { calls };
}

/** build-frontier-s1-01.json's frontier: K-02 v1.1's context-s1-01.json, its one choice the sign-up door. */
function turnOneFrontier(): Json & { choices: Json[] } {
  return structuredClone(buildFrontierS101.outcome.context);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inside workerd, check.ts makes no code", () => {
  it("runs in the Workers runtime", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    expect(RUNS_IN_WORKERD).toBe(true);
  });

  it("making the checker and running every recorded K-02 v1.1 check, with the trap set, makes no code at all", () => {
    const trap = trapCodeFromStrings();
    const trapped = createFrontierChecker();
    for (const check of FRONTIER_CHECKS) {
      const value = valueOf(check);
      expect(trapped.check(partOf(check), value)).toEqual(formatProblems(check.errors));
      prebuiltOf(check.definition)(value);
    }
    const frontier = turnOneFrontier();
    expect(trapped.check("context", frontier)).toEqual([]);
    expect(defaultChecker().check("choice", frontier.choices[0])).toEqual([]);
    expect(trap.calls).toEqual([]);
  });

  it("check.ts never reaches for the compiler here, and checks no definition beyond its four", () => {
    expect(() => createFrontierChecker([])).toThrow("cannot run inside workerd");
    expect(() => checker.check("decideRead" as K02Part, {})).toThrow(
      "not a K-02 v1.1 definition the frontier checks",
    );
  });
});

describe("the prebuilt code holds K-02 v1.1's four definitions the frontier checks", () => {
  it("built for K-02 v1.1, the $id check.ts reads", () => {
    expect(MODEL_SCHEMA_ID).toBe("https://rosie.invalid/contracts/model/model.v1.1.schema.json");
    expect(build.modelSchemaId).toBe(MODEL_SCHEMA_ID);
    expect([...K02_PARTS]).toEqual(["choice", "openQuestion", "stepCard", "context"]);
    for (const part of K02_PARTS) expect(definitions[`${MODEL_DEFS}${part}`], part).toBeTypeOf("function");
  });

  it("the build recorded the frontier's checks on K-02's contexts and on each frontier buildFrontier answers", () => {
    const sources = new Set(FRONTIER_CHECKS.map((check) => check.source));
    const k02 = modelIndex.fixtures.filter((entry) => (K02_PARTS as readonly string[]).includes(entry.def));
    for (const entry of k02) expect(sources.has(`model/fixtures/${entry.file}`), entry.file).toBe(true);
    expect(k02.map((entry) => entry.version)).toEqual(expect.arrayContaining(["v1", "v1.1"]));
    for (const file of ["build-frontier-s1-01.json", "build-frontier-s1-02.json"]) {
      expect(sources.has(`tool-api/fixtures/${file}`), file).toBe(true);
    }
    const parts = new Set(FRONTIER_CHECKS.map((check) => partOf(check)));
    expect([...parts].sort()).toEqual([...K02_PARTS].sort());
    expect(FRONTIER_CHECKS.filter((check) => check.source === null)).toHaveLength(K02_PARTS.length);
  });
});

describe("every frontier check gives the answer of Ajv's compiler in Node", () => {
  for (const [source, checks] of checksBySource()) {
    it(`${source}: the same verdict, errors and problem lines`, () => {
      for (const check of checks) {
        const value = valueOf(check);
        const where = `/${check.at.join("/")} against ${check.definition}`;
        const validate = prebuiltOf(check.definition);
        const valid = validate(value);
        expect(valid, where).toBe(check.valid);
        expect(valid ? [] : validate.errors, where).toEqual(check.errors);
        expect(checker.check(partOf(check), value), where).toEqual(formatProblems(check.errors));
      }
    });
  }
});

describe("the sign-up door (K-02 v1.1) inside workerd", () => {
  it("build-frontier-s1-01.json's frontier passes, its one choice the sign-up door to S1-01", () => {
    const frontier = turnOneFrontier();
    const passes = (each: FrontierChecker): void => {
      expect(each.check("context", frontier)).toEqual([]);
      for (const choice of frontier.choices) expect(each.check("choice", choice)).toEqual([]);
    };
    passes(checker);
    expect(frontier.choices.map((choice) => [choice.kind, choice.door, choice.step])).toEqual([
      ["door", "signUp", "S1-01"],
    ]);
  });

  it("a door outside K-02 v1.1's six is refused, the problem naming the six", () => {
    const frontier = turnOneFrontier();
    const [door] = frontier.choices;
    if (door === undefined) throw new Error("no choice");
    door.door = "joinUs";
    const problems = checker.check("choice", door);
    expect(problems).toContain(
      "/door must be equal to one of the allowed values (newBooking, existingBooking, ownerCommand, teamChange, " +
        "unclearOwnerOrHelp, signUp)",
    );
    expect(checker.check("context", frontier)).not.toEqual([]);
  });
});
