// T-1165's proof, inside the Workers runtime (workerd): compose input's check (check.ts) reads K-03's composeInput with
// the prebuilt code that `npm run build:validators` compiles beside the Tool API's (infra/build/tool-api-validators.mjs:
// compose-input-validators.js), never with Ajv's compiler, which makes each check's code with new Function: the Workers
// runtime refuses that when it serves a request. This test pool's workerd does not refuse it, so, as the Tool API's
// validator.worker.test.ts and the frontier's check.worker.test.ts do, the test traps Function and eval while check.ts
// makes its checkers and runs every check below, and the trap counts no call.
//
// Both K-03 versions are prebuilt (DL-357): v1.1's composeInput, whose facts may also be term facts, which compose input
// checks since T-1174 (its default checker), and v1's. The build records, in compose-input-answers.js, what Ajv's compiler
// answers in Node, with the Tool API validator's options, to each K-03 input on the contracts' fixtures under each
// version: each K-03 composeInput fixture (input-s1-02-v1.1.json among them), each inputAndPlan fixture's input, the
// input K-09's compose-input-s1-02.json answers, and {}. Here, each check gives the same verdict, errors and problem
// lines. Values come only from the contracts' fixtures (rule 9).

import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import messagePlanIndex from "../../../contracts/message-plan/fixtures/index.json";
import inputS102V11 from "../../../contracts/message-plan/fixtures/input-s1-02-v1.1.json";
import inputS102 from "../../../contracts/message-plan/fixtures/input-s1-02.json";
import refuseFrontierInInput from "../../../contracts/message-plan/fixtures/invalid/refuse-frontier-in-input.json";
import composeInputS102 from "../../../contracts/tool-api/fixtures/compose-input-s1-02.json";
import { ajvAnswers, type AjvCheck } from "../tool-api/generated/compose-input-answers";
import { build, definitions } from "../tool-api/generated/compose-input-validators";
import { AJV_OPTIONS, RUNS_IN_WORKERD, formatProblems } from "../tool-api/validator";
import { MAX_CONVERSATION } from "./build";
import {
  COMPOSE_INPUT_SCHEMA_FILES,
  COMPOSE_INPUT_SCHEMA_IDS,
  MESSAGE_PLAN_SCHEMA_ID,
  MESSAGE_PLAN_V1_1_SCHEMA_ID,
  admitInput,
  createComposeInputChecker,
  defaultComposeInputChecker,
  loadComposeInputSchemas,
  type ComposeInputChecker,
  type ComposeInputSchemaId,
} from "./check";
import { ComposeInputRefusedError } from "./errors";

type Json = Record<string, unknown>;

/** K-03's composeInput, by version: the $ref of each definition the prebuilt code holds. */
const refOf = (schemaId: ComposeInputSchemaId): string => `${schemaId}#/$defs/composeInput`;

/** A checker for each K-03 version, inside workerd: createComposeInputChecker() takes no schemas and compiles nothing. */
const checkers = new Map<string, ComposeInputChecker>(
  COMPOSE_INPUT_SCHEMA_IDS.map((schemaId) => [
    refOf(schemaId),
    createComposeInputChecker(undefined, schemaId),
  ]),
);

/** The value a check reads: the fixture's value at its path, or {}. */
function valueOf(check: AjvCheck): unknown {
  let value: unknown = check.source === null ? {} : ajvAnswers.fixtures[check.source];
  for (const key of check.at) value = (value as Record<string | number, unknown>)[key];
  return value;
}

/** The checker of the K-03 version a recorded check is against. */
function checkerOf(check: AjvCheck): ComposeInputChecker {
  const checker = checkers.get(check.definition);
  if (checker === undefined) throw new Error(`${check.definition} is not compose input's`);
  return checker;
}

/** The prebuilt code's validate function for a $ref; fails the test when it holds none. */
function prebuiltOf(ref: string): NonNullable<(typeof definitions)[string]> {
  const validate = definitions[ref];
  if (validate === undefined) throw new Error(`the prebuilt code holds no ${ref}`);
  return validate;
}

/** The recorded checks on each fixture (or on {}), by fixture, in the build's order. */
function checksBySource(): Map<string, AjvCheck[]> {
  const bySource = new Map<string, AjvCheck[]>();
  for (const check of ajvAnswers.checks) {
    const source = check.source ?? "{} against each definition";
    bySource.set(source, [...(bySource.get(source) ?? []), check]);
  }
  return bySource;
}

/** The recorded check of `source`'s whole file against K-03 `schemaId`'s composeInput; fails the test when none. */
function recordedOn(source: string, schemaId: ComposeInputSchemaId): AjvCheck {
  const found = ajvAnswers.checks.find(
    (check) => check.source === source && check.at.length === 0 && check.definition === refOf(schemaId),
  );
  if (found === undefined) throw new Error(`no check of ${source} against ${refOf(schemaId)}`);
  return found;
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

/** input-s1-02.json with a conversation of `count` messages, each Sam's text as its <inbound> gives it. */
function withConversation(count: number): Json {
  const input = structuredClone(inputS102) as Json & { inbound: { text: string; sentAt: unknown } };
  const message = { from: "reader", text: input.inbound.text, sentAt: input.inbound.sentAt };
  input.conversation = Array.from({ length: count }, () => structuredClone(message));
  return input;
}

/** What a call threw; fails the test when it threw nothing. */
function thrownFrom(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error("nothing was thrown");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inside workerd, check.ts makes no code", () => {
  it("runs in the Workers runtime", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    expect(RUNS_IN_WORKERD).toBe(true);
  });

  it("the trap counts Ajv's compiler: compiling one schema makes its code with new Function", () => {
    const trap = trapCodeFromStrings();
    new Ajv2020(AJV_OPTIONS).compile({ type: "object", required: ["row"] });
    expect(trap.calls).toContain("new Function");
  });

  it("making a checker for each K-03 version and running every recorded check, with the trap set, makes no code at all", () => {
    const trap = trapCodeFromStrings();
    const trapped = new Map(
      COMPOSE_INPUT_SCHEMA_IDS.map((schemaId) => [
        refOf(schemaId),
        createComposeInputChecker(undefined, schemaId),
      ]),
    );
    for (const check of ajvAnswers.checks) {
      const value = valueOf(check);
      expect(trapped.get(check.definition)?.check(value)).toEqual(formatProblems(check.errors));
      prebuiltOf(check.definition)(value);
    }
    expect(defaultComposeInputChecker().check(inputS102)).toEqual([]);
    expect(admitInput(inputS102, createComposeInputChecker())).toStrictEqual(inputS102);
    expect(() => admitInput(refuseFrontierInInput, createComposeInputChecker())).toThrow(
      ComposeInputRefusedError,
    );
    expect(ajvAnswers.checks.length).toBeGreaterThan(COMPOSE_INPUT_SCHEMA_IDS.length);
    expect(trap.calls).toEqual([]);
  });

  it("check.ts never reaches for the compiler or the disk here, and checks no K-03 version beyond its two", () => {
    expect(() => createComposeInputChecker([])).toThrow("cannot run inside workerd");
    expect(() => createComposeInputChecker([], MESSAGE_PLAN_V1_1_SCHEMA_ID)).toThrow(
      "cannot run inside workerd",
    );
    expect(() => loadComposeInputSchemas()).toThrow("no contracts/ on disk");
    const v2 = "https://rosie.invalid/contracts/message-plan/message-plan.v2.schema.json";
    expect(() => createComposeInputChecker(undefined, v2 as ComposeInputSchemaId)).toThrow(
      "not a K-03 version whose composeInput compose input checks",
    );
  });
});

describe("the prebuilt code holds K-03 v1's and v1.1's composeInput, as check.ts reads them", () => {
  it("built for check.ts's two K-03 versions from its schema files, with the Tool API validator's options", () => {
    expect([...COMPOSE_INPUT_SCHEMA_IDS]).toEqual([
      "https://rosie.invalid/contracts/message-plan/message-plan.v1.schema.json",
      "https://rosie.invalid/contracts/message-plan/message-plan.v1.1.schema.json",
    ]);
    expect([...COMPOSE_INPUT_SCHEMA_IDS]).toEqual([MESSAGE_PLAN_SCHEMA_ID, MESSAGE_PLAN_V1_1_SCHEMA_ID]);
    expect(build.messagePlanSchemaIds).toEqual([...COMPOSE_INPUT_SCHEMA_IDS]);
    expect([...build.schemaFiles].sort()).toEqual([...COMPOSE_INPUT_SCHEMA_FILES].sort());
    expect(Object.keys(build.sha256).sort()).toEqual([...COMPOSE_INPUT_SCHEMA_FILES].sort());
    expect(build.options).toEqual(AJV_OPTIONS);
  });

  it("holds exactly the two composeInput definitions, each a function", () => {
    const refs = COMPOSE_INPUT_SCHEMA_IDS.map((schemaId) => refOf(schemaId));
    expect(Object.keys(definitions).sort()).toEqual([...refs].sort());
    for (const ref of refs) expect(definitions[ref], ref).toBeTypeOf("function");
  });

  it("the build recorded the compiler's answers on each K-03 input, under each version", () => {
    const k03 = messagePlanIndex.fixtures.filter(
      (entry) => entry.def === "composeInput" || entry.def === "inputAndPlan",
    );
    expect(k03.map((entry) => entry.file)).toEqual(
      expect.arrayContaining([
        "input-s1-02.json",
        "input-s1-02-v1.1.json",
        "invalid/refuse-frontier-in-input.json",
      ]),
    );
    const sources = [
      ...k03.map((entry) => `message-plan/fixtures/${entry.file}`),
      "tool-api/fixtures/compose-input-s1-02.json",
    ];
    expect(Object.keys(ajvAnswers.fixtures)).toEqual(expect.arrayContaining(sources));
    const bySource = checksBySource();
    for (const [source, checks] of bySource) {
      expect(checks.map((check) => check.definition).sort(), source).toEqual(
        COMPOSE_INPUT_SCHEMA_IDS.map((schemaId) => refOf(schemaId)).sort(),
      );
    }
    expect(bySource.get("{} against each definition")).toHaveLength(COMPOSE_INPUT_SCHEMA_IDS.length);
    // The recorded fixtures are the files themselves.
    expect(ajvAnswers.fixtures["message-plan/fixtures/input-s1-02-v1.1.json"]).toEqual(inputS102V11);
    expect(ajvAnswers.fixtures["message-plan/fixtures/input-s1-02.json"]).toEqual(inputS102);
    expect(ajvAnswers.fixtures["tool-api/fixtures/compose-input-s1-02.json"]).toEqual(composeInputS102);
  });
});

describe("every compose input check gives the answer of Ajv's compiler in Node", () => {
  for (const [source, checks] of checksBySource()) {
    it(`${source}: the same verdict, errors and problem lines`, () => {
      for (const check of checks) {
        const value = valueOf(check);
        const where = `/${check.at.join("/")} against ${check.definition}`;
        const validate = prebuiltOf(check.definition);
        const valid = validate(value);
        expect(valid, where).toBe(check.valid);
        expect(valid ? [] : validate.errors, where).toEqual(check.errors);
        expect(checkerOf(check).check(value), where).toEqual(formatProblems(check.errors));
      }
    });
  }
});

describe("input-s1-02-v1.1.json under each version (DL-357): the prebuilt answer is Ajv's", () => {
  const source = "message-plan/fixtures/input-s1-02-v1.1.json";

  for (const schemaId of COMPOSE_INPUT_SCHEMA_IDS) {
    it(`against ${refOf(schemaId)}`, () => {
      const recorded = recordedOn(source, schemaId);
      const validate = prebuiltOf(refOf(schemaId));
      const valid = validate(structuredClone(inputS102V11));
      expect(valid).toBe(recorded.valid);
      expect(valid ? [] : validate.errors).toEqual(recorded.errors);
      const checker = checkers.get(refOf(schemaId));
      expect(checker?.check(structuredClone(inputS102V11))).toEqual(formatProblems(recorded.errors));
    });
  }

  it("Ajv's answers: K-03 v1.1 accepts its term facts; K-03 v1 refuses each, naming the place, never the words", () => {
    expect(recordedOn(source, MESSAGE_PLAN_V1_1_SCHEMA_ID).valid).toBe(true);
    const underV1 = checkers.get(refOf(MESSAGE_PLAN_SCHEMA_ID))?.check(structuredClone(inputS102V11)) ?? [];
    expect(recordedOn(source, MESSAGE_PLAN_SCHEMA_ID).valid).toBe(false);
    expect(underV1).toContain("/facts/0 must have required property 'slot'");
    expect(underV1).toContain("/facts/0 must NOT have additional properties (source)");
    expect(underV1.join(" ")).not.toContain("$2");
  });
});

describe("check.ts's own answers inside workerd, as in Node", () => {
  it("accepts input-s1-02.json and refuses refuse-frontier-in-input.json for its frontier alone, under each version", () => {
    for (const checker of checkers.values()) {
      expect(checker.check(structuredClone(inputS102))).toEqual([]);
      expect(checker.check(structuredClone(refuseFrontierInInput))).toEqual([
        "(root) must NOT have additional properties (frontier)",
      ]);
    }
    const thrown = thrownFrom(() =>
      admitInput(structuredClone(refuseFrontierInInput), createComposeInputChecker()),
    );
    if (!(thrown instanceof ComposeInputRefusedError)) throw new Error("not a compose-input refusal");
    expect(thrown.fault).toBe("inputRefused");
    expect(thrown.problems).toBe(1);
  });

  it(`refuses a conversation of more than ${String(MAX_CONVERSATION)} messages by the code check, under each version`, () => {
    for (const checker of checkers.values()) {
      expect(checker.check(withConversation(MAX_CONVERSATION))).toEqual([]);
      expect(checker.check(withConversation(MAX_CONVERSATION + 1))).toEqual([
        `/conversation holds more than ${String(MAX_CONVERSATION)} messages`,
      ]);
    }
  });
});
